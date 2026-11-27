//! Test guest: writes about 2 MiB to stdout

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.logs_a_lot".into(),
            name: "test.logs_a_lot".into(),
            version: "0.1.0".into(),
            description: "writes about 2 MiB to stdout".into(),
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
        for i in 0..40_000 {
            println!("line {i:06} of a chatty indicator that logs on every step");
        }
        out(candles.iter().map(|c| c.close).collect())
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
