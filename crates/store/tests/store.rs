use sandchart_core::alert::{Alert, AlertKind, Direction};
use sandchart_core::{
    Anchor, Candle, Drawing, DrawingBody, Instrument, InstrumentId, Style, Timeframe,
};
use sandchart_store::{
    MAX_ACTIVE_ALERTS, MAX_ALERT_PAIRS, MAX_ALERTS, MAX_DRAWINGS_PER_INSTRUMENT, Store, StoreError,
    StoredInstance, StoredModule,
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
        assert_eq!(table_count(&path), 8);
        store.migrate_down_to(0).unwrap();
        assert_eq!(table_count(&path), 0);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(table_count(&path), 8);
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
    assert_eq!(rusqlite_count(&path), 8);
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
    assert_eq!(rusqlite_count(&path), 8);
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
    assert_eq!(store.drawings(&id("BTCUSDT")).unwrap(), vec![moved.clone()]);
    assert_eq!(store.drawing("a").unwrap(), Some(moved));
    assert_eq!(store.drawing("nope").unwrap(), None);

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

fn alert(alert_id: &str, symbol: &str, kind: AlertKind) -> Alert {
    Alert {
        id: alert_id.into(),
        instrument: id(symbol),
        price_scale: 2,
        kind,
        direction: Direction::Cross,
        active: true,
        created_at: 1_700_000_000_000,
        triggered_at: None,
        triggered_price: None,
    }
}

fn fire(a: Alert, at: i64, p: i64, scale: u8) -> Alert {
    Alert {
        active: false,
        triggered_at: Some(at),
        triggered_price: Some(p),
        price_scale: scale,
        ..a
    }
}

fn price(p: i64) -> AlertKind {
    AlertKind::Price { price: p }
}

fn on_drawing(drawing_id: &str) -> AlertKind {
    AlertKind::Drawing {
        drawing_id: drawing_id.into(),
    }
}

#[test]
fn alert_migration_goes_down_to_3_and_up_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    {
        let mut store = Store::open(&path).unwrap();
        store.upsert_drawing(&drawing("d", "BTCUSDT", 0)).unwrap();
        store
            .upsert_alert(&alert("a", "BTCUSDT", price(100)))
            .unwrap();
        store.migrate_down_to(3).unwrap();
        assert_eq!(rusqlite_count(&path), 7);
        assert_eq!(store.drawings(&id("BTCUSDT")).unwrap().len(), 1);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(rusqlite_count(&path), 8);
    assert!(store.alerts().unwrap().is_empty());
}

#[test]
fn alerts_round_trip_and_replace_by_id() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_drawing(&drawing("d1", "ETHUSDT", 0)).unwrap();
    let mut fired = alert("b", "ETHUSDT", on_drawing("d1"));
    fired.direction = Direction::Below;
    fired.active = false;
    fired.created_at = 5;
    fired.triggered_at = Some(9);
    fired.triggered_price = Some(-3);
    let first = alert("a", "BTCUSDT", price(100));
    store.upsert_alert(&fired).unwrap();
    store.upsert_alert(&first).unwrap();
    // Oldest first.
    assert_eq!(store.alerts().unwrap(), vec![fired.clone(), first.clone()]);
    assert_eq!(store.alert("b").unwrap(), Some(fired));
    assert_eq!(store.alert("zz").unwrap(), None);

    let mut moved = first.clone();
    moved.kind = price(200);
    moved.direction = Direction::Above;
    store.upsert_alert(&moved).unwrap();
    assert_eq!(store.alert("a").unwrap(), Some(moved));

    store.delete_alert("a").unwrap();
    store.delete_alert("a").unwrap();
    assert_eq!(store.alerts().unwrap().len(), 1);
}

#[test]
fn an_unreadable_alert_row_is_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    let mut store = Store::open(&path).unwrap();
    store
        .upsert_alert(&alert("a", "BTCUSDT", price(100)))
        .unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO alerts (id, source, symbol, price_scale, kind, price, drawing_id,
                             direction, active, created_at)
         VALUES ('b', 'binance', 'BTCUSDT', 2, 'price', 5, NULL, 'sideways', 1, 0)",
        [],
    )
    .unwrap();
    let ids: Vec<String> = store.alerts().unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["a"]);
}

