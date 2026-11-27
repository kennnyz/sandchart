//! Test guest: returns WASI random numbers: secure, insecure, insecure seed

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.reads_random".into(),
            name: "test.reads_random".into(),
            version: "0.1.0".into(),
            description: "returns WASI random numbers: secure, insecure, insecure seed".into(),
            params: Vec::new(),
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
        let picks = [
            wasip2::random::random::get_random_u64() as f64,
            wasip2::random::insecure::get_insecure_random_u64() as f64,
            wasip2::random::insecure_seed::insecure_seed().0 as f64,
        ];
        out((0..candles.len()).map(|i| picks[i % 3]).collect())
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
