//! Replay: paper trades over historical candles, their results and the `.replay` file.
//!
//! A session is candles (context before `start`, then the bars revealed one by one up to
//! `current`) and the trade commands the user gave. [`simulate`] turns them into trades and
//! [`Stats`]; nothing else computes results, so a file gives the same numbers everywhere.
//! See ADR 0005.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::decimal::JS_SAFE_MAX;
use crate::drawing::{Anchor, rescale_ticks};
use crate::model::{Candle, Instrument, InstrumentId};
use crate::position::{Side, Status, resolve_iter};
use crate::timeframe::Timeframe;

/// The file version this code reads and writes.
pub const VERSION: u32 = 1;
pub const MAX_CANDLES: usize = 200_000;
pub const MAX_COMMANDS: usize = 10_000;
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
/// Largest price or quantity scale a file may carry: 10^18 is the largest power of ten
/// in an `i64`, so ticks can still be rescaled.
pub const MAX_SCALE: u8 = 18;
/// Longest source, symbol, base or quote of a file's instrument.
pub const MAX_NAME_BYTES: usize = 64;

/// What the user did at a bar. `bar` indexes the session's candles. JSON is
/// `{ "kind": "open", ... }` with camelCase fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    /// A market trade, filled at the close of `bar`.
    Open {
        bar: u32,
        side: Side,
        stop: i64,
        take: i64,
    },
    /// New stop and/or take, in force from the bar after `bar`.
    Edit {
        bar: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        take: Option<i64>,
    },
    /// Closes the open trade at the close of `bar`.
    Close { bar: u32 },
}

impl Command {
    pub fn bar(&self) -> u32 {
        match *self {
            Command::Open { bar, .. } | Command::Edit { bar, .. } | Command::Close { bar } => bar,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Take,
    Stop,
    Manual,
    /// Still open at the current bar.
    Open,
}

/// One trade. Prices are ticks. An open trade has no exit and its `r` is marked to the
/// close of the current bar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub side: Side,
    pub entry_bar: u32,
    pub entry_time: i64,
    pub entry_price: i64,
    /// The stop at entry; R is measured against it.
    pub initial_stop: i64,
    /// The levels in force at the exit (or now, while open).
    pub stop: i64,
    pub take: i64,
    pub exit_bar: Option<u32>,
    pub exit_time: Option<i64>,
    pub exit_price: Option<i64>,
    pub reason: ExitReason,
    /// The exit bar touched both stop and take; it counts as a stop.
    pub ambiguous: bool,
    /// (exit - entry) / (entry - initial stop); the same formula holds for shorts.
    pub r: f64,
}

/// Statistics over the closed trades, in R. Open trades do not count.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub count: u32,
    /// Trades with R > 0; R < 0 are losses, R = 0 is neither.
    pub wins: u32,
    pub losses: u32,
    /// wins / count, 0 without trades.
    pub win_rate: f64,
    pub total_r: f64,
    /// total R / count, 0 without trades.
    pub average_r: f64,
    /// Sum of wins over the absolute sum of losses; `None` without losses.
    pub profit_factor: Option<f64>,
    /// Deepest fall of the running R total below its peak (which starts at 0), as a
    /// positive number.
    pub max_drawdown_r: f64,
    pub longest_losing_streak: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Simulation {
    pub trades: Vec<Trade>,
    pub stats: Stats,
}

struct Running {
    side: Side,
    entry_bar: u32,
    entry_price: i64,
    initial_stop: i64,
    stop: i64,
    take: i64,
    /// The first bar not yet checked for a hit.
    next: usize,
}

impl Running {
    fn r_at(&self, exit: i64) -> f64 {
        let (e, x, s) = (
            i128::from(self.entry_price),
            i128::from(exit),
            i128::from(self.initial_stop),
        );
        (x - e) as f64 / (e - s) as f64
    }

    fn finish(
        &self,
        candles: &[Candle],
        exit_bar: usize,
        exit_price: i64,
        reason: ExitReason,
        ambiguous: bool,
    ) -> Trade {
        Trade {
            side: self.side,
            entry_bar: self.entry_bar,
            entry_time: candles[self.entry_bar as usize].open_time,
            entry_price: self.entry_price,
            initial_stop: self.initial_stop,
            stop: self.stop,
            take: self.take,
            exit_bar: Some(exit_bar as u32),
            exit_time: Some(candles[exit_bar].open_time),
            exit_price: Some(exit_price),
            reason,
            ambiguous,
            r: self.r_at(exit_price),
        }
    }

