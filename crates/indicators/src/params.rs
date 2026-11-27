//! Parameter checks and resolution of saved parameter values.

use crate::{ParamKind, ParamSpec, ParamValue};

/// Whether `value` is of the kind `kind` and inside its range or list.
pub(crate) fn fits(kind: &ParamKind, value: &ParamValue) -> bool {
    match (kind, value) {
        (ParamKind::Int { min, max }, ParamValue::Int(v)) => min <= v && v <= max,
        // NaN fails both comparisons, so it never fits.
        (ParamKind::Float { min, max }, ParamValue::Float(v)) => min <= v && v <= max,
        (ParamKind::Boolean, ParamValue::Boolean(_)) => true,
        (ParamKind::Choice(options), ParamValue::Choice(v)) => options.contains(v),
        _ => false,
    }
}

/// One value per spec, in spec order: the saved value when it still fits the
/// spec, the default otherwise. Saved ids the spec no longer has are dropped.
pub(crate) fn resolve(
    specs: &[ParamSpec],
    saved: &[(String, ParamValue)],
) -> Vec<(String, ParamValue)> {
    specs
        .iter()
        .map(|spec| {
            let value = saved
                .iter()
                .find(|(id, _)| *id == spec.id)
                .map(|(_, v)| v)
                .filter(|v| fits(&spec.kind, v))
                .unwrap_or(&spec.default);
            (spec.id.clone(), value.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specs() -> Vec<ParamSpec> {
        vec![
            ParamSpec {
                id: "period".into(),
                label: "Period".into(),
                kind: ParamKind::Int { min: 1, max: 100 },
                default: ParamValue::Int(20),
            },
            ParamSpec {
                id: "k".into(),
                label: "K".into(),
                kind: ParamKind::Float { min: 0.0, max: 5.0 },
                default: ParamValue::Float(2.0),
            },
            ParamSpec {
                id: "source".into(),
                label: "Source".into(),
                kind: ParamKind::Choice(vec!["close".into(), "open".into()]),
                default: ParamValue::Choice("close".into()),
            },
        ]
    }

    fn saved(v: &[(&str, ParamValue)]) -> Vec<(String, ParamValue)> {
        v.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn defaults() -> Vec<(String, ParamValue)> {
        saved(&[
            ("period", ParamValue::Int(20)),
            ("k", ParamValue::Float(2.0)),
            ("source", ParamValue::Choice("close".into())),
        ])
    }

    #[test]
    fn resolve_params_keeps_valid_values_in_spec_order() {
        let got = resolve(
            &specs(),
            &saved(&[
                ("source", ParamValue::Choice("open".into())),
                ("period", ParamValue::Int(50)),
                ("k", ParamValue::Float(5.0)),
            ]),
        );
        assert_eq!(
            got,
            saved(&[
                ("period", ParamValue::Int(50)),
                ("k", ParamValue::Float(5.0)),
                ("source", ParamValue::Choice("open".into())),
            ])
        );
    }

    #[test]
    fn resolve_params_unknown_id_dropped() {
        let got = resolve(&specs(), &saved(&[("gone", ParamValue::Int(3))]));
        assert_eq!(got, defaults());
    }

    #[test]
    fn resolve_params_missing_id_gets_default() {
        assert_eq!(resolve(&specs(), &[]), defaults());
    }

    #[test]
    fn resolve_params_out_of_range_gets_default() {
        let got = resolve(
            &specs(),
            &saved(&[
                ("period", ParamValue::Int(0)),
                ("k", ParamValue::Float(f64::NAN)),
            ]),
        );
        assert_eq!(got, defaults());
        let got = resolve(&specs(), &saved(&[("period", ParamValue::Int(101))]));
        assert_eq!(got, defaults());
    }

    #[test]
    fn resolve_params_wrong_kind_gets_default() {
        let got = resolve(
            &specs(),
            &saved(&[
                ("period", ParamValue::Float(20.0)),
                ("source", ParamValue::Boolean(true)),
            ]),
        );
        assert_eq!(got, defaults());
    }

    #[test]
    fn resolve_params_unknown_choice_gets_default() {
        let got = resolve(
            &specs(),
            &saved(&[("source", ParamValue::Choice("hl2".into()))]),
        );
        assert_eq!(got, defaults());
    }
}