#[test]
fn firing_happens_once_and_rearming_clears_it() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert_alert(&alert("a", "BTCUSDT", price(100)))
        .unwrap();
    // Fired at another price scale: the stored price moves to it too.
    let fired = fire(alert("a", "BTCUSDT", price(1_000)), 3, 1_005, 3);
    assert!(store.fire_alert(&fired).unwrap());
    assert!(!store.fire_alert(&fire(fired.clone(), 4, 2_000, 3)).unwrap());
    let gone = fire(alert("gone", "BTCUSDT", price(1)), 4, 2_000, 3);
    assert!(!store.fire_alert(&gone).unwrap());
    let got = store.alert("a").unwrap().unwrap();
    assert_eq!(got, fired);
    assert!(!got.active);
    assert_eq!(got.triggered_at, Some(3));
    assert_eq!(got.triggered_price, Some(1_005));
    assert_eq!(got.price_scale, 3);
    assert_eq!(got.kind, price(1_000));

    let mut armed = got;
    armed.active = true;
    armed.triggered_at = None;
    armed.triggered_price = None;
    store.upsert_alert(&armed).unwrap();
    assert_eq!(store.alert("a").unwrap(), Some(armed));
}

#[test]
fn a_firing_of_an_alert_that_was_replaced_meanwhile_is_ignored() {
    let mut store = Store::open_in_memory().unwrap();
    let old = alert("a", "BTCUSDT", price(100));
    store.upsert_alert(&old).unwrap();
    // Another process replaces it (a new created_at) before the firing of the old one lands.
    let mut new = alert("a", "BTCUSDT", price(300));
    new.created_at = old.created_at + 1;
    store.upsert_alert(&new).unwrap();
    assert!(!store.fire_alert(&fire(old, 3, 101, 2)).unwrap());
    assert_eq!(store.alert("a").unwrap(), Some(new.clone()));
    assert!(store.fire_alert(&fire(new, 4, 301, 2)).unwrap());
}

#[test]
fn a_line_alert_fires_without_touching_its_drawing_id() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_drawing(&drawing("d1", "BTCUSDT", 0)).unwrap();
    store
        .upsert_alert(&alert("a", "BTCUSDT", on_drawing("d1")))
        .unwrap();
    let fired = fire(alert("a", "BTCUSDT", on_drawing("d1")), 3, 7, 2);
    assert!(store.fire_alert(&fired).unwrap());
    assert_eq!(store.alert("a").unwrap(), Some(fired));
}

#[test]
fn deleting_a_drawing_deletes_its_alerts() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_drawing(&drawing("d1", "BTCUSDT", 0)).unwrap();
    store.upsert_drawing(&drawing("d2", "BTCUSDT", 0)).unwrap();
    for (a, kind) in [
        ("a1", on_drawing("d1")),
        ("a2", on_drawing("d1")),
        ("a3", on_drawing("d2")),
        ("a4", price(5)),
    ] {
        store.upsert_alert(&alert(a, "BTCUSDT", kind)).unwrap();
    }
    // Saving the drawing again (a move) keeps its alerts.
    store.upsert_drawing(&drawing("d1", "BTCUSDT", 3)).unwrap();
    assert_eq!(store.alerts().unwrap().len(), 4);
    assert_eq!(store.delete_drawing("d1").unwrap(), 2);
    assert_eq!(store.delete_drawing("d1").unwrap(), 0);
    let ids: Vec<String> = store.alerts().unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["a3", "a4"]);
}

#[test]
fn at_most_100_alerts_are_active() {
    let mut store = Store::open_in_memory().unwrap();
    for i in 0..MAX_ACTIVE_ALERTS {
        store
            .upsert_alert(&alert(&format!("a{i}"), "BTCUSDT", price(i as i64)))
            .unwrap();
    }
    let err = store
        .upsert_alert(&alert("more", "BTCUSDT", price(1)))
        .unwrap_err();
    assert!(
        matches!(err, StoreError::TooManyActiveAlerts { max: 100 }),
        "{err:?}"
    );
    assert!(err.to_string().contains("100"));
    // Changing one that is active works at the cap; an inactive one may be added.
    store
        .upsert_alert(&alert("a0", "BTCUSDT", price(-1)))
        .unwrap();
    let mut off = alert("off", "BTCUSDT", price(1));
    off.active = false;
    store.upsert_alert(&off).unwrap();
    // Re-arming it is refused until one fires.
    off.active = true;
    assert!(store.upsert_alert(&off).is_err());
    assert!(
        store
            .fire_alert(&fire(alert("a1", "BTCUSDT", price(1)), 1, 1, 2))
            .unwrap()
    );
    store.upsert_alert(&off).unwrap();
}

