//! The replay session through the engine: start over cached candles, step, commands,
//! state since a cursor, views of higher timeframes, re-basing, catching up with live
//! data, export and open, exit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use sandchart_core::aggregate::aggregate;
use sandchart_core::replay::{Command, ExitReason, MAX_FILE_BYTES};
use sandchart_core::{Candle, Instrument, InstrumentId, Side, Timeframe};
use sandchart_data::{LiveCandle, Provider, ProviderError};
use sandchart_engine::{Engine, EngineError, LiveEvent, REPLAY_CONTEXT};
use sandchart_store::Store;
use tokio::sync::mpsc;

const DAY: i64 = 86_400_000;
/// Midnight UTC, so every timeframe up to a day has a boundary here.
const T0: i64 = 1_700_000_000_000 / DAY * DAY;
const H: i64 = 3_600_000;
const Q: i64 = 900_000;
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

/// The four 15m candles of hour `i`, which aggregate to exactly `bar(i)`: the high in the
/// first quarter, the low in the second.
fn quarters(i: i64) -> [Candle; 4] {
    let b = bar(i);
    let q = |k: i64, high: i64, low: i64, volume: i64| Candle {
        open_time: b.open_time + k * Q,
        open: b.close,
        high,
        low,
        close: b.close,
        volume,
    };
    [
        q(0, b.high, b.close, 1),
        q(1, b.close, b.low, 2),
        q(2, b.close, b.close, 2),
        q(3, b.close, b.close, 2),
    ]
}

fn instrument() -> Instrument {
    Instrument {
        id: id(),
        base: "BTC".into(),
        quote: "USDT".into(),
        price_scale: 2,
        qty_scale: 5,
    }
}

/// A store with the pair and hourly bars `0..BARS`, all closed at the engine's clock.
fn store_in(dir: &tempfile::TempDir) -> Store {
    let mut store = Store::open(&dir.path().join("sandchart.db")).unwrap();
    store.upsert_instruments(&[instrument()]).unwrap();
    let candles: Vec<Candle> = (0..BARS).map(bar).collect();
    store
        .upsert_candles(&id(), Timeframe::H1, &candles)
        .unwrap();
    store
}

fn engine() -> (Engine, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    store_in(&dir);
    let engine =
        Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| T0 + BARS * H)).unwrap();
    (engine, dir)
}