    /// Checks bars `next..=to` for a hit with [`resolve_iter`]; returns the closed trade.
    fn advance(&mut self, candles: &[Candle], to: usize) -> Option<Trade> {
        if self.next > to {
            return None;
        }
        let from = self.next;
        self.next = to + 1;
        let entry = Anchor {
            t: candles[from - 1].open_time,
            p: self.entry_price,
        };
        let end_t = candles[to].open_time;
        let out = resolve_iter(
            self.side,
            entry,
            self.stop,
            self.take,
            end_t,
            candles[from..=to].iter().copied(),
        );
        let exit_time = out.exit_time?;
        let bar = from + candles[from..=to].partition_point(|c| c.open_time < exit_time);
        // A bar that opens beyond the level (a gap) fills at its open, not at the level.
        let open = candles[bar].open;
        let long = self.side == Side::Long;
        let (price, reason) = match out.status {
            Status::Stop if long => (self.stop.min(open), ExitReason::Stop),
            Status::Stop => (self.stop.max(open), ExitReason::Stop),
            Status::Take if long => (self.take.max(open), ExitReason::Take),
            Status::Take => (self.take.min(open), ExitReason::Take),
            Status::Open => return None,
        };
        Some(self.finish(candles, bar, price, reason, out.ambiguous))
    }
}

/// Long: stop < price < take; short: take < price < stop.
fn check_levels(side: Side, price: i64, stop: i64, take: i64) -> Result<(), String> {
    for (name, v) in [("stop", stop), ("take", take)] {
        if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
            return Err(format!("{name} {v} is outside ±(2^53 - 1)"));
        }
    }
    match side {
        Side::Long if !(stop < price && price < take) => Err(format!(
            "a long trade needs stop < price < take (stop {stop}, price {price}, take {take})"
        )),
        Side::Short if !(take < price && price < stop) => Err(format!(
            "a short trade needs take < price < stop (take {take}, price {price}, stop {stop})"
        )),
        _ => Ok(()),
    }
}

/// Plays `commands` over `candles` (ascending by `open_time`) from bar `start` to bar
/// `current`. Commands must be in bar order, inside `start..=current`, and valid at the
/// close of their bar; the first one that is not is reported (numbered from 1).
///
/// Rules (ADR 0005): one trade at a time; open and close fill at the close of their bar;
/// stop and take are checked from the next bar on, like a position drawing, and fill at
/// their level, or at the bar's open when it opens beyond the level; an edit applies from
/// the next bar. Commands at a bar come after that bar's hit check.
pub fn simulate(
    candles: &[Candle],
    start: u32,
    current: u32,
    commands: &[Command],
) -> Result<Simulation, String> {
    let current_i = current as usize;
    if start > current || current_i >= candles.len() {
        return Err(format!(
            "start {start} and current {current} must satisfy start <= current < {} candles",
            candles.len()
        ));
    }
    if commands.len() > MAX_COMMANDS {
        return Err(format!(
            "at most {MAX_COMMANDS} commands, not {}",
            commands.len()
        ));
    }
    let mut trades = Vec::new();
    let mut open: Option<Running> = None;
    let mut last_bar = start;
    for (i, cmd) in commands.iter().enumerate() {
        let n = i + 1;
        let bar = cmd.bar();
        if bar < start || bar > current {
            return Err(format!(
                "command {n}: bar {bar} is outside the replay ({start}..={current})"
            ));
        }
        if bar < last_bar {
            return Err(format!(
                "command {n}: bar {bar} comes before bar {last_bar} of the previous command"
            ));
        }
        last_bar = bar;
        let b = bar as usize;
        if let Some(t) = open.as_mut()
            && let Some(done) = t.advance(candles, b)
        {
            trades.push(done);
            open = None;
        }
        let close = candles[b].close;
        match *cmd {
            Command::Open {
                side, stop, take, ..
            } => {
                if open.is_some() {
                    return Err(format!("command {n}: a trade is already open"));
                }
                check_levels(side, close, stop, take).map_err(|e| format!("command {n}: {e}"))?;
                open = Some(Running {
                    side,
                    entry_bar: bar,
                    entry_price: close,
                    initial_stop: stop,
                    stop,
                    take,
                    next: b + 1,
                });
            }
            Command::Edit { stop, take, .. } => {
                let Some(t) = open.as_mut() else {
                    return Err(format!("command {n}: no open trade to edit"));
                };
                if stop.is_none() && take.is_none() {
                    return Err(format!(
                        "command {n}: an edit must set the stop or the take"
                    ));
                }
                let (s, k) = (stop.unwrap_or(t.stop), take.unwrap_or(t.take));
                check_levels(t.side, close, s, k).map_err(|e| format!("command {n}: {e}"))?;
                t.stop = s;
                t.take = k;
            }
            Command::Close { .. } => {
                let Some(t) = open.take() else {
                    return Err(format!("command {n}: no open trade to close"));
                };
                trades.push(t.finish(candles, b, close, ExitReason::Manual, false));
            }
        }
    }
    if let Some(mut t) = open {
        match t.advance(candles, current_i) {
            Some(done) => trades.push(done),
            None => trades.push(Trade {
                side: t.side,
                entry_bar: t.entry_bar,
                entry_time: candles[t.entry_bar as usize].open_time,
                entry_price: t.entry_price,
                initial_stop: t.initial_stop,
                stop: t.stop,
                take: t.take,
                exit_bar: None,
                exit_time: None,
                exit_price: None,
                reason: ExitReason::Open,
                ambiguous: false,
                r: t.r_at(candles[current_i].close),
            }),
        }
    }
    let stats = stats(&trades);
    Ok(Simulation { trades, stats })
}

