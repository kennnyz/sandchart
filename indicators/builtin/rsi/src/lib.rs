//! Built-in relative strength index (Wilder).

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec, ta,
};

struct Rsi;

impl Indicator for Rsi {
    fn meta() -> Meta {
        Meta {
            id: "builtin.rsi".into(),
            name: "RSI".into(),
            version: "0.2.0".into(),
            description: "Relative strength index, Wilder smoothing".into(),
            params: vec![
                ParamSpec {
                    id: "period".into(),
                    label: "Period".into(),
                    kind: ParamKind::Int((2, 1000)),
                    default: ParamValue::Int(14),
                },
                ParamSpec {
                    id: "source".into(),
                    label: "Source".into(),
                    kind: ParamKind::Choice(ta::SOURCES.iter().map(|s| s.to_string()).collect()),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![SeriesSpec {
                id: "rsi".into(),
                label: "RSI".into(),
                kind: SeriesKind::Line,
                pane: Pane::Own,
                color: 4,
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
        // Change at bar i is src[i] - src[i-1]; bar 0 has none.
        let mut gain = vec![f64::NAN; src.len()];
        let mut loss = vec![f64::NAN; src.len()];
        for i in 1..src.len() {
            let d = src[i] - src[i - 1];
            gain[i] = d.max(0.0);
            loss[i] = (-d).max(0.0);
        }
        let (g, l) = (ta::rma(&gain, period), ta::rma(&loss, period));
        let rsi = g
            .iter()
            .zip(&l)
            .map(|(g, l)| {
                if l == &0.0 {
                    if g == &0.0 { 50.0 } else { 100.0 }
                } else {
                    100.0 - 100.0 / (1.0 + g / l)
                }
            })
            .collect();
        Ok(vec![SeriesOut {
            id: "rsi".into(),
            data: SeriesData::Values(rsi),
        }])
    }
}

sandchart_indicator::export!(Rsi with_types_in sandchart_indicator::bindings);
