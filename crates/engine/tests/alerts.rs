//! The alert service over a fake provider whose live streams the test drives: arming,
//! firing once, shared and own streams, caps, replay pause and drawings.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use sandchart_core::alert::{Alert, AlertKind, Direction};
use sandchart_core::{
    Anchor, Candle, Drawing, DrawingBody, Instrument, InstrumentId, Style, Timeframe,
};
use sandchart_data::{LiveCandle, Provider, ProviderError};
use sandchart_engine::{AlertEvent, Engine, EngineError, MAX_LIVE_STREAMS};
use sandchart_store::MAX_ALERT_PAIRS;
use tokio::sync::{broadcast, mpsc};

const M: i64 = 60_000;
const NOW: i64 = 1_700_000_000_000 / M * M + 1_000;

type LiveItem = Result<LiveCandle, ProviderError>;
type Opened = Vec<(Timeframe, mpsc::UnboundedSender<LiveItem>)>;

/// Every `live` call opens a new stream; the test sends into the ones still open.
#[derive(Default)]
struct FakeProvider {
    instruments: Vec<Instrument>,
    opened: Mutex<HashMap<String, Opened>>,
}

#[async_trait]
impl Provider for FakeProvider {
    fn source(&self) -> &str {
        "fake"
    }

    async fn instruments(&self) -> Result<Vec<Instrument>, ProviderError> {
        Ok(self.instruments.clone())
    }

    async fn history(
        &self,
        _inst: &Instrument,
        _tf: Timeframe,
        _end_before: Option<i64>,
        _limit: u16,
    ) -> Result<Vec<Candle>, ProviderError> {
        Ok(Vec::new())
    }

    fn live(&self, inst: &Instrument, tf: Timeframe) -> BoxStream<'static, LiveItem> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.opened
            .lock()
            .unwrap()
            .entry(inst.id.symbol.clone())
            .or_default()
            .push((tf, tx));
        futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|i| (i, rx)) })
            .boxed()
    }
}

