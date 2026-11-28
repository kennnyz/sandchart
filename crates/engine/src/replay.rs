//! The replay session (ADR 0005, ADR 0008): one at a time, over base candles held in
//! memory. The session steps its base timeframe; the cut is the close time of the last
//! revealed base candle. Charts of any timeframe that builds from the base are aggregated
//! from the revealed base candles, so nothing after the cut ever leaves the engine.
//!
//! A session started from the cache reads newer candles when its steps reach the last
//! loaded one (the store, else the provider). When none is left it has caught up with real
//! time and its backtest ends there: it takes no more steps or commands, the trade still
//! open is unfinished, and it stops holding the pair's live updates back, so the chart shows
//! live data again while the session stays at its cut.

use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, MutexGuard, PoisonError};

use crate::chart::fetch_window;
use crate::{Engine, EngineError, Shared, blocking, lock};
use sandchart_core::aggregate::aggregate;
use sandchart_core::replay::{
    Command, ExitReason, MAX_CANDLES, ReplayFile, Simulation, Stats, Trade, check_candles,
    revealed, simulate,
};
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};

/// Base candles shown before the start, for context.
pub const REPLAY_CONTEXT: usize = 500;
/// Most base candles of context a re-base to a lower timeframe loads before the start
/// (ADR 0008): the old context's time span when it fits, else its newest part.
pub const REBASE_CONTEXT: usize = 5_000;

const DAY_MS: i64 = 86_400_000;

pub(crate) struct Session {
    /// Unique per session and per re-base in this process, so indicator results computed
    /// over other candles never mix.
    id: u64,
    instrument: Instrument,
    /// The step resolution: the timeframe of `candles`.
    base: Timeframe,
    /// Closed base candles: context, the revealed ones up to the cut, maybe later ones.
    /// Shared, so readers take it out of the lock (`replay_bars`) instead of working under it.
    candles: Arc<Vec<Candle>>,
    /// The cut when the replay began.
    start: i64,
    /// The close time of the last revealed base candle.
    cut: i64,
    commands: Vec<Command>,
    /// The simulation of `commands` up to the cut, until a step or a command changes it.
    sim: Option<Simulation>,
    /// Started from the cache of a pair with a provider: it reads newer candles and can
    /// catch up. A file's session (or a CSV pair's) ends at its last candle.
    live: bool,
    /// The cut at which the session caught up with real time and its backtest ended (for
    /// a file, the one it was saved with). The cut never moves past it.
    caught_up_at: Option<i64>,
}

/// What the UI gets for one chart timeframe `tf` (the base or one that builds from it):
/// the revealed bars of `tf` from index `from` on, never one with data after the cut, and
/// the trades from `trades_from` on (closed trades never change, so the UI keeps those it
/// has; the open trade, always the last, always comes).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayState {
    pub instrument: Instrument,
    /// The step resolution.
    pub base: Timeframe,
    /// The timeframe of `bars`.
    pub tf: Timeframe,
    /// Index of the `tf` bar that holds the first replayed base candle.
    pub start: u32,
    /// Index of the last revealed `tf` bar.
    pub current: u32,
    /// The close time of the last revealed base candle. Commands carry it as their time.
    pub cut: i64,
    /// No base candle is left to reveal, and no newer one can be loaded (a file's end, a
    /// pair without a provider, the candle limit, or caught up).
    pub at_end: bool,
    /// The replay reached the newest data in this session: the pair's live data flows
    /// again (for display), and no step and no command is taken.
    pub caught_up: bool,
    /// The cut at which the backtest ended at real time (also for a file saved after
    /// catching up); the trade still open there is unfinished.
    pub caught_up_at: Option<i64>,
    /// The last `tf` bar is still forming: more base candles go into it.
    pub partial: bool,
    /// Index of `bars[0]`.
    pub from: u32,
    pub bars: Vec<Candle>,
    /// Index of `trades[0]` among all the trades.
    pub trades_from: u32,
    pub trades: Vec<Trade>,
    pub stats: Stats,
}

