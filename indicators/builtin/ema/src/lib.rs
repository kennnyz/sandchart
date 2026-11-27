//! Built-in exponential moving average.

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec, ta,
};

struct Ema;

impl Indicator for Ema {
    fn meta() -> Meta {
        Meta {
            id: "builtin.ema".into(),
            name: "EMA".into(),
            version: "0.2.0".into(),
            description: "Exponential moving average".into(),
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
                    kind: ParamKind::Choice(ta::SOURCES.iter().map(|s| s.to_string()).collect()),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![SeriesSpec {
                id: "ema".into(),
                label: "EMA".into(),
                kind: SeriesKind::Line,
                pane: Pane::Price,
                color: 1,
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
            id: "ema".into(),
            data: SeriesData::Values(ta::ema(&src, period)),
        }])
    }
}

sandchart_indicator::export!(Ema with_types_in sandchart_indicator::bindings);