const TF: Timeframe = Timeframe::H1;

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
    assert!(st.trades.is_empty());

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
    // A cached candle that has not closed yet cannot be replayed either.
    let dir = tempfile::tempdir().unwrap();
    store_in(&dir)
        .upsert_candles(&id(), Timeframe::H1, &[bar(BARS)])
        .unwrap();
    let early =
        Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| T0 + BARS * H + 1)).unwrap();
    let msg = replay_err(early.replay_start(&id(), TF, T0 + BARS * H).await);
    assert_eq!(msg, format!("no cached 1h bar opens at {}", T0 + BARS * H));
    early.replay_start(&id(), TF, T0).await.unwrap();
    let cut = early.replay_step(u32::MAX).await.unwrap();
    assert_eq!(cut, T0 + BARS * H, "the forming candle stays out");
    let msg = replay_err(engine.replay_start(&id(), Timeframe::H4, T0).await);
    assert_eq!(msg, format!("no cached 4h bar opens at {T0}"));
    // The lowest time does not overflow looking for the bar.
    let msg = replay_err(engine.replay_start(&id(), Timeframe::H1, i64::MIN).await);
    assert_eq!(msg, format!("no cached 1h bar opens at {}", i64::MIN));
    assert!(matches!(
        engine.replay_state(TF, 0, 0),
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
    // A step returns the cut: the close time of the last revealed candle.
    assert_eq!(engine.replay_step(3).await.unwrap(), st.cut + 3 * H);
    let st = engine.replay_state(TF, have, 0).unwrap();
    assert_eq!((st.from, st.current), (have, have + 2));
    assert_eq!(st.bars, vec![bar(591), bar(592), bar(593)]);
    // A cursor past the current bar gets nothing, never a future bar.
    assert!(
        engine
            .replay_state(TF, have + 100, 0)
            .unwrap()
            .bars
            .is_empty()
    );
    // Steps stop at the newest cached bar; without a provider nothing newer can come.
    assert_eq!(engine.replay_step(1000).await.unwrap(), T0 + BARS * H);
    let st = engine.replay_state(TF, 0, 0).unwrap();
    assert_eq!(*st.bars.last().unwrap(), bar(BARS - 1));
    assert!(st.at_end && !st.caught_up);
}

#[tokio::test]
async fn commands_are_checked_against_the_revealed_bars() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    // The start bar (550) closes at 10 550; the next bars rise by 1 a bar with a ±50 range.
    // Commands carry the cut, the close time of the current bar.
    assert_eq!(st.cut, T0 + 551 * H);
    let open = Command::Open {
        time: st.cut,
        side: Side::Long,
        stop: 10_400,
        take: 10_610,
    };
    let ahead = Command::Open {
        time: st.cut + H,
        side: Side::Long,
        stop: 10_400,
        take: 10_610,
    };
    let msg = replay_err(engine.replay_command(ahead));
    assert_eq!(
        msg,
        format!(
            "command 1: time {} is outside the replay ({}..={})",
            st.cut + H,
            st.cut,
            st.cut
        )
    );
    engine.replay_command(open).unwrap();
    let msg = replay_err(engine.replay_command(open));
    assert_eq!(msg, "command 2: a trade is already open");

    engine.replay_step(5).await.unwrap();
    let st = engine.replay_state(TF, u32::MAX, 0).unwrap();
    let t = st.trades[0];
    // Bar 555 closes at 10 555 with a high of 10 605: still open, marked to the close.
    assert_eq!((t.reason, t.entry_price), (ExitReason::Open, 10_550));
    assert!((t.r - 5.0 / 150.0).abs() < 1e-12);

    engine.replay_step(5).await.unwrap();
    // Bar 560 reaches 10 610: the take.
    let t = engine.replay_state(TF, u32::MAX, 0).unwrap().trades[0];
    assert_eq!(
        (t.reason, t.exit_time),
        (ExitReason::Take, Some(bar(560).open_time))
    );
    let msg = replay_err(engine.replay_command(Command::Close {
        time: bar(560).open_time + H,
    }));
    assert_eq!(msg, "command 2: no open trade to close");
    assert_eq!(engine.replay_state(TF, 0, 0).unwrap().stats.count, 1);
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
            time: st.cut,
            side: Side::Short,
            stop: 10_700,
            take: 10_300,
        })
        .unwrap();
    engine.replay_step(7).await.unwrap();
    engine
        .replay_command(Command::Close {
            time: st.cut + 7 * H,
        })
        .unwrap();
    let before = engine.replay_state(TF, 0, 0).unwrap();
    assert_eq!(engine.replay_file_name().unwrap(), "BTCUSDT-1h.replay");
    let bytes = engine.replay_export().unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    // Bar 557 is the current one; 558 and later stay in the engine.
    assert!(text.contains(&format!("[{}, ", bar(557).open_time)));
    assert!(!text.contains(&format!("[{}, ", bar(558).open_time)));

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
    assert_eq!(engine.replay_step(1).await.unwrap(), opened.cut);
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
    assert!(engine.replay_state(TF, 0, 0).is_ok());
}

/// A file of `n` bars from bar 550 on, with prices at `price_scale` decimals (`bar` is at 2).
fn file_at(price_scale: u8, n: i64) -> sandchart_core::replay::ReplayFile {
    let k = 10i64.pow(u32::from(price_scale)) / 100;
    let candles = (550..550 + n)
        .map(|i| {
            let c = bar(i);
            Candle {
                open: c.open * k,
                high: c.high * k,
                low: c.low * k,
                close: c.close * k,
                volume: c.volume * 10,
                ..c
            }
        })
        .collect();
    sandchart_core::replay::ReplayFile {
        instrument: Instrument {
            id: id(),
            base: "BTC".into(),
            quote: "USDT".into(),
            price_scale,
            qty_scale: 6,
        },
        base: Timeframe::H1,
        candles,
        start: T0 + 551 * H,
        cut: T0 + (550 + n) * H,
        caught_up_at: None,
        commands: vec![Command::Open {
            time: T0 + 551 * H,
            side: Side::Long,
            stop: 10_400 * k,
            take: 10_610 * k,
        }],
    }
}

