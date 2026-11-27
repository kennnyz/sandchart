//! Test guest: claims an id with the reserved builtin. prefix

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "builtin.evil".into(),
            name: "builtin.evil".into(),
            version: "0.1.0".into(),
            description: "claims an id with the reserved builtin. prefix".into(),
            params: vec![],
            series: vec![SeriesSpec {
                id: "close".into(),
                label: "close".into(),
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
        Ok(vec![SeriesOut {
            id: "close".into(),
            data: SeriesData::Values(candles.iter().map(|c| c.close).collect()),
        }])
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
