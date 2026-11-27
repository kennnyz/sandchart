//! `test`: runs a module in the app's host and reports what the app would see.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use sandchart_indicators::{
    DEFAULT_FUEL, Limits, Module, Output, ParamKind, ParamValue, REPAINT_BARS, REPAINT_PREFIXES,
    RepaintAt, Runtime, SeriesData, SeriesSpec, check_repaint, sample_bars,
};
use serde_json::{Value, json};

use crate::csv;

/// How many trailing values of each series are shown.
const LAST: usize = 5;

/// What a run found. Fields stay empty when the run stopped early.
#[derive(Default)]
struct Report {
    id: Option<String>,
    version: Option<String>,
    bars: usize,
    series: Vec<Value>,
    fuel_used: Option<u64>,
    log: String,
    deterministic: Option<bool>,
    repaints: Option<RepaintAt>,
    errors: Vec<String>,
}

pub fn run(
    file: &Path,
    csv: Option<&Path>,
    params: &[String],
    json: bool,
) -> Result<ExitCode, String> {
    let mut report = Report::default();
    if let Err(e) = check(file, csv, params, &mut report) {
        report.errors.push(e);
    }
    if json {
        println!("{:#}", report.to_json());
    } else {
        report.print();
    }
    Ok(if report.errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn check(
    file: &Path,
    csv_file: Option<&Path>,
    params: &[String],
    report: &mut Report,
) -> Result<(), String> {
    let bytes = fs::read(file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    let runtime = Runtime::new(Limits::default(), None).map_err(|e| e.to_string())?;
    let module = runtime.load(&bytes).map_err(|e| e.to_string())?;
    let meta = module.meta();
    report.id = Some(meta.id.clone());
    report.version = Some(meta.version.clone());

    let saved = parse_params(&module, params)?;
    let (bars, prefixes) = match csv_file {
        Some(path) => {
            let text = fs::read_to_string(path)
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let bars = csv::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            let n = bars.len();
            let mut prefixes: Vec<usize> = [n / 4, n / 2, n * 3 / 4, n - 1]
                .into_iter()
                .filter(|&p| p > 0)
                .collect();
            prefixes.dedup();
            (bars, prefixes)
        }
        None => (sample_bars(REPAINT_BARS), REPAINT_PREFIXES.to_vec()),
    };
    report.bars = bars.len();

    let first = module.compute(&saved, &bars).map_err(|e| e.to_string())?;
    let second = module.compute(&saved, &bars).map_err(|e| e.to_string())?;
    report.series = meta
        .series
        .iter()
        .zip(&first.series)
        .map(|(spec, out)| series_json(spec, &out.data))
        .collect();
    report.fuel_used = Some(first.fuel_used);
    report.log = first.log.clone();
    let deterministic = same_output(&first, &second);
    report.deterministic = Some(deterministic);
    if !deterministic {
        return Err(
            "two runs on the same input gave different output; the indicator must be a pure \
             function of its params and candles (no clocks, no randomness, no state between calls)"
                .into(),
        );
    }
    report.repaints =
        check_repaint(&module, &saved, &bars, &prefixes).map_err(|e| e.to_string())?;
    Ok(())
}

/// `id=value` pairs, checked against the module's specs, as a saved-params list.
fn parse_params(module: &Module, raw: &[String]) -> Result<Vec<(String, ParamValue)>, String> {
    let mut saved = Vec::new();
    for item in raw {
        let (id, text) = item
            .split_once('=')
            .ok_or_else(|| format!("--param \"{item}\": expected id=value"))?;
        let spec = module
            .meta()
            .params
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| {
                let known: Vec<&str> = module.meta().params.iter().map(|p| p.id.as_str()).collect();
                format!(
                    "--param {id}: the module has no such param (it has: {})",
                    known.join(", ")
                )
            })?;
        let bad = |what: String| format!("--param {id}: {what}");
        let value = match &spec.kind {
            ParamKind::Int { min, max } => {
                let v: i64 = text
                    .parse()
                    .map_err(|_| bad(format!("\"{text}\" is not an integer")))?;
                if !(*min..=*max).contains(&v) {
                    return Err(bad(format!("{v} is outside {min}..={max}")));
                }
                ParamValue::Int(v)
            }
            ParamKind::Float { min, max } => {
                let v: f64 = text
                    .parse()
                    .map_err(|_| bad(format!("\"{text}\" is not a number")))?;
                if !(*min..=*max).contains(&v) {
                    return Err(bad(format!("{v} is outside {min}..={max}")));
                }
                ParamValue::Float(v)
            }
            ParamKind::Boolean => ParamValue::Boolean(
                text.parse()
                    .map_err(|_| bad(format!("\"{text}\" is not true or false")))?,
            ),
            ParamKind::Choice(options) => {
                if !options.iter().any(|o| o == text) {
                    return Err(bad(format!(
                        "\"{text}\" is not one of {}",
                        options.join(", ")
                    )));
                }
                ParamValue::Choice(text.to_string())
            }
        };
        saved.retain(|(k, _): &(String, ParamValue)| k != id);
        saved.push((id.to_string(), value));
    }
    Ok(saved)
}

/// NaN equals NaN; everything else must be bit-identical.
fn same_output(a: &Output, b: &Output) -> bool {
    if a.fuel_used != b.fuel_used || a.log != b.log || a.series.len() != b.series.len() {
        return false;
    }
    a.series.iter().zip(&b.series).all(|(x, y)| {
        x.id == y.id
            && match (&x.data, &y.data) {
                (SeriesData::Values(p), SeriesData::Values(q)) => {
                    p.len() == q.len()
                        && p.iter()
                            .zip(q)
                            .all(|(p, q)| (p.is_nan() && q.is_nan()) || p.to_bits() == q.to_bits())
                }
                (SeriesData::Markers(p), SeriesData::Markers(q)) => p == q,
                _ => false,
            }
    })
}

fn series_json(spec: &SeriesSpec, data: &SeriesData) -> Value {
    let (count, last): (usize, Vec<Value>) = match data {
        SeriesData::Values(v) => (
            v.len(),
            v[v.len().saturating_sub(LAST)..]
                .iter()
                .map(|x| if x.is_finite() { json!(x) } else { Value::Null })
                .collect(),
        ),
        SeriesData::Markers(m) => {
            let mut m: Vec<_> = m.iter().collect();
            m.sort_by_key(|m| m.index);
            (
                m.len(),
                m[m.len().saturating_sub(LAST)..]
                    .iter()
                    .map(|m| json!({"index": m.index, "shape": m.shape, "text": m.text}))
                    .collect(),
            )
        }
    };
    json!({
        "id": spec.id,
        "kind": spec.kind,
        "pane": spec.pane,
        "count": count,
        "last": last,
    })
}

impl Report {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "version": self.version,
            "bars": self.bars,
            "series": self.series,
            "fuel_used": self.fuel_used,
            "fuel_percent": self.fuel_used.map(fuel_percent),
            "log": self.log,
            "deterministic": self.deterministic,
            "repaints": self.repaints.as_ref().map(|r| json!({"series": r.series, "index": r.index})),
            "errors": self.errors,
        })
    }

    fn print(&self) {
        if let (Some(id), Some(version)) = (&self.id, &self.version) {
            if self.bars > 0 {
                println!("{id} {version} on {} bars", self.bars);
            } else {
                println!("{id} {version}");
            }
        }
        for s in &self.series {
            let last: Vec<String> = s["last"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| match v {
                    Value::Null => "NaN".to_string(),
                    Value::Object(m) => {
                        format!("{}@{}", m["shape"].as_str().unwrap_or("?"), m["index"])
                    }
                    v => v.to_string(),
                })
                .collect();
            println!(
                "  {} ({}, {}, {} {}): last {}: {}",
                s["id"].as_str().unwrap_or(""),
                s["kind"]
                    .as_str()
                    .map_or_else(|| s["kind"].to_string(), str::to_string),
                s["pane"].as_str().unwrap_or(""),
                s["count"],
                if s["kind"] == "markers" {
                    "markers"
                } else {
                    "values"
                },
                last.len(),
                last.join(" ")
            );
        }
        if let Some(fuel) = self.fuel_used {
            println!(
                "fuel: {fuel} of {DEFAULT_FUEL} ({:.2}%)",
                fuel_percent(fuel)
            );
        }
        if !self.log.is_empty() {
            println!("log:");
            for line in self.log.lines() {
                println!("  {line}");
            }
        }
        match self.deterministic {
            Some(true) => println!("deterministic: yes"),
            Some(false) => println!("deterministic: NO"),
            None => {}
        }
        if let Some(r) = &self.repaints {
            println!(
                "warning: repaints (series \"{}\", first difference at bar {})",
                r.series, r.index
            );
        }
        for e in &self.errors {
            eprintln!("error: {e}");
        }
    }
}

fn fuel_percent(fuel: u64) -> f64 {
    (fuel as f64 / DEFAULT_FUEL as f64 * 10_000.0).round() / 100.0
}
