use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{DayChange, LiveCandle, Provider, ProviderError};
use sandchart_engine::{ConnectionState, Engine, LiveEvent, LiveHandle};
use sandchart_store::Store;
use tokio::sync::mpsc;

const H: i64 = 3_600_000;
/// The fixed "now" of every test: the middle of the candle at `NOW_OPEN`.
const NOW_OPEN: i64 = 1_700_000_000_000 / H * H;
const NOW: i64 = NOW_OPEN + 1_000;

type LiveItem = Result<LiveCandle, ProviderError>;

struct FakeProvider {
    instruments: Vec<Instrument>,
    pages: Mutex<VecDeque<Result<Vec<Candle>, ProviderError>>>,
    history_calls: Mutex<Vec<(Option<i64>, u16)>>,
    quote_calls: Mutex<Vec<usize>>,
    live_rx: Mutex<HashMap<String, mpsc::UnboundedReceiver<LiveItem>>>,
    live_tx: HashMap<String, mpsc::UnboundedSender<LiveItem>>,
}

impl FakeProvider {
    /// Returns the provider and the live sender of the first instrument (or a dummy).
    fn new(instruments: Vec<Instrument>) -> (Arc<FakeProvider>, mpsc::UnboundedSender<LiveItem>) {
        let mut live_rx = HashMap::new();
        let mut live_tx = HashMap::new();
        for i in &instruments {
            let (tx, rx) = mpsc::unbounded_channel();
            live_rx.insert(i.id.symbol.clone(), rx);
            live_tx.insert(i.id.symbol.clone(), tx);
        }
        let first = instruments.first().map_or_else(
            || mpsc::unbounded_channel().0,
            |i| live_tx[&i.id.symbol].clone(),
        );
        let p = FakeProvider {
            instruments,
            pages: Mutex::default(),
            history_calls: Mutex::default(),
            quote_calls: Mutex::default(),
            live_rx: Mutex::new(live_rx),
            live_tx,
        };
        (Arc::new(p), first)
    }

    fn sender(&self, symbol: &str) -> mpsc::UnboundedSender<LiveItem> {
        self.live_tx[symbol].clone()
    }

    fn push_page(&self, page: Result<Vec<Candle>, ProviderError>) {
        self.pages.lock().unwrap().push_back(page);
    }

    fn history_calls(&self) -> Vec<(Option<i64>, u16)> {
        self.history_calls.lock().unwrap().clone()
    }
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
        end_before: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Candle>, ProviderError> {
        self.history_calls.lock().unwrap().push((end_before, limit));
        self.pages
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Vec::new()))
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

    async fn day_changes(&self, insts: &[Instrument]) -> Result<Vec<DayChange>, ProviderError> {
        self.quote_calls.lock().unwrap().push(insts.len());
        Ok(insts
            .iter()
            .map(|i| DayChange {
                id: i.id.clone(),
                last: 100,
                change_bp: 5,
            })
            .collect())
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

fn id(symbol: &str) -> InstrumentId {
    InstrumentId {
        source: "fake".into(),
        symbol: symbol.into(),
    }
}

/// The hourly candle `back` candles before the current one.
fn candle(back: i64) -> Candle {
    let p = 10_000 - back;
    Candle {
        open_time: NOW_OPEN - back * H,
        open: p,
        high: p + 5,
        low: p - 5,
        close: p + 1,
        volume: 7,
    }
}

fn live(back: i64, closed: bool) -> LiveItem {
    Ok(LiveCandle {
        candle: candle(back),
        closed,
    })
}

fn net() -> ProviderError {
    ProviderError::Network("down".into())
}

struct Fixture {
    engine: Engine,
    provider: Arc<FakeProvider>,
    live_tx: mpsc::UnboundedSender<LiveItem>,
    dir: tempfile::TempDir,
}

async fn fixture(symbols: &[&str]) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (provider, live_tx) = FakeProvider::new(symbols.iter().map(|s| inst(s)).collect());
    let engine = Engine::open_with_clock(
        dir.path(),
        vec![provider.clone() as Arc<dyn Provider>],
        Arc::new(|| NOW),
    )
    .unwrap();
    engine.sync_instruments("fake").await.unwrap();
    Fixture {
        engine,
        provider,
        live_tx,
        dir,
    }
}

