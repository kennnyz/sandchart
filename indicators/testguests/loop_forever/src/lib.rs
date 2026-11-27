//! Test guest: spins forever when the spin param is true

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.loop".into(),
            name: "test.loop".into(),
            version: "0.1.0".into(),
            description: "spins forever when the spin param is true".into(),
            params: vec![ParamSpec {
                id: "spin".into(),
                label: "Spin".into(),
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
        if Params::new(params).boolean("spin")? {
            let mut n = 0u64;
            loop {
                n = std::hint::black_box(n.wrapping_add(1));
            }
        }
        out(vec![f64::NAN; candles.len()])
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
