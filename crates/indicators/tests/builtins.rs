//! The built-in indicators against reference values, the repaint check, and
//! the performance and fuel budgets.

use std::path::Path;
use std::time::{Duration, Instant};

use sandchart_indicators::{
    Bar, DEFAULT_FUEL, Limits, Module, ParamValue, REPAINT_BARS, REPAINT_PREFIXES, RepaintAt,
    RunError, Runtime, SeriesData, builtins, check_repaint, sample_bars,
};

fn load_all(rt: &Runtime) -> Vec<(&'static str, Module)> {
    builtins()
        .iter()
        .map(|(id, bytes)| (*id, rt.load(bytes).unwrap()))
        .collect()
}

fn builtin(rt: &Runtime, id: &str) -> Module {
    let bytes = builtins().iter().find(|(i, _)| *i == id).unwrap().1;
    rt.load(bytes).unwrap()
}

fn runtime() -> Runtime {
    Runtime::new(Limits::default(), None).unwrap()
}

/// `reference.csv`: header, then one row per bar; an empty cell is NaN.
struct Reference {
    bars: Vec<Bar>,
    columns: Vec<(String, Vec<f64>)>,
}

impl Reference {
    fn load() -> Reference {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reference.csv");
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines = text.lines();
        let header: Vec<&str> = lines.next().unwrap().split(',').collect();
        assert_eq!(
            header[..6],
            ["time", "open", "high", "low", "close", "volume"]
        );
        let mut columns: Vec<(String, Vec<f64>)> = header[6..]
            .iter()
            .map(|n| (n.to_string(), Vec::new()))
            .collect();
        let mut bars = Vec::new();
        for line in lines {
            let cells: Vec<&str> = line.split(',').collect();
            let f = |i: usize| cells[i].parse::<f64>().unwrap();
            bars.push(Bar {
                time: cells[0].parse().unwrap(),
                open: f(1),
                high: f(2),
                low: f(3),
                close: f(4),
                volume: f(5),
            });
            for (k, (_, col)) in columns.iter_mut().enumerate() {
                let c = cells[6 + k];
                col.push(if c.is_empty() {
                    f64::NAN
                } else {
                    c.parse().unwrap()
                });
            }
        }
        Reference { bars, columns }
    }

    fn column(&self, name: &str) -> &[f64] {
        &self.columns.iter().find(|(n, _)| n == name).unwrap().1
    }
}

fn values<'a>(out: &'a sandchart_indicators::Output, id: &str) -> &'a [f64] {
    match &out.series.iter().find(|s| s.id == id).unwrap().data {
        SeriesData::Values(v) => v,
        SeriesData::Markers(_) => panic!("{id} is markers"),
    }
}

fn assert_matches(label: &str, got: &[f64], want: &[f64]) {
    assert_eq!(got.len(), want.len(), "{label}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        if w.is_nan() {
            assert!(g.is_nan(), "{label}[{i}]: got {g}, want NaN");
        } else {
            let tol = 1e-9 * w.abs().max(1.0);
            assert!((g - w).abs() <= tol, "{label}[{i}]: got {g}, want {w}");
        }
    }
}

fn check(id: &str, params: &[(String, ParamValue)], pairs: &[(&str, &str)]) {
    let rt = runtime();
    let reference = Reference::load();
    let out = builtin(&rt, id).compute(params, &reference.bars).unwrap();
    for (series, column) in pairs {
        assert_matches(
            &format!("{id}/{series}"),
            values(&out, series),
            reference.column(column),
        );
    }
}

#[test]
fn sma_matches_reference() {
    check("builtin.sma", &[], &[("sma", "sma20")]);
}

#[test]
fn ema_matches_reference() {
    check("builtin.ema", &[], &[("ema", "ema20")]);
}

#[test]
fn bollinger_matches_reference() {
    check(
        "builtin.bollinger",
        &[],
        &[
            ("basis", "bb_basis"),
            ("upper", "bb_upper"),
            ("lower", "bb_lower"),
        ],
    );
}

