//! The engine's indicator service: install, chart instances and compute over cached bars.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{LiveCandle, Provider, ProviderError};
use sandchart_engine::{Engine, EngineError, Instance, InstanceResult, LiveHandle};
use sandchart_indicators::{ParamValue, SeriesData};
use tokio::sync::mpsc;

const H: i64 = 3_600_000;
const NOW_OPEN: i64 = 1_700_000_000_000 / H * H;
const NOW: i64 = NOW_OPEN + 1_000;
const TF: Timeframe = Timeframe::H1;

type LiveItem = Result<LiveCandle, ProviderError>;

/// Serves queued history pages and one live stream per symbol.
struct FakeProvider {
    instruments: Vec<Instrument>,
    pages: Mutex<VecDeque<Vec<Candle>>>,
    live_rx: Mutex<HashMap<String, mpsc::UnboundedReceiver<LiveItem>>>,
    live_tx: HashMap<String, mpsc::UnboundedSender<LiveItem>>,
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
        Ok(self.pages.lock().unwrap().pop_front().unwrap_or_default())
    }

    fn live(&self, inst: &Instrument, _tf: Timeframe) -> BoxStream<'static, LiveItem> {
        let rx = self
            .live_rx
            .lock()
            .unwrap()
            .remove(&inst.id.symbol)
            .expect("live called once per instrument");
        futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|i| (i, rx)) })
            .boxed()
    }
}

fn id(symbol: &str) -> InstrumentId {
    InstrumentId {
        source: "fake".into(),
        symbol: symbol.into(),
    }
}

/// Hourly candle `back` candles before the current one, with close `close` ticks
/// (price scale 2, so 10000 ticks is 100.0).
fn candle(back: i64, close: i64) -> Candle {
    Candle {
        open_time: NOW_OPEN - back * H,
        open: close,
        high: close + 50,
        low: close - 50,
        close,
        volume: 1_000,
    }
}

/// The three newest candles, closes 100.00, 101.00 and 102.00.
fn three() -> Vec<Candle> {
    vec![candle(2, 10_000), candle(1, 10_100), candle(0, 10_200)]
}

struct Fixture {
    engine: Engine,
    provider: Arc<FakeProvider>,
    dir: tempfile::TempDir,
    cache: tempfile::TempDir,
}

fn open(data: &Path, cache: Option<&Path>, provider: &Arc<FakeProvider>) -> Engine {
    Engine::open_with_clock(
        data,
        cache,
        vec![provider.clone() as Arc<dyn Provider>],
        Arc::new(|| NOW),
    )
    .unwrap()
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut live_rx = HashMap::new();
    let mut live_tx = HashMap::new();
    let instruments: Vec<Instrument> = ["BTCUSDT", "ETHUSDT"]
        .iter()
        .map(|s| {
            let (tx, rx) = mpsc::unbounded_channel();
            live_rx.insert(s.to_string(), rx);
            live_tx.insert(s.to_string(), tx);
            Instrument {
                id: id(s),
                base: s.to_string(),
                quote: "USDT".into(),
                price_scale: 2,
                qty_scale: 3,
            }
        })
        .collect();
    let provider = Arc::new(FakeProvider {
        instruments,
        pages: Mutex::default(),
        live_rx: Mutex::new(live_rx),
        live_tx,
    });
    let engine = open(dir.path(), Some(cache.path()), &provider);
    engine.sync_instruments("fake").await.unwrap();
    Fixture {
        engine,
        provider,
        dir,
        cache,
    }
}

impl Fixture {
    /// Stores `candles` as the newest page of `symbol` through `load_chart`.
    async fn cache_candles(&self, symbol: &str, candles: Vec<Candle>) {
        self.provider.pages.lock().unwrap().push_back(candles);
        self.engine.load_chart(&id(symbol), TF, None).await.unwrap();
    }

    async fn install(&self, guest: &str) {
        self.engine
            .install_indicator(guest_bytes(guest))
            .await
            .unwrap();
    }

    async fn compute(&self, from_time: i64) -> Vec<InstanceResult> {
        self.compute_for("BTCUSDT", from_time).await
    }

    async fn compute_for(&self, symbol: &str, from_time: i64) -> Vec<InstanceResult> {
        self.engine
            .compute_indicators(&id(symbol), TF, from_time)
            .await
            .unwrap()
    }
}

fn guest_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../indicators/target/wasm32-wasip2/release")
        .join(format!("testguest_{name}.wasm"))
}

fn guest_bytes(name: &str) -> Vec<u8> {
    let path = guest_path(name);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}. Build the test guests first: \
             cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release",
            path.display()
        )
    })
}