impl Fixture {
    /// A second connection to the engine's database, for checking what was stored.
    fn store(&self) -> Store {
        Store::open(&self.dir.path().join("sandchart.db")).unwrap()
    }
}

async fn next_event(handle: &mut LiveHandle) -> LiveEvent {
    tokio::time::timeout(Duration::from_secs(5), handle.receiver().recv())
        .await
        .expect("timed out waiting for a live event")
        .expect("live channel closed")
}

#[tokio::test]
async fn first_load_fetches_and_caches() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider
        .push_page(Ok(vec![candle(2), candle(1), candle(0)]));

    let first = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(first.candles, vec![candle(2), candle(1), candle(0)]);
    assert_eq!(first.instrument.id, id("BTCUSDT"));
    assert!(first.warning.is_none());
    assert!(!first.at_history_start);

    let second = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(second.candles, first.candles);
    assert_eq!(f.provider.history_calls(), vec![(None, 1000)]);
}

#[tokio::test]
async fn stale_cache_fetches_the_newest_page_again() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(5), candle(4)])); // newest cached is 4 candles old
    f.provider.push_page(Ok(vec![
        candle(5),
        candle(4),
        candle(3),
        candle(2),
        candle(1),
        candle(0),
    ]));

    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    let page = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(page.candles.len(), 6);
    assert_eq!(f.provider.history_calls().len(), 2);
}

#[tokio::test]
async fn scroll_back_fetches_older_page() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(1), candle(0)]));
    f.provider.push_page(Ok(vec![candle(3), candle(2)]));

    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    let older = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, Some(candle(1).open_time))
        .await
        .unwrap();
    assert_eq!(older.candles, vec![candle(3), candle(2)]);
    assert_eq!(
        f.provider.history_calls()[1],
        (Some(candle(1).open_time), 1000)
    );
}

#[tokio::test]
async fn stops_at_start_of_history() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(1), candle(0)]));
    f.provider.push_page(Ok(vec![])); // nothing older than candle(1)

    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    let before = Some(candle(1).open_time);
    let second = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, before)
        .await
        .unwrap();
    assert!(second.candles.is_empty());
    assert!(second.at_history_start);

    let calls = f.provider.history_calls().len();
    let third = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, before)
        .await
        .unwrap();
    assert!(third.at_history_start);
    assert_eq!(
        f.provider.history_calls().len(),
        calls,
        "no request at the start of history"
    );
}

#[tokio::test]
async fn load_chart_serves_cache_when_provider_fails() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(5), candle(4)])); // stale on the next call
    f.provider.push_page(Err(net()));

    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    let page = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(page.candles, vec![candle(5), candle(4)]);
    assert!(page.warning.is_some());
    assert_eq!(*f.engine.connection().borrow(), ConnectionState::Offline);
}

#[tokio::test]
async fn load_chart_without_cache_returns_the_provider_error() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Err(net()));
    let err = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("network"), "{err}");
}

#[tokio::test]
async fn closed_live_candles_are_stored() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();

    f.live_tx.send(live(1, true)).unwrap();
    f.live_tx.send(live(0, false)).unwrap();
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(1, true).unwrap())
    );
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(0, false).unwrap())
    );

    let stored = f
        .store()
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 10)
        .unwrap();
    assert_eq!(stored, vec![candle(1)], "only the closed candle is stored");
}

#[tokio::test]
async fn backfills_after_reconnect() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.provider.push_page(Ok(vec![candle(2), candle(1)]));

    f.live_tx.send(live(3, true)).unwrap();
    f.live_tx.send(Err(net())).unwrap();
    f.live_tx.send(live(0, true)).unwrap();

    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(3, true).unwrap())
    );
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Backfilled(vec![candle(2), candle(1)])
    );
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(0, true).unwrap())
    );

    let stored = f
        .store()
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 10)
        .unwrap();
    assert_eq!(stored, vec![candle(3), candle(2), candle(1), candle(0)]);
    assert_eq!(f.provider.history_calls(), vec![(None, 1000)]);
}

#[tokio::test]
async fn consecutive_errors_backfill_once() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.provider.push_page(Ok(vec![candle(1)]));

    f.live_tx.send(live(2, true)).unwrap();
    for _ in 0..3 {
        f.live_tx.send(Err(net())).unwrap();
    }
    f.live_tx.send(live(0, false)).unwrap();

    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(2, true).unwrap())
    );
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Backfilled(vec![candle(1)])
    );
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(0, false).unwrap())
    );
    assert_eq!(f.provider.history_calls().len(), 1);
}

