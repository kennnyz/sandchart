//! The replay session through the engine: start over cached candles, step, commands,
//! state since a cursor, export and open, exit.

use std::sync::Arc;

use sandchart_core::replay::{Command, ExitReason, MAX_FILE_BYTES};
use sandchart_core::{Candle, Instrument, InstrumentId, Side, Timeframe};
use sandchart_engine::{Engine, EngineError, REPLAY_CONTEXT};
use sandchart_store::Store;

const T0: i64 = 1_700_000_000_000 / H * H;
const H: i64 = 3_600_000;
/// Cached hourly bars `0..BARS`.
const BARS: i64 = 600;

fn id() -> InstrumentId {
    InstrumentId {
        source: "binance".into(),
        symbol: "BTCUSDT".into(),
    }
}

/// Bar `i` opens at `T0 + i h` and closes at 10 000 + i, with a range of ±50 around it.
fn bar(i: i64) -> Candle {
    let p = 10_000 + i;
    Candle {
        open_time: T0 + i * H,
        open: p,
        high: p + 50,
        low: p - 50,
        close: p,
        volume: 7,
    }
}

fn engine() -> (Engine, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("sandchart.db")).unwrap();
    store
        .upsert_instruments(&[Instrument {
            id: id(),
            base: "BTC".into(),
            quote: "USDT".into(),
            price_scale: 2,
            qty_scale: 5,
        }])
        .unwrap();
    let candles: Vec<Candle> = (0..BARS).map(bar).collect();
    store
        .upsert_candles(&id(), Timeframe::H1, &candles)
        .unwrap();
    let engine = Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| 0)).unwrap();
    (engine, dir)
}

fn replay_err(r: Result<impl std::fmt::Debug, EngineError>) -> String {
    match r {
        Err(EngineError::Replay(m)) => m,
        other => panic!("expected a replay error, got {other:?}"),
    }
}

#[tokio::test]
async fn start_loads_context_and_reveals_only_the_start_bar() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    // 500 bars of context (50..550), then the start bar.
    assert_eq!(st.start as usize, REPLAY_CONTEXT);
    assert_eq!(st.current, st.start);
    assert_eq!(st.from, 0);
    assert_eq!(st.bars.len(), REPLAY_CONTEXT + 1);
    assert_eq!(st.bars[0], bar(50));
    assert_eq!(*st.bars.last().unwrap(), bar(550));
    assert!(!st.at_end);
    assert!(st.simulation.trades.is_empty());

    // Near the start of the cache the context is shorter.
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 3 * H)
        .await
        .unwrap();
    assert_eq!((st.start, st.bars.len()), (3, 4));
}

#[tokio::test]
async fn start_needs_a_cached_bar_at_that_time() {
    let (engine, _dir) = engine();
    let msg = replay_err(
        engine
            .replay_start(&id(), Timeframe::H1, T0 + 3 * H + 1)
            .await,
    );
    assert_eq!(msg, format!("no cached 1h bar opens at {}", T0 + 3 * H + 1));
    let msg = replay_err(engine.replay_start(&id(), Timeframe::H4, T0).await);
    assert_eq!(msg, format!("no cached 4h bar opens at {T0}"));
    assert!(matches!(
        engine.replay_state(0),
        Err(EngineError::Replay(m)) if m == "no replay is open"
    ));
}

#[tokio::test]
async fn step_reveals_bars_and_state_sends_only_new_ones() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 590 * H)
        .await
        .unwrap();
    let have = st.bars.len() as u32;
    assert_eq!(engine.replay_step(3).unwrap(), st.start + 3);
    let st = engine.replay_state(have).unwrap();
    assert_eq!(st.from, have);
    assert_eq!(st.bars, vec![bar(591), bar(592), bar(593)]);
    // A cursor past the current bar gets nothing, never a future bar.
    assert!(engine.replay_state(have + 100).unwrap().bars.is_empty());
    // Steps stop at the newest cached bar.
    let last = engine.replay_step(1000).unwrap();
    let st = engine.replay_state(last).unwrap();
    assert_eq!(st.bars, vec![bar(BARS - 1)]);
    assert!(st.at_end);
}

