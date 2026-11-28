//! `simulate` and the replay file against the hand-written cases in `fixtures/replay.json`,
//! which the UI mock's TEST-ONLY copy is checked against too.

use sandchart_core::replay::{
    Command, MAX_CANDLES, MAX_COMMANDS, MAX_FILE_BYTES, ReplayFile, Simulation, Stats, Trade,
    candle_hash, simulate,
};
use sandchart_core::{Candle, Instrument, InstrumentId, Side, Timeframe};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    candles: Vec<[i64; 5]>,
    start: u32,
    current: u32,
    commands: Vec<Command>,
    expect: Option<Simulation>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct FileCase {
    name: String,
    file: serde_json::Value,
    expect: Option<Simulation>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
    files: Vec<FileCase>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/replay.json")).unwrap()
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

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn assert_trade(got: &Trade, want: &Trade, name: &str) {
    assert!(close(got.r, want.r), "{name}: r {} != {}", got.r, want.r);
    assert_eq!(
        Trade { r: 0.0, ..*got },
        Trade { r: 0.0, ..*want },
        "{name}"
    );
}

fn assert_stats(got: &Stats, want: &Stats, name: &str) {
    let pairs = [
        ("winRate", got.win_rate, want.win_rate),
        ("totalR", got.total_r, want.total_r),
        ("averageR", got.average_r, want.average_r),
        ("maxDrawdownR", got.max_drawdown_r, want.max_drawdown_r),
    ];
    for (field, g, w) in pairs {
        assert!(close(g, w), "{name}: {field} {g} != {w}");
    }
    match (got.profit_factor, want.profit_factor) {
        (Some(g), Some(w)) => assert!(close(g, w), "{name}: profitFactor {g} != {w}"),
        (g, w) => assert_eq!(g, w, "{name}: profitFactor"),
    }
    assert_eq!(
        (got.count, got.wins, got.losses, got.longest_losing_streak),
        (
            want.count,
            want.wins,
            want.losses,
            want.longest_losing_streak
        ),
        "{name}"
    );
}

fn assert_sim(got: &Simulation, want: &Simulation, name: &str) {
    assert_eq!(got.trades.len(), want.trades.len(), "{name}: trade count");
    for (g, w) in got.trades.iter().zip(&want.trades) {
        assert_trade(g, w, name);
    }
    assert_stats(&got.stats, &want.stats, name);
}

#[test]
fn simulate_matches_the_fixture() {
    let cases = fixture().cases;
    assert!(cases.len() >= 15);
    for c in &cases {
        let got = simulate(&candles(&c.candles), c.start, c.current, &c.commands);
        match (&c.expect, &c.error) {
            (Some(want), None) => assert_sim(&got.unwrap(), want, &c.name),
            (None, Some(msg)) => assert_eq!(got.unwrap_err(), *msg, "{}", c.name),
            _ => panic!("{}: needs exactly one of expect and error", c.name),
        }
    }
}

#[test]
fn files_match_the_fixture() {
    for c in &fixture().files {
        let bytes = serde_json::to_vec(&c.file).unwrap();
        let got = ReplayFile::from_json(&bytes);
        match (&c.expect, &c.error) {
            (Some(want), None) => assert_sim(&got.unwrap().1, want, &c.name),
            (None, Some(msg)) => assert_eq!(got.unwrap_err(), *msg, "{}", c.name),
            _ => panic!("{}: needs exactly one of expect and error", c.name),
        }
    }
}

fn session(n: usize) -> ReplayFile {
    let candles = (0..n as i64)
        .map(|i| Candle {
            open_time: 1_700_000_000_000 + i * 3_600_000,
            open: 10_000 + i,
            high: 10_050 + i,
            low: 9_950 + i,
            close: 10_001 + i,
            volume: 7,
        })
        .collect();
    ReplayFile {
        instrument: Instrument {
            id: InstrumentId {
                source: "binance".into(),
                symbol: "BTCUSDT".into(),
            },
            base: "BTC".into(),
            quote: "USDT".into(),
            price_scale: 2,
            qty_scale: 5,
        },
        timeframe: Timeframe::H4,
        candles,
        start: 2,
        current: n as u32 - 1,
        commands: vec![
            Command::Open {
                bar: 2,
                side: Side::Long,
                stop: 9_900,
                take: 10_300,
            },
            Command::Edit {
                bar: 3,
                stop: Some(9_950),
                take: None,
            },
        ],
    }
}

#[test]
fn a_file_round_trips_with_one_candle_per_line() {
    let file = session(5);
    let text = file.to_json();
    let (back, sim) = ReplayFile::from_json(text.as_bytes()).unwrap();
    assert_eq!(back, file);
    assert_eq!(sim.trades.len(), 1);
    assert!(text.contains("\"timeframe\": \"4h\""), "{text}");
    assert!(text.contains("\n    [1700000000000, 10000, 10050, 9950, 10001, 7],\n"));
    assert!(text.contains("\n    {\"kind\":\"edit\",\"bar\":3,\"stop\":9950}\n  ],\n"));
    // Seven header lines, the commands and the candles with their brackets, the closing brace.
    assert_eq!(text.lines().count(), 7 + (2 + 2) + (5 + 2) + 1);
}

#[test]
fn hash_is_sha256_of_six_little_endian_i64_per_candle() {
    assert_eq!(
        candle_hash(&[]),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    let c = Candle {
        open_time: 1,
        open: 2,
        high: 3,
        low: 4,
        close: 5,
        volume: -1,
    };
    // Independent: python3 -c "import hashlib,struct;print(hashlib.sha256(struct.pack('<6q',1,2,3,4,5,-1)).hexdigest())"
    assert_eq!(
        candle_hash(&[c]),
        "d916e34d2e70caec5f17ad7b98b22eab344f94f34eb54ee0b474ef3fcda6d20f"
    );
}

#[test]
fn files_over_the_limits_are_refused() {
    let big = vec![b' '; MAX_FILE_BYTES + 1];
    assert_eq!(
        ReplayFile::from_json(&big).unwrap_err(),
        "the replay file is 32 MiB; the limit is 32 MiB"
    );

    let mut many = session(3);
    many.commands = vec![Command::Close { bar: 2 }; MAX_COMMANDS + 1];
    assert_eq!(
        ReplayFile::from_json(many.to_json().as_bytes()).unwrap_err(),
        format!("at most {MAX_COMMANDS} commands, not {}", MAX_COMMANDS + 1)
    );

    let long = session(MAX_CANDLES + 1);
    assert_eq!(
        ReplayFile::from_json(long.to_json().as_bytes()).unwrap_err(),
        format!("at most {MAX_CANDLES} candles, not {}", MAX_CANDLES + 1)
    );
}

#[test]
fn broken_files_are_refused_with_a_reason() {
    let text = session(4).to_json();
    let cases = [
        (text.replace("\"4h\"", "\"7h\""), "unknown timeframe \"7h\""),
        (
            text.replace("\"current\": 3", "\"current\": 4"),
            "start 2 and current 4 must satisfy start <= current < 4 candles",
        ),
        (
            text.replace("\"version\": 1,", "\"version\": 1, \"extra\": 0,"),
            "not a replay file: unknown field `extra`",
        ),
        ("\"x\"".into(), "not a replay file: invalid type"),
    ];
    for (bad, want) in cases {
        let err = ReplayFile::from_json(bad.as_bytes()).unwrap_err();
        assert!(
            err.starts_with(want),
            "{err:?} does not start with {want:?}"
        );
    }

    let mut swapped = session(4);
    swapped.candles.swap(0, 1);
    assert_eq!(
        ReplayFile::from_json(swapped.to_json().as_bytes()).unwrap_err(),
        "candle 1: open times must go up"
    );
    let mut huge = session(4);
    huge.candles[2].high = 1 << 53;
    assert_eq!(
        ReplayFile::from_json(huge.to_json().as_bytes()).unwrap_err(),
        format!("candle 2: {} is outside ±(2^53 - 1)", 1i64 << 53)
    );
}