#[tokio::test]
async fn failed_backfill_is_retried_on_the_next_message() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.provider.push_page(Err(net()));
    f.provider.push_page(Ok(vec![candle(1)]));

    f.live_tx.send(live(2, true)).unwrap();
    f.live_tx.send(Err(net())).unwrap();
    f.live_tx.send(live(0, false)).unwrap(); // backfill fails here
    f.live_tx.send(live(0, false)).unwrap(); // and succeeds here

    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(2, true).unwrap())
    );
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(0, false).unwrap())
    );
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Backfilled(vec![candle(1)])
    );
    assert_eq!(
        next_event(&mut handle).await,
        LiveEvent::Candle(live(0, false).unwrap())
    );
}

#[tokio::test]
async fn connection_state_follows_stream() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    let state = f.engine.connection();

    f.live_tx.send(Err(net())).unwrap();
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    assert_eq!(*state.borrow(), ConnectionState::Reconnecting);

    f.live_tx.send(live(0, false)).unwrap();
    next_event(&mut handle).await;
    assert_eq!(*state.borrow(), ConnectionState::Connected);
}

#[tokio::test]
async fn dropping_the_handle_stops_the_stream() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.live_tx.send(live(0, false)).unwrap();
    next_event(&mut handle).await; // the task is running and owns the provider stream
    drop(handle);
    // The provider stream owns the receiver; it is dropped once the task is aborted.
    tokio::time::timeout(Duration::from_secs(5), f.live_tx.closed())
        .await
        .expect("provider stream still alive after the handle was dropped");
}

#[test]
fn subscribe_outside_a_runtime_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let (provider, _tx) = FakeProvider::new(vec![]);
    let engine = Engine::open(dir.path(), vec![provider as Arc<dyn Provider>]).unwrap();
    assert!(
        engine
            .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
            .is_err()
    );
}

fn write_csv(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    path
}

