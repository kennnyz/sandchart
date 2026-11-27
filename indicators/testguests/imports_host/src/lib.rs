//! Test guest: the echo indicator that also imports a non-WASI host function

#[allow(clippy::all, missing_docs)]
mod bindings {
    wit_bindgen::generate!({
        inline: "
            package test:host;
            world plugin {
                include sandchart:indicator/plugin@0.1.0;
                import secret: func() -> string;
            }
        ",
        path: "../../sdk/wit",
        world: "test:host/plugin",
        generate_all,
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
            id: "test.imports_host".into(),
            name: "test.imports_host".into(),
            version: "0.1.0".into(),
            description: "the echo indicator that also imports a non-WASI host function".into(),
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
        let _ = bindings::secret();
        Ok(vec![SeriesOut {
            id: "close".into(),
            data: SeriesData::Values(candles.iter().map(|c| c.close).collect()),
        }])
    }
}

bindings::export!(Guest with_types_in bindings);
