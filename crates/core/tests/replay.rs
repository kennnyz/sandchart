//! `simulate` and the replay file against the hand-written cases in `fixtures/replay.json`,
//! which the UI mock's TEST-ONLY copy is checked against too.

use sandchart_core::aggregate::aggregate;
use sandchart_core::replay::{
    Command, MAX_CANDLES, MAX_COMMANDS, MAX_FILE_BYTES, ReplayFile, Simulation, Stats, Trade,
    candle_hash, revealed, simulate,
};
use sandchart_core::{Candle, Instrument, InstrumentId, Side, Timeframe};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    base: String,
    candles: Vec<[i64; 5]>,
    start: i64,
    cut: i64,
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
struct Chart {
    cut: i64,
    candles: Vec<[i64; 6]>,
}

#[derive(Deserialize)]
struct View {
    name: String,
    base: String,
    tf: String,
    candles: Vec<[i64; 6]>,
    start: i64,
    cut: i64,
    commands: Vec<Command>,
    charts: Vec<Chart>,
    expect: Simulation,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
    files: Vec<FileCase>,
    views: Vec<View>,
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

fn rows6(rows: &[[i64; 6]]) -> Vec<Candle> {
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
        let got = simulate(
            tf(&c.base),
            &candles(&c.candles),
            c.start,
            c.cut,
            &c.commands,
        );
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
            // serde adds where in the text it failed; the fixture holds the message before it.
            (None, Some(msg)) => {
                let err = got.unwrap_err();
                assert!(err.starts_with(msg.as_str()), "{}: {err}", c.name);
            }
            _ => panic!("{}: needs exactly one of expect and error", c.name),
        }
    }
}

/// A command is a time, so the chart's timeframe cannot change a result; the chart at each
/// cut is the revealed base candles aggregated, its last bar the forming one.
#[test]
fn views_aggregate_the_revealed_candles_and_leave_results_alone() {
    for v in &fixture().views {
        let (base, candles) = (tf(&v.base), rows6(&v.candles));
        for c in &v.charts {
            let shown = aggregate(revealed(base, &candles, c.cut), base, tf(&v.tf)).unwrap();
            assert_eq!(shown, rows6(&c.candles), "{}: chart at {}", v.name, c.cut);
        }
        let got = simulate(base, &candles, v.start, v.cut, &v.commands).unwrap();
        assert_sim(&got, &v.expect, &v.name);
        // The entry is the close of the forming bar shown when the command was given.
        let entry_cut = v.commands[0].time();
        let chart = v.charts.iter().find(|c| c.cut == entry_cut).unwrap();
        assert_eq!(chart.candles.last().unwrap()[4], got.trades[0].entry_price);
    }
}

#[test]
fn revealed_candles_close_at_or_before_the_cut() {
    let candles: Vec<Candle> = (0..4i64)
        .map(|i| Candle {
            open_time: i * 3_600_000,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 0,
        })
        .collect();
    let h = Timeframe::H1;
    assert_eq!(revealed(h, &candles, 0).len(), 0);
    assert_eq!(revealed(h, &candles, 3_599_999).len(), 0);
    assert_eq!(revealed(h, &candles, 3_600_000).len(), 1);
    assert_eq!(revealed(h, &candles, 7_200_001).len(), 2);
    assert_eq!(revealed(h, &candles, i64::MAX).len(), 4);
}

const H: i64 = 3_600_000;
const T0: i64 = 1_700_000_000_000 - 1_700_000_000_000 % H;