fn instance(name: &str, module_id: &str, params: Vec<(&str, ParamValue)>) -> Instance {
    Instance {
        instance: name.into(),
        module_id: module_id.into(),
        params: params.into_iter().map(|(k, v)| (k.into(), v)).collect(),
        colors: HashMap::new(),
        hidden: false,
    }
}

fn sma(period: i64) -> Instance {
    instance(
        "sma",
        "builtin.sma",
        vec![("period", ParamValue::Int(period))],
    )
}

fn echo() -> Instance {
    instance("echo", "test.echo", vec![])
}

/// The values of the first series of an instance's result.
fn values(r: &InstanceResult) -> Vec<f64> {
    let computed = r.result.as_ref().expect("instance computed");
    match &computed.series[0].data {
        SeriesData::Values(v) => v.clone(),
        SeriesData::Markers(_) => panic!("expected values"),
    }
}

fn result<'a>(results: &'a [InstanceResult], name: &str) -> &'a InstanceResult {
    results
        .iter()
        .find(|r| r.instance == name)
        .unwrap_or_else(|| panic!("no result for {name}"))
}

fn same(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| (x.is_nan() && y.is_nan()) || x == y)
}

async fn next_event(handle: &mut LiveHandle) {
    tokio::time::timeout(Duration::from_secs(5), handle.receiver().recv())
        .await
        .expect("timed out waiting for a live event")
        .expect("live channel closed");
}

#[tokio::test]
async fn open_returns_before_compiling_and_lists_builtins() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Arc::new(FakeProvider {
        instruments: vec![],
        pages: Mutex::default(),
        live_rx: Mutex::default(),
        live_tx: HashMap::new(),
    });
    let engine = open(dir.path(), None, &provider);
    assert!(
        !engine.indicators_ready(),
        "Engine::open must not wait for module compilation"
    );
    let list = engine.indicators().await;
    assert!(engine.indicators_ready());
    let ids: Vec<&str> = list.iter().map(|i| i.meta.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "builtin.sma",
            "builtin.ema",
            "builtin.bollinger",
            "builtin.rsi",
            "builtin.macd"
        ]
    );
    assert!(list.iter().all(|i| i.builtin && !i.repaints));
}

#[tokio::test]
async fn installed_indicator_is_listed_and_persists() {
    let f = fixture().await;
    assert_eq!(
        f.engine
            .inspect_indicator(&guest_bytes("ok_echo"))
            .await
            .unwrap()
            .replaces,
        None
    );
    let info = f
        .engine
        .install_indicator(guest_bytes("ok_echo"))
        .await
        .unwrap();
    assert_eq!(info.meta.id, "test.echo");
    assert!(!info.builtin && !info.repaints);

    let list = f.engine.indicators().await;
    assert_eq!(list.len(), 6);
    assert_eq!(list.last().unwrap().meta.id, "test.echo");
    let files: Vec<_> = std::fs::read_dir(f.dir.path().join("indicators"))
        .unwrap()
        .collect();
    assert_eq!(files.len(), 1);

    let inspection = f
        .engine
        .inspect_indicator(&guest_bytes("ok_echo"))
        .await
        .unwrap();
    assert_eq!(inspection.meta.id, "test.echo");
    assert_eq!(inspection.replaces.as_deref(), Some("0.1.0"));

    // Re-installing the same id keeps one file and one entry.
    f.install("ok_echo").await;
    assert_eq!(f.engine.indicators().await.len(), 6);

    drop(f.engine);
    let reopened = open(f.dir.path(), Some(f.cache.path()), &f.provider);
    let list = reopened.indicators().await;
    let echo = list.iter().find(|i| i.meta.id == "test.echo").unwrap();
    assert!(!echo.builtin);
}

#[tokio::test]
async fn reserved_and_invalid_modules_are_rejected() {
    let f = fixture().await;
    let err = f
        .engine
        .install_indicator(guest_bytes("builtin_evil"))
        .await
        .unwrap_err();
    assert!(matches!(err, EngineError::Indicator(_)), "{err:?}");
    assert!(err.to_string().contains("builtin.evil"), "{err}");
    assert!(
        f.engine
            .inspect_indicator(&guest_bytes("builtin_evil"))
            .await
            .is_err()
    );
    let err = f
        .engine
        .install_indicator(b"not wasm".to_vec())
        .await
        .unwrap_err();
    assert!(matches!(err, EngineError::Indicator(_)), "{err:?}");
    assert_eq!(f.engine.indicators().await.len(), 5);
}

