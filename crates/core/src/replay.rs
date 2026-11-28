//! Replay: paper trades over historical candles, their results and the `.replay` file.
//!
//! A session is base candles (context before the start, then the candles revealed one by
//! one up to the cut, maybe more after it) and the trade commands the user gave. The cut
//! is a time: the close time of the last revealed base candle. Commands carry the cut they
//! were given at, so results depend on the base candles only, never on the timeframe the
//! chart shows. [`simulate`] turns them into trades and [`Stats`]; nothing else computes
//! results, so a file gives the same numbers everywhere. See ADR 0005 and ADR 0008.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::decimal::JS_SAFE_MAX;
use crate::drawing::{Anchor, rescale_ticks};
use crate::model::{Candle, Instrument, InstrumentId};
use crate::position::{Side, Status, resolve_iter};
use crate::timeframe::Timeframe;

/// The file version this code writes. Version 1 files are read too.
pub const VERSION: u32 = 2;
pub const MAX_CANDLES: usize = 200_000;
pub const MAX_COMMANDS: usize = 10_000;
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
/// Largest price or quantity scale a file may carry: 10^18 is the largest power of ten
/// in an `i64`, so ticks can still be rescaled.
pub const MAX_SCALE: u8 = 18;
/// Longest source, symbol, base or quote of a file's instrument.
pub const MAX_NAME_BYTES: usize = 64;

/// What the user did at a cut. `time` is that cut: the close time of the last revealed
/// base candle when the command was given. JSON is `{ "kind": "open", ... }` with camelCase
/// fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    /// A market trade, filled at the close of the base candle that closes at `time`.
    Open {
        time: i64,
        side: Side,
        stop: i64,
        take: i64,
    },
    /// New stop and/or take, in force from the base candle after `time`.
    Edit {
        time: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        take: Option<i64>,
    },
    /// Closes the open trade at the close of the base candle that closes at `time`.
    Close { time: i64 },
}

