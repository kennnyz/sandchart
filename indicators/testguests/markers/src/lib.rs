//! Test guest: puts an up marker on every bar, with the bar index as text

use sandchart_indicator::{
    Candle, Indicator, Marker, MarkerShape, Meta, Pane, ParamValue, SeriesData, SeriesKind,
    SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.markers".into(),
            name: "test.markers".into(),
            version: "0.1.0".into(),
            description: "puts an up marker on every bar, with the bar index as text".into(),
            params: vec![],
            series: vec![SeriesSpec {
                id: "marks".into(),
                label: "marks".into(),
                kind: SeriesKind::Markers,
                pane: Pane::Price,
                color: 0,
            }],
        }
    }

    fn compute(
        _params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let marks = (0..candles.len() as u32)
            .map(|index| Marker {
                index,
                shape: MarkerShape::Up,
                text: Some(index.to_string()),
            })
            .collect();
        Ok(vec![SeriesOut {
            id: "marks".into(),
            data: SeriesData::Markers(marks),
        }])
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
