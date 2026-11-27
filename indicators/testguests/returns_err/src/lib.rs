//! Test guest: returns an error from compute

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.returns_err".into(),
            name: "test.returns_err".into(),
            version: "0.1.0".into(),
            description: "returns an error from compute".into(),
            params: vec![],
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
        _params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let _ = candles;
        Err("bad period".into())
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
