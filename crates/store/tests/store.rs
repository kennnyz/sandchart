use sandchart_core::{
    Anchor, Candle, Drawing, DrawingBody, Instrument, InstrumentId, Style, Timeframe,
};
use sandchart_store::{
    MAX_DRAWINGS_PER_INSTRUMENT, Store, StoreError, StoredInstance, StoredModule,
};

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
fn delete_series_removes_only_that_series() {
    let mut store = Store::open_in_memory().unwrap();
    let (btc, eth) = (id("BTCUSDT"), id("ETHUSDT"));
    for (i, tf) in [
        (&btc, Timeframe::H1),
        (&btc, Timeframe::H4),
        (&eth, Timeframe::H1),
    ] {
        store.upsert_candles(i, tf, &series(3)).unwrap();
        store.set_history_start(i, tf, 1).unwrap();
    }
    store.delete_series(&btc, Timeframe::H1).unwrap();
    assert!(
        store
            .candles_before(&btc, Timeframe::H1, None, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.history_start(&btc, Timeframe::H1).unwrap(), None);
    assert_eq!(store.newest_open_time(&btc, Timeframe::H1).unwrap(), None);
    for (i, tf) in [(&btc, Timeframe::H4), (&eth, Timeframe::H1)] {
        assert_eq!(store.candles_before(i, tf, None, 10).unwrap().len(), 3);
        assert_eq!(store.history_start(i, tf).unwrap(), Some(1));
    }
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
        assert_eq!(table_count(&path), 7);
        store.migrate_down_to(0).unwrap();
        assert_eq!(table_count(&path), 0);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(table_count(&path), 7);
    assert_eq!(store.instrument(&id("BTCUSDT")).unwrap(), None);
}

fn module(id: &str, version: &str) -> StoredModule {
    StoredModule {
        id: id.into(),
        version: version.into(),
        sha256: "ab".repeat(32),
        repaints: false,
        installed_at: 1_700_000_000_000,
    }
}

fn inst(instance: &str, module_id: &str) -> StoredInstance {
    StoredInstance {
        instance: instance.into(),
        module_id: module_id.into(),
        params: r#"{"period":14}"#.into(),
        colors: r#"{"line":2}"#.into(),
        hidden: false,
    }
}

#[test]
fn indicator_migration_goes_down_to_1_and_up_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    {
        let mut store = Store::open(&path).unwrap();
        store.upsert_indicator_module(&module("m", "1")).unwrap();
        store.migrate_down_to(1).unwrap();
        assert_eq!(rusqlite_count(&path), 4);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(rusqlite_count(&path), 7);
    assert!(store.indicator_modules().unwrap().is_empty());
}

#[test]
fn module_upsert_replaces_the_version() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_indicator_module(&module("m", "1")).unwrap();
    let mut v2 = module("m", "2");
    v2.repaints = true;
    store.upsert_indicator_module(&v2).unwrap();
    assert_eq!(store.indicator_modules().unwrap(), vec![v2]);
}

#[test]
fn deleting_a_module_deletes_its_instances() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_indicator_module(&module("m", "1")).unwrap();
    store
        .set_indicator_instances(&[inst("a", "m"), inst("b", "builtin.sma"), inst("c", "m")])
        .unwrap();
    store.delete_indicator_module("m").unwrap();
    assert!(store.indicator_modules().unwrap().is_empty());
    assert_eq!(
        store.indicator_instances().unwrap(),
        vec![inst("b", "builtin.sma")]
    );
}

#[test]
fn instances_keep_order_and_can_be_emptied() {
    let mut store = Store::open_in_memory().unwrap();
    let mut hidden = inst("z", "builtin.ema");
    hidden.hidden = true;
    let items = vec![hidden, inst("a", "builtin.sma"), inst("m", "builtin.rsi")];
    store.set_indicator_instances(&items).unwrap();
    assert_eq!(store.indicator_instances().unwrap(), items);
    store.set_indicator_instances(&[]).unwrap();
    assert!(store.indicator_instances().unwrap().is_empty());
}

fn drawing(drawing_id: &str, symbol: &str, z: i64) -> Drawing {
    Drawing {
        id: drawing_id.into(),
        instrument: id(symbol),
        price_scale: 2,
        body: DrawingBody::Trend {
            a: Anchor { t: 1, p: 100 },
            b: Anchor { t: 2, p: 200 },
            extend_left: false,
            extend_right: true,
        },
        style: Style {
            color: 3,
            width: 2,
            dash: true,
        },
        locked: true,
        z,
        updated_at: 1_700_000_000_000,
    }
}

#[test]
fn drawing_migration_goes_down_to_2_and_up_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    {
        let mut store = Store::open(&path).unwrap();
        store.upsert_drawing(&drawing("d", "BTCUSDT", 0)).unwrap();
        store.upsert_indicator_module(&module("m", "1")).unwrap();
        store.migrate_down_to(2).unwrap();
        assert_eq!(rusqlite_count(&path), 6);
        // Going down to 2 keeps the 0.2 tables and their rows.
        assert_eq!(store.indicator_modules().unwrap().len(), 1);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(rusqlite_count(&path), 7);
    assert!(store.drawings(&id("BTCUSDT")).unwrap().is_empty());
}

