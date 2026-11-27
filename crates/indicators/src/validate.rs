//! Checks of what a module declares (`meta`) and what it returns (`compute`).
//! Every message names the item at fault so an indicator author can fix it.

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::params::fits;
use crate::{Meta, Pane, ParamKind, SeriesData, SeriesKind, SeriesOut};

/// The highest palette slot a series may use.
const MAX_COLOR: u8 = 7;

/// Caps on what a module declares and returns, so a module cannot make the host
/// or the UI hold or draw unbounded text and lists.
pub(crate) const MAX_PARAMS: usize = 64;
pub(crate) const MAX_SERIES: usize = 64;
const MAX_CHOICES: usize = 256;
/// Ids, labels, choice options and marker text.
const MAX_SHORT: usize = 64;
const MAX_NAME: usize = 128;
const MAX_DESCRIPTION: usize = 4096;
/// The largest integer a JavaScript number holds exactly: the UI gets params as JSON.
const SAFE_INT: std::ops::RangeInclusive<i64> = -((1 << 53) - 1)..=(1 << 53) - 1;

/// A guest string as it may appear in a message: at most [`MAX_SHORT`] bytes,
/// cut at a character boundary and marked with "…", so a module cannot make
/// an error message (which reaches the UI) large.
pub(crate) fn shown(s: &str) -> String {
    if s.len() <= MAX_SHORT {
        return s.to_owned();
    }
    format!("{}…", &s[..s.floor_char_boundary(MAX_SHORT)])
}

fn short(what: &str, s: &str) -> Result<(), String> {
    if s.len() > MAX_SHORT {
        return Err(format!(
            "{what} is {} bytes long; the limit is {MAX_SHORT} bytes",
            s.len()
        ));
    }
    Ok(())
}

/// A param or series id: `[a-z0-9_-]+`, at most 64 bytes.
fn part_id(what: &str, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("a {what} has an empty id"));
    }
    short(&format!("{what} id \"{}\"", shown(id)), id)?;
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(format!(
            "{what} id \"{id}\" may only use lowercase letters, digits, '_' and '-'"
        ));
    }
    Ok(())
}

