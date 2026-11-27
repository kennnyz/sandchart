//! Test guest: the echo indicator built against contract 0.1.1

#[allow(clippy::all, missing_docs)]
mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "plugin",
    });
}

use bindings::exports::sandchart::indicator::indicator::Guest as Indicator;
use bindings::sandchart::indicator::types::{
    Candle, Meta, Pane, ParamValue, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.newer_patch".into(),
            name: "test.newer_patch".into(),
            version: "0.1.0".into(),
            description: "the echo indicator built against contract 0.1.1".into(),
            params: Vec::new(),
            series: vec![SeriesSpec {
                id: "close".into(),
                label: "Close".into(),
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

bindings::export!(Guest with_types_in bindings);
