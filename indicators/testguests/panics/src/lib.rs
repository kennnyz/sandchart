//! Test guest: panics in compute

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.panics".into(),
            name: "test.panics".into(),
            version: "0.1.0".into(),
            description: "panics in compute".into(),
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
        if candles.len() < usize::MAX {
            panic!("boom");
        }
        out(Vec::new())
    }
}

/// The one `out` series with the given values.
fn out(values: Vec<f64>) -> Result<Vec<SeriesOut>, String> {
    Ok(vec![SeriesOut {
        id: "out".into(),
        data: SeriesData::Values(values),
    }])
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
