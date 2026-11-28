//! `aggregate` against the hand-written cases in `fixtures/replay.json` (section
//! `aggregates`), which the UI mock's TEST-ONLY copy is checked against too.

use sandchart_core::aggregate::aggregate;
use sandchart_core::{Candle, Timeframe};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    base: String,
    tf: String,
    candles: Vec<[i64; 6]>,
    expect: Option<Vec<[i64; 6]>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Fixture {
    aggregates: Vec<Case>,
}

fn candles(rows: &[[i64; 6]]) -> Vec<Candle> {
    rows.iter()
        .map(|&[open_time, open, high, low, close, volume]| Candle {
            open_time,
            open,
            high,
            low,
            close,
            volume,
        })
        .collect()
}

fn tf(code: &str) -> Timeframe {
    Timeframe::from_code(code).unwrap()
}

#[test]
fn aggregate_matches_the_fixture() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/replay.json")).unwrap();
    assert!(fixture.aggregates.len() >= 8);
    for c in &fixture.aggregates {
        let got = aggregate(&candles(&c.candles), tf(&c.base), tf(&c.tf));
        match (&c.expect, &c.error) {
            (Some(want), None) => assert_eq!(got.unwrap(), candles(want), "{}", c.name),
            (None, Some(msg)) => assert_eq!(got.unwrap_err(), *msg, "{}", c.name),
            _ => panic!("{}: needs exactly one of expect and error", c.name),
        }
    }
}

/// 15m candles over two hours, built by hand from hourly OHLCV the way Binance splits an
/// hour, aggregate to exactly those hours.
#[test]
fn quarter_hours_aggregate_to_the_hours_they_were_split_from() {
    let hours = [
        [
            1_795_752_000_000,
            6_150_010,
            6_180_000,
            6_145_000,
            6_177_735,
            51_234,
        ],
        [
            1_795_755_600_000,
            6_177_735,
            6_179_000,
            6_160_000,
            6_161_200,
            40_000,
        ],
    ];
    let quarters = [
        // First hour: open, high in the second quarter, low in the third, close in the last.
        [
            1_795_752_000_000,
            6_150_010,
            6_160_000,
            6_149_000,
            6_158_000,
            10_000,
        ],
        [
            1_795_752_900_000,
            6_158_000,
            6_180_000,
            6_150_000,
            6_170_000,
            20_000,
        ],
        [
            1_795_753_800_000,
            6_170_000,
            6_171_000,
            6_145_000,
            6_160_000,
            11_000,
        ],
        [
            1_795_754_700_000,
            6_160_000,
            6_178_000,
            6_159_000,
            6_177_735,
            10_234,
        ],
        [
            1_795_755_600_000,
            6_177_735,
            6_179_000,
            6_170_000,
            6_171_000,
            10_000,
        ],
        [
            1_795_756_500_000,
            6_171_000,
            6_172_000,
            6_160_000,
            6_165_000,
            10_000,
        ],
        [
            1_795_757_400_000,
            6_165_000,
            6_168_000,
            6_161_000,
            6_162_000,
            10_000,
        ],
        [
            1_795_758_300_000,
            6_162_000,
            6_166_000,
            6_161_000,
            6_161_200,
            10_000,
        ],
    ];
    assert_eq!(
        aggregate(&candles(&quarters), Timeframe::M15, Timeframe::H1).unwrap(),
        candles(&hours)
    );
    // Every prefix (a forming hour) aggregates to the hours so far, the last one partial.
    let partial = aggregate(&candles(&quarters[..6]), Timeframe::M15, Timeframe::H1).unwrap();
    assert_eq!(partial[0], candles(&hours)[0]);
    assert_eq!(
        partial[1],
        candles(&[[
            1_795_755_600_000,
            6_177_735,
            6_179_000,
            6_160_000,
            6_165_000,
            20_000
        ]])[0]
    );
}

#[test]
fn which_timeframes_build_from_which() {
    use Timeframe::*;
    let ok = [
        (M1, M1),
        (M1, M3),
        (M1, Mn1),
        (M3, M15),
        (M15, H1),
        (M30, H4),
        (H1, D1),
        (H8, D1),
        (H8, W1),
        (H12, W1),
        (D1, D3),
        (D1, W1),
        (D1, Mn1),
        (H4, Mn1),
        (W1, W1),
        (Mn1, Mn1),
    ];
    let refused = [
        (M5, M3),
        (H1, M15),
        (M3, M5),
        (H4, H6),
        (D3, W1),
        (D3, Mn1),
        (W1, Mn1),
        (Mn1, W1),
        (W1, D3),
        (D1, H12),
    ];
    for (base, tf) in ok {
        assert!(tf.builds_from(base), "{} from {}", tf.code(), base.code());
    }
    for (base, tf) in refused {
        assert!(!tf.builds_from(base), "{} from {}", tf.code(), base.code());
    }
}