impl FakeProvider {
    /// The timeframes of the open streams of `symbol`.
    fn open(&self, symbol: &str) -> Vec<Timeframe> {
        self.opened
            .lock()
            .unwrap()
            .get(symbol)
            .map(|v| {
                v.iter()
                    .filter(|(_, tx)| !tx.is_closed())
                    .map(|(tf, _)| *tf)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Sends to every open stream of `symbol` at `tf`.
    fn send(&self, symbol: &str, tf: Timeframe, c: Candle) {
        self.send_item(symbol, tf, c, false);
    }

    /// Sends a closed candle to every open stream of `symbol` at `tf`.
    fn send_closed(&self, symbol: &str, tf: Timeframe, c: Candle) {
        self.send_item(symbol, tf, c, true);
    }

    fn send_item(&self, symbol: &str, tf: Timeframe, c: Candle, closed: bool) {
        for (at, tx) in self
            .opened
            .lock()
            .unwrap()
            .get(symbol)
            .into_iter()
            .flatten()
        {
            if *at == tf && !tx.is_closed() {
                let _ = tx.send(Ok(LiveCandle { candle: c, closed }));
            }
        }
    }
}

fn id(symbol: &str) -> InstrumentId {
    InstrumentId {
        source: "fake".into(),
        symbol: symbol.into(),
    }
}

fn inst(symbol: &str) -> Instrument {
    Instrument {
        id: id(symbol),
        base: symbol.into(),
        quote: "USDT".into(),
        price_scale: 2,
        qty_scale: 3,
    }
}

/// A bar opening at `open_time` with its range and close so far.
fn bar(open_time: i64, low: i64, high: i64, close: i64) -> Candle {
    Candle {
        open_time,
        open: close,
        high,
        low,
        close,
        volume: 1,
    }
}

struct Fixture {
    engine: Arc<Engine>,
    provider: Arc<FakeProvider>,
    events: broadcast::Receiver<AlertEvent>,
    clock: Arc<AtomicI64>,
    _dir: tempfile::TempDir,
}

async fn fixture(symbols: &[&str]) -> Fixture {
    fixture_in(tempfile::tempdir().unwrap(), symbols).await
}

async fn fixture_in(dir: tempfile::TempDir, symbols: &[&str]) -> Fixture {
    let provider = Arc::new(FakeProvider {
        instruments: symbols.iter().map(|s| inst(s)).collect(),
        ..FakeProvider::default()
    });
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let engine = Arc::new(
        Engine::open_with_clock(
            dir.path(),
            None,
            vec![provider.clone() as Arc<dyn Provider>],
            Arc::new(move || now.load(Ordering::Relaxed)),
        )
        .unwrap(),
    );
    engine.sync_instruments("fake").await.unwrap();
    let events = engine.alert_events();
    let service = engine.clone();
    tokio::spawn(async move { service.run_alerts().await });
    Fixture {
        engine,
        provider,
        events,
        clock,
        _dir: dir,
    }
}

fn price_alert(alert_id: &str, symbol: &str, price: i64, direction: Direction) -> Alert {
    Alert {
        id: alert_id.into(),
        instrument: id(symbol),
        price_scale: 2,
        kind: AlertKind::Price { price },
        direction,
        active: false,
        created_at: 0,
        triggered_at: None,
        triggered_price: None,
    }
}

fn line_alert(alert_id: &str, symbol: &str, drawing_id: &str) -> Alert {
    Alert {
        kind: AlertKind::Drawing {
            drawing_id: drawing_id.into(),
        },
        ..price_alert(alert_id, symbol, 0, Direction::Cross)
    }
}

fn drawing(drawing_id: &str, symbol: &str, body: DrawingBody) -> Drawing {
    Drawing {
        id: drawing_id.into(),
        instrument: id(symbol),
        price_scale: 2,
        body,
        style: Style {
            color: 0,
            width: 1,
            dash: false,
        },
        locked: false,
        z: 0,
        updated_at: 0,
    }
}

/// Polls `f` until it is true (5 s at most).
async fn until(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..500 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting until {what}");
}

/// The next alert event other than `Changed`.
async fn next_fired(events: &mut broadcast::Receiver<AlertEvent>) -> Alert {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("timed out waiting for an alert to fire")
            .unwrap();
        if let AlertEvent::Fired(a) = e {
            return a;
        }
    }
}

/// No alert fires within a short while.
async fn none_fired(events: &mut broadcast::Receiver<AlertEvent>) {
    tokio::time::sleep(Duration::from_millis(100)).await;
    loop {
        match events.try_recv() {
            Ok(AlertEvent::Fired(a)) => panic!("{} fired", a.id),
            Ok(AlertEvent::Changed) => continue,
            Err(_) => return,
        }
    }
}

#[tokio::test]
async fn a_price_alert_fires_once_on_the_engines_own_stream() {
    let mut f = fixture(&["BTCUSDT"]).await;
    let set = f
        .engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Above))
        .await
        .unwrap();
    assert!(set.active);
    assert_eq!(set.created_at, NOW);
    until("the alert stream opens", || {
        f.provider.open("BTCUSDT") == [Timeframe::M1]
    })
    .await;

    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_980, 9_990, 9_990));
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_980, 10_005, 10_002));
    let fired = next_fired(&mut f.events).await;
    assert_eq!(fired.id, "a1");
    assert!(!fired.active);
    assert_eq!(fired.triggered_at, Some(NOW));
    assert_eq!(fired.triggered_price, Some(10_002));
    assert_eq!(f.engine.alerts().await.unwrap(), vec![fired]);

    // Nothing is armed on the pair any more, so its stream closes; a later cross is silent.
    until("the alert stream closes", || p.open("BTCUSDT").is_empty()).await;
    none_fired(&mut f.events).await;
}

#[tokio::test]
async fn a_bar_that_opens_past_the_level_fires_and_rearming_waits_for_the_next_cross() {
    let mut f = fixture(&["BTCUSDT"]).await;
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Cross))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 10_010, 10_020, 10_015));
    p.send("BTCUSDT", Timeframe::M1, bar(M, 9_950, 9_960, 9_955));
    let fired = next_fired(&mut f.events).await;
    assert_eq!(fired.triggered_price, Some(9_955));

    until("the alert stream closes", || p.open("BTCUSDT").is_empty()).await;
    let again = f.engine.rearm_alert("a1").await.unwrap();
    assert!(again.active);
    assert_eq!(again.triggered_at, None);
    until("the alert stream opens again", || {
        !p.open("BTCUSDT").is_empty()
    })
    .await;
    // The first update after arming is only the baseline.
    p.send("BTCUSDT", Timeframe::M1, bar(M, 9_950, 9_960, 9_955));
    p.send("BTCUSDT", Timeframe::M1, bar(M, 9_950, 9_990, 9_990));
    none_fired(&mut f.events).await;
    p.send("BTCUSDT", Timeframe::M1, bar(M, 9_950, 10_030, 10_030));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(10_030)
    );
}