#[tokio::test]
async fn a_file_at_another_tick_size_is_rescaled_to_the_stored_one() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_open(file_at(3, 5).to_json().as_bytes())
        .unwrap();
    // The store has the pair at 2 price and 5 quantity decimals: the file follows it.
    assert_eq!((st.instrument.price_scale, st.instrument.qty_scale), (2, 5));
    assert_eq!(st.bars, (550..555).map(bar).collect::<Vec<_>>());
    let t = st.trades[0];
    assert_eq!((t.entry_price, t.stop, t.take), (10_550, 10_400, 10_610));
    // Saved again, it is at the stored scale.
    let text = String::from_utf8(engine.replay_export().unwrap()).unwrap();
    assert!(text.contains("\"priceScale\":2"), "{text}");
}

#[tokio::test]
async fn a_file_that_does_not_fit_the_stored_tick_size_is_refused() {
    let (engine, _dir) = engine();
    let mut file = file_at(2, 3);
    file.instrument.price_scale = 0;
    file.candles[1].high = sandchart_core::JS_SAFE_MAX / 10;
    let msg = replay_err(engine.replay_open(file.to_json().as_bytes()));
    assert!(
        msg.starts_with("at the stored price scale 2: candle 1: "),
        "{msg}"
    );
    assert!(engine.replay_state(TF, 0, 0).is_err());
}

#[tokio::test]
async fn an_unknown_pair_keeps_the_file_instrument() {
    let (engine, _dir) = engine();
    let mut file = file_at(3, 3);
    file.instrument.id.symbol = "ETHUSDT".into();
    let st = engine.replay_open(file.to_json().as_bytes()).unwrap();
    assert_eq!(st.instrument.price_scale, 3);
    assert_eq!(st.bars[0].close, bar(550).close * 10);
}

#[tokio::test]
async fn state_sends_closed_trades_from_the_index_given_and_always_the_open_one() {
    let (engine, _dir) = engine();
    let st = engine
        .replay_start(&id(), Timeframe::H1, T0 + 550 * H)
        .await
        .unwrap();
    let open = |time| Command::Open {
        time,
        side: Side::Long,
        stop: 10_000,
        take: 11_000,
    };
    engine.replay_command(open(st.cut)).unwrap();
    engine.replay_step(1).await.unwrap();
    engine
        .replay_command(Command::Close { time: st.cut + H })
        .unwrap();
    engine.replay_command(open(st.cut + H)).unwrap();
    let all = engine.replay_state(TF, 0, 0).unwrap();
    assert_eq!((all.trades_from, all.trades.len()), (0, 2));
    // The UI has the closed trade: only the open one comes.
    let st = engine.replay_state(TF, 0, 1).unwrap();
    assert_eq!(st.trades_from, 1);
    assert_eq!(st.trades, all.trades[1..]);
    // An index past the closed trades is clamped to them: the open trade still comes.
    let st = engine.replay_state(TF, 0, 9).unwrap();
    assert_eq!((st.trades_from, st.trades.len()), (1, 1));
    assert_eq!(st.stats, all.stats);
}

#[tokio::test]
async fn a_higher_timeframe_is_built_from_the_revealed_candles_and_a_lower_one_is_refused() {
    let (engine, _dir) = engine();
    // T0 is midnight: bar 550 is the third hour of the 4h bucket that starts at bar 548.
    engine.replay_start(&id(), TF, T0 + 550 * H).await.unwrap();
    let st = engine.replay_state(Timeframe::H4, 0, 0).unwrap();
    let shown: Vec<Candle> = (50..=550).map(bar).collect();
    assert_eq!(
        st.bars,
        aggregate(&shown, TF, Timeframe::H4).unwrap(),
        "4h bars from the revealed 1h ones"
    );
    assert_eq!((st.base, st.tf), (TF, Timeframe::H4));
    // Bars 50 and 51 are the second half of the bucket at 48; bar 550's bucket is the last.
    assert_eq!((st.start, st.current), (125, 125));
    assert!(st.partial, "the last 4h bar is still forming");
    let forming = *st.bars.last().unwrap();
    assert_eq!(forming.open_time, T0 + 548 * H);
    assert_eq!((forming.open, forming.close), (10_548, 10_550));

    // It grows with each step and is complete when its last hour is revealed.
    engine.replay_step(1).await.unwrap();
    let st = engine.replay_state(Timeframe::H4, 125, 0).unwrap();
    assert_eq!(st.from, 125);
    assert_eq!(
        st.bars,
        [Candle {
            high: 10_601,
            close: 10_551,
            volume: 28,
            ..forming
        }]
    );
    assert!(!st.partial);
    engine.replay_step(1).await.unwrap();
    let st = engine.replay_state(Timeframe::H4, 126, 0).unwrap();
    assert_eq!(st.bars[0].open_time, T0 + 552 * H);
    assert!(st.partial);

    let msg = replay_err(engine.replay_state(Timeframe::M15, 0, 0));
    assert_eq!(
        msg,
        "the replay steps 1h candles, so 15m candles cannot be built from them; re-base it to 15m first"
    );
    let msg = replay_err(engine.replay_state(Timeframe::D3, 0, 0));
    assert_eq!(msg, "3d candles cannot be built from 1h candles");
}

