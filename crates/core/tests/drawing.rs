//! `validate` against the cases in `fixtures/drawings_valid.json` and
//! `fixtures/drawings_invalid.json`, which the UI mock's copy of the rules is checked against
//! too, so the two cannot drift apart.

use sandchart_core::drawing::validate;
use sandchart_core::{Drawing, DrawingBody, InstrumentId, Style};
use serde::Deserialize;

/// The fields of a drawing the UI sends (`DrawingInput` without the instrument and scale).
#[derive(Deserialize)]
struct Input {
    id: String,
    body: DrawingBody,
    style: Style,
    z: i64,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    drawing: Input,
    /// The whole message; absent for a valid drawing.
    error: Option<String>,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn cases(json: &str) -> Vec<Case> {
    serde_json::from_str::<Fixture>(json).unwrap().cases
}

fn drawing(i: Input) -> Drawing {
    Drawing {
        id: i.id,
        instrument: InstrumentId {
            source: "binance".into(),
            symbol: "BTCUSDT".into(),
        },
        price_scale: 2,
        body: i.body,
        style: i.style,
        locked: false,
        z: i.z,
        updated_at: 0,
    }
}

#[test]
fn valid_fixture_drawings_pass() {
    let cases = cases(include_str!("fixtures/drawings_valid.json"));
    assert!(cases.len() >= 10);
    for c in cases {
        assert_eq!(c.error, None, "{}", c.name);
        assert_eq!(validate(&drawing(c.drawing)), Ok(()), "{}", c.name);
    }
}

#[test]
fn invalid_fixture_drawings_fail_with_their_message() {
    let cases = cases(include_str!("fixtures/drawings_invalid.json"));
    assert!(cases.len() >= 30);
    for c in cases {
        let want = c
            .error
            .unwrap_or_else(|| panic!("{}: no error given", c.name));
        assert_eq!(validate(&drawing(c.drawing)), Err(want), "{}", c.name);
    }
}
