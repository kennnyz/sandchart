//! Test guest: declares more series than the host allows

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.oversized_meta".into(),
            name: "test.oversized_meta".into(),
            version: "0.1.0".into(),
            description: "declares 65 series, one more than the host allows".into(),
            params: vec![],
            series: (0..65)
                .map(|i| SeriesSpec {
                    id: format!("s{i}"),
                    label: format!("s{i}"),
                    kind: SeriesKind::Line,
                    pane: Pane::Own,
                    color: 0,
                })
                .collect(),
        }
    }

    fn compute(
        _params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let _ = candles;
        Ok(Vec::new())
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
