//! Test guest: allocates until memory runs out

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.alloc_bomb".into(),
            name: "test.alloc_bomb".into(),
            version: "0.1.0".into(),
            description: "allocates until memory runs out".into(),
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
        let mut hoard: Vec<Vec<u8>> = Vec::new();
        loop {
            hoard.push(vec![1; 1 << 20]);
            std::hint::black_box(&hoard);
            if hoard.len() == usize::MAX {
                break;
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