#[tokio::test]
async fn the_charts_stream_is_shared_and_the_own_one_comes_back_when_it_ends() {
    let mut f = fixture(&["BTCUSDT"]).await;
    let chart = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Below))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        f.provider.open("BTCUSDT"),
        [Timeframe::H1],
        "no second stream"
    );

    drop(chart);
    until("the engine opens its own stream", || {
        f.provider.open("BTCUSDT") == [Timeframe::M1]
    })
    .await;
    let mut chart = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    until("the own stream gives way to the chart's", || {
        f.provider.open("BTCUSDT") == [Timeframe::H1]
    })
    .await;

    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::H1, bar(0, 10_010, 10_100, 10_050));
    // A new low of the same bar reaches the level: the level is the fired price.
    p.send("BTCUSDT", Timeframe::H1, bar(0, 9_990, 10_100, 10_020));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(10_000)
    );
    // The chart still gets every candle.
    assert!(chart.receiver().recv().await.is_some());
}

#[tokio::test]
async fn after_a_change_of_stream_only_the_closes_count() {
    let mut f = fixture(&["BTCUSDT"]).await;
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Above))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_900, 9_950, 9_950));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _chart = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    // The hour bar's high is from before; its close is still below the level.
    p.send("BTCUSDT", Timeframe::H1, bar(0, 9_000, 10_500, 9_960));
    none_fired(&mut f.events).await;
    p.send("BTCUSDT", Timeframe::H1, bar(0, 9_000, 10_500, 10_001));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(10_001)
    );
}

#[tokio::test]
async fn a_replayed_pair_is_not_evaluated_and_resumes_from_the_last_price() {
    let mut f = fixture(&["BTCUSDT"]).await;
    let h = 60 * M;
    let open = NOW / h * h;
    let mut chart = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Above))
        .await
        .unwrap();
    until("the chart stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    // A closed bar to replay from (stored before its event comes), then the baseline.
    f.provider.opened.lock().unwrap()["BTCUSDT"][0]
        .1
        .send(Ok(LiveCandle {
            candle: bar(open - h, 9_000, 9_100, 9_050),
            closed: true,
        }))
        .unwrap();
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::H1, bar(open, 9_900, 9_950, 9_950));
    for _ in 0..2 {
        chart.receiver().recv().await.unwrap();
    }
    f.engine
        .replay_start(&id("BTCUSDT"), Timeframe::H1, open - h)
        .await
        .unwrap();
    p.send("BTCUSDT", Timeframe::H1, bar(open, 9_900, 10_200, 10_100));
    none_fired(&mut f.events).await;
    f.engine.replay_exit();
    // The first update after the replay is compared with the last one before it.
    p.send("BTCUSDT", Timeframe::H1, bar(open, 9_900, 10_200, 10_150));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(10_150)
    );
    drop(chart);
}

#[tokio::test]
async fn a_line_alert_follows_its_drawing_and_goes_with_it() {
    let mut f = fixture(&["BTCUSDT", "ETHUSDT"]).await;
    let e = &f.engine;
    e.save_drawing(drawing("h1", "BTCUSDT", DrawingBody::Hline { p: 10_000 }))
        .await
        .unwrap();
    e.save_drawing(drawing(
        "n1",
        "BTCUSDT",
        DrawingBody::Note {
            t: 0,
            text: "x".into(),
        },
    ))
    .await
    .unwrap();
    e.save_drawing(drawing("h2", "ETHUSDT", DrawingBody::Hline { p: 5 }))
        .await
        .unwrap();
    let err = e
        .set_alert(line_alert("a", "BTCUSDT", "n1"))
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("horizontal or a trend line"),
        "{err}"
    );
    let err = e
        .set_alert(line_alert("a", "BTCUSDT", "h2"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("another pair"), "{err}");
    let err = e
        .set_alert(line_alert("a", "BTCUSDT", "nope"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("does not exist"), "{err}");
    assert!(e.alerts().await.unwrap().is_empty());

    e.set_alert(line_alert("a", "BTCUSDT", "h1")).await.unwrap();
    // Moving the line moves the level.
    e.save_drawing(drawing("h1", "BTCUSDT", DrawingBody::Hline { p: 11_000 }))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 10_500, 10_500, 10_500));
    p.send("BTCUSDT", Timeframe::M1, bar(0, 10_500, 10_900, 10_900));
    none_fired(&mut f.events).await;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 10_500, 11_000, 11_000));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(11_000)
    );

    e.rearm_alert("a").await.unwrap();
    while f.events.try_recv().is_ok() {}
    e.delete_drawing("h1").await.unwrap();
    assert!(e.alerts().await.unwrap().is_empty());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), f.events.recv())
            .await
            .unwrap()
            .unwrap(),
        AlertEvent::Changed
    );
    until("the alert stream closes", || p.open("BTCUSDT").is_empty()).await;
}