/// Statistics over the closed trades, summed in trade order.
pub fn stats(trades: &[Trade]) -> Stats {
    let (mut count, mut wins, mut losses) = (0u32, 0u32, 0u32);
    let (mut total, mut gross_win, mut gross_loss) = (0.0f64, 0.0f64, 0.0f64);
    let (mut peak, mut max_dd) = (0.0f64, 0.0f64);
    let (mut streak, mut longest) = (0u32, 0u32);
    for t in trades.iter().filter(|t| t.reason != ExitReason::Open) {
        count += 1;
        total += t.r;
        if t.r > 0.0 {
            wins += 1;
            gross_win += t.r;
            streak = 0;
        } else if t.r < 0.0 {
            losses += 1;
            gross_loss += t.r;
            streak += 1;
            longest = longest.max(streak);
        } else {
            streak = 0;
        }
        peak = peak.max(total);
        max_dd = max_dd.max(peak - total);
    }
    let ratio = |a: f64, b: u32| if b == 0 { 0.0 } else { a / f64::from(b) };
    Stats {
        count,
        wins,
        losses,
        win_rate: ratio(f64::from(wins), count),
        total_r: total,
        average_r: ratio(total, count),
        profit_factor: (losses > 0).then(|| gross_win / -gross_loss),
        max_drawdown_r: max_dd,
        longest_losing_streak: longest,
    }
}