/// A snapshot of the open replay's revealed bars of one timeframe, taken by
/// [`crate::Shared::replay_bars`].
pub(crate) struct ReplayBars {
    pub instrument: Instrument,
    pub session: u64,
    /// The snapshot's content is fixed by `(session, cut)`.
    pub cut: i64,
    base: Timeframe,
    tf: Timeframe,
    candles: Arc<Vec<Candle>>,
    /// How many base candles are revealed.
    len: usize,
}

impl ReplayBars {
    /// The revealed bars of the snapshot's timeframe; aggregation runs here, off the lock.
    pub fn revealed(&self) -> Cow<'_, [Candle]> {
        bars_of(&self.candles[..self.len], self.base, self.tf)
    }
}

/// `tf` bars from revealed base candles; `tf` was checked with [`check_view`].
fn bars_of(shown: &[Candle], base: Timeframe, tf: Timeframe) -> Cow<'_, [Candle]> {
    if tf == base {
        Cow::Borrowed(shown)
    } else {
        Cow::Owned(aggregate(shown, base, tf).unwrap_or_default())
    }
}

/// Whether a replay stepping `base` can show `tf`.
fn check_view(base: Timeframe, tf: Timeframe) -> Result<(), EngineError> {
    if tf.builds_from(base) {
        return Ok(());
    }
    let (b, t) = (base.code(), tf.code());
    Err(EngineError::Replay(if base.builds_from(tf) {
        format!(
            "the replay steps {b} candles, so {t} candles cannot be built from them; re-base it to {t} first"
        )
    } else {
        format!("{t} candles cannot be built from {b} candles")
    }))
}

fn next_session_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn no_session() -> EngineError {
    EngineError::Replay("no replay is open".into())
}

fn caught_up_error(what: &str) -> EngineError {
    EngineError::Replay(format!(
        "the replay has caught up with real time, so its backtest is finished: it takes no {what}"
    ))
}

/// Keeps the leading candles of `candles` that are closed at `now`.
fn closed_by(candles: &mut Vec<Candle>, tf: Timeframe, now: i64) {
    let n = candles.partition_point(|c| tf.close_time(c.open_time) <= now);
    candles.truncate(n);
}

impl Session {
    fn revealed_len(&self) -> usize {
        revealed(self.base, &self.candles, self.cut).len()
    }

    fn simulate(&self, commands: &[Command]) -> Result<Simulation, EngineError> {
        let sim = simulate(self.base, &self.candles, self.start, self.cut, commands)
            .map_err(EngineError::Replay)?;
        Ok(if self.caught_up_at.is_some() {
            sim.at_real_time()
        } else {
            sim
        })
    }

    /// Caught up with real time in this run: the pair's live data is no longer held back.
    fn caught_up(&self) -> bool {
        self.live && self.caught_up_at.is_some()
    }

    /// Every loaded candle is revealed and newer ones may still be loaded.
    fn wants_more(&self) -> bool {
        self.live
            && self.caught_up_at.is_none()
            && self.candles.len() < MAX_CANDLES
            && self.revealed_len() == self.candles.len()
    }