#[tokio::test]
async fn repainting_module_is_flagged() {
    let f = fixture().await;
    let info = f
        .engine
        .install_indicator(guest_bytes("repaints"))
        .await
        .unwrap();
    assert!(info.repaints);
    let listed = f.engine.indicators().await;
    assert!(
        listed
            .iter()
            .find(|i| i.meta.id == "test.repaints")
            .unwrap()
            .repaints
    );
}

#[tokio::test]
async fn remove_drops_module_and_its_instances() {
    let f = fixture().await;
    f.install("ok_echo").await;
    f.engine
        .set_chart_indicators(vec![sma(2), echo()])
        .await
        .unwrap();
    f.engine.remove_indicator("test.echo").await.unwrap();
    assert_eq!(f.engine.indicators().await.len(), 5);
    let instances = f.engine.chart_indicators().await.unwrap();
    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].module_id, "builtin.sma");
    assert_eq!(
        std::fs::read_dir(f.dir.path().join("indicators"))
            .unwrap()
            .count(),
        0
    );
    assert!(f.engine.remove_indicator("builtin.sma").await.is_err());
    assert!(f.engine.remove_indicator("test.echo").await.is_err());
}

#[tokio::test]
async fn saved_params_are_resolved_and_orphans_dropped() {
    let f = fixture().await;
    let mut colored = sma(100_000);
    colored.colors.insert("sma".into(), 3);
    colored.hidden = true;
    f.engine
        .set_chart_indicators(vec![colored, instance("gone", "test.gone", vec![])])
        .await
        .unwrap();
    let got = f.engine.chart_indicators().await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].instance, "sma");
    assert_eq!(
        got[0].params,
        vec![
            ("period".to_string(), ParamValue::Int(20)),
            ("source".to_string(), ParamValue::Choice("close".into())),
        ]
    );
    assert_eq!(got[0].colors.get("sma"), Some(&3));
    assert!(got[0].hidden);
}

#[tokio::test]
async fn computes_in_price_units_over_cached_candles() {
    let f = fixture().await;
    f.install("ok_echo").await;
    f.cache_candles("BTCUSDT", three()).await;
    let mut hidden = instance("hidden", "builtin.ema", vec![]);
    hidden.hidden = true;
    f.engine
        .set_chart_indicators(vec![sma(2), echo(), hidden])
        .await
        .unwrap();

    let results = f.compute(i64::MIN).await;
    assert_eq!(results.len(), 2, "hidden instances are not computed");
    assert!(same(
        &values(result(&results, "echo")),
        &[100.0, 101.0, 102.0]
    ));
    assert!(same(
        &values(result(&results, "sma")),
        &[f64::NAN, 100.5, 101.5]
    ));
    let c = result(&results, "echo").result.as_ref().unwrap();
    assert_eq!(c.first_time, NOW_OPEN - 2 * H);
    assert_eq!(c.last_time, NOW_OPEN);
    assert!(c.log.contains("echo 3 bars"), "{:?}", c.log);
}

#[tokio::test]
async fn from_time_cuts_values_and_rebases_markers() {
    let f = fixture().await;
    f.install("ok_echo").await;
    f.install("markers").await;
    f.cache_candles("BTCUSDT", three()).await;
    f.engine
        .set_chart_indicators(vec![echo(), instance("marks", "test.markers", vec![])])
        .await
        .unwrap();

    let results = f.compute(NOW_OPEN - H).await;
    assert!(same(&values(result(&results, "echo")), &[101.0, 102.0]));
    let marks = result(&results, "marks").result.as_ref().unwrap();
    assert_eq!(marks.first_time, NOW_OPEN - H);
    assert_eq!(marks.last_time, NOW_OPEN);
    let SeriesData::Markers(m) = &marks.series[0].data else {
        panic!("expected markers");
    };
    let got: Vec<(u32, Option<&str>)> = m.iter().map(|m| (m.index, m.text.as_deref())).collect();
    assert_eq!(got, [(0, Some("1")), (1, Some("2"))]);
}

#[tokio::test]
async fn a_failing_instance_does_not_fail_the_others() {
    let f = fixture().await;
    f.install("loop_forever").await;
    f.cache_candles("BTCUSDT", three()).await;
    f.engine
        .set_chart_indicators(vec![
            instance(
                "spin",
                "test.loop",
                vec![("spin", ParamValue::Boolean(true))],
            ),
            sma(2),
        ])
        .await
        .unwrap();
    let results = f.compute(i64::MIN).await;
    let err = result(&results, "spin").result.as_ref().unwrap_err();
    assert!(err.contains("fuel"), "{err}");
    assert!(same(
        &values(result(&results, "sma")),
        &[f64::NAN, 100.5, 101.5]
    ));
}