#[tokio::test]
async fn a_trend_line_alert_fires_when_the_line_meets_the_price() {
    let mut f = fixture(&["BTCUSDT"]).await;
    let e = &f.engine;
    // Rising 1 tick a second from 9 900 at NOW, extended to the right.
    let body = DrawingBody::Trend {
        a: Anchor { t: NOW, p: 9_900 },
        b: Anchor {
            t: NOW + 100_000,
            p: 10_000,
        },
        extend_left: false,
        extend_right: true,
    };
    e.save_drawing(drawing("t1", "BTCUSDT", body))
        .await
        .unwrap();
    e.set_alert(line_alert("a", "BTCUSDT", "t1")).await.unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_950, 9_950, 9_950));
    tokio::time::sleep(Duration::from_millis(50)).await;
    f.clock.store(NOW + 40_000, Ordering::Relaxed); // the line is at 9 940
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_950, 9_950, 9_950));
    none_fired(&mut f.events).await;
    f.clock.store(NOW + 60_000, Ordering::Relaxed); // 9 960: it passed the price
    p.send("BTCUSDT", Timeframe::M1, bar(M, 9_950, 9_950, 9_950));
    assert_eq!(next_fired(&mut f.events).await.triggered_price, Some(9_950));
}

#[tokio::test]
async fn arming_past_the_pair_cap_is_refused() {
    let symbols: Vec<String> = (0..=MAX_ALERT_PAIRS).map(|i| format!("P{i}")).collect();
    let refs: Vec<&str> = symbols.iter().map(String::as_str).collect();
    let f = fixture(&refs).await;
    for s in &symbols[..MAX_ALERT_PAIRS] {
        f.engine
            .set_alert(price_alert(s, s, 100, Direction::Cross))
            .await
            .unwrap();
    }
    let last = &symbols[MAX_ALERT_PAIRS];
    let err = f
        .engine
        .set_alert(price_alert(last, last, 100, Direction::Cross))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("30 pairs"), "{err}");
    until("every armed pair has a stream", || {
        symbols[..MAX_ALERT_PAIRS]
            .iter()
            .all(|s| f.provider.open(s).len() == 1)
    })
    .await;
}

