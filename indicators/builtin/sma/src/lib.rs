//! Built-in simple moving average.

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec, ta,
};

const SOURCES: [&str; 7] = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"];

struct Sma;

impl Indicator for Sma {
    fn meta() -> Meta {
        Meta {
            id: "builtin.sma".into(),
            name: "SMA".into(),
            version: "0.1.0".into(),
            description: "Simple moving average".into(),
            params: vec![
                ParamSpec {
                    id: "period".into(),
                    label: "Period".into(),
                    kind: ParamKind::Int((1, 1000)),
                    default: ParamValue::Int(20),
                },
                ParamSpec {
                    id: "source".into(),
                    label: "Source".into(),
                    kind: ParamKind::Choice(SOURCES.iter().map(|s| s.to_string()).collect()),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![SeriesSpec {
                id: "sma".into(),
                label: "SMA".into(),
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
        let p = Params::new(params);
        let period = usize::try_from(p.int("period")?).map_err(|_| "period must be positive")?;
        let src = ta::source(&candles, p.choice("source")?)?;
        Ok(vec![SeriesOut {
            id: "sma".into(),
            data: SeriesData::Values(ta::sma(&src, period)),
        }])
    }
}

sandchart_indicator::export!(Sma with_types_in sandchart_indicator::bindings);