fn session(n: usize) -> ReplayFile {
    let candles = (0..n as i64)
        .map(|i| Candle {
            open_time: T0 + i * H,
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
        base: Timeframe::H1,
        candles,
        start: T0 + 3 * H,
        cut: T0 + n as i64 * H,
        caught_up_at: None,
        commands: vec![
            Command::Open {
                time: T0 + 3 * H,
                side: Side::Long,
                stop: 9_900,
                take: 10_300,
            },
            Command::Edit {
                time: T0 + 4 * H,
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
    assert!(text.starts_with("{\n  \"version\": 2,\n"), "{text}");
    assert!(text.contains("\n  \"base\": \"1h\",\n"), "{text}");
    assert!(
        text.contains(&format!("\n  \"cut\": {},\n", T0 + 5 * H)),
        "{text}"
    );
    assert!(text.contains(&format!("\n    [{T0}, 10000, 10050, 9950, 10001, 7],\n")));
    let edit = format!(
        "{{\"kind\":\"edit\",\"time\":{},\"stop\":9950}}",
        T0 + 4 * H
    );
    assert!(text.contains(&format!("\n    {edit}\n  ],\n")), "{text}");
    // Seven header lines, the commands and the candles with their brackets, the closing brace.
    assert_eq!(text.lines().count(), 7 + (2 + 2) + (5 + 2) + 1);
}

#[test]
fn a_file_that_caught_up_round_trips_its_catch_up_time() {
    let mut file = session(5);
    file.caught_up_at = Some(file.cut);
    let text = file.to_json();
    assert!(
        text.contains(&format!(
            "\n  \"cut\": {0},\n  \"caughtUpAt\": {0},\n",
            file.cut
        )),
        "{text}"
    );
    let (back, _) = ReplayFile::from_json(text.as_bytes()).unwrap();
    assert_eq!(back, file);
    assert!(!session(5).to_json().contains("caughtUpAt"));
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
    many.commands = vec![Command::Close { time: T0 + 3 * H }; MAX_COMMANDS + 1];
    let err = ReplayFile::from_json(many.to_json().as_bytes()).unwrap_err();
    let want = format!("not a replay file: at most {MAX_COMMANDS} commands");
    assert!(err.starts_with(&want), "{err}");

    let long = session(MAX_CANDLES + 1);
    let err = ReplayFile::from_json(long.to_json().as_bytes()).unwrap_err();
    let want = format!("not a replay file: at most {MAX_CANDLES} candles");
    assert!(err.starts_with(&want), "{err}");
}

#[test]
fn broken_files_are_refused_with_a_reason() {
    let text = session(4).to_json();
    let cases = [
        (text.replace("\"1h\"", "\"7h\""), "unknown timeframe \"7h\""),
        (
            text.replace(
                &format!("\"cut\": {}", T0 + 4 * H),
                &format!("\"cut\": {}", T0 + 5 * H),
            ),
            &format!("the cut {} is not the close time of a candle", T0 + 5 * H),
        ),
        (
            text.replace("\"version\": 2,", "\"version\": 2, \"extra\": 0,"),
            "not a replay file: unknown field `extra`",
        ),
        ("\"x\"".into(), "not a replay file: invalid type"),
    ];
    for (bad, want) in &cases {
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

#[test]
fn rescaled_moves_prices_volumes_and_levels_but_no_time() {
    let file = session(4);
    let down = file.rescaled(1, 4).unwrap();
    assert_eq!(
        (down.instrument.price_scale, down.instrument.qty_scale),
        (1, 4)
    );
    // 10 001 at 2 decimals is 1000.1 at 1, rounded half away from zero: 1 000.
    assert_eq!(down.candles[0].close, 1_000);
    assert_eq!(down.candles[0].open_time, file.candles[0].open_time);
    assert_eq!(down.candles[0].volume, 1);
    assert_eq!(
        down.commands,
        vec![
            Command::Open {
                time: T0 + 3 * H,
                side: Side::Long,
                stop: 990,
                take: 1_030,
            },
            Command::Edit {
                time: T0 + 4 * H,
                stop: Some(995),
                take: None,
            },
        ]
    );
    assert_eq!(file.rescaled(2, 5).unwrap(), file);
    assert_eq!(file.rescaled(19, 5), None);
}

/// A version 1 file opens in times on its timeframe and saves as version 2 with the same
/// trades; the version 2 text opens to the same session.
#[test]
fn a_version_1_file_saves_as_version_2_with_the_same_trades() {
    let rows: Vec<String> = (0..5i64)
        .map(|i| {
            format!(
                "[{}, {}, {}, {}, {}, 7]",
                T0 + i * H,
                100,
                102 + 5 * i,
                98,
                100 + i
            )
        })
        .collect();
    let candles: Vec<[i64; 6]> = (0..5i64)
        .map(|i| [T0 + i * H, 100, 102 + 5 * i, 98, 100 + i, 7])
        .collect();
    let sha = candle_hash(&rows6(&candles));
    let v1 = format!(
        "{{\"version\": 1, \"instrument\": {{\"source\": \"binance\", \"symbol\": \"BTCUSDT\", \"base\": \"BTC\", \"quote\": \"USDT\", \"priceScale\": 2, \"qtyScale\": 5}}, \"timeframe\": \"1h\", \"start\": 1, \"current\": 4, \"sha256\": \"{sha}\", \"commands\": [{{\"kind\": \"open\", \"bar\": 1, \"side\": \"long\", \"stop\": 90, \"take\": 115}}, {{\"kind\": \"edit\", \"bar\": 2, \"take\": 112}}], \"candles\": [{}]}}",
        rows.join(", ")
    );
    let (file, sim) = ReplayFile::from_json(v1.as_bytes()).unwrap();
    assert_eq!(
        (file.base, file.start, file.cut),
        (Timeframe::H1, T0 + 2 * H, T0 + 5 * H)
    );
    assert_eq!(
        file.commands[1],
        Command::Edit {
            time: T0 + 3 * H,
            stop: None,
            take: Some(112)
        }
    );
    // Long at 101 (bar 1); bar 2 reaches 112 but the edit applies from bar 3, which does.
    assert_eq!(sim.trades.len(), 1);
    let t = sim.trades[0];
    assert_eq!(
        (t.entry_time, t.entry_price, t.exit_time, t.exit_price),
        (T0 + H, 101, Some(T0 + 3 * H), Some(112))
    );
    let text = file.to_json();
    assert!(text.starts_with("{\n  \"version\": 2,\n"), "{text}");
    let (again, sim2) = ReplayFile::from_json(text.as_bytes()).unwrap();
    assert_eq!(again, file);
    assert_eq!(sim2, sim);
}

#[test]
fn version_1_indices_are_checked_with_the_version_1_rules() {
    let file = session(4);
    let rows: Vec<[i64; 6]> = file
        .candles
        .iter()
        .map(|c| [c.open_time, c.open, c.high, c.low, c.close, c.volume])
        .collect();
    let v1 = |start: u32, current: u32, bar: u32| {
        serde_json::json!({
            "version": 1,
            "instrument": {"source": "binance", "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "priceScale": 2, "qtyScale": 5},
            "timeframe": "1h", "start": start, "current": current, "sha256": candle_hash(&file.candles),
            "commands": [{"kind": "close", "bar": bar}], "candles": rows,
        })
        .to_string()
    };
    let err = |s: String| ReplayFile::from_json(s.as_bytes()).unwrap_err();
    assert_eq!(
        err(v1(1, 4, 1)),
        "start 1 and current 4 must satisfy start <= current < 4 candles"
    );
    assert_eq!(
        err(v1(1, 2, 3)),
        "command 1: bar 3 is outside the replay (1..=2)"
    );
    assert_eq!(err(v1(1, 2, 2)), "command 1: no open trade to close");
}
