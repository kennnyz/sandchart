//! Test guest: returns an error from compute; with `long` set, one of 3000 bytes

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, SeriesKind, SeriesOut,
    SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.returns_err".into(),
            name: "test.returns_err".into(),
            version: "0.1.0".into(),
            description: "returns an error from compute".into(),
            params: vec![ParamSpec {
                id: "long".into(),
                label: "long".into(),
                kind: ParamKind::Boolean,
                default: ParamValue::Boolean(false),
            }],
            series: vec![SeriesSpec {
                id: "out".into(),
                label: "out".into(),
                kind: SeriesKind::Line,
                pane: Pane::Price,
                color: 0,
            }],
        }
    }

    fn compute(
        params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let _ = candles;
        let long = params
            .iter()
            .any(|(id, v)| id == "long" && matches!(v, ParamValue::Boolean(true)));
        // '€' is 3 bytes, so a cut at 1 KiB falls inside a character.
        Err(if long {
            "€".repeat(1000)
        } else {
            "bad period".into()
        })
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
