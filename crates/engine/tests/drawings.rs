//! Drawings through the engine: save, list with tick rescaling, delete, position outcomes.

use std::sync::Arc;

use sandchart_core::{
    Anchor, Candle, Drawing, DrawingBody, Instrument, InstrumentId, JS_SAFE_MAX, PositionBody,
    Side, Status, Style, Timeframe,
};
use sandchart_engine::{Engine, EngineError};
use sandchart_store::Store;

const NOW: i64 = 1_700_000_000_000;
const H: i64 = 3_600_000;

fn id(symbol: &str) -> InstrumentId {
    InstrumentId {
        source: "binance".into(),
        symbol: symbol.into(),
    }
}

fn inst(symbol: &str, price_scale: u8) -> Instrument {
    Instrument {
        id: id(symbol),
        base: "BTC".into(),
        quote: "USDT".into(),
        price_scale,
        qty_scale: 5,
    }
}

fn drawing(drawing_id: &str, body: DrawingBody) -> Drawing {
    Drawing {
        id: drawing_id.into(),
        instrument: id("BTCUSDT"),
        price_scale: 2,
        body,
        style: Style {
            color: 1,
            width: 2,
            dash: false,
        },
        locked: false,
        z: 0,
        updated_at: 0,
    }
}

fn long(entry_t: i64, end_t: i64) -> PositionBody {
    PositionBody {
        side: Side::Long,
        entry: Anchor {
            t: entry_t,
            p: 10_000,
        },
        stop: 9_000,
        take: 12_000,
        end_t,
    }
}

struct Fixture {
    engine: Engine,
    dir: tempfile::TempDir,
}

impl Fixture {
    /// BTCUSDT at price scale 2 is known; nothing else is.
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        Store::open(&dir.path().join("sandchart.db"))
            .unwrap()
            .upsert_instruments(&[inst("BTCUSDT", 2)])
            .unwrap();
        let engine = Engine::open_with_clock(dir.path(), None, vec![], Arc::new(|| NOW)).unwrap();
        Fixture { engine, dir }
    }

    fn store(&self) -> Store {
        Store::open(&self.dir.path().join("sandchart.db")).unwrap()
    }
}

#[tokio::test]
async fn save_sets_scale_and_time_and_lists_it_back() {
    let f = Fixture::new();
    let mut d = drawing("a", DrawingBody::Hline { p: 12_345 });
    d.updated_at = 1;
    let saved = f.engine.save_drawing(d.clone()).await.unwrap();
    assert_eq!(saved.price_scale, 2);
    assert_eq!(saved.updated_at, NOW);
    assert_eq!(
        f.engine.drawings(&id("BTCUSDT")).await.unwrap(),
        vec![saved]
    );

    f.engine.delete_drawing("a").await.unwrap();
    assert!(f.engine.drawings(&id("BTCUSDT")).await.unwrap().is_empty());
}

#[tokio::test]
async fn save_rescales_a_drawing_made_at_an_older_tick_size() {
    let f = Fixture::new();
    // The UI loaded the drawing at scale 2; meanwhile the exchange moved to four decimals.
    f.store().upsert_instruments(&[inst("BTCUSDT", 4)]).unwrap();
    let saved = f
        .engine
        .save_drawing(drawing("pos", DrawingBody::Position(long(NOW, NOW + H))))
        .await
        .unwrap();
    assert_eq!(saved.price_scale, 4);
    let DrawingBody::Position(p) = &saved.body else {
        panic!("{saved:?}");
    };
    assert_eq!((p.stop, p.entry.p, p.take), (900_000, 1_000_000, 1_200_000));
    assert_eq!(
        f.store().drawings(&id("BTCUSDT")).unwrap(),
        vec![saved.clone()]
    );

    // Down to scale 0: 12 345 (123.45) is stored as 123.
    f.store().upsert_instruments(&[inst("BTCUSDT", 0)]).unwrap();
    let saved = f
        .engine
        .save_drawing(drawing("line", DrawingBody::Hline { p: 12_345 }))
        .await
        .unwrap();
    assert_eq!(
        (saved.price_scale, &saved.body),
        (0, &DrawingBody::Hline { p: 123 })
    );
}

