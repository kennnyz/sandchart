//! Test guest: declares a band over a line it does not have

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.bad_meta".into(),
            name: "test.bad_meta".into(),
            version: "0.1.0".into(),
            description: "declares a band over a line it does not have".into(),
            params: vec![],
            series: vec![
                SeriesSpec {
                    id: "upper".into(),
                    label: "upper".into(),
                    kind: SeriesKind::Line,
                    pane: Pane::Price,
                    color: 0,
                },
                SeriesSpec {
                    id: "bb".into(),
                    label: "bb".into(),
                    kind: SeriesKind::Band(("upper".into(), "lower".into())),
                    pane: Pane::Price,
                    color: 0,
                },
            ],
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