#[test]
fn rsi_matches_reference() {
    check("builtin.rsi", &[], &[("rsi", "rsi14")]);
}

#[test]
fn macd_matches_reference() {
    check(
        "builtin.macd",
        &[],
        &[
            ("macd", "macd"),
            ("signal", "macd_signal"),
            ("hist", "macd_hist"),
        ],
    );
}

#[test]
fn builtin_ids_and_versions() {
    let rt = runtime();
    for (id, module) in load_all(&rt) {
        assert_eq!(module.meta().id, id);
        assert_eq!(module.meta().version, "0.2.0");
    }
}

#[test]
fn macd_fast_ge_slow_is_error() {
    let rt = runtime();
    let m = builtin(&rt, "builtin.macd");
    let params = vec![
        ("fast".to_string(), ParamValue::Int(26)),
        ("slow".to_string(), ParamValue::Int(26)),
    ];
    match m.compute(&params, &sample_bars(100)) {
        Err(RunError::Indicator(msg)) => assert_eq!(msg, "fast must be less than slow"),
        other => panic!("expected an indicator error, got {other:?}"),
    }
}

#[test]
fn builtins_do_not_repaint() {
    let rt = runtime();
    let bars = sample_bars(REPAINT_BARS);
    for (id, module) in load_all(&rt) {
        let params = module.resolve_params(&[]);
        let found = check_repaint(&module, &params, &bars, &REPAINT_PREFIXES).unwrap();
        assert_eq!(found, None, "{id} repaints");
    }
}

#[test]
fn repaint_is_detected() {
    let rt = runtime();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../indicators/target/wasm32-wasip2/release/testguest_repaints.wasm");
    let module = rt.load(&std::fs::read(path).unwrap()).unwrap();
    let found = check_repaint(&module, &[], &sample_bars(REPAINT_BARS), &REPAINT_PREFIXES).unwrap();
    assert_eq!(
        found,
        Some(RepaintAt {
            series: "max".into(),
            index: 0
        })
    );
}

#[test]
fn macd_fuel_budget() {
    let rt = runtime();
    let out = builtin(&rt, "builtin.macd")
        .compute(&[], &sample_bars(100_000))
        .unwrap();
    println!("macd fuel on 100k bars: {}", out.fuel_used);
    assert!(
        out.fuel_used < DEFAULT_FUEL / 20,
        "MACD used {} of {DEFAULT_FUEL} fuel",
        out.fuel_used
    );
}

fn slack() -> f64 {
    std::env::var("SANDCHART_PERF_SLACK")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0)
}

/// Best of five runs of all five built-ins with default params; only
/// `compute` is timed.
fn best_total(bars: &[Bar]) -> Duration {
    let rt = runtime();
    let modules = load_all(&rt);
    let params: Vec<_> = modules.iter().map(|(_, m)| m.resolve_params(&[])).collect();
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let mut total = Duration::ZERO;
        for ((id, m), p) in modules.iter().zip(&params) {
            let t = Instant::now();
            m.compute(p, bars).unwrap();
            let d = t.elapsed();
            println!("  {id}: {d:?}");
            total += d;
        }
        println!("total: {total:?}");
        best = best.min(total);
    }
    best
}

#[test]
#[ignore = "timing; run in release: cargo test --release -p sandchart-indicators --test builtins -- --ignored perf_"]
fn perf_builtins_100k() {
    let best = best_total(&sample_bars(100_000));
    let budget = Duration::from_millis(50).mul_f64(slack());
    println!("100k bars, best of 5: {best:?} (budget {budget:?})");
    assert!(best < budget, "{best:?} >= {budget:?}");
}

#[test]
#[ignore = "timing; run in release: cargo test --release -p sandchart-indicators --test builtins -- --ignored perf_"]
fn perf_builtins_5k() {
    let best = best_total(&sample_bars(5_000));
    let budget = Duration::from_millis(5).mul_f64(slack());
    println!("5k bars, best of 5: {best:?} (budget {budget:?})");
    assert!(best < budget, "{best:?} >= {budget:?}");
}