    fn state(
        &mut self,
        tf: Timeframe,
        cursor: u32,
        trades_from: u32,
    ) -> Result<ReplayState, EngineError> {
        check_view(self.base, tf)?;
        let sim = match self.sim.take() {
            Some(sim) => sim,
            None => self.simulate(&self.commands)?,
        };
        let shown = revealed(self.base, &self.candles, self.cut);
        let bars = bars_of(shown, self.base, tf);
        // The base candle that closes at the start (the session simulated, so it exists).
        let first = revealed(self.base, &self.candles, self.start)
            .last()
            .map_or(i64::MIN, |c| c.open_time);
        let key = if tf == self.base {
            first
        } else {
            tf.bucket_start(first)
        };
        let start = bars
            .partition_point(|b| b.open_time <= key)
            .saturating_sub(1);
        let partial = tf != self.base
            && bars
                .last()
                .is_some_and(|b| tf.bucket_end(b.open_time) > self.cut);
        let from = (cursor as usize).min(bars.len());
        let open = sim
            .trades
            .last()
            .is_some_and(|t| t.reason == ExitReason::Open);
        let closed = sim.trades.len() - usize::from(open);
        let tfrom = (trades_from as usize).min(closed);
        let st = ReplayState {
            instrument: self.instrument.clone(),
            base: self.base,
            tf,
            start: start as u32,
            current: bars.len().saturating_sub(1) as u32,
            cut: self.cut,
            at_end: shown.len() == self.candles.len() && !self.wants_more(),
            caught_up: self.caught_up(),
            caught_up_at: self.caught_up_at,
            partial,
            from: from as u32,
            bars: bars[from..].to_vec(),
            trades_from: tfrom as u32,
            trades: sim.trades[tfrom..].to_vec(),
            stats: sim.stats,
        };
        self.sim = Some(sim);
        Ok(st)
    }

    /// Adds base candles newer than the last one (a candle with its open time replaces it)
    /// up to the limit.
    fn append(&mut self, candles: &[Candle]) {
        let mut changed = false;
        for c in candles {
            let last = self.candles.last().copied();
            match last {
                Some(l) if l.open_time > c.open_time || l == *c => {}
                Some(l) if l.open_time == c.open_time => {
                    *Arc::make_mut(&mut self.candles)
                        .last_mut()
                        .expect("a last candle") = *c;
                    changed = true;
                }
                _ if self.candles.len() >= MAX_CANDLES => break,
                _ => {
                    Arc::make_mut(&mut self.candles).push(*c);
                    changed = true;
                }
            }
        }
        if changed {
            self.sim = None;
        }
    }
}

impl Shared {
    fn session(&self) -> MutexGuard<'_, Option<Session>> {
        self.replay.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The revealed bars of `tf` of the open replay, if it replays `id` and holds its live
    /// data back (not caught up). Indicators and position outcomes read these instead of
    /// the cache, so they never see data after the cut (ADR 0005, decision 5). A `tf` that
    /// cannot be built from the base is an error, never the cache. Only an `Arc` is cloned
    /// under the lock; the work on the bars runs without it, so a step never waits for it.
    pub(crate) fn replay_bars(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<Option<ReplayBars>, EngineError> {
        let guard = self.session();
        let Some(s) = guard
            .as_ref()
            .filter(|s| s.instrument.id == *id && !s.caught_up())
        else {
            return Ok(None);
        };
        check_view(s.base, tf)?;
        Ok(Some(ReplayBars {
            instrument: s.instrument.clone(),
            session: s.id,
            cut: s.cut,
            base: s.base,
            tf,
            candles: Arc::clone(&s.candles),
            len: s.revealed_len(),
        }))
    }

    /// Live events of this instrument are held back while it is replayed, until the replay
    /// has caught up with them.
    pub(crate) fn replaying(&self, id: &InstrumentId) -> bool {
        self.session()
            .as_ref()
            .is_some_and(|s| s.instrument.id == *id && !s.caught_up())
    }
}

/// What a re-base works from, copied out of the lock.
struct Snapshot {
    id: u64,
    instrument: Instrument,
    base: Timeframe,
    candles: Arc<Vec<Candle>>,
    start: i64,
    cut: i64,
    commands: Vec<Command>,
    live: bool,
}

impl Engine {
    fn with_session<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        f(self.shared.session().as_mut().ok_or_else(no_session)?)
    }