/// The 15m candles of hours `0..BARS` in a store that has the hours too.
fn quarters_in(store: &mut Store) {
    let qs: Vec<Candle> = (0..BARS).flat_map(quarters).collect();
    store.upsert_candles(&id(), Timeframe::M15, &qs).unwrap();
}

#[tokio::test]
async fn re_basing_down_keeps_the_cut_and_the_commands_and_steps_the_lower_candles() {
    let dir = tempfile::tempdir().unwrap();
    quarters_in(&mut store_in(&dir));
    let engine =
        Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| T0 + BARS * H)).unwrap();
    let st = engine.replay_start(&id(), TF, T0 + 550 * H).await.unwrap();
    let open = Command::Open {
        time: st.cut,
        side: Side::Long,
        stop: 10_400,
        take: 10_610,
    };
    engine.replay_command(open).unwrap();
    engine.replay_step(5).await.unwrap();
    let hourly = engine.replay_state(TF, 0, 0).unwrap();

    let st = engine.replay_set_base(Timeframe::M15).await.unwrap();
    assert_eq!(
        (st.base, st.tf, st.cut),
        (Timeframe::M15, Timeframe::M15, hourly.cut)
    );
    // The context keeps its time span: from bar 50 on, four quarters an hour.
    assert_eq!(st.bars.first().unwrap().open_time, bar(50).open_time);
    assert_eq!(*st.bars.last().unwrap(), quarters(555)[3]);
    assert_eq!(
        st.start,
        500 * 4 + 3,
        "the start is the last quarter of bar 550"
    );
    // An hourly chart of the new base shows the same bars, and the trade is the same.
    let again = engine.replay_state(TF, 0, 0).unwrap();
    assert_eq!(again.bars, hourly.bars);
    // The same fill: the close at the same cut. Its time is the open of the base candle
    // it filled on, the last quarter of bar 550, in the same hourly bar.
    let (t, h) = (again.trades[0], hourly.trades[0]);
    assert_eq!(
        (t.entry_price, t.r, again.stats),
        (h.entry_price, h.r, hourly.stats)
    );
    assert_eq!(t.entry_time, quarters(550)[3].open_time);

    // Steps are quarters now; back up to 1h only on an hour boundary.
    assert_eq!(engine.replay_step(1).await.unwrap(), hourly.cut + Q);
    let msg = replay_err(engine.replay_set_base(TF).await);
    assert_eq!(
        msg,
        format!(
            "the replay is at {}, inside a 1h candle; step to {} first, where it closes",
            hourly.cut + Q,
            hourly.cut + H
        )
    );
    engine.replay_step(3).await.unwrap();
    let st = engine.replay_set_base(TF).await.unwrap();
    assert_eq!((st.base, st.cut), (TF, hourly.cut + H));
    assert_eq!(st.bars.last(), Some(&bar(556)));
    // The file is written at the base.
    assert_eq!(engine.replay_file_name().unwrap(), "BTCUSDT-1h.replay");
    let text = String::from_utf8(engine.replay_export().unwrap()).unwrap();
    assert!(text.contains("\"base\": \"1h\""), "{text}");
}