impl Command {
    pub fn time(&self) -> i64 {
        match *self {
            Command::Open { time, .. } | Command::Edit { time, .. } | Command::Close { time } => {
                time
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Take,
    Stop,
    Manual,
    /// Still open at the cut.
    Open,
    /// Still open when the replay caught up with real time, where the backtest ends
    /// (ADR 0008, decision 9). Like an open trade it has no exit and does not count in the
    /// statistics.
    Unfinished,
}

impl ExitReason {
    /// Take, stop or manual: the trade has an exit and counts in the statistics.
    pub fn is_closed(self) -> bool {
        !matches!(self, ExitReason::Open | ExitReason::Unfinished)
    }
}

/// One trade. Prices are ticks; times are the open times of the base candles it filled on,
/// so a chart of any timeframe puts them in the bar that contains them. An open trade has
/// no exit and its `r` is marked to the close of the base candle at the cut.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub side: Side,
    pub entry_time: i64,
    pub entry_price: i64,
    /// The stop at entry; R is measured against it.
    pub initial_stop: i64,
    /// The levels in force at the exit (or now, while open).
    pub stop: i64,
    pub take: i64,
    pub exit_time: Option<i64>,
    pub exit_price: Option<i64>,
    pub reason: ExitReason,
    /// The exit candle touched both stop and take; it counts as a stop.
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

impl Simulation {
    /// The backtest ended at real time: the trade still open there is unfinished. The
    /// statistics do not change, since an open trade never counted in them.
    pub fn at_real_time(mut self) -> Simulation {
        if let Some(t) = self.trades.last_mut()
            && t.reason == ExitReason::Open
        {
            t.reason = ExitReason::Unfinished;
        }
        self
    }
}

/// The base candles revealed at `cut`: those that close at or before it.
pub fn revealed(base: Timeframe, candles: &[Candle], cut: i64) -> &[Candle] {
    &candles[..candles.partition_point(|c| base.close_time(c.open_time) <= cut)]
}

/// Index of the base candle that closes exactly at `t`.
fn closing_at(base: Timeframe, candles: &[Candle], t: i64) -> Option<usize> {
    let i = candles.partition_point(|c| base.close_time(c.open_time) < t);
    candles
        .get(i)
        .filter(|c| base.close_time(c.open_time) == t)
        .map(|_| i)
}

struct Running {
    side: Side,
    /// Index of the candle the trade was filled on.
    entry: usize,
    entry_price: i64,
    initial_stop: i64,
    stop: i64,
    take: i64,
    /// The first candle not yet checked for a hit.
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

    fn trade(&self, candles: &[Candle], exit: Option<(usize, i64)>, reason: ExitReason) -> Trade {
        Trade {
            side: self.side,
            entry_time: candles[self.entry].open_time,
            entry_price: self.entry_price,
            initial_stop: self.initial_stop,
            stop: self.stop,
            take: self.take,
            exit_time: exit.map(|(i, _)| candles[i].open_time),
            exit_price: exit.map(|(_, p)| p),
            reason,
            ambiguous: false,
            r: 0.0,
        }
    }

    fn finish(
        &self,
        candles: &[Candle],
        exit: usize,
        exit_price: i64,
        reason: ExitReason,
        ambiguous: bool,
    ) -> Trade {
        Trade {
            ambiguous,
            r: self.r_at(exit_price),
            ..self.trade(candles, Some((exit, exit_price)), reason)
        }
    }

    /// Checks candles `next..=to` for a hit with [`resolve_iter`]; returns the closed trade.
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
        let at = from + candles[from..=to].partition_point(|c| c.open_time < exit_time);
        // A candle that opens beyond the level (a gap) fills at its open, not at the level.
        let open = candles[at].open;
        let long = self.side == Side::Long;
        let (price, reason) = match out.status {
            Status::Stop if long => (self.stop.min(open), ExitReason::Stop),
            Status::Stop => (self.stop.max(open), ExitReason::Stop),
            Status::Take if long => (self.take.max(open), ExitReason::Take),
            Status::Take => (self.take.min(open), ExitReason::Take),
            Status::Open => return None,
        };
        Some(self.finish(candles, at, price, reason, out.ambiguous))
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

/// Plays `commands` over the `base` candles (ascending by `open_time`) from the cut
/// `start` (when the replay began) to the cut `cut`; candles after the cut are not read.
/// Both cuts and every command time must be the close time of a candle
/// ([`Timeframe::close_time`]). Commands must be in time order, inside `start..=cut`, and
/// valid at the close of their candle; the first one that is not is reported (numbered
/// from 1).
///
/// Rules (ADR 0005, ADR 0008): one trade at a time; open and close fill at the close of
/// the candle ending at their time; stop and take are checked on the candles after it,
/// like a position drawing, and fill at their level, or at the candle's open when it opens
/// beyond the level; an edit applies from the next candle. Commands at a time come after
/// that candle's hit check.
pub fn simulate(
    base: Timeframe,
    candles: &[Candle],
    start: i64,
    cut: i64,
    commands: &[Command],
) -> Result<Simulation, String> {
    if start > cut {
        return Err(format!("the start {start} is after the cut {cut}"));
    }
    if closing_at(base, candles, start).is_none() {
        return Err(format!(
            "the start {start} is not the close time of a candle"
        ));
    }
    let Some(cut_i) = closing_at(base, candles, cut) else {
        return Err(format!("the cut {cut} is not the close time of a candle"));
    };
    if commands.len() > MAX_COMMANDS {
        return Err(format!(
            "at most {MAX_COMMANDS} commands, not {}",
            commands.len()
        ));
    }
    let mut trades = Vec::new();
    let mut open: Option<Running> = None;
    let mut last = start;
    for (i, cmd) in commands.iter().enumerate() {
        let n = i + 1;
        let t = cmd.time();
        if t < start || t > cut {
            return Err(format!(
                "command {n}: time {t} is outside the replay ({start}..={cut})"
            ));
        }
        if t < last {
            return Err(format!(
                "command {n}: time {t} comes before time {last} of the previous command"
            ));
        }
        last = t;
        let Some(b) = closing_at(base, candles, t) else {
            return Err(format!(
                "command {n}: time {t} is not the close time of a candle"
            ));
        };
        if let Some(r) = open.as_mut()
            && let Some(done) = r.advance(candles, b)
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
                    entry: b,
                    entry_price: close,
                    initial_stop: stop,
                    stop,
                    take,
                    next: b + 1,
                });
            }
            Command::Edit { stop, take, .. } => {
                let Some(r) = open.as_mut() else {
                    return Err(format!("command {n}: no open trade to edit"));
                };
                if stop.is_none() && take.is_none() {
                    return Err(format!(
                        "command {n}: an edit must set the stop or the take"
                    ));
                }
                let (s, k) = (stop.unwrap_or(r.stop), take.unwrap_or(r.take));
                check_levels(r.side, close, s, k).map_err(|e| format!("command {n}: {e}"))?;
                r.stop = s;
                r.take = k;
            }
            Command::Close { .. } => {
                let Some(r) = open.take() else {
                    return Err(format!("command {n}: no open trade to close"));
                };
                trades.push(r.finish(candles, b, close, ExitReason::Manual, false));
            }
        }
    }
    if let Some(mut r) = open {
        match r.advance(candles, cut_i) {
            Some(done) => trades.push(done),
            None => trades.push(Trade {
                r: r.r_at(candles[cut_i].close),
                ..r.trade(candles, None, ExitReason::Open)
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
    for t in trades.iter().filter(|t| t.reason.is_closed()) {
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
    /// The step resolution: the timeframe of `candles`.
    pub base: Timeframe,
    /// Context before the start, the candles up to the cut, and maybe later ones.
    pub candles: Vec<Candle>,
    /// The cut when the replay began.
    pub start: i64,
    /// The close time of the last revealed candle.
    pub cut: i64,
    pub commands: Vec<Command>,
    /// The cut at which the replay caught up with real time, where its backtest ended;
    /// equal to `cut`, and no candle comes after it. `None` for a replay that had not.
    pub caught_up_at: Option<i64>,
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
    base: String,
    start: i64,
    cut: i64,
    #[serde(default)]
    caught_up_at: Option<i64>,
    sha256: String,
    #[serde(deserialize_with = "capped_commands")]
    commands: Vec<Command>,
    #[serde(deserialize_with = "capped_candles")]
    candles: Vec<[i64; 6]>,
}

/// A version 1 file: indices into the candles of the chart's timeframe.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BodyV1 {
    #[allow(dead_code)]
    version: u32,
    instrument: FileInstrument,
    timeframe: String,
    start: u32,
    current: u32,
    sha256: String,
    #[serde(deserialize_with = "capped_commands_v1")]
    commands: Vec<CommandV1>,
    #[serde(deserialize_with = "capped_candles")]
    candles: Vec<[i64; 6]>,
}

/// A version 1 command: `bar` indexes the file's candles.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandV1 {
    Open {
        bar: u32,
        side: Side,
        stop: i64,
        take: i64,
    },
    Edit {
        bar: u32,
        #[serde(default)]
        stop: Option<i64>,
        #[serde(default)]
        take: Option<i64>,
    },
    Close {
        bar: u32,
    },
}

impl CommandV1 {
    fn bar(&self) -> u32 {
        match *self {
            CommandV1::Open { bar, .. }
            | CommandV1::Edit { bar, .. }
            | CommandV1::Close { bar } => bar,
        }
    }

    fn at(self, time: i64) -> Command {
        match self {
            CommandV1::Open {
                side, stop, take, ..
            } => Command::Open {
                time,
                side,
                stop,
                take,
            },
            CommandV1::Edit { stop, take, .. } => Command::Edit { time, stop, take },
            CommandV1::Close { .. } => Command::Close { time },
        }
    }
}

/// A version 1 session in times: each bar index becomes that bar's close time on the
/// file's timeframe, which is the base. Indices must satisfy the version 1 rules.
fn from_v1(
    tf: Timeframe,
    candles: &[Candle],
    start: u32,
    current: u32,
    commands: &[CommandV1],
) -> Result<(i64, i64, Vec<Command>), String> {
    if start > current || current as usize >= candles.len() {
        return Err(format!(
            "start {start} and current {current} must satisfy start <= current < {} candles",
            candles.len()
        ));
    }
    let close = |bar: u32| tf.close_time(candles[bar as usize].open_time);
    let commands = commands
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let bar = c.bar();
            if bar < start || bar > current {
                return Err(format!(
                    "command {}: bar {bar} is outside the replay ({start}..={current})",
                    i + 1
                ));
            }
            Ok(c.at(close(bar)))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((close(start), close(current), commands))
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

fn capped_commands_v1<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<CommandV1>, D::Error> {
    d.deserialize_seq(Capped::new(MAX_COMMANDS, "commands"))
}

fn capped_candles<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<[i64; 6]>, D::Error> {
    d.deserialize_seq(Capped::new(MAX_CANDLES, "candles"))
}

/// The parts every file version has, checked: instrument, candles of `base` and their hash.
fn checked(
    base: Timeframe,
    instrument: FileInstrument,
    rows: &[[i64; 6]],
    sha256: &str,
) -> Result<(Instrument, Vec<Candle>), String> {
    check_instrument(&instrument)?;
    let candles: Vec<Candle> = rows
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
    check_candles(base, &candles)?;
    if candle_hash(&candles) != sha256 {
        return Err("the candles do not match the file's sha256".into());
    }
    let i = instrument;
    let instrument = Instrument {
        id: InstrumentId {
            source: i.source,
            symbol: i.symbol,
        },
        base: i.base,
        quote: i.quote,
        price_scale: i.price_scale,
        qty_scale: i.qty_scale,
    };
    Ok((instrument, candles))
}

fn timeframe(code: &str) -> Result<Timeframe, String> {
    Timeframe::from_code(code).ok_or_else(|| format!("unknown timeframe {code:?}"))
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
                        time,
                        side,
                        stop,
                        take,
                    } => Command::Open {
                        time,
                        side,
                        stop: px(stop)?,
                        take: px(take)?,
                    },
                    Command::Edit { time, stop, take } => Command::Edit {
                        time,
                        stop: level(stop)?,
                        take: level(take)?,
                    },
                    Command::Close { time } => Command::Close { time },
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

    /// [`simulate`] over this file's session; a session that caught up ended its backtest
    /// there ([`Simulation::at_real_time`]).
    pub fn simulate(&self) -> Result<Simulation, String> {
        if let Some(t) = self.caught_up_at {
            if t != self.cut {
                return Err(format!(
                    "the replay caught up at {t}, which is not its cut {}",
                    self.cut
                ));
            }
            if revealed(self.base, &self.candles, self.cut).len() != self.candles.len() {
                return Err("a replay that caught up has no candle after its cut".into());
            }
        }
        let sim = simulate(
            self.base,
            &self.candles,
            self.start,
            self.cut,
            &self.commands,
        )?;
        Ok(if self.caught_up_at.is_some() {
            sim.at_real_time()
        } else {
            sim
        })
    }

    /// The file text, always the current [`VERSION`]: JSON with one command and one candle
    /// (`[time, open, high, low, close, volume]`) per line, so two files diff well.
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
        let caught_up = self
            .caught_up_at
            .map_or(String::new(), |t| format!("  \"caughtUpAt\": {t},\n"));
        format!(
            "{{\n  \"version\": {VERSION},\n  \"instrument\": {},\n  \"base\": {},\n  \"start\": {},\n  \"cut\": {},\n{caught_up}  \"sha256\": \"{}\",\n  \"commands\": {commands},\n  \"candles\": {candles}\n}}\n",
            line(&instrument),
            line(&self.base.code()),
            self.start,
            self.cut,
            candle_hash(&self.candles),
        )
    }

    /// Reads a file of version 1 or 2 and checks everything: size, version, limits, candle
    /// order and range, the hash, and that the commands simulate. A version 1 file comes
    /// back in times ([`from_v1`]), so saving it again writes version 2. Returns the file
    /// and its simulation.
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
        let not_a_file = |e: serde_json::Error| format!("not a replay file: {e}");
        let file = match head.version {
            1 => {
                let body: BodyV1 = serde_json::from_slice(bytes).map_err(not_a_file)?;
                let base = timeframe(&body.timeframe)?;
                let (instrument, candles) =
                    checked(base, body.instrument, &body.candles, &body.sha256)?;
                let (start, cut, commands) =
                    from_v1(base, &candles, body.start, body.current, &body.commands)?;
                ReplayFile {
                    instrument,
                    base,
                    candles,
                    start,
                    cut,
                    commands,
                    caught_up_at: None,
                }
            }
            VERSION => {
                let body: Body = serde_json::from_slice(bytes).map_err(not_a_file)?;
                let base = timeframe(&body.base)?;
                let (instrument, candles) =
                    checked(base, body.instrument, &body.candles, &body.sha256)?;
                ReplayFile {
                    instrument,
                    base,
                    candles,
                    start: body.start,
                    cut: body.cut,
                    commands: body.commands,
                    caught_up_at: body.caught_up_at,
                }
            }
            v => {
                return Err(format!(
                    "replay file version {v} is not supported (this app reads versions 1 and {VERSION})"
                ));
            }
        };
        let sim = file.simulate()?;
        Ok((file, sim))
    }
}

/// Candles of the `base` timeframe as a file may hold them: every number and every close time
/// inside ±(2^53 - 1) (so a start, cut or catch-up time, each a close time, is too), each
/// opening on a `base` bucket boundary, strictly ascending open times (on the grid that also
/// rules out overlaps), low ≤ open, close ≤ high and a volume that is not negative.
pub fn check_candles(base: Timeframe, candles: &[Candle]) -> Result<(), String> {
    for (i, c) in candles.iter().enumerate() {
        for v in [c.open_time, c.open, c.high, c.low, c.close, c.volume] {
            if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
                return Err(format!("candle {i}: {v} is outside ±(2^53 - 1)"));
            }
        }
        let closes = base.close_time(c.open_time);
        if closes > JS_SAFE_MAX {
            return Err(format!(
                "candle {i}: its close time {closes} is outside ±(2^53 - 1)"
            ));
        }
        if base.bucket_start(c.open_time) != c.open_time {
            return Err(format!(
                "candle {i}: open time {} is not on the {} grid",
                c.open_time,
                base.code()
            ));
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