#[tokio::test]
async fn imports_csv_with_iso_and_ms_times() {
    let f = fixture(&[]).await;
    let csv = write_csv(
        f.dir.path(),
        "bars.csv",
        "time,open,high,low,close,volume\n\
         2024-01-01T00:00:00Z,100.25,101,99.5,100,1.2345\n\
         1704070800000,100,102.75,100,102,2\n\
         2024-01-01T04:00:00+02:00,102,103,101.5,102.5,0.5\n",
    );
    let csv_id = f.engine.import_csv(&csv, "MYDATA", Timeframe::H1).unwrap();
    assert_eq!(
        csv_id,
        InstrumentId {
            source: "csv".into(),
            symbol: "MYDATA".into()
        }
    );

    let found = f.engine.search("mydata", 10).unwrap();
    assert_eq!((found[0].price_scale, found[0].qty_scale), (2, 4));

    let page = f
        .engine
        .load_chart(&csv_id, Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(page.candles.len(), 3);
    assert_eq!(page.candles[0].open_time, 1_704_067_200_000);
    assert_eq!(page.candles[1].open_time, 1_704_070_800_000);
    assert_eq!(page.candles[2].open_time, 1_704_074_400_000);
    assert_eq!(page.candles[0].open, 10_025);
    assert_eq!(page.candles[0].volume, 12_345);
    assert_eq!(page.candles[1].high, 10_275);
    assert!(
        page.at_history_start,
        "a csv series is complete in the cache"
    );
    assert!(f.provider.history_calls().is_empty());
}

#[tokio::test]
async fn csv_rejects_bad_header_and_bad_rows() {
    let f = fixture(&[]).await;
    let bad_header = write_csv(f.dir.path(), "a.csv", "t,o,h,l,c,v\n1,1,1,1,1,1\n");
    assert!(
        f.engine
            .import_csv(&bad_header, "A", Timeframe::H1)
            .is_err()
    );
    let bad_row = write_csv(
        f.dir.path(),
        "b.csv",
        "time,open,high,low,close,volume\n1,1,1,1,1e5,1\n",
    );
    assert!(f.engine.import_csv(&bad_row, "B", Timeframe::H1).is_err());
    let empty = write_csv(f.dir.path(), "c.csv", "time,open,high,low,close,volume\n");
    assert!(f.engine.import_csv(&empty, "C", Timeframe::H1).is_err());
    assert!(
        f.engine
            .search("a", 10)
            .unwrap()
            .iter()
            .all(|i| i.id.source != "csv")
    );
}

#[tokio::test]
async fn csv_reimport_keeps_existing_scales() {
    let f = fixture(&[]).await;
    let first = write_csv(
        f.dir.path(),
        "h1.csv",
        "time,open,high,low,close,volume\n1704067200000,1.25,2,1,1.5,3\n",
    );
    f.engine.import_csv(&first, "X", Timeframe::H1).unwrap();
    let finer = write_csv(
        f.dir.path(),
        "h4.csv",
        "time,open,high,low,close,volume\n1704067200000,1.255,2,1,1.5,3\n",
    );
    assert!(f.engine.import_csv(&finer, "X", Timeframe::H4).is_err());
}

#[tokio::test]
async fn watchlist_quotes_one_call_per_source() {
    let f = fixture(&["BTCUSDT", "ETHUSDT"]).await;
    let csv = write_csv(
        f.dir.path(),
        "bars.csv",
        "time,open,high,low,close,volume\n1704067200000,1,1,1,1,1\n",
    );
    let csv_id = f.engine.import_csv(&csv, "LOCAL", Timeframe::H1).unwrap();
    f.engine
        .set_watchlist(&[id("BTCUSDT"), csv_id, id("ETHUSDT")])
        .unwrap();
    assert_eq!(f.engine.watchlist().unwrap().len(), 3);

    let quotes = f.engine.watchlist_quotes().await.unwrap();
    assert_eq!(quotes.len(), 2);
    assert_eq!(*f.provider.quote_calls.lock().unwrap(), vec![2]);
}

#[tokio::test]
async fn watchlist_quotes_chunks_at_100_symbols() {
    let symbols: Vec<String> = (0..150).map(|i| format!("S{i:03}USDT")).collect();
    let refs: Vec<&str> = symbols.iter().map(String::as_str).collect();
    let f = fixture(&refs).await;
    let ids: Vec<InstrumentId> = refs.iter().map(|s| id(s)).collect();
    f.engine.set_watchlist(&ids).unwrap();

    let quotes = f.engine.watchlist_quotes().await.unwrap();
    assert_eq!(quotes.len(), 150);
    assert_eq!(*f.provider.quote_calls.lock().unwrap(), vec![100, 50]);
}

#[tokio::test]
async fn unknown_instrument_and_source_are_errors() {
    let f = fixture(&["BTCUSDT"]).await;
    assert!(
        f.engine
            .load_chart(&id("NOPE"), Timeframe::H1, None)
            .await
            .is_err()
    );
    assert!(f.engine.sync_instruments("nope").await.is_err());
    assert_eq!(f.engine.search("btc", 5).unwrap().len(), 1);
}

/// Pages like the exchange returns them: `back` candles ago, ascending, newest page first.
fn pages_back(from: i64, count: i64) -> Vec<Vec<Candle>> {
    (0..count)
        .map(|p| {
            ((from + p * 1000)..(from + (p + 1) * 1000))
                .rev()
                .map(candle)
                .collect()
        })
        .collect()
}

fn assert_contiguous(candles: &[Candle]) {
    assert!(!candles.is_empty());
    for w in candles.windows(2) {
        assert_eq!(
            w[1].open_time - w[0].open_time,
            H,
            "hole before {}",
            w[1].open_time
        );
    }
}

#[tokio::test]
async fn long_offline_fills_gap_without_hole() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(2501), candle(2500)]));
    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    for page in pages_back(0, 3) {
        f.provider.push_page(Ok(page));
    }

    let page = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert!(page.warning.is_none());
    assert_eq!(
        f.provider.history_calls().len(),
        1 + 3,
        "stops at the page that reaches the cache"
    );
    let stored = f
        .store()
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 100_000)
        .unwrap();
    assert_contiguous(&stored);
    assert_eq!(stored.first().unwrap().open_time, candle(2999).open_time);
    assert_eq!(stored.last().unwrap().open_time, candle(0).open_time);
    assert_eq!(page.candles.len(), 1000);
}