#[tokio::test]
async fn a_re_base_the_commands_do_not_fit_is_refused_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    quarters_in(&mut store_in(&dir));
    let engine =
        Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| T0 + BARS * H)).unwrap();
    let st = engine
        .replay_start(&id(), Timeframe::M15, quarters(550)[1].open_time)
        .await
        .unwrap();
    // An open at a quarter that is not an hour's close cannot be played on hours.
    engine
        .replay_command(Command::Open {
            time: st.cut,
            side: Side::Long,
            stop: 10_400,
            take: 10_610,
        })
        .unwrap();
    engine.replay_step(2).await.unwrap();
    let before = engine.replay_state(Timeframe::M15, 0, 0).unwrap();
    let msg = replay_err(engine.replay_set_base(TF).await);
    assert_eq!(
        msg,
        format!(
            "the replay cannot step 1h candles: command 1: time {} is outside the replay ({}..={})",
            st.cut,
            T0 + 551 * H,
            T0 + 551 * H
        )
    );
    assert_eq!(engine.replay_state(Timeframe::M15, 0, 0).unwrap(), before);
    let msg = replay_err(engine.replay_set_base(Timeframe::M3).await);
    assert!(
        msg.starts_with("the replay cannot step 3m candles: "),
        "{msg}"
    );
    let msg = replay_err(engine.replay_set_base(Timeframe::M5).await);
    assert!(
        msg.starts_with("the replay cannot step 5m candles: "),
        "{msg}"
    );
}

#[tokio::test]
async fn re_basing_to_1m_over_too_long_a_span_is_refused_with_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("sandchart.db")).unwrap();
    store.upsert_instruments(&[instrument()]).unwrap();
    let days: Vec<Candle> = (0..200)
        .map(|i| Candle {
            open_time: T0 + i * DAY,
            ..bar(i)
        })
        .collect();
    store.upsert_candles(&id(), Timeframe::D1, &days).unwrap();
    let engine =
        Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| T0 + 200 * DAY)).unwrap();
    engine
        .replay_start(&id(), Timeframe::D1, T0 + 10 * DAY)
        .await
        .unwrap();
    let msg = replay_err(engine.replay_set_base(Timeframe::M1).await);
    assert_eq!(
        msg,
        "a replay holds at most 200000 candles: at 1m that is 138 days from its start to its last candle, and this one spans 190 days; replay at a higher step or start later"
    );
    assert_eq!(
        engine.replay_state(Timeframe::D1, 0, 0).unwrap().base,
        Timeframe::D1
    );
    // A step that does not line up with the base is refused as such.
    let msg = replay_err(engine.replay_set_base(Timeframe::W1).await);
    assert!(msg.contains("inside a 1w candle"), "{msg}");
}

type LiveItem = Result<LiveCandle, ProviderError>;

/// A provider that serves history from in-memory series and opens any number of live
/// streams, each fed by `send`.
#[derive(Default)]
struct FakeProvider {
    series: Mutex<HashMap<Timeframe, Vec<Candle>>>,
    history_calls: Mutex<Vec<(Timeframe, Option<i64>)>>,
    streams: Mutex<Vec<(Timeframe, mpsc::UnboundedSender<LiveItem>)>>,
}

impl FakeProvider {
    fn set(&self, tf: Timeframe, candles: Vec<Candle>) {
        self.series.lock().unwrap().insert(tf, candles);
    }

    fn calls(&self, tf: Timeframe) -> usize {
        let calls = self.history_calls.lock().unwrap();
        calls.iter().filter(|(t, _)| *t == tf).count()
    }

    fn open(&self, tf: Timeframe) -> usize {
        let streams = self.streams.lock().unwrap();
        streams
            .iter()
            .filter(|(t, tx)| *t == tf && !tx.is_closed())
            .count()
    }

    fn send(&self, tf: Timeframe, candle: Candle, closed: bool) {
        for (t, tx) in self.streams.lock().unwrap().iter() {
            if *t == tf {
                let _ = tx.send(Ok(LiveCandle { candle, closed }));
            }
        }
    }
}

#[async_trait]
impl Provider for FakeProvider {
    fn source(&self) -> &str {
        "binance"
    }

    async fn instruments(&self) -> Result<Vec<Instrument>, ProviderError> {
        Ok(vec![instrument()])
    }