    /// Starts a replay stepping `base` at the cached candle that opens at `start_time`,
    /// with up to [`REPLAY_CONTEXT`] candles before it and every closed cached candle after
    /// it (within the file limit). Replaces any open replay. Returns the state of `base`
    /// with every revealed bar; a start at the newest candle has caught up at once.
    pub async fn replay_start(
        &self,
        id: &InstrumentId,
        base: Timeframe,
        start_time: i64,
    ) -> Result<ReplayState, EngineError> {
        let key = id.clone();
        let (instrument, context, mut rest) = blocking(&self.shared.store, move |s| {
            let instrument = s.instrument(&key)?;
            let context = s.candles_before(&key, base, Some(start_time), REPLAY_CONTEXT)?;
            let room = MAX_CANDLES - context.len();
            let rest =
                s.scan_candles_between(&key, base, start_time.saturating_sub(1), i64::MAX, |it| {
                    it.take(room).collect::<Vec<_>>()
                })?;
            Ok((instrument, context, rest))
        })
        .await?;
        let instrument = instrument.ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        // The newest cached candle may have been stored while it was still forming.
        closed_by(&mut rest, base, self.now_ms());
        let Some(first) = rest.first().filter(|c| c.open_time == start_time) else {
            return Err(EngineError::Replay(format!(
                "no cached {} bar opens at {start_time}",
                base.code()
            )));
        };
        let start = base.close_time(first.open_time);
        let mut candles = context;
        candles.extend(rest);
        let session = Session {
            id: next_session_id(),
            live: self.provider(&id.source).is_some(),
            instrument,
            base,
            candles: Arc::new(candles),
            start,
            cut: start,
            commands: Vec::new(),
            sim: None,
            caught_up_at: None,
        };
        *self.shared.session() = Some(session);
        // The newest data could not be asked for: a later step asks again.
        if let Err(e) = self.load_newer().await {
            eprintln!("the replay could not load newer candles: {e}");
        }
        self.replay_state(base, 0, 0)
    }

    /// Reveals up to `n` more base candles; returns the cut. Once every loaded candle is
    /// revealed it loads newer ones; with none left the replay has caught up. Refused once
    /// caught up (or for a file saved after catching up). A failure to load newer candles is returned after the step: stepping
    /// again tries again.
    pub async fn replay_step(&self, n: u32) -> Result<i64, EngineError> {
        let cut = self.with_session(|s| {
            if s.caught_up_at.is_some() {
                return Err(caught_up_error("steps"));
            }
            let shown = s.revealed_len();
            let next = shown.saturating_add(n as usize).min(s.candles.len());
            if next > shown {
                s.cut = s.base.close_time(s.candles[next - 1].open_time);
                s.sim = None;
            }
            Ok(s.cut)
        })?;
        self.load_newer().await?;
        Ok(cut)
    }

    /// When a session from the cache has revealed every loaded candle: loads the newer
    /// closed base candles, or, when there are none, marks it caught up at its cut.
    async fn load_newer(&self) -> Result<(), EngineError> {
        let Some((sid, inst, base, last, room)) = self.with_session(|s| {
            Ok(s.wants_more().then(|| {
                let last = s.candles.last().map_or(i64::MIN, |c| c.open_time);
                (
                    s.id,
                    s.instrument.clone(),
                    s.base,
                    last,
                    MAX_CANDLES - s.candles.len(),
                )
            }))
        })?
        else {
            return Ok(());
        };
        let newer = self.newer_candles(&inst, base, last, room).await?;
        let mut guard = self.shared.session();
        let Some(s) = guard.as_mut().filter(|s| s.id == sid && s.wants_more()) else {
            return Ok(()); // replaced or changed meanwhile
        };
        if newer.is_empty() {
            s.caught_up_at = Some(s.cut);
            s.sim = None;
        } else {
            s.append(&newer);
        }
        Ok(())
    }

