//! Alert levels, the firing rule and validation against `fixtures/alerts.json`, which the
//! browser mock's copy of the rule runs too, so the two cannot drift apart.

use sandchart_core::InstrumentId;
use sandchart_core::alert::{Alert, AlertKind, Direction, Level, Update, fires, validate};
use serde::Deserialize;

#[derive(Deserialize)]
struct LevelCase {
    name: String,
    level: Level,
    t: i64,
    value: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FireCase {
    name: String,
    direction: Direction,
    level: Level,
    same_stream: bool,
    prev: Update,
    cur: Update,
    fired: Option<i64>,
}

#[derive(Deserialize)]
struct Input {
    id: String,
    kind: AlertKind,
    direction: Direction,
}

#[derive(Deserialize)]
struct ValidationCase {
    name: String,
    alert: Input,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Fixture {
    levels: Vec<LevelCase>,
    fires: Vec<FireCase>,
    invalid: Vec<ValidationCase>,
    valid: Vec<ValidationCase>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/alerts.json")).unwrap()
}

fn alert(i: Input) -> Alert {
    Alert {
        id: i.id,
        instrument: InstrumentId {
            source: "binance".into(),
            symbol: "BTCUSDT".into(),
        },
        price_scale: 2,
        kind: i.kind,
        direction: i.direction,
        active: true,
        created_at: 0,
        triggered_at: None,
        triggered_price: None,
    }
}

#[test]
fn levels_match_the_fixture() {
    let cases = fixture().levels;
    assert!(cases.len() >= 15);
    for c in cases {
        assert_eq!(c.level.at(c.t), c.value, "{}", c.name);
    }
}

#[test]
fn firing_matches_the_fixture() {
    let cases = fixture().fires;
    assert!(cases.len() >= 25);
    for c in cases {
        let got = fires(c.direction, &c.level, &c.prev, &c.cur, c.same_stream);
        assert_eq!(got, c.fired, "{}", c.name);
    }
}

#[test]
fn validation_matches_the_fixture() {
    let f = fixture();
    for c in f.invalid {
        let err = validate(&alert(c.alert)).unwrap_err();
        assert_eq!(Some(err), c.error, "{}", c.name);
    }
    for c in f.valid {
        assert_eq!(c.error, None, "{}", c.name);
        assert_eq!(validate(&alert(c.alert)), Ok(()), "{}", c.name);
    }
}