    async fn history(
        &self,
        _inst: &Instrument,
        tf: Timeframe,
        end_before: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Candle>, ProviderError> {
        self.history_calls.lock().unwrap().push((tf, end_before));
        let series = self.series.lock().unwrap();
        let all = series.get(&tf).cloned().unwrap_or_default();
        let end = end_before.unwrap_or(i64::MAX);
        let before: Vec<Candle> = all.into_iter().filter(|c| c.open_time < end).collect();
        Ok(before[before.len().saturating_sub(usize::from(limit))..].to_vec())
    }

    fn live(&self, _inst: &Instrument, tf: Timeframe) -> BoxStream<'static, LiveItem> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.streams.lock().unwrap().push((tf, tx));
        futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|i| (i, rx)) })
            .boxed()
    }
}

struct Live {
    engine: Engine,
    provider: Arc<FakeProvider>,
    clock: Arc<AtomicI64>,
    dir: tempfile::TempDir,
}

/// An engine with a provider over the hourly store, its clock at `now`.
fn live_engine(now: i64) -> Live {
    let dir = tempfile::tempdir().unwrap();
    store_in(&dir);
    let provider = Arc::new(FakeProvider::default());
    let clock = Arc::new(AtomicI64::new(now));
    let c = clock.clone();
    let engine = Engine::open_with_clock(
        dir.path(),
        None,
        vec![provider.clone() as Arc<dyn Provider>],
        Arc::new(move || c.load(Ordering::Relaxed)),
    )
    .unwrap();
    Live {
        engine,
        provider,
        clock,
        dir,
    }
}

#[tokio::test]
async fn a_lower_base_missing_from_the_cache_is_fetched_and_not_stored() {
    let f = live_engine(T0 + BARS * H);
    f.provider
        .set(Timeframe::M15, (0..BARS).flat_map(quarters).collect());
    f.engine
        .replay_start(&id(), TF, T0 + 550 * H)
        .await
        .unwrap();
    f.engine.replay_step(5).await.unwrap();
    let st = f.engine.replay_set_base(Timeframe::M15).await.unwrap();
    assert_eq!(st.cut, T0 + 556 * H);
    assert_eq!(st.bars.first().unwrap().open_time, bar(50).open_time);
    assert_eq!(*st.bars.last().unwrap(), quarters(555)[3]);
    // The window from bar 50 to now is 2200 quarters: three pages, walked back from now.
    assert_eq!(f.provider.calls(Timeframe::M15), 3);
    let stored = Store::open(&f.dir.path().join("sandchart.db"))
        .unwrap()
        .candles_before(&id(), Timeframe::M15, None, 10)
        .unwrap();
    assert!(stored.is_empty(), "a window is never stored");
    // Every quarter up to now was loaded: they step without asking again.
    f.engine.replay_step(4).await.unwrap();
    assert_eq!(f.provider.calls(Timeframe::M15), 3);
}

