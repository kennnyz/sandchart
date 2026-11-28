//! The replay session: one at a time, over cached candles held in memory. Only bars up to
//! the current one ever leave the engine (ADR 0005).

use std::sync::{MutexGuard, PoisonError};

use sandchart_core::replay::{
    Command, MAX_CANDLES, ReplayFile, Simulation, check_candles, simulate,
};
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};

use crate::{Engine, EngineError, blocking, lock};

/// Bars shown before the start, for context.
pub const REPLAY_CONTEXT: usize = 500;

pub(crate) struct Session {
    instrument: Instrument,
    tf: Timeframe,
    /// Context, then every bar from the start to the newest cached one.
    candles: Vec<Candle>,
    start: u32,
    current: u32,
    commands: Vec<Command>,
}

/// What the UI gets: the revealed bars from `from` on, never a bar after `current`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayState {
    pub instrument: Instrument,
    pub tf: Timeframe,
    pub start: u32,
    pub current: u32,
    /// No bar is left to reveal.
    pub at_end: bool,
    /// Index of `bars[0]`.
    pub from: u32,
    pub bars: Vec<Candle>,
    pub commands: Vec<Command>,
    pub simulation: Simulation,
}

fn no_session() -> EngineError {
    EngineError::Replay("no replay is open".into())
}

impl Session {
    fn simulate(&self, commands: &[Command]) -> Result<Simulation, EngineError> {
        simulate(&self.candles, self.start, self.current, commands).map_err(EngineError::Replay)
    }

    fn state(&self, cursor: u32) -> Result<ReplayState, EngineError> {
        let from = cursor.min(self.current + 1);
        Ok(ReplayState {
            instrument: self.instrument.clone(),
            tf: self.tf,
            start: self.start,
            current: self.current,
            at_end: self.current as usize + 1 >= self.candles.len(),
            from,
            bars: self.candles[from as usize..=self.current as usize].to_vec(),
            commands: self.commands.clone(),
            simulation: self.simulate(&self.commands)?,
        })
    }
}

impl crate::Shared {
    fn session(&self) -> MutexGuard<'_, Option<Session>> {
        self.replay.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` over the instrument and the revealed bars (up to the current one) of the
    /// open replay, if it replays `(id, tf)`. Indicators and position outcomes read these
    /// instead of the cache, so they never see a bar the UI has not been shown (ADR 0005,
    /// decision 5).
    pub(crate) fn with_replay_bars<R>(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        f: impl FnOnce(&Instrument, &[Candle]) -> R,
    ) -> Option<R> {
        let guard = self.session();
        let s = guard
            .as_ref()
            .filter(|s| s.instrument.id == *id && s.tf == tf)?;
        Some(f(&s.instrument, &s.candles[..=s.current as usize]))
    }

    /// Live events of this instrument are held back while it is replayed.
    pub(crate) fn replaying(&self, id: &InstrumentId) -> bool {
        self.session()
            .as_ref()
            .is_some_and(|s| s.instrument.id == *id)
    }
}

impl Engine {
    fn with_session<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        f(self.shared.session().as_mut().ok_or_else(no_session)?)
    }

    /// Starts a replay at the cached bar that opens at `start_time`, with up to
    /// [`REPLAY_CONTEXT`] bars before it and every cached bar after it (within the file
    /// limit). Replaces any open replay. Returns the state with every revealed bar.
    pub async fn replay_start(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        start_time: i64,
    ) -> Result<ReplayState, EngineError> {
        let key = id.clone();
        let (instrument, context, rest) = blocking(&self.shared.store, move |s| {
            let instrument = s.instrument(&key)?;
            let context = s.candles_before(&key, tf, Some(start_time), REPLAY_CONTEXT)?;
            let room = MAX_CANDLES - context.len();
            let rest =
                s.scan_candles_between(&key, tf, start_time.saturating_sub(1), i64::MAX, |it| {
                    it.take(room).collect::<Vec<_>>()
                })?;
            Ok((instrument, context, rest))
        })
        .await?;
        let instrument = instrument.ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        if rest.first().is_none_or(|c| c.open_time != start_time) {
            return Err(EngineError::Replay(format!(
                "no cached {} bar opens at {start_time}",
                tf.code()
            )));
        }
        let start = context.len() as u32;
        let mut candles = context;
        candles.extend(rest);
        let session = Session {
            instrument,
            tf,
            candles,
            start,
            current: start,
            commands: Vec::new(),
        };
        let state = session.state(0)?;
        *self.shared.session() = Some(session);
        Ok(state)
    }

    /// Reveals up to `n` more bars; returns the index of the current bar.
    pub fn replay_step(&self, n: u32) -> Result<u32, EngineError> {
        self.with_session(|s| {
            let last = s.candles.len() as u32 - 1;
            s.current = s.current.saturating_add(n).min(last);
            Ok(s.current)
        })
    }

    /// Appends a trade command if the session stays valid with it (bar order, revealed
    /// bars only, one trade at a time, levels around the close).
    pub fn replay_command(&self, cmd: Command) -> Result<(), EngineError> {
        self.with_session(|s| {
            let mut next = s.commands.clone();
            next.push(cmd);
            s.simulate(&next)?;
            s.commands = next;
            Ok(())
        })
    }

    /// The session with the revealed bars from index `cursor` on (the UI passes how many
    /// it already has), trades and statistics.
    pub fn replay_state(&self, cursor: u32) -> Result<ReplayState, EngineError> {
        self.with_session(|s| s.state(cursor))
    }

    /// The default name of the session's file, `<symbol>-<timeframe>.replay`, with only
    /// file-safe characters (a CSV symbol is whatever the user typed).
    pub fn replay_file_name(&self) -> Result<String, EngineError> {
        self.with_session(|s| Ok(file_name(&s.instrument.id.symbol, s.tf)))
    }

    /// The `.replay` file: context and revealed bars only, never a bar after the current one.
    pub fn replay_export(&self) -> Result<Vec<u8>, EngineError> {
        self.with_session(|s| {
            let file = ReplayFile {
                instrument: s.instrument.clone(),
                timeframe: s.tf,
                candles: s.candles[..=s.current as usize].to_vec(),
                start: s.start,
                current: s.current,
                commands: s.commands.clone(),
            };
            Ok(file.to_json().into_bytes())
        })
    }

    /// Checks a `.replay` file and opens it as the session, revealed up to its current bar.
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
                simulate(&file.candles, file.start, file.current, &file.commands).map_err(at)?;
            }
            file.instrument = inst;
        }
        let session = Session {
            instrument: file.instrument,
            tf: file.timeframe,
            candles: file.candles,
            start: file.start,
            current: file.current,
            commands: file.commands,
        };
        let state = session.state(0)?;
        *self.shared.session() = Some(session);
        Ok(state)
    }

    /// Closes the session; live updates of its instrument flow again.
    pub fn replay_exit(&self) {
        *self.shared.session() = None;
    }
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