#[test]
fn at_most_30_pairs_have_active_alerts() {
    let mut store = Store::open_in_memory().unwrap();
    for i in 0..MAX_ALERT_PAIRS {
        store
            .upsert_alert(&alert(&format!("a{i}"), &format!("P{i}"), price(1)))
            .unwrap();
    }
    // Another alert on a pair that has one is fine.
    store.upsert_alert(&alert("b", "P0", price(2))).unwrap();
    let err = store
        .upsert_alert(&alert("c", "NEW", price(1)))
        .unwrap_err();
    assert!(
        matches!(err, StoreError::TooManyAlertPairs { max: 30 }),
        "{err:?}"
    );
    assert!(err.to_string().contains("30"));
    // Moving the last alert of a pair to a new one keeps the count.
    store.upsert_alert(&alert("a5", "NEW", price(1))).unwrap();
    assert!(
        store
            .fire_alert(&fire(alert("a6", "P6", price(1)), 1, 1, 2))
            .unwrap()
    );
    store.upsert_alert(&alert("c", "NEW2", price(1))).unwrap();
}

#[test]
fn at_most_500_alerts_are_stored() {
    let mut store = Store::open_in_memory().unwrap();
    for i in 0..MAX_ALERTS {
        let mut a = alert(&format!("a{i}"), "BTCUSDT", price(1));
        a.active = false;
        store.upsert_alert(&a).unwrap();
    }
    let mut a = alert("more", "BTCUSDT", price(1));
    a.active = false;
    let err = store.upsert_alert(&a).unwrap_err();
    assert!(
        matches!(err, StoreError::TooManyAlerts { max: 500 }),
        "{err:?}"
    );
    store.delete_alert("a0").unwrap();
    store.upsert_alert(&a).unwrap();
}

/// Holds the write lock of `path` from another connection, as the app or the MCP server
/// would, and lets it go after `ms`.
fn hold_write_lock(path: &std::path::Path, ms: u64) -> std::thread::JoinHandle<()> {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        conn.execute_batch("COMMIT").unwrap();
    })
}

#[test]
fn a_write_waits_for_another_process_instead_of_failing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    let mut store = Store::open(&path).unwrap();
    store.upsert_instruments(&[instrument("BTCUSDT")]).unwrap();

    let started = std::time::Instant::now();
    let other = hold_write_lock(&path, 300);
    // A read-then-write transaction (it counts the drawings first) and a single statement.
    store.upsert_drawing(&drawing("a", "BTCUSDT", 0)).unwrap();
    store.delete_alert("none").unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_millis(250));
    other.join().unwrap();

    // Reads never wait for a writer in WAL mode.
    let other = hold_write_lock(&path, 300);
    let started = std::time::Instant::now();
    assert_eq!(store.drawings(&id("BTCUSDT")).unwrap().len(), 1);
    assert!(started.elapsed() < std::time::Duration::from_millis(250));
    other.join().unwrap();
}

#[test]
fn two_processes_opening_an_old_file_migrate_it_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    Store::open(&path).unwrap().migrate_down_to(1).unwrap();

    // Both open while a third connection holds the write lock, so both read the old version
    // before either can migrate.
    let lock = hold_write_lock(&path, 300);
    let opens: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || Store::open(&path).map(|_| ()))
        })
        .collect();
    lock.join().unwrap();
    for open in opens {
        open.join().unwrap().unwrap();
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
}

#[test]
fn data_version_changes_only_with_another_connections_commits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    let mut app = Store::open(&path).unwrap();
    let mut other = Store::open(&path).unwrap();
    let v0 = app.data_version().unwrap();
    app.upsert_instruments(&[instrument("BTCUSDT")]).unwrap();
    assert_eq!(
        app.data_version().unwrap(),
        v0,
        "its own writes do not count"
    );
    other.upsert_drawing(&drawing("a", "BTCUSDT", 0)).unwrap();
    let v1 = app.data_version().unwrap();
    assert_ne!(v1, v0);
    assert_eq!(app.data_version().unwrap(), v1);
}

#[test]
fn a_second_process_never_migrates_an_older_apps_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandchart.db");
    Store::open(&path).unwrap().migrate_down_to(3).unwrap();
    let err = Store::open_existing(&path).err().expect("refused");
    assert!(
        matches!(
            err,
            StoreError::SchemaTooOld {
                found: 3,
                supported: 4
            }
        ),
        "{err:?}"
    );
    assert_contains_text(&err.to_string(), "update the Sandchart app first");
    let conn = rusqlite::Connection::open(&path).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3, "left as it was");

    // A brand-new file is set up, and one at the latest version opens.
    let fresh = dir.path().join("new.db");
    Store::open_existing(&fresh).unwrap();
    Store::open(&path).unwrap();
    Store::open_existing(&path).unwrap();
}