#[test]
fn drawings_round_trip_per_instrument_ordered_by_z_then_id() {
    let mut store = Store::open_in_memory().unwrap();
    let mut position = drawing("p", "BTCUSDT", 1);
    position.body = DrawingBody::Position(sandchart_core::PositionBody {
        side: sandchart_core::Side::Short,
        entry: Anchor { t: 10, p: 100 },
        stop: 110,
        take: 85,
        end_t: 20,
    });
    position.locked = false;
    let items = [
        drawing("b", "BTCUSDT", 0),
        position.clone(),
        drawing("a", "BTCUSDT", 0),
        drawing("x", "ETHUSDT", -5),
    ];
    for d in &items {
        store.upsert_drawing(d).unwrap();
    }
    let got = store.drawings(&id("BTCUSDT")).unwrap();
    let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["a", "b", "p"]);
    assert_eq!(got[2], position);
    assert_eq!(got[0], items[2]);
    assert_eq!(
        store.drawings(&id("ETHUSDT")).unwrap(),
        vec![items[3].clone()]
    );
    assert!(store.drawings(&id("SOLUSDT")).unwrap().is_empty());
}

#[test]
fn an_unreadable_drawing_row_is_left_out_of_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    let mut store = Store::open(&path).unwrap();
    store.upsert_drawing(&drawing("a", "BTCUSDT", 0)).unwrap();
    store.upsert_drawing(&drawing("c", "BTCUSDT", 2)).unwrap();
    // A later version wrote a kind this one does not know, and a style it cannot read.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO drawings (id, source, symbol, price_scale, body, style, locked, z, updated_at)
         VALUES ('b', 'binance', 'BTCUSDT', 2, '{\"kind\":\"spiral\"}',
                 '{\"color\":0,\"width\":1,\"dash\":false}', 0, 1, 0),
                ('d', 'binance', 'BTCUSDT', 2, '{\"kind\":\"hline\",\"p\":1}', 'nope', 0, 3, 0)",
        [],
    )
    .unwrap();
    let got = store.drawings(&id("BTCUSDT")).unwrap();
    let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["a", "c"]);
    // It stays stored and counts toward the cap.
    store.delete_drawing("a").unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM drawings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3);
}

#[test]
fn upsert_replaces_a_drawing_and_delete_removes_it() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_drawing(&drawing("a", "BTCUSDT", 0)).unwrap();
    let mut moved = drawing("a", "BTCUSDT", 9);
    moved.body = DrawingBody::Hline { p: 555 };
    moved.price_scale = 4;
    store.upsert_drawing(&moved).unwrap();
    assert_eq!(store.drawings(&id("BTCUSDT")).unwrap(), vec![moved]);

    store.delete_drawing("a").unwrap();
    assert!(store.drawings(&id("BTCUSDT")).unwrap().is_empty());
    // Deleting what is not there is not an error: the UI may retry a delete.
    store.delete_drawing("a").unwrap();
}

#[test]
fn an_instrument_holds_at_most_2000_drawings() {
    let mut store = Store::open_in_memory().unwrap();
    for i in 0..MAX_DRAWINGS_PER_INSTRUMENT {
        store
            .upsert_drawing(&drawing(&format!("d{i}"), "BTCUSDT", 0))
            .unwrap();
    }
    let err = store
        .upsert_drawing(&drawing("one-more", "BTCUSDT", 0))
        .unwrap_err();
    assert!(
        matches!(err, StoreError::TooManyDrawings { max: 2000 }),
        "{err:?}"
    );
    assert!(err.to_string().contains("2000"));
    // Updating one that exists still works at the cap, and other instruments are free.
    store.upsert_drawing(&drawing("d0", "BTCUSDT", 7)).unwrap();
    store.upsert_drawing(&drawing("e", "ETHUSDT", 0)).unwrap();
    // Moving a drawing to a full instrument counts as a new one there.
    let err = store
        .upsert_drawing(&drawing("e", "BTCUSDT", 0))
        .unwrap_err();
    assert!(matches!(err, StoreError::TooManyDrawings { .. }));
    store.delete_drawing("d1").unwrap();
    store
        .upsert_drawing(&drawing("one-more", "BTCUSDT", 0))
        .unwrap();
    assert_eq!(
        store.drawings(&id("BTCUSDT")).unwrap().len(),
        MAX_DRAWINGS_PER_INSTRUMENT
    );
}

#[test]
fn scan_candles_between_is_after_exclusive_until_inclusive_and_can_stop_early() {
    let mut store = Store::open_in_memory().unwrap();
    let candles = series(6);
    store
        .upsert_candles(&id("BTCUSDT"), Timeframe::M1, &candles)
        .unwrap();
    let (after, until) = (candles[1].open_time, candles[4].open_time);
    let all = store
        .scan_candles_between(&id("BTCUSDT"), Timeframe::M1, after, until, |it| {
            it.collect::<Vec<_>>()
        })
        .unwrap();
    assert_eq!(all, candles[2..=4].to_vec());
    // The closure reads as far as it wants; the rest is never fetched.
    let first = store
        .scan_candles_between(&id("BTCUSDT"), Timeframe::M1, after, until, |it| it.next())
        .unwrap();
    assert_eq!(first, Some(candles[2]));
    let none = store
        .scan_candles_between(&id("BTCUSDT"), Timeframe::H1, 0, i64::MAX, |it| it.count())
        .unwrap();
    assert_eq!(none, 0);
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