/// Lowercase hex SHA-256 over the candles laid out as six little-endian `i64` each:
/// open time, open, high, low, close, volume, oldest first.
pub fn candle_hash(candles: &[Candle]) -> String {
    let mut h = Sha256::new();
    for c in candles {
        for v in [c.open_time, c.open, c.high, c.low, c.close, c.volume] {
            h.update(v.to_le_bytes());
        }
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A replay session as saved in a `.replay` file.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayFile {
    pub instrument: Instrument,
    pub timeframe: Timeframe,
    /// Context before `start`, then the bars up to `current`.
    pub candles: Vec<Candle>,
    /// Index of the first replayed bar.
    pub start: u32,
    /// Index of the last revealed bar.
    pub current: u32,
    pub commands: Vec<Command>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInstrument {
    source: String,
    symbol: String,
    base: String,
    quote: String,
    price_scale: u8,
    qty_scale: u8,
}

/// The version alone; every other value is skipped without being stored.
#[derive(Deserialize)]
struct Head {
    version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Body {
    #[allow(dead_code)]
    version: u32,
    instrument: FileInstrument,
    timeframe: String,
    start: u32,
    current: u32,
    sha256: String,
    #[serde(deserialize_with = "capped_commands")]
    commands: Vec<Command>,
    #[serde(deserialize_with = "capped_candles")]
    candles: Vec<[i64; 6]>,
}

/// A JSON array read into a `Vec` of at most `max` elements: the element after the cap
/// fails the file at once, so a hostile file cannot make it allocate more.
struct Capped<T> {
    max: usize,
    what: &'static str,
    item: std::marker::PhantomData<T>,
}

impl<T> Capped<T> {
    fn new(max: usize, what: &'static str) -> Self {
        Capped {
            max,
            what,
            item: std::marker::PhantomData,
        }
    }
}

impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Capped<T> {
    type Value = Vec<T>;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "an array of at most {} {}", self.max, self.what)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(self.max));
        while let Some(v) = seq.next_element()? {
            if out.len() == self.max {
                return Err(serde::de::Error::custom(format!(
                    "at most {} {}",
                    self.max, self.what
                )));
            }
            out.push(v);
        }
        Ok(out)
    }
}

fn capped_commands<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Command>, D::Error> {
    d.deserialize_seq(Capped::new(MAX_COMMANDS, "commands"))
}

fn capped_candles<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<[i64; 6]>, D::Error> {
    d.deserialize_seq(Capped::new(MAX_CANDLES, "candles"))
}

impl ReplayFile {
    /// The session with every price at `price_scale` and every volume at `qty_scale`
    /// decimals (rounded half away from zero); `None` when a value overflows. The result
    /// may break a rule after rounding: check its candles and simulate it again.
    pub fn rescaled(&self, price_scale: u8, qty_scale: u8) -> Option<ReplayFile> {
        let (pf, qf) = (self.instrument.price_scale, self.instrument.qty_scale);
        let px = |v: i64| rescale_ticks(v, pf, price_scale);
        let candles = self
            .candles
            .iter()
            .map(|c| {
                Some(Candle {
                    open_time: c.open_time,
                    open: px(c.open)?,
                    high: px(c.high)?,
                    low: px(c.low)?,
                    close: px(c.close)?,
                    volume: rescale_ticks(c.volume, qf, qty_scale)?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        // `Some(None)`: no level to move; `None`: it overflowed.
        let level = |v: Option<i64>| match v {
            None => Some(None),
            Some(x) => px(x).map(Some),
        };
        let commands = self
            .commands
            .iter()
            .map(|c| {
                Some(match *c {
                    Command::Open {
                        bar,
                        side,
                        stop,
                        take,
                    } => Command::Open {
                        bar,
                        side,
                        stop: px(stop)?,
                        take: px(take)?,
                    },
                    Command::Edit { bar, stop, take } => Command::Edit {
                        bar,
                        stop: level(stop)?,
                        take: level(take)?,
                    },
                    Command::Close { bar } => Command::Close { bar },
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let mut instrument = self.instrument.clone();
        instrument.price_scale = price_scale;
        instrument.qty_scale = qty_scale;
        Some(ReplayFile {
            instrument,
            candles,
            commands,
            ..self.clone()
        })
    }

    /// The file text: JSON with one command and one candle (`[time, open, high, low,
    /// close, volume]`) per line, so two files diff well.
    pub fn to_json(&self) -> String {
        let i = &self.instrument;
        let instrument = FileInstrument {
            source: i.id.source.clone(),
            symbol: i.id.symbol.clone(),
            base: i.base.clone(),
            quote: i.quote.clone(),
            price_scale: i.price_scale,
            qty_scale: i.qty_scale,
        };
        let lines = |items: Vec<String>| -> String {
            if items.is_empty() {
                "[]".into()
            } else {
                format!("[\n    {}\n  ]", items.join(",\n    "))
            }
        };
        let commands = lines(self.commands.iter().map(line).collect());
        let candles = lines(
            self.candles
                .iter()
                .map(|c| {
                    format!(
                        "[{}, {}, {}, {}, {}, {}]",
                        c.open_time, c.open, c.high, c.low, c.close, c.volume
                    )
                })
                .collect(),
        );
        format!(
            "{{\n  \"version\": {VERSION},\n  \"instrument\": {},\n  \"timeframe\": {},\n  \"start\": {},\n  \"current\": {},\n  \"sha256\": \"{}\",\n  \"commands\": {commands},\n  \"candles\": {candles}\n}}\n",
            line(&instrument),
            line(&self.timeframe.code()),
            self.start,
            self.current,
            candle_hash(&self.candles),
        )
    }

    /// Reads a file and checks everything: size, version, limits, candle order and range,
    /// the hash, and that the commands simulate. Returns the file and its simulation.
    pub fn from_json(bytes: &[u8]) -> Result<(ReplayFile, Simulation), String> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err(format!(
                "the replay file is {} MiB; the limit is {} MiB",
                bytes.len() / (1024 * 1024),
                MAX_FILE_BYTES / (1024 * 1024)
            ));
        }
        // A first pass reads only the version (it stores nothing else), so a newer file is
        // refused for its version rather than for a field this version does not know.
        let head: Head =
            serde_json::from_slice(bytes).map_err(|e| format!("not a replay file: {e}"))?;
        if head.version != VERSION {
            return Err(format!(
                "replay file version {} is not supported (this app reads version {VERSION})",
                head.version
            ));
        }
        let body: Body =
            serde_json::from_slice(bytes).map_err(|e| format!("not a replay file: {e}"))?;
        let timeframe = Timeframe::from_code(&body.timeframe)
            .ok_or_else(|| format!("unknown timeframe {:?}", body.timeframe))?;
        check_instrument(&body.instrument)?;
        let candles: Vec<Candle> = body
            .candles
            .iter()
            .map(|&[open_time, open, high, low, close, volume]| Candle {
                open_time,
                open,
                high,
                low,
                close,
                volume,
            })
            .collect();
        check_candles(&candles)?;
        if candle_hash(&candles) != body.sha256 {
            return Err("the candles do not match the file's sha256".into());
        }
        let sim = simulate(&candles, body.start, body.current, &body.commands)?;
        let i = body.instrument;
        let file = ReplayFile {
            instrument: Instrument {
                id: InstrumentId {
                    source: i.source,
                    symbol: i.symbol,
                },
                base: i.base,
                quote: i.quote,
                price_scale: i.price_scale,
                qty_scale: i.qty_scale,
            },
            timeframe,
            candles,
            start: body.start,
            current: body.current,
            commands: body.commands,
        };
        Ok((file, sim))
    }
}

/// Strictly ascending open times, every number inside ±(2^53 - 1), low ≤ open, close ≤ high
/// and a volume that is not negative.
pub fn check_candles(candles: &[Candle]) -> Result<(), String> {
    for (i, c) in candles.iter().enumerate() {
        for v in [c.open_time, c.open, c.high, c.low, c.close, c.volume] {
            if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
                return Err(format!("candle {i}: {v} is outside ±(2^53 - 1)"));
            }
        }
        if c.low > c.open.min(c.close) {
            return Err(format!(
                "candle {i}: low must be at most the open and the close"
            ));
        }
        if c.high < c.open.max(c.close) {
            return Err(format!(
                "candle {i}: high must be at least the open and the close"
            ));
        }
        if c.volume < 0 {
            return Err(format!("candle {i}: volume must not be negative"));
        }
        if i > 0 && candles[i - 1].open_time >= c.open_time {
            return Err(format!("candle {i}: open times must go up"));
        }
    }
    Ok(())
}

/// A file's instrument is only as trusted as the file: scales the tick maths can use, and
/// names of the length and characters the providers give.
fn check_instrument(i: &FileInstrument) -> Result<(), String> {
    for (what, v) in [("price", i.price_scale), ("quantity", i.qty_scale)] {
        if v > MAX_SCALE {
            return Err(format!(
                "the instrument's {what} scale {v} is above {MAX_SCALE}"
            ));
        }
    }
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= MAX_NAME_BYTES
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    for (what, v) in [
        ("source", &i.source),
        ("symbol", &i.symbol),
        ("base", &i.base),
        ("quote", &i.quote),
    ] {
        if !ok(v) {
            return Err(format!(
                "the instrument's {what} must be 1 to {MAX_NAME_BYTES} characters from A-Z, a-z, 0-9, ., _ and -"
            ));
        }
    }
    Ok(())
}

/// One-line JSON, for [`ReplayFile::to_json`].
fn line<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("plain data always serialises")
}

#[cfg(test)]
mod tests {
    use serde::Deserializer as _;

    use super::Capped;

    #[test]
    fn capped_stops_at_the_first_element_past_the_cap() {
        // Elements past the cap are never read: the broken tail would be a syntax error.
        let mut de = serde_json::Deserializer::from_str("[1, 2, 3, 4, ???");
        let err = de
            .deserialize_seq(Capped::<i64>::new(3, "numbers"))
            .unwrap_err();
        assert!(err.to_string().starts_with("at most 3 numbers"), "{err}");
        let mut ok = serde_json::Deserializer::from_str("[1, 2, 3]");
        assert_eq!(
            ok.deserialize_seq(Capped::<i64>::new(3, "numbers"))
                .unwrap(),
            vec![1, 2, 3]
        );
    }
}