/// Checks the rules of the contract for `meta`.
pub(crate) fn meta(m: &Meta) -> Result<(), String> {
    if !valid_id(&m.id) {
        return Err(format!(
            "id \"{}\" must look like \"author.name\": lowercase letters, digits, '_' and '-', \
             with exactly one '.'",
            shown(&m.id)
        ));
    }
    short(&format!("id \"{}\"", shown(&m.id)), &m.id)?;
    if m.name.trim().is_empty() {
        return Err("name is empty".into());
    }
    if m.name.len() > MAX_NAME {
        return Err(format!(
            "name is {} bytes long; the limit is {MAX_NAME} bytes",
            m.name.len()
        ));
    }
    if m.description.len() > MAX_DESCRIPTION {
        return Err(format!(
            "description is {} bytes long; the limit is 4 KiB",
            m.description.len()
        ));
    }
    if m.params.len() > MAX_PARAMS {
        return Err(format!(
            "{} params declared; the limit is {MAX_PARAMS} params",
            m.params.len()
        ));
    }
    if m.series.len() > MAX_SERIES {
        return Err(format!(
            "{} series declared; the limit is {MAX_SERIES} series",
            m.series.len()
        ));
    }
    short(&format!("version \"{}\"", shown(&m.version)), &m.version)?;
    if let Err(e) = semver::Version::parse(&m.version) {
        return Err(format!(
            "version \"{}\" is not a semver version such as \"0.1.0\": {e}",
            m.version
        ));
    }

    let mut param_ids = HashSet::new();
    for p in &m.params {
        part_id("param", &p.id)?;
        if !param_ids.insert(p.id.as_str()) {
            return Err(format!("param id \"{}\" is used twice", p.id));
        }
        short(&format!("the label of param \"{}\"", p.id), &p.label)?;
        match &p.kind {
            ParamKind::Int { min, max } if min > max => {
                return Err(format!("param \"{}\" has min {min} above max {max}", p.id));
            }
            ParamKind::Int { min, max } if !SAFE_INT.contains(min) || !SAFE_INT.contains(max) => {
                return Err(format!(
                    "param \"{}\" has a range {min}..{max} outside ±(2^53 - 1), which the UI \
                     cannot hold exactly",
                    p.id
                ));
            }
            ParamKind::Float { min, max } if !min.is_finite() || !max.is_finite() => {
                return Err(format!(
                    "param \"{}\" has a float range {min}..{max}; both bounds must be finite \
                     numbers",
                    p.id
                ));
            }
            // `partial_cmp` is `None` when a bound is NaN.
            ParamKind::Float { min, max }
                if !matches!(min.partial_cmp(max), Some(Ordering::Less | Ordering::Equal)) =>
            {
                return Err(format!(
                    "param \"{}\" has a float range {min}..{max} that is empty or NaN",
                    p.id
                ));
            }
            ParamKind::Choice(options) => choices(&p.id, options)?,
            _ => {}
        }
        if !fits(&p.kind, &p.default) {
            return Err(format!(
                "param \"{}\" has a default that is not of its kind or outside its range",
                p.id
            ));
        }
    }

    if m.series.is_empty() {
        return Err("no series declared".into());
    }
    let mut series_ids = HashSet::new();
    for s in &m.series {
        part_id("series", &s.id)?;
        if !series_ids.insert(s.id.as_str()) {
            return Err(format!("series id \"{}\" is used twice", s.id));
        }
        short(&format!("the label of series \"{}\"", s.id), &s.label)?;
        if s.color > MAX_COLOR {
            return Err(format!(
                "series \"{}\" has color {}; use a palette slot from 0 to {MAX_COLOR}",
                s.id, s.color
            ));
        }
        match &s.kind {
            SeriesKind::Markers if s.pane != Pane::Price => {
                return Err(format!(
                    "markers series \"{}\" must be on the price pane",
                    s.id
                ));
            }
            SeriesKind::Band(a, b) => {
                if a == b {
                    return Err(format!("band \"{}\" names \"{}\" twice", s.id, shown(a)));
                }
                // A linear search per band: at most MAX_SERIES series, so this stays cheap.
                for line in [a, b] {
                    let target = m.series.iter().find(|t| t.id == *line);
                    match target {
                        Some(t) if t.kind == SeriesKind::Line && t.pane == s.pane => {}
                        Some(t) if t.kind == SeriesKind::Line => {
                            return Err(format!(
                                "band \"{}\" names \"{}\", which is on another pane",
                                s.id,
                                shown(line)
                            ));
                        }
                        _ => {
                            return Err(format!(
                                "band \"{}\" names \"{}\", which is not a line series",
                                s.id,
                                shown(line)
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn choices(param: &str, options: &[String]) -> Result<(), String> {
    if options.is_empty() {
        return Err(format!("choice param \"{param}\" has no options"));
    }
    if options.len() > MAX_CHOICES {
        return Err(format!(
            "choice param \"{param}\" has {} options; the limit is {MAX_CHOICES} options",
            options.len()
        ));
    }
    let mut seen = HashSet::new();
    for o in options {
        if o.is_empty() {
            return Err(format!("choice param \"{param}\" has an empty option"));
        }
        short(&format!("an option of choice param \"{param}\""), o)?;
        if !seen.insert(o.as_str()) {
            return Err(format!(
                "choice param \"{param}\" lists the option \"{o}\" twice"
            ));
        }
    }
    Ok(())
}

/// Whether `id` may be used by an installed (not built-in) module: it matches
/// the id pattern and does not take the reserved `builtin.` prefix.
pub fn is_user_id(id: &str) -> bool {
    valid_id(id) && !id.starts_with(BUILTIN_PREFIX)
}

/// The id prefix reserved for the indicators compiled into the app.
const BUILTIN_PREFIX: &str = "builtin.";

/// `^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$`
fn valid_id(id: &str) -> bool {
    let part = |s: &str| {
        let mut chars = s.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    };
    id.split_once('.')
        .is_some_and(|(author, name)| part(author) && part(name))
}

/// Checks `compute` output against `meta` for `count` bars and returns it in
/// the declared series order, with `±inf` turned into NaN (a gap) and band
/// data dropped (the UI fills between the band's two lines).
pub(crate) fn output(
    m: &Meta,
    mut out: Vec<SeriesOut>,
    count: usize,
) -> Result<Vec<SeriesOut>, String> {
    let mut seen = HashSet::new();
    for s in &out {
        if !m.series.iter().any(|spec| spec.id == s.id) {
            return Err(format!(
                "series \"{}\" is not declared in meta",
                shown(&s.id)
            ));
        }
        if !seen.insert(s.id.as_str()) {
            return Err(format!("series \"{}\" is returned twice", s.id));
        }
    }

    let mut ordered = Vec::with_capacity(m.series.len());
    for spec in &m.series {
        let Some(pos) = out.iter().position(|s| s.id == spec.id) else {
            return Err(format!("series \"{}\" is missing", spec.id));
        };
        let mut s = out.swap_remove(pos);
        match (&spec.kind, &mut s.data) {
            (SeriesKind::Band(..), _) => s.data = SeriesData::Values(Vec::new()),
            (SeriesKind::Line | SeriesKind::Histogram, SeriesData::Values(values)) => {
                if values.len() != count {
                    return Err(format!(
                        "series \"{}\" has {} values for {count} bars; return one value per bar \
                         and NaN where there is none",
                        s.id,
                        values.len()
                    ));
                }
                for v in values.iter_mut().filter(|v| v.is_infinite()) {
                    *v = f64::NAN;
                }
            }
            (SeriesKind::Markers, SeriesData::Markers(markers)) => {
                if let Some(bad) = markers.iter().find(|mk| mk.index as usize >= count) {
                    return Err(format!(
                        "series \"{}\" has a marker at bar {} of {count}",
                        s.id, bad.index
                    ));
                }
                for mk in markers.iter() {
                    if let Some(text) = &mk.text {
                        short(
                            &format!(
                                "the text of a marker at bar {} of series \"{}\"",
                                mk.index, s.id
                            ),
                            text,
                        )?;
                    }
                }
            }
            (SeriesKind::Markers, SeriesData::Values(_)) => {
                return Err(format!(
                    "series \"{}\" is a markers series but returned values",
                    s.id
                ));
            }
            (_, SeriesData::Markers(_)) => {
                return Err(format!(
                    "series \"{}\" is a line or histogram but returned markers",
                    s.id
                ));
            }
        }
        ordered.push(s);
    }
    Ok(ordered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Marker, MarkerShape, ParamSpec, ParamValue, SeriesSpec};

    fn series(id: &str, kind: SeriesKind, pane: Pane) -> SeriesSpec {
        SeriesSpec {
            id: id.into(),
            label: id.into(),
            kind,
            pane,
            color: 0,
        }
    }

    fn base() -> Meta {
        Meta {
            id: "me.bands".into(),
            name: "Bands".into(),
            version: "1.2.3".into(),
            description: String::new(),
            params: vec![ParamSpec {
                id: "period".into(),
                label: "Period".into(),
                kind: ParamKind::Int { min: 1, max: 10 },
                default: ParamValue::Int(5),
            }],
            series: vec![
                series("upper", SeriesKind::Line, Pane::Price),
                series("lower", SeriesKind::Line, Pane::Price),
                series(
                    "bb",
                    SeriesKind::Band("upper".into(), "lower".into()),
                    Pane::Price,
                ),
                series("hist", SeriesKind::Histogram, Pane::Own),
                series("sig", SeriesKind::Markers, Pane::Price),
            ],
        }
    }

    fn err(f: impl FnOnce(&mut Meta)) -> String {
        let mut m = base();
        f(&mut m);
        meta(&m).unwrap_err()
    }

    #[test]
    fn valid_meta_passes() {
        meta(&base()).unwrap();
        meta(&Meta {
            id: "builtin.sma".into(),
            ..base()
        })
        .unwrap();
    }

    #[test]
    fn user_ids() {
        assert!(is_user_id("me.bands"));
        assert!(is_user_id("a-1.b_2"));
        assert!(!is_user_id("builtin.sma"));
        assert!(!is_user_id("Bad.Id"));
        assert!(!is_user_id("a.b.c"));
        assert!(!is_user_id("nodot"));
    }

    #[test]
    fn meta_rules() {
        assert!(err(|m| m.id = "Bad.Id".into()).contains("Bad.Id"));
        assert!(err(|m| m.id = "a.b.c".into()).contains("a.b.c"));
        assert!(err(|m| m.id = "nodot".into()).contains("nodot"));
        assert!(err(|m| m.version = "1.0".into()).contains("semver"));
        assert!(err(|m| m.series[1].id = "upper".into()).contains("twice"));
        assert!(err(|m| m.series[0].color = 8).contains("color 8"));
        assert!(err(|m| m.series[4].pane = Pane::Own).contains("price pane"));
        assert!(err(|m| m.series[0].pane = Pane::Own).contains("another pane"));
        assert!(err(|m| m.series[1].kind = SeriesKind::Histogram).contains("not a line"));
        assert!(err(|m| m.params[0].default = ParamValue::Int(11)).contains("default"));
        assert!(err(|m| m.params[0].kind = ParamKind::Int { min: 3, max: 1 }).contains("min"));
        assert!(err(|m| m.series.clear()).contains("no series"));
        assert!(
            err(|m| {
                m.params[0].kind = ParamKind::Float {
                    min: f64::NAN,
                    max: 1.0,
                };
                m.params[0].default = ParamValue::Float(0.5);
            })
            .contains("NaN")
        );
    }

    #[test]
    fn numbers_must_survive_json() {
        let float = |min: f64, max: f64, default: f64| {
            err(|m| {
                m.params[0].kind = ParamKind::Float { min, max };
                m.params[0].default = ParamValue::Float(default);
            })
        };
        assert!(float(f64::NEG_INFINITY, 1.0, 0.5).contains("finite"));
        assert!(float(0.0, f64::INFINITY, 0.5).contains("finite"));
        assert!(float(0.0, f64::INFINITY, f64::INFINITY).contains("finite"));
        let int = |min: i64, max: i64| {
            err(|m| {
                m.params[0].kind = ParamKind::Int { min, max };
                m.params[0].default = ParamValue::Int(0);
            })
        };
        assert!(int(-(1 << 53), 0).contains("2^53"));
        assert!(int(0, 1 << 53).contains("2^53"));
        assert!(int(i64::MIN, i64::MAX).contains("2^53"));
        let mut m = base();
        m.params[0].kind = ParamKind::Int {
            min: -((1 << 53) - 1),
            max: (1 << 53) - 1,
        };
        meta(&m).unwrap();
    }

    #[test]
    fn sizes_are_capped() {
        let long = |n: usize| "a".repeat(n);
        assert!(err(|m| m.id = format!("me.{}", long(62))).contains("64 bytes"));
        assert!(err(|m| m.name = long(129)).contains("128 bytes"));
        assert!(err(|m| m.description = long(4097)).contains("4 KiB"));
        assert!(err(|m| m.params[0].id = long(65)).contains("64 bytes"));
        assert!(err(|m| m.params[0].label = long(65)).contains("64 bytes"));
        assert!(err(|m| m.series[3].id = long(65)).contains("64 bytes"));
        assert!(err(|m| m.series[3].label = long(65)).contains("64 bytes"));
        assert!(err(|m| m.params[0].id = "Period".into()).contains("Period"));
        assert!(err(|m| m.series[3].id = "h i".into()).contains("h i"));
        assert!(
            err(|m| {
                let p = m.params[0].clone();
                m.params = (0..65)
                    .map(|i| ParamSpec {
                        id: format!("p{i}"),
                        ..p.clone()
                    })
                    .collect();
            })
            .contains("64 params")
        );
        assert!(
            err(|m| {
                m.series = (0..65)
                    .map(|i| series(&format!("s{i}"), SeriesKind::Line, Pane::Own))
                    .collect();
            })
            .contains("64 series")
        );
        let choice = |options: Vec<String>| {
            err(|m| {
                m.params[0].default = ParamValue::Choice(options[0].clone());
                m.params[0].kind = ParamKind::Choice(options);
            })
        };
        assert!(choice((0..257).map(|i| i.to_string()).collect()).contains("256 options"));
        assert!(choice(vec!["a".into(), "a".into()]).contains("twice"));
        assert!(choice(vec!["a".into(), String::new()]).contains("empty"));
        assert!(choice(vec![long(65)]).contains("64 bytes"));

        let mut m = base();
        m.id = format!("me.{}", long(61));
        m.name = long(128);
        m.description = long(4096);
        m.params[0].label = long(64);
        meta(&m).unwrap();
    }

    #[test]
    fn messages_stay_short_for_huge_guest_strings() {
        let huge = "é".repeat(500_000);
        let small = |msg: String| {
            assert!(
                msg.len() < 512,
                "{} bytes: {}",
                msg.len(),
                msg.chars().take(80).collect::<String>()
            );
        };
        small(err(|m| m.id = huge.clone()));
        small(err(|m| m.id = format!("me.{huge}")));
        small(err(|m| m.version = huge.clone()));
        small(err(|m| m.params[0].id = huge.clone()));
        small(err(|m| m.series[3].id = huge.clone()));
        small(err(|m| {
            m.series[2].kind = SeriesKind::Band(huge.clone(), "lower".into())
        }));
        small(err(|m| {
            m.series[2].kind = SeriesKind::Band(huge.clone(), huge.clone())
        }));
        let mut out = good_output();
        out.push(values(&huge, vec![]));
        small(output(&base(), out, 2).unwrap_err());
    }

    #[test]
    fn marker_text_is_capped() {
        let mut out = good_output();
        out[0].data = SeriesData::Markers(vec![Marker {
            index: 0,
            shape: MarkerShape::Up,
            text: Some("x".repeat(65)),
        }]);
        assert!(output(&base(), out, 2).unwrap_err().contains("64 bytes"));
        let mut out = good_output();
        out[0].data = SeriesData::Markers(vec![Marker {
            index: 0,
            shape: MarkerShape::Up,
            text: Some("x".repeat(64)),
        }]);
        output(&base(), out, 2).unwrap();
    }

    fn values(id: &str, v: Vec<f64>) -> SeriesOut {
        SeriesOut {
            id: id.into(),
            data: SeriesData::Values(v),
        }
    }

    fn good_output() -> Vec<SeriesOut> {
        vec![
            values("sig", vec![]),
            values("hist", vec![1.0, f64::NEG_INFINITY]),
            values("bb", vec![9.0]),
            values("lower", vec![1.0, 2.0]),
            values("upper", vec![f64::INFINITY, 3.0]),
        ]
        .into_iter()
        .map(|mut s| {
            if s.id == "sig" {
                s.data = SeriesData::Markers(vec![Marker {
                    index: 1,
                    shape: MarkerShape::Up,
                    text: None,
                }]);
            }
            s
        })
        .collect()
    }

    #[test]
    fn output_is_ordered_cleaned_and_band_data_dropped() {
        let out = output(&base(), good_output(), 2).unwrap();
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["upper", "lower", "bb", "hist", "sig"]);
        let SeriesData::Values(upper) = &out[0].data else {
            panic!()
        };
        assert!(upper[0].is_nan() && upper[1] == 3.0);
        assert_eq!(out[2].data, SeriesData::Values(vec![]));
    }

    #[test]
    fn output_rules() {
        let run = |f: fn(&mut Vec<SeriesOut>)| {
            let mut out = good_output();
            f(&mut out);
            output(&base(), out, 2).unwrap_err()
        };
        assert!(run(|o| o.retain(|s| s.id != "hist")).contains("missing"));
        assert!(run(|o| o.push(values("extra", vec![]))).contains("not declared"));
        assert!(run(|o| o.push(values("hist", vec![1.0, 2.0]))).contains("twice"));
        assert!(run(|o| o[1] = values("hist", vec![1.0])).contains("1 values for 2 bars"));
        assert!(run(|o| o[0] = values("sig", vec![1.0, 2.0])).contains("returned values"));
        assert!(
            run(|o| o[0].data = SeriesData::Markers(vec![Marker {
                index: 2,
                shape: MarkerShape::Dot,
                text: None,
            }]))
            .contains("bar 2 of 2")
        );
        assert!(run(|o| o[3].data = SeriesData::Markers(vec![])).contains("returned markers"));
    }
}
