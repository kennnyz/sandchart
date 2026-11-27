//! Test guest: tries to open a TCP connection and returns what happened as an error

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamValue, SeriesKind, SeriesOut, SeriesSpec,
};

struct Guest;

impl Indicator for Guest {
    fn meta() -> Meta {
        Meta {
            id: "test.opens_socket".into(),
            name: "test.opens_socket".into(),
            version: "0.1.0".into(),
            description: "tries to open a TCP connection and returns what happened as an error"
                .into(),
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
        match std::net::TcpStream::connect("1.1.1.1:80") {
            Ok(_) => Err("connected".into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

sandchart_indicator::export!(Guest with_types_in sandchart_indicator::bindings);