#[tokio::test]
async fn bar_cache_and_memo_follow_store_writes() {
    let f = fixture().await;
    f.install("ok_echo").await;
    f.cache_candles("BTCUSDT", three()).await;
    f.engine
        .set_chart_indicators(vec![sma(2), echo()])
        .await
        .unwrap();

    f.compute(i64::MIN).await;
    f.compute(i64::MIN).await;
    let s = f.engine.indicator_stats();
    assert_eq!((s.store_reads, s.module_calls), (1, 2), "memo hit");

    // A different window is a new result, but the bars come from the cache. The memo
    // keeps one result per instance, so going back computes again.
    f.compute(NOW_OPEN).await;
    f.compute(i64::MIN).await;
    let s = f.engine.indicator_stats();
    assert_eq!((s.store_reads, s.module_calls), (1, 6));

    let mut handle = f.engine.subscribe_live(&id("BTCUSDT"), TF).unwrap();
    let live_tx = f.provider.live_tx["BTCUSDT"].clone();

    // The same candle again changes nothing.
    live_tx
        .send(Ok(LiveCandle {
            candle: candle(0, 10_200),
            closed: true,
        }))
        .unwrap();
    next_event(&mut handle).await;
    f.compute(i64::MIN).await;
    let s = f.engine.indicator_stats();
    assert_eq!((s.store_reads, s.module_calls), (1, 6));

    // A changed close is applied in place and recomputed.
    live_tx
        .send(Ok(LiveCandle {
            candle: candle(0, 10_400),
            closed: true,
        }))
        .unwrap();
    next_event(&mut handle).await;
    let results = f.compute(i64::MIN).await;
    assert!(same(
        &values(result(&results, "echo")),
        &[100.0, 101.0, 104.0]
    ));
    let s = f.engine.indicator_stats();
    assert_eq!((s.store_reads, s.module_calls), (1, 8));

    // A newer candle is appended in place.
    live_tx
        .send(Ok(LiveCandle {
            candle: candle(-1, 10_500),
            closed: true,
        }))
        .unwrap();
    next_event(&mut handle).await;
    let results = f.compute(i64::MIN).await;
    assert!(same(
        &values(result(&results, "echo")),
        &[100.0, 101.0, 104.0, 105.0]
    ));
    assert_eq!(f.engine.indicator_stats().store_reads, 1);
    drop(handle);

    // An older page stored by load_chart drops the cache.
    f.provider
        .pages
        .lock()
        .unwrap()
        .push_back(vec![candle(4, 9_800), candle(3, 9_900)]);
    f.engine
        .load_chart(&id("BTCUSDT"), TF, Some(NOW_OPEN - 2 * H))
        .await
        .unwrap();
    let results = f.compute(i64::MIN).await;
    assert_eq!(f.engine.indicator_stats().store_reads, 2);
    assert!(same(
        &values(result(&results, "echo")),
        &[98.0, 99.0, 100.0, 101.0, 104.0, 105.0]
    ));

    // Another instrument replaces the cache; coming back reads the store again.
    f.cache_candles("ETHUSDT", three()).await;
    f.compute_for("ETHUSDT", i64::MIN).await;
    assert_eq!(f.engine.indicator_stats().store_reads, 3);
    f.compute(i64::MIN).await;
    assert_eq!(f.engine.indicator_stats().store_reads, 4);
}

#[tokio::test]
async fn csv_import_drops_the_bar_cache() {
    let f = fixture().await;
    f.install("ok_echo").await;
    f.engine.set_chart_indicators(vec![echo()]).await.unwrap();
    let path = f.dir.path().join("x.csv");
    std::fs::write(&path, "time,open,high,low,close,volume\n0,1,1,1,1,1\n").unwrap();
    let csv = f.engine.import_csv(&path, "X", TF).unwrap();
    f.engine.compute_indicators(&csv, TF, 0).await.unwrap();
    std::fs::write(
        &path,
        "time,open,high,low,close,volume\n3600000,2,2,2,2,2\n",
    )
    .unwrap();
    f.engine.import_csv(&path, "X", TF).unwrap();
    let results = f.engine.compute_indicators(&csv, TF, 0).await.unwrap();
    assert_eq!(f.engine.indicator_stats().store_reads, 2);
    assert!(same(&values(&results[0]), &[1.0, 2.0]));
}