#[tokio::test]
async fn commands_are_checked_against_the_revealed_bars() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    let s = st.start;
    // The start bar closes at 10 550; the next bars rise by 1 a bar with a ±50 range.
    let open = Command::Open {
        bar: s,
        side: Side::Long,
        stop: 10_400,
        take: 10_610,
    };
    let ahead = Command::Open {
        bar: s + 1,
        side: Side::Long,
        stop: 10_400,
        take: 10_610,
    };
    let msg = replay_err(engine.replay_command(ahead));
    assert_eq!(
        msg,
        format!("command 1: bar {} is outside the replay ({s}..={s})", s + 1)
    );
    engine.replay_command(open).unwrap();
    let msg = replay_err(engine.replay_command(open));
    assert_eq!(msg, "command 2: a trade is already open");

    engine.replay_step(5).unwrap();
    let st = engine.replay_state(u32::MAX).unwrap();
    assert_eq!(st.commands, vec![open]);
    let t = st.simulation.trades[0];
    // Bar s+5 closes at 10 555 with a high of 10 605: still open, marked to the close.
    assert_eq!((t.reason, t.entry_price), (ExitReason::Open, 10_550));
    assert!((t.r - 5.0 / 150.0).abs() < 1e-12);

    engine.replay_step(5).unwrap();
    // Bar s+10 reaches 10 610: the take.
    let t = engine.replay_state(u32::MAX).unwrap().simulation.trades[0];
    assert_eq!((t.reason, t.exit_bar), (ExitReason::Take, Some(s + 10)));
    let msg = replay_err(engine.replay_command(Command::Close { bar: s + 10 }));
    assert_eq!(msg, "command 2: no open trade to close");
    assert_eq!(engine.replay_state(0).unwrap().simulation.stats.count, 1);
}

#[tokio::test]
async fn export_holds_no_future_bar_and_opens_to_the_same_state() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    engine
        .replay_command(Command::Open {
            bar: st.start,
            side: Side::Short,
            stop: 10_700,
            take: 10_300,
        })
        .unwrap();
    engine.replay_step(7).unwrap();
    engine
        .replay_command(Command::Close { bar: st.start + 7 })
        .unwrap();
    let before = engine.replay_state(0).unwrap();
    let bytes = engine.replay_export().unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    // Bar 557 is the current one; 558 and later stay in the engine.
    assert!(text.contains(&format!("[{}, ", bar(557).open_time)));
    assert!(!text.contains(&bar(558).open_time.to_string()));

    engine.replay_exit();
    assert!(engine.replay_export().is_err());
    let opened = engine.replay_open(&bytes).unwrap();
    // The same state, except that the file ends at the current bar.
    let want = sandchart_engine::ReplayState {
        at_end: true,
        ..before
    };
    assert_eq!(opened, want);
    // The opened file ends at its current bar, so nothing is left to step.
    assert_eq!(engine.replay_step(1).unwrap(), opened.current);
}

#[tokio::test]
async fn broken_or_oversized_files_leave_the_session_alone() {
    let (engine, _dir) = engine();
    engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    let mut text = String::from_utf8(engine.replay_export().unwrap()).unwrap();
    text = text.replace(&bar(550).close.to_string(), "10551");
    let msg = replay_err(engine.replay_open(text.as_bytes()));
    assert_eq!(msg, "the candles do not match the file's sha256");
    let msg = replay_err(engine.replay_open(&vec![b' '; MAX_FILE_BYTES + 1]));
    assert!(msg.starts_with("the replay file is 32 MiB"), "{msg}");
    assert!(engine.replay_state(0).is_ok());
}