    /// Closed base candles after the one opening at `last`, at most `room`: the cached
    /// ones when they follow it without a gap, else the provider's (kept in memory only).
    async fn newer_candles(
        &self,
        inst: &Instrument,
        base: Timeframe,
        last: i64,
        room: usize,
    ) -> Result<Vec<Candle>, EngineError> {
        let now = self.now_ms();
        let from = base.close_time(last);
        let key = inst.id.clone();
        let mut cached = blocking(&self.shared.store, move |s| {
            s.scan_candles_between(&key, base, last, i64::MAX, |it| {
                it.take(room).collect::<Vec<_>>()
            })
        })
        .await?;
        closed_by(&mut cached, base, now);
        let Some(provider) = self.provider(&inst.id.source) else {
            return Ok(cached);
        };
        if cached.first().is_some_and(|c| c.open_time == from) {
            return Ok(cached);
        }
        match fetch_window(provider.as_ref(), inst, base, from, now, room).await {
            Ok(fetched) => {
                self.shared.note_ok();
                Ok(fetched)
            }
            Err(e) => {
                self.shared.note_error(&e);
                Err(EngineError::Replay(format!(
                    "the newest {} candles could not be loaded: {e}",
                    base.code()
                )))
            }
        }
    }

    /// Changes the step resolution to `base`, keeping the cut, the start and the commands
    /// (they are times). A lower base loads its candles (the cache, else the provider) from
    /// before the start to the newest closed one (to the last candle for a file); a higher
    /// one is built from the current candles and needs the cut on its boundary. The
    /// commands play again on the new candles; a session they do not fit is refused and
    /// stays as it was. Returns the state of `base` with every revealed bar.
    pub async fn replay_set_base(&self, base: Timeframe) -> Result<ReplayState, EngineError> {
        let snap = self.with_session(|s| {
            Ok(Snapshot {
                id: s.id,
                instrument: s.instrument.clone(),
                base: s.base,
                candles: Arc::clone(&s.candles),
                start: s.start,
                cut: s.cut,
                commands: s.commands.clone(),
                // A finished backtest loads nothing past its cut, as a file does not.
                live: s.live && s.caught_up_at.is_none(),
            })
        })?;
        let (old, new) = (snap.base.code(), base.code());
        if base == snap.base {
            return self.replay_state(base, 0, 0);
        }
        let candles = if snap.base.builds_from(base) {
            self.lower_candles(&snap, base).await?
        } else if base.builds_from(snap.base) {
            higher_candles(&snap, base)?
        } else {
            return Err(EngineError::Replay(format!(
                "a replay of {old} candles cannot step {new} candles: their boundaries do not line up"
            )));
        };
        let close = |c: &Candle| base.close_time(c.open_time);
        // A gap in the new candles moves the start up and the cut down to candles it has.
        let start = candles
            .iter()
            .map(close)
            .find(|&t| t >= snap.start)
            .unwrap_or(snap.start);
        let cut = revealed(base, &candles, snap.cut)
            .last()
            .map_or(snap.cut, close);
        let sim = simulate(base, &candles, start, cut, &snap.commands).map_err(|e| {
            EngineError::Replay(format!("the replay cannot step {new} candles: {e}"))
        })?;
        {
            let mut guard = self.shared.session();
            let s = guard.as_mut().filter(|s| s.id == snap.id).ok_or_else(|| {
                EngineError::Replay("the replay changed while it was re-based".into())
            })?;
            s.id = next_session_id();
            s.base = base;
            s.candles = Arc::new(candles);
            s.start = start;
            s.cut = cut;
            // A finished backtest stays finished, at the cut on the new candles.
            s.caught_up_at = s.caught_up_at.map(|_| cut);
            s.sim = Some(if s.caught_up_at.is_some() {
                sim.at_real_time()
            } else {
                sim
            });
        }
        if let Err(e) = self.load_newer().await {
            eprintln!("the replay could not load newer candles: {e}");
        }
        self.replay_state(base, 0, 0)
    }