#[tokio::test]
async fn save_rejects_a_drawing_that_does_not_fit_the_new_tick_size() {
    let f = Fixture::new();
    f.store().upsert_instruments(&[inst("BTCUSDT", 4)]).unwrap();
    // Past ±(2^53 - 1) once multiplied by 100.
    let big = drawing(
        "big",
        DrawingBody::Hline {
            p: JS_SAFE_MAX / 10,
        },
    );
    let err = f.engine.save_drawing(big).await.unwrap_err();
    assert!(
        matches!(&err, EngineError::Drawing(m) if m.contains("price scale 4") && m.contains("±(2^53 - 1)")),
        "{err:?}"
    );
    // Past i64 itself.
    let mut huge = drawing("huge", DrawingBody::Hline { p: i64::MAX / 2 });
    huge.price_scale = 0;
    let err = f.engine.save_drawing(huge).await.unwrap_err();
    assert!(
        matches!(&err, EngineError::Drawing(m) if m.contains("price scale 4") && m.contains("do not fit")),
        "{err:?}"
    );
    // A rounded stop that meets the entry breaks the position's rules.
    f.store().upsert_instruments(&[inst("BTCUSDT", 0)]).unwrap();
    let tight = PositionBody {
        stop: 9_999,
        take: 10_001,
        ..long(NOW, NOW + H)
    };
    let err = f
        .engine
        .save_drawing(drawing("tight", DrawingBody::Position(tight)))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::Drawing(m) if m.contains("price scale 0") && m.contains("stop < entry < take")),
        "{err:?}"
    );
    assert!(f.store().drawings(&id("BTCUSDT")).unwrap().is_empty());
}

#[tokio::test]
async fn save_rejects_an_invalid_drawing_and_stores_nothing() {
    let f = Fixture::new();
    let bad = drawing(
        "a",
        DrawingBody::Position(PositionBody {
            stop: 13_000,
            ..long(0, H)
        }),
    );
    let err = f.engine.save_drawing(bad).await.unwrap_err();
    assert!(
        matches!(&err, EngineError::Drawing(m) if m.contains("stop < entry < take")),
        "{err:?}"
    );
    let mut bad_id = drawing("a b", DrawingBody::Hline { p: 1 });
    assert!(matches!(
        f.engine.save_drawing(bad_id.clone()).await,
        Err(EngineError::Drawing(_))
    ));
    bad_id.id = "ok".into();
    bad_id.instrument = id("NOPE");
    assert!(matches!(
        f.engine.save_drawing(bad_id).await,
        Err(EngineError::UnknownInstrument(_))
    ));
    assert!(f.engine.drawings(&id("BTCUSDT")).await.unwrap().is_empty());
    assert!(matches!(
        f.engine.delete_drawing("").await,
        Err(EngineError::Drawing(_))
    ));
}

#[tokio::test]
async fn drawings_are_rescaled_when_the_tick_size_changed() {
    let f = Fixture::new();
    f.engine
        .save_drawing(drawing("pos", DrawingBody::Position(long(NOW, NOW + H))))
        .await
        .unwrap();
    f.engine
        .save_drawing(drawing("line", DrawingBody::Hline { p: 12_345 }))
        .await
        .unwrap();

    // The exchange now quotes BTCUSDT with four decimals.
    f.store().upsert_instruments(&[inst("BTCUSDT", 4)]).unwrap();
    let got = f.engine.drawings(&id("BTCUSDT")).await.unwrap();
    assert_eq!(got.len(), 2);
    assert!(got.iter().all(|d| d.price_scale == 4));
    assert_eq!(got[0].body, DrawingBody::Hline { p: 1_234_500 });
    let DrawingBody::Position(p) = &got[1].body else {
        panic!("{:?}", got[1]);
    };
    assert_eq!((p.stop, p.entry.p, p.take), (900_000, 1_000_000, 1_200_000));
    assert_eq!((p.entry.t, p.end_t), (NOW, NOW + H));

    // Reading does not rewrite the stored rows.
    let stored = f.store().drawings(&id("BTCUSDT")).unwrap();
    assert!(stored.iter().all(|d| d.price_scale == 2));

    // Down to one decimal: 12 345 (123.45) rounds to 1 235 (123.5).
    f.store().upsert_instruments(&[inst("BTCUSDT", 1)]).unwrap();
    let got = f.engine.drawings(&id("BTCUSDT")).await.unwrap();
    assert_eq!(got[0].body, DrawingBody::Hline { p: 1_235 });
}