#[tokio::test]
async fn stepping_reads_newer_candles_then_catches_up_and_the_backtest_ends_there() {
    // Bars up to 597 are cached; 598 and 599 are stored later, as the chart's stream does.
    let f = live_engine(T0 + BARS * H + 1);
    Store::open(&f.dir.path().join("sandchart.db"))
        .unwrap()
        .delete_series(&id(), TF)
        .unwrap();
    let mut store = Store::open(&f.dir.path().join("sandchart.db")).unwrap();
    store
        .upsert_candles(&id(), TF, &(0..598).map(bar).collect::<Vec<_>>())
        .unwrap();
    let st = f
        .engine
        .replay_start(&id(), TF, T0 + 595 * H)
        .await
        .unwrap();
    let open = Command::Open {
        time: st.cut,
        side: Side::Long,
        stop: 10_500,
        take: 10_655,
    };
    f.engine.replay_command(open).unwrap();
    let mut chart = f.engine.subscribe_live(&id(), TF).unwrap();
    store
        .upsert_candles(&id(), TF, &[bar(598), bar(599)])
        .unwrap();
    f.engine.replay_step(2).await.unwrap();
    let st = f.engine.replay_state(TF, 0, 0).unwrap();
    assert!(
        !st.at_end && !st.caught_up && st.caught_up_at.is_none(),
        "598 and 599 came from the store"
    );
    assert_eq!(st.trades[0].reason, ExitReason::Open);
    assert_eq!(f.provider.calls(TF), 0);

    // The provider has nothing newer either (bar 600 is still forming): caught up, and the
    // backtest ends at this cut with the trade unfinished, outside the statistics.
    f.provider.set(TF, (0..=BARS).map(bar).collect());
    let at = T0 + BARS * H;
    assert_eq!(f.engine.replay_step(2).await.unwrap(), at);
    let st = f.engine.replay_state(TF, 0, 0).unwrap();
    assert!(st.at_end && st.caught_up);
    assert_eq!(st.caught_up_at, Some(at));
    assert_eq!(
        (st.trades[0].reason, st.trades[0].exit_time),
        (ExitReason::Unfinished, None)
    );
    assert_eq!(st.stats.count, 0);
    let msg = replay_err(f.engine.replay_step(1).await);
    assert_eq!(
        msg,
        "the replay has caught up with real time, so its backtest is finished: it takes no steps"
    );
    let msg = replay_err(f.engine.replay_command(Command::Close { time: st.cut }));
    assert_eq!(
        msg,
        "the replay has caught up with real time, so its backtest is finished: it takes no commands"
    );

    // Bar 600 closes reaching the take: the chart gets it, since nothing is held back any
    // more, but the backtest does not: no own stream, the cut and the trade stay.
    f.clock.store(T0 + 601 * H, Ordering::Relaxed);
    let take = Candle {
        high: 10_660,
        ..bar(BARS)
    };
    f.provider.send(TF, take, true);
    let event = tokio::time::timeout(Duration::from_secs(5), chart.receiver().recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        event,
        LiveEvent::Candle(LiveCandle {
            candle: take,
            closed: true
        })
    );
    assert_eq!(f.provider.open(TF), 1, "only the chart's stream");
    let st = f.engine.replay_state(TF, 0, 0).unwrap();
    assert_eq!(st.cut, at);
    assert_eq!(st.trades[0].reason, ExitReason::Unfinished);

    // The file ends at the catch-up cut and opens to the same unfinished trade.
    let text = String::from_utf8(f.engine.replay_export().unwrap()).unwrap();
    assert!(text.contains(&format!("\"caughtUpAt\": {at},")), "{text}");
    assert!(!text.contains(&format!("[{}, ", take.open_time)));
    let opened = f.engine.replay_open(text.as_bytes()).unwrap();
    assert!(opened.at_end && !opened.caught_up);
    assert_eq!(opened.caught_up_at, Some(at));
    assert_eq!(opened.trades[0].reason, ExitReason::Unfinished);
    let msg = replay_err(f.engine.replay_command(Command::Close { time: at }));
    assert!(msg.ends_with("it takes no commands"), "{msg}");
    f.engine.replay_exit();
    drop(chart);
}

#[tokio::test]
async fn a_start_at_the_newest_candle_has_caught_up_and_a_re_base_down_stays_finished() {
    let f = live_engine(T0 + BARS * H + 30 * 60_000);
    f.provider.set(TF, (0..=BARS).map(bar).collect());
    let quarters_now: Vec<Candle> = (0..BARS)
        .flat_map(quarters)
        .chain([quarters(BARS)[0], quarters(BARS)[1]])
        .collect();
    f.provider.set(Timeframe::M15, quarters_now);
    let st = f
        .engine
        .replay_start(&id(), TF, T0 + (BARS - 1) * H)
        .await
        .unwrap();
    assert!(st.caught_up);
    assert_eq!(st.caught_up_at, Some(T0 + BARS * H));
    // Two quarters of bar 600 closed since the cut, but the backtest ended there: a 15m
    // chart shows the quarters up to the cut and nothing to step.
    let st = f.engine.replay_set_base(Timeframe::M15).await.unwrap();
    assert!(st.caught_up && st.at_end);
    assert_eq!(
        (st.cut, st.caught_up_at),
        (T0 + BARS * H, Some(T0 + BARS * H))
    );
    assert_eq!(*st.bars.last().unwrap(), quarters(BARS - 1)[3]);
    assert!(replay_err(f.engine.replay_step(1).await).ends_with("it takes no steps"));
}
