//! Test guest: returns the wall clock in seconds since the epoch on every bar

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.reads_clock".into(),
            name: "test.reads_clock".into(),
            version: "0.1.0".into(),
            description: "returns the wall clock in seconds since the epoch on every bar".into(),
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs_f64();
        out(vec![now; candles.len()])
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