#[tokio::test]
async fn a_drawing_that_breaks_a_rule_after_rescaling_is_left_out() {
    let f = Fixture::new();
    let tight = PositionBody {
        entry: Anchor { t: NOW, p: 10_000 },
        stop: 9_999,
        take: 10_001,
        ..long(NOW, NOW + H)
    };
    f.engine
        .save_drawing(drawing("tight", DrawingBody::Position(tight)))
        .await
        .unwrap();
    f.engine
        .save_drawing(drawing("line", DrawingBody::Hline { p: 5 }))
        .await
        .unwrap();
    // At scale 0 the stop, the entry and the take all round to 100.
    f.store().upsert_instruments(&[inst("BTCUSDT", 0)]).unwrap();
    let got = f.engine.drawings(&id("BTCUSDT")).await.unwrap();
    let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["line"]);
    assert_eq!(f.store().drawings(&id("BTCUSDT")).unwrap().len(), 2);
}

#[tokio::test]
async fn unknown_instrument_has_no_drawings_list() {
    let f = Fixture::new();
    assert!(matches!(
        f.engine.drawings(&id("NOPE")).await,
        Err(EngineError::UnknownInstrument(_))
    ));
}

fn bar(open_time: i64, high: i64, low: i64) -> Candle {
    Candle {
        open_time,
        open: 10_000,
        high,
        low,
        close: 10_000,
        volume: 1,
    }
}

#[tokio::test]
async fn position_outcomes_read_the_cached_candles_of_the_timeframe() {
    let f = Fixture::new();
    let t0 = NOW / H * H;
    f.store()
        .upsert_candles(
            &id("BTCUSDT"),
            Timeframe::H1,
            &[
                bar(t0, 13_000, 8_000), // the entry bar: skipped
                bar(t0 + H, 10_500, 9_500),
                bar(t0 + 2 * H, 12_100, 9_900),
            ],
        )
        .unwrap();
    let positions = vec![
        ("take".to_owned(), long(t0 + 10, t0 + 5 * H)),
        ("open".to_owned(), long(t0 + 10, t0 + H)),
    ];
    let got = f
        .engine
        .position_outcomes(&id("BTCUSDT"), Timeframe::H1, positions.clone())
        .await
        .unwrap();
    assert_eq!(got[0].0, "take");
    assert_eq!(got[0].1.status, Status::Take);
    assert_eq!(got[0].1.exit_time, Some(t0 + 2 * H));
    assert_eq!(got[0].1.r, 2.0);
    assert_eq!(got[1].0, "open");
    assert_eq!(got[1].1.status, Status::Open);

    // Another timeframe has no cached candles.
    let other = f
        .engine
        .position_outcomes(&id("BTCUSDT"), Timeframe::M15, positions)
        .await
        .unwrap();
    assert!(other.iter().all(|(_, o)| o.status == Status::Open));
}

#[tokio::test]
async fn position_outcomes_reject_an_invalid_position() {
    let f = Fixture::new();
    let err = f
        .engine
        .position_outcomes(
            &id("BTCUSDT"),
            Timeframe::H1,
            vec![("p1".into(), long(NOW, NOW))],
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::Drawing(m) if m.contains("p1") && m.contains("end after")),
        "{err:?}"
    );
}
