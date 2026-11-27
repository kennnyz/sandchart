//! Test guest: returns the max of all closes on every bar

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.repaints".into(),
            name: "test.repaints".into(),
            version: "0.1.0".into(),
            description: "returns the max of all closes on every bar".into(),
            params: vec![],
            series: vec![SeriesSpec {
                id: "max".into(),
                label: "max".into(),
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
        let max = candles.iter().map(|c| c.close).fold(f64::NAN, f64::max);
        Ok(vec![SeriesOut {
            id: "max".into(),
            data: SeriesData::Values(vec![max; candles.len()]),
        }])
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