    /// Candles of the lower `base` for a re-base: from before the start (the old context's
    /// span, at most [`REBASE_CONTEXT`]) to now (to the old last candle for a session that
    /// does not load newer ones). Refused when the part from the start on does not fit
    /// [`MAX_CANDLES`].
    async fn lower_candles(
        &self,
        snap: &Snapshot,
        base: Timeframe,
    ) -> Result<Vec<Candle>, EngineError> {
        let new = base.code();
        let len = base
            .fixed_ms()
            .ok_or_else(|| EngineError::Replay(format!("cannot re-base to {new}")))?;
        let now = self.now_ms();
        let end = match snap.candles.last() {
            Some(c) if !snap.live => snap.base.close_time(c.open_time),
            _ => now,
        };
        // The new candle that closes at the start opens one length before it.
        let first = snap.start - len;
        let need = usize::try_from((end - first) / len).unwrap_or(usize::MAX);
        if need > MAX_CANDLES {
            let most = MAX_CANDLES as i64 * len / DAY_MS;
            let span = (end - first + DAY_MS - 1) / DAY_MS;
            let to = if snap.live { "now" } else { "its last candle" };
            return Err(EngineError::Replay(format!(
                "a replay holds at most {MAX_CANDLES} candles: at {new} that is {most} days from its start to {to}, and this one spans {span} days; replay at a higher step or start later"
            )));
        }
        let old_first = snap.candles.first().map_or(first, |c| c.open_time);
        let span = usize::try_from((first - old_first).max(0) / len).unwrap_or(0);
        let context = span.min(REBASE_CONTEXT).min(MAX_CANDLES - need);
        let from = first - context as i64 * len;
        let want = need + context;
        let key = snap.instrument.id.clone();
        let mut cached = blocking(&self.shared.store, move |s| {
            s.scan_candles_between(&key, base, from - 1, end, |it| {
                it.take(want).collect::<Vec<_>>()
            })
        })
        .await?;
        cached.retain(|c| base.close_time(c.open_time) <= end);
        let Some(provider) = self.provider(&snap.instrument.id.source) else {
            return Ok(cached);
        };
        if cached.len() == want {
            return Ok(cached);
        }
        match fetch_window(provider.as_ref(), &snap.instrument, base, from, end, want).await {
            Ok(fetched) => {
                self.shared.note_ok();
                Ok(fetched)
            }
            Err(e) => {
                self.shared.note_error(&e);
                Err(EngineError::Replay(format!(
                    "the {new} candles could not be loaded: {e}"
                )))
            }
        }
    }

    /// Appends a trade command if the session stays valid with it (time order, the time
    /// of a revealed base candle's close, one trade at a time, levels around the close).
    /// Refused once caught up: the backtest is finished, and the live chart shows prices
    /// after the cut.
    pub fn replay_command(&self, cmd: Command) -> Result<(), EngineError> {
        self.with_session(|s| {
            if s.caught_up_at.is_some() {
                return Err(caught_up_error("commands"));
            }
            let mut next = s.commands.clone();
            next.push(cmd);
            let sim = s.simulate(&next)?;
            s.commands = next;
            s.sim = Some(sim);
            Ok(())
        })
    }

    /// The session as a chart of `tf` shows it: its revealed bars from index `cursor` on
    /// and the trades from index `trades_from` on (the UI passes how many bars and closed
    /// trades it already has; the last bar of a higher timeframe may be partial and change),
    /// and the statistics. `tf` must build from the base.
    pub fn replay_state(
        &self,
        tf: Timeframe,
        cursor: u32,
        trades_from: u32,
    ) -> Result<ReplayState, EngineError> {
        self.with_session(|s| s.state(tf, cursor, trades_from))
    }

    /// The default name of the session's file, `<symbol>-<base>.replay`, with only
    /// file-safe characters (a CSV symbol is whatever the user typed).
    pub fn replay_file_name(&self) -> Result<String, EngineError> {
        self.with_session(|s| Ok(file_name(&s.instrument.id.symbol, s.base)))
    }

    /// The `.replay` file: context and revealed candles, never a candle after the cut (so
    /// none after catching up, where the cut stopped), and the catch-up time.
    pub fn replay_export(&self) -> Result<Vec<u8>, EngineError> {
        self.with_session(|s| {
            let file = ReplayFile {
                instrument: s.instrument.clone(),
                base: s.base,
                candles: revealed(s.base, &s.candles, s.cut).to_vec(),
                start: s.start,
                cut: s.cut,
                commands: s.commands.clone(),
                caught_up_at: s.caught_up_at,
            };
            Ok(file.to_json().into_bytes())
        })
    }