#[tokio::test]
async fn every_stream_counts_toward_the_cap() {
    let symbols: Vec<String> = (0..MAX_LIVE_STREAMS + 1).map(|i| format!("P{i}")).collect();
    let refs: Vec<&str> = symbols.iter().map(String::as_str).collect();
    let f = fixture(&refs).await;
    f.engine
        .set_alert(price_alert("a", "P0", 100, Direction::Cross))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("P0").is_empty()
    })
    .await;
    let mut charts = Vec::new();
    for s in &symbols[1..MAX_LIVE_STREAMS] {
        charts.push(f.engine.subscribe_live(&id(s), Timeframe::H1).unwrap());
    }
    let err = f
        .engine
        .subscribe_live(&id(&symbols[MAX_LIVE_STREAMS]), Timeframe::H1)
        .err()
        .unwrap();
    assert!(
        matches!(&err, EngineError::Alert(m) if m.contains("32")),
        "{err}"
    );
    // An alert on a pair without a stream cannot get one now; on a streamed pair it can.
    let err = f
        .engine
        .set_alert(price_alert(
            "b",
            &symbols[MAX_LIVE_STREAMS],
            1,
            Direction::Cross,
        ))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("live streams"), "{err}");
    f.engine
        .set_alert(price_alert("c", "P5", 1, Direction::Cross))
        .await
        .unwrap();
    // A stopped stream frees its slot once its task is gone.
    charts.pop();
    let last = id(&symbols[MAX_LIVE_STREAMS]);
    let mut tries = 0;
    while f.engine.subscribe_live(&last, Timeframe::H1).is_err() {
        tries += 1;
        assert!(tries < 500, "the slot was never freed");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn stored_alerts_are_armed_when_the_service_starts() {
    let first = fixture(&["BTCUSDT"]).await;
    first
        .engine
        .set_alert(price_alert("a", "BTCUSDT", 100, Direction::Cross))
        .await
        .unwrap();
    let dir = first._dir;
    let second = fixture_in(dir, &["BTCUSDT"]).await;
    until("the stored alert gets a stream", || {
        !second.provider.open("BTCUSDT").is_empty()
    })
    .await;
}

#[tokio::test]
async fn deleting_an_alert_disarms_it() {
    let mut f = fixture(&["BTCUSDT"]).await;
    f.engine
        .set_alert(price_alert("a", "BTCUSDT", 100, Direction::Cross))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    f.engine.delete_alert("a").await.unwrap();
    f.engine.delete_alert("a").await.unwrap();
    until("the alert stream closes", || {
        f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    assert!(f.engine.alerts().await.unwrap().is_empty());
    none_fired(&mut f.events).await;
}

#[tokio::test]
async fn alerts_another_process_sets_or_deletes_are_armed_or_disarmed() {
    let f = fixture(&["BTCUSDT"]).await;
    // The MCP server: a second engine on the same data folder, without the alert service.
    let other = Engine::open_secondary(
        f._dir.path(),
        None,
        vec![f.provider.clone() as Arc<dyn Provider>],
    )
    .unwrap();
    other
        .set_alert(price_alert("a", "BTCUSDT", 100, Direction::Cross))
        .await
        .unwrap();
    until("the app arms the other process's alert", || {
        f.provider.open("BTCUSDT") == [Timeframe::M1]
    })
    .await;
    other.delete_alert("a").await.unwrap();
    until("the app disarms it", || {
        f.provider.open("BTCUSDT").is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_drawing_saved_as_another_kind_takes_its_alerts_with_it() {
    let mut f = fixture(&["BTCUSDT"]).await;
    let e = &f.engine;
    e.save_drawing(drawing("h1", "BTCUSDT", DrawingBody::Hline { p: 10_000 }))
        .await
        .unwrap();
    e.set_alert(line_alert("a", "BTCUSDT", "h1")).await.unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    // Fired, so nothing is armed on the line any more; the panel must still hear of it.
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_990, 9_990, 9_990));
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_990, 10_000, 10_000));
    next_fired(&mut f.events).await;
    while f.events.try_recv().is_ok() {}
    let note = DrawingBody::Note {
        t: 0,
        text: "x".into(),
    };
    e.save_drawing(drawing("h1", "BTCUSDT", note))
        .await
        .unwrap();
    assert!(e.alerts().await.unwrap().is_empty());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), f.events.recv())
            .await
            .unwrap()
            .unwrap(),
        AlertEvent::Changed
    );
    until("the alert stream closes", || {
        f.provider.open("BTCUSDT").is_empty()
    })
    .await;
}

/// Runs one SQL batch on the fixture's database from another connection.
fn sql(dir: &std::path::Path, batch: &str) {
    let conn = rusqlite::Connection::open(dir.join("sandchart.db")).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn.execute_batch(batch).unwrap();
}

#[tokio::test]
async fn a_firing_that_cannot_be_stored_is_still_reported_and_stored_on_the_retry() {
    let mut f = fixture(&["BTCUSDT"]).await;
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Above))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    // The write of the firing fails: the table is gone for a moment.
    sql(f._dir.path(), "ALTER TABLE alerts RENAME TO alerts_away");
    let p = &f.provider;
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_980, 9_990, 9_990));
    p.send("BTCUSDT", Timeframe::M1, bar(0, 9_980, 10_005, 10_002));
    let fired = next_fired(&mut f.events).await;
    assert_eq!(fired.id, "a1");
    sql(f._dir.path(), "ALTER TABLE alerts_away RENAME TO alerts");
    let mut stored = Vec::new();
    for _ in 0..300 {
        stored = f.engine.alerts().await.unwrap();
        if stored.iter().all(|a| !a.active) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(stored, vec![fired]);
    none_fired(&mut f.events).await;
}

/// Stored candles of `symbol`, every timeframe.
fn stored_candles(dir: &std::path::Path, symbol: &str) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("sandchart.db")).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM candles WHERE symbol = ?1",
        [symbol],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn the_engines_own_stream_only_evaluates_and_stores_nothing() {
    let mut f = fixture(&["BTCUSDT"]).await;
    f.engine
        .set_alert(price_alert("a1", "BTCUSDT", 10_000, Direction::Above))
        .await
        .unwrap();
    until("the alert stream opens", || {
        !f.provider.open("BTCUSDT").is_empty()
    })
    .await;
    let p = &f.provider;
    p.send_closed("BTCUSDT", Timeframe::M1, bar(0, 9_980, 9_990, 9_990));
    p.send_closed("BTCUSDT", Timeframe::M1, bar(M, 9_980, 10_005, 10_002));
    assert_eq!(
        next_fired(&mut f.events).await.triggered_price,
        Some(10_002)
    );
    assert_eq!(stored_candles(f._dir.path(), "BTCUSDT"), 0);
}