fn assert_contains_text(haystack: &str, needle: &str) {
    assert!(haystack.contains(needle), "{needle:?} not in {haystack:?}");
}

fn with_body(mut d: Drawing, body: DrawingBody) -> Drawing {
    d.body = body;
    d
}

fn rect() -> DrawingBody {
    DrawingBody::Rect {
        a: Anchor { t: 1, p: 100 },
        b: Anchor { t: 2, p: 200 },
        extend_right: false,
    }
}

fn alert_ids(store: &Store) -> Vec<String> {
    store.alerts().unwrap().into_iter().map(|a| a.id).collect()
}

#[test]
fn a_line_alert_needs_an_hline_or_trend_drawing_of_its_pair() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert_drawing(&drawing("t", "BTCUSDT", 0)).unwrap();
    store
        .upsert_drawing(&with_body(
            drawing("h", "BTCUSDT", 0),
            DrawingBody::Hline { p: 5 },
        ))
        .unwrap();
    store
        .upsert_drawing(&with_body(drawing("r", "BTCUSDT", 0), rect()))
        .unwrap();
    store.upsert_drawing(&drawing("e", "ETHUSDT", 0)).unwrap();
    store
        .upsert_alert(&alert("a1", "BTCUSDT", on_drawing("t")))
        .unwrap();
    store
        .upsert_alert(&alert("a2", "BTCUSDT", on_drawing("h")))
        .unwrap();
    for (drawing_id, want) in [
        ("none", "drawing \"none\" does not exist"),
        ("e", "drawing \"e\" is on another pair"),
        ("r", "an alert can follow only a horizontal or a trend line"),
    ] {
        let err = store
            .upsert_alert(&alert("x", "BTCUSDT", on_drawing(drawing_id)))
            .unwrap_err();
        assert!(matches!(err, StoreError::AlertDrawing(_)), "{err:?}");
        assert_contains_text(&err.to_string(), want);
    }
    assert_eq!(alert_ids(&store), ["a1", "a2"]);
}

#[test]
fn a_drawing_that_stops_being_a_line_or_moves_pair_loses_its_alerts() {
    let mut store = Store::open_in_memory().unwrap();
    for d in ["d1", "d2", "d3"] {
        store.upsert_drawing(&drawing(d, "BTCUSDT", 0)).unwrap();
    }
    for (a, d) in [("a1", "d1"), ("a2", "d2"), ("a3", "d3")] {
        store
            .upsert_alert(&alert(a, "BTCUSDT", on_drawing(d)))
            .unwrap();
    }
    // Moved or turned into an hline: still a line on the pair, the alerts stay.
    assert_eq!(
        store.upsert_drawing(&drawing("d1", "BTCUSDT", 4)).unwrap(),
        0
    );
    let hline = with_body(drawing("d1", "BTCUSDT", 0), DrawingBody::Hline { p: 7 });
    assert_eq!(store.upsert_drawing(&hline).unwrap(), 0);
    // A rectangle now, and on another pair: their alerts go in the same write.
    assert_eq!(
        store
            .upsert_drawing(&with_body(drawing("d2", "BTCUSDT", 0), rect()))
            .unwrap(),
        1
    );
    assert_eq!(
        store.upsert_drawing(&drawing("d3", "ETHUSDT", 0)).unwrap(),
        1
    );
    assert_eq!(alert_ids(&store), ["a1"]);
}

#[test]
fn two_processes_racing_on_a_drawing_and_its_alert_leave_no_orphan() {
    for round in 0..10 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sandchart.db");
        Store::open(&path)
            .unwrap()
            .upsert_drawing(&drawing("d", "BTCUSDT", 0))
            .unwrap();
        // Both start while a third connection holds the write lock, then run in any order.
        let lock = hold_write_lock(&path, 100);
        let (p1, p2) = (path.clone(), path.clone());
        let agent = std::thread::spawn(move || {
            Store::open(&p1)
                .unwrap()
                .upsert_alert(&alert("a", "BTCUSDT", on_drawing("d")))
                .is_ok()
        });
        let app = std::thread::spawn(move || {
            let mut s = Store::open(&p2).unwrap();
            if round % 2 == 0 {
                s.upsert_drawing(&with_body(drawing("d", "BTCUSDT", 0), rect()))
                    .unwrap();
            } else {
                s.delete_drawing("d").unwrap();
            }
        });
        lock.join().unwrap();
        let _ = agent.join().unwrap();
        app.join().unwrap();
        let store = Store::open(&path).unwrap();
        assert!(
            alert_ids(&store).is_empty(),
            "round {round}: an orphan alert"
        );
    }
}
