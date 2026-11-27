use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_store::Store;

fn id(symbol: &str) -> InstrumentId {
    InstrumentId {
        source: "binance".into(),
        symbol: symbol.into(),
    }
}

fn instrument(symbol: &str) -> Instrument {
    Instrument {
        id: id(symbol),
        base: "BTC".into(),
        quote: "USDT".into(),
        price_scale: 2,
        qty_scale: 5,
    }
}

fn candle(open_time: i64, close: i64) -> Candle {
    Candle {
        open_time,
        open: 100,
        high: 200,
        low: 50,
        close,
        volume: 7,
    }
}

fn series(n: i64) -> Vec<Candle> {
    (0..n)
        .map(|i| candle(1_000 + i * 60_000, 150 + i))
        .collect()
}

fn symbols(items: &[Instrument]) -> Vec<&str> {
    items.iter().map(|i| i.id.symbol.as_str()).collect()
}

#[test]
fn upsert_is_idempotent() {
    let mut store = Store::open_in_memory().unwrap();
    let candles = series(3);
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &candles)
        .unwrap();
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &candles)
        .unwrap();
    let got = store
        .candles_before(&id("BTCUSDT"), Timeframe::M1, None, 10)
        .unwrap();
    assert_eq!(got, candles);
}

#[test]
fn upsert_replaces_same_open_time() {
    let mut store = Store::open_in_memory().unwrap();
    let t = 1_000;
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &[candle(t, 150)])
        .unwrap();
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &[candle(t, 999)])
        .unwrap();
    let got = store
        .candles_before(&id("BTCUSDT"), Timeframe::M1, None, 10)
        .unwrap();
    assert_eq!(got, vec![candle(t, 999)]);
}

#[test]
fn candles_before_returns_newest_page_ascending() {
    let mut store = Store::open_in_memory().unwrap();
    let candles = series(10);
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &candles)
        .unwrap();
    let got = store
        .candles_before(&id("BTCUSDT"), Timeframe::M1, Some(candles[8].open_time), 3)
        .unwrap();
    assert_eq!(got, candles[5..8].to_vec());
}

#[test]
fn series_are_isolated_by_instrument_and_timeframe() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &series(3))
        .unwrap();
    assert!(
        store
            .candles_before(&id("BTCUSDT"), Timeframe::H1, None, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .candles_before(&id("ETHUSDT"), Timeframe::M1, None, 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn newest_open_time_and_history_start() {
    let mut store = Store::open_in_memory().unwrap();
    let (btc, tf) = (id("BTCUSDT"), Timeframe::M1);
    assert_eq!(store.newest_open_time(&btc, tf).unwrap(), None);
    assert_eq!(store.history_start(&btc, tf).unwrap(), None);
    let candles = series(4);
    store.upsert_candles(&btc, tf, &candles).unwrap();
    assert_eq!(
        store.newest_open_time(&btc, tf).unwrap(),
        Some(candles[3].open_time)
    );
    store.set_history_start(&btc, tf, 42).unwrap();
    store.set_history_start(&btc, tf, 43).unwrap();
    assert_eq!(store.history_start(&btc, tf).unwrap(), Some(43));
}

#[test]
fn instruments_round_trip_and_update() {
    let mut store = Store::open_in_memory().unwrap();
    assert_eq!(store.instrument(&id("BTCUSDT")).unwrap(), None);
    store.upsert_instruments(&[instrument("BTCUSDT")]).unwrap();
    let mut changed = instrument("BTCUSDT");
    changed.price_scale = 4;
    store.upsert_instruments(&[changed.clone()]).unwrap();
    assert_eq!(store.instrument(&id("BTCUSDT")).unwrap(), Some(changed));
}

#[test]
fn search_orders_exact_prefix_substring() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert_instruments(&[
            instrument("WBTCUSDT"),
            instrument("BTCUSDT"),
            instrument("BTCUSDC"),
        ])
        .unwrap();
    let exact = store.search_instruments("btcusdt", 10).unwrap();
    assert_eq!(symbols(&exact), ["BTCUSDT", "WBTCUSDT"]);
    let loose = store.search_instruments("btc", 10).unwrap();
    assert_eq!(symbols(&loose), ["BTCUSDC", "BTCUSDT", "WBTCUSDT"]);
    assert_eq!(store.search_instruments("btc", 1).unwrap().len(), 1);
}

#[test]
fn watchlist_keeps_order() {
    let mut store = Store::open_in_memory().unwrap();
    let list = vec![id("ETHUSDT"), id("BTCUSDT"), id("SOLUSDT")];
    store.set_watchlist(&list).unwrap();
    assert_eq!(store.watchlist().unwrap(), list);
    let shorter = vec![id("SOLUSDT"), id("ETHUSDT")];
    store.set_watchlist(&shorter).unwrap();
    assert_eq!(store.watchlist().unwrap(), shorter);
}

#[test]
fn migrations_go_down_and_up() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    let table_count = rusqlite_count;

    {
        let mut store = Store::open(&path).unwrap();
        store.upsert_instruments(&[instrument("BTCUSDT")]).unwrap();
        assert_eq!(table_count(&path), 4);
        store.migrate_down_to(0).unwrap();
        assert_eq!(table_count(&path), 0);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(table_count(&path), 4);
    assert_eq!(store.instrument(&id("BTCUSDT")).unwrap(), None);
}

/// Counts user tables by opening a second raw connection.
fn rusqlite_count(path: &std::path::Path) -> i64 {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}
