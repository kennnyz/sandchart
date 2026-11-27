//! `resolve` against the hand-written cases in `fixtures/positions.json`, which the UI mock's
//! TEST-ONLY copy is checked against too.

use sandchart_core::{Anchor, Candle, Outcome, PositionBody, Side, Status, position::resolve};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    side: Side,
    entry: Anchor,
    stop: i64,
    take: i64,
    end_t: i64,
    candles: Vec<[i64; 5]>,
    expect: Outcome,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn cases() -> Vec<Case> {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/positions.json")).unwrap();
    fixture.cases
}

fn candles(rows: &[[i64; 5]]) -> Vec<Candle> {
    rows.iter()
        .map(|&[open_time, open, high, low, close]| Candle {
            open_time,
            open,
            high,
            low,
            close,
            volume: 0,
        })
        .collect()
}

#[test]
fn resolve_matches_the_fixture() {
    let cases = cases();
    assert!(cases.len() >= 12);
    for c in &cases {
        let got = resolve(
            c.side,
            c.entry,
            c.stop,
            c.take,
            c.end_t,
            &candles(&c.candles),
        );
        assert_eq!(got, c.expect, "{}", c.name);
    }
}

#[test]
fn fixture_positions_are_valid_and_cover_every_status() {
    let cases = cases();
    for c in &cases {
        let body = PositionBody {
            side: c.side,
            entry: c.entry,
            stop: c.stop,
            take: c.take,
            end_t: c.end_t,
        };
        assert_eq!(body.validate(), Ok(()), "{}", c.name);
        assert_eq!(body.resolve(&candles(&c.candles)), c.expect, "{}", c.name);
    }
    for side in [Side::Long, Side::Short] {
        for status in [Status::Open, Status::Take, Status::Stop] {
            assert!(
                cases
                    .iter()
                    .any(|c| c.side == side && c.expect.status == status),
                "no {side:?} {status:?} case"
            );
        }
        assert!(cases.iter().any(|c| c.side == side && c.expect.ambiguous));
    }
}

#[test]
fn outcome_json_is_camel_case() {
    let o = Outcome {
        status: Status::Take,
        exit_time: Some(3),
        ambiguous: false,
        r: 2.5,
    };
    assert_eq!(
        serde_json::to_value(o).unwrap(),
        serde_json::json!({ "status": "take", "exitTime": 3, "ambiguous": false, "r": 2.5 })
    );
}