    /// Checks a `.replay` file and opens it as the session, revealed up to its cut; candles
    /// the file has after the cut can be stepped to. It never loads newer candles.
    /// When the pair is stored, the session takes the stored instrument, and a file at
    /// another tick or lot size is rescaled to it, so drawings and outcomes of the pair
    /// stay at one scale; a file that no longer fits or simulates after rounding is refused.
    pub fn replay_open(&self, bytes: &[u8]) -> Result<ReplayState, EngineError> {
        let (mut file, _) = ReplayFile::from_json(bytes).map_err(EngineError::Replay)?;
        if let Some(inst) = lock(&self.shared.store).instrument(&file.instrument.id)? {
            let (ps, qs) = (inst.price_scale, inst.qty_scale);
            if (file.instrument.price_scale, file.instrument.qty_scale) != (ps, qs) {
                let at =
                    |e: String| EngineError::Replay(format!("at the stored price scale {ps}: {e}"));
                file = file
                    .rescaled(ps, qs)
                    .ok_or_else(|| at("a value does not fit".into()))?;
                check_candles(&file.candles).map_err(at)?;
                file.simulate().map_err(at)?;
            }
            file.instrument = inst;
        }
        let base = file.base;
        let mut session = Session {
            id: next_session_id(),
            instrument: file.instrument,
            base,
            candles: Arc::new(file.candles),
            start: file.start,
            cut: file.cut,
            commands: file.commands,
            sim: None,
            live: false,
            caught_up_at: file.caught_up_at,
        };
        let state = session.state(base, 0, 0)?;
        *self.shared.session() = Some(session);
        Ok(state)
    }

    /// Closes the session; live updates of its instrument flow again.
    pub fn replay_exit(&self) {
        *self.shared.session() = None;
    }
}

/// Candles of the higher `base` for a re-base, built from the current ones; a bucket the
/// current candles cover only in part (at either end) is left out. Needs the cut on a
/// `base` boundary: a snap down would hide candles already seen, a snap up would show
/// unseen ones.
fn higher_candles(snap: &Snapshot, base: Timeframe) -> Result<Vec<Candle>, EngineError> {
    if base.bucket_start(snap.cut) != snap.cut {
        return Err(EngineError::Replay(format!(
            "the replay is at {}, inside a {} candle; step to {} first, where it closes",
            snap.cut,
            base.code(),
            base.bucket_end(snap.cut)
        )));
    }
    let src = snap.candles.as_slice();
    let mut out = aggregate(src, snap.base, base).map_err(EngineError::Replay)?;
    if let (Some(f), Some(c)) = (out.first(), src.first())
        && c.open_time > f.open_time
    {
        out.remove(0);
    }
    if let (Some(l), Some(c)) = (out.last(), src.last())
        && base.bucket_end(l.open_time) > snap.base.close_time(c.open_time)
    {
        out.pop();
    }
    Ok(out)
}

/// `<symbol>-<tf>.replay` keeping only A-Z, a-z, 0-9, `.`, `_` and `-` of the symbol, and no
/// leading dot (a hidden file); `replay` when nothing is left.
fn file_name(symbol: &str, tf: Timeframe) -> String {
    let safe: String = symbol
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    let safe = safe.trim_start_matches('.');
    let stem = if safe.is_empty() { "replay" } else { safe };
    format!("{stem}-{}.replay", tf.code())
}

#[cfg(test)]
mod tests {
    use sandchart_core::Timeframe;

    use super::file_name;

    #[test]
    fn file_names_keep_only_safe_characters() {
        assert_eq!(file_name("BTCUSDT", Timeframe::H1), "BTCUSDT-1h.replay");
        assert_eq!(
            file_name("../a b/c:d.e_f-g", Timeframe::D1),
            "abcd.e_f-g-1d.replay"
        );
        assert_eq!(file_name("/ \\", Timeframe::H4), "replay-4h.replay");
    }
}