#[tokio::test]
async fn very_long_offline_resets_series() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider
        .push_page(Ok(vec![candle(20_001), candle(20_000)]));
    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    f.store()
        .set_history_start(&id("BTCUSDT"), Timeframe::H1, candle(20_001).open_time)
        .unwrap();
    for page in pages_back(0, 10) {
        f.provider.push_page(Ok(page));
    }

    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert_eq!(f.provider.history_calls().len(), 1 + 10);
    let store = f.store();
    let stored = store
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 100_000)
        .unwrap();
    assert_contiguous(&stored);
    assert_eq!(stored.len(), 10_000, "the old series is gone");
    assert_eq!(stored.first().unwrap().open_time, candle(9_999).open_time);
    assert_eq!(
        store.history_start(&id("BTCUSDT"), Timeframe::H1).unwrap(),
        None
    );
}

#[tokio::test]
async fn failed_catch_up_stores_nothing_and_warns() {
    let f = fixture(&["BTCUSDT"]).await;
    f.provider.push_page(Ok(vec![candle(2501), candle(2500)]));
    f.engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    f.provider.push_page(Ok(pages_back(0, 1).remove(0)));
    f.provider.push_page(Err(net()));

    let page = f
        .engine
        .load_chart(&id("BTCUSDT"), Timeframe::H1, None)
        .await
        .unwrap();
    assert!(page.warning.is_some());
    assert_eq!(page.candles, vec![candle(2501), candle(2500)]);
    let stored = f
        .store()
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 100_000)
        .unwrap();
    assert_eq!(stored.len(), 2, "a partial walk must not leave a hole");
}

#[tokio::test]
async fn connection_state_with_two_subscriptions() {
    let f = fixture(&["AAAUSDT", "BBBUSDT"]).await;
    let mut a = f
        .engine
        .subscribe_live(&id("AAAUSDT"), Timeframe::H1)
        .unwrap();
    let mut b = f
        .engine
        .subscribe_live(&id("BBBUSDT"), Timeframe::H1)
        .unwrap();
    let state = f.engine.connection();
    let (tx_a, tx_b) = (f.provider.sender("AAAUSDT"), f.provider.sender("BBBUSDT"));

    tx_a.send(Err(net())).unwrap();
    assert_eq!(next_event(&mut a).await, LiveEvent::Disconnected);
    assert_eq!(*state.borrow(), ConnectionState::Reconnecting);

    // A healthy stream B must not clear A's gap.
    tx_b.send(live(0, false)).unwrap();
    next_event(&mut b).await;
    assert_eq!(*state.borrow(), ConnectionState::Reconnecting);

    tx_a.send(live(0, false)).unwrap();
    next_event(&mut a).await;
    assert_eq!(*state.borrow(), ConnectionState::Connected);
}

#[tokio::test]
async fn dropping_errored_subscription_clears_reconnecting() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    let mut state = f.engine.connection();

    f.live_tx.send(Err(net())).unwrap();
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    assert_eq!(*state.borrow_and_update(), ConnectionState::Reconnecting);

    drop(handle);
    tokio::time::timeout(Duration::from_secs(5), state.changed())
        .await
        .expect("state was not released")
        .unwrap();
    assert_eq!(*state.borrow(), ConnectionState::Connected);
}

#[tokio::test]
async fn backfill_past_cap_resets_series() {
    let f = fixture(&["BTCUSDT"]).await;
    let mut handle = f
        .engine
        .subscribe_live(&id("BTCUSDT"), Timeframe::H1)
        .unwrap();
    f.live_tx.send(live(20_000, true)).unwrap();
    next_event(&mut handle).await;
    f.store()
        .set_history_start(&id("BTCUSDT"), Timeframe::H1, candle(20_000).open_time)
        .unwrap();
    for page in pages_back(0, 10) {
        f.provider.push_page(Ok(page));
    }

    f.live_tx.send(Err(net())).unwrap();
    f.live_tx.send(live(0, true)).unwrap();
    assert_eq!(next_event(&mut handle).await, LiveEvent::Disconnected);
    match next_event(&mut handle).await {
        LiveEvent::Backfilled(c) => assert_eq!(c.len(), 10_000),
        other => panic!("expected Backfilled, got {other:?}"),
    }
    next_event(&mut handle).await;

    assert_eq!(f.provider.history_calls().len(), 10);
    let store = f.store();
    let stored = store
        .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 100_000)
        .unwrap();
    assert_contiguous(&stored);
    assert_eq!(stored.first().unwrap().open_time, candle(9_999).open_time);
    assert_eq!(
        store.history_start(&id("BTCUSDT"), Timeframe::H1).unwrap(),
        None
    );
}
