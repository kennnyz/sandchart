//! Test guest: tries to read a host file and returns what happened as an error

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.reads_file".into(),
            name: "test.reads_file".into(),
            version: "0.1.0".into(),
            description: "tries to read a host file and returns what happened as an error".into(),
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
        let _ = candles;
        match std::fs::read("/etc/hosts") {
            Ok(bytes) => Err(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) => Err(e.to_string()),
        }
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
