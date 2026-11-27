//! Built-in Bollinger bands: a moving average and bands at `mult` standard
//! deviations around it, with a fill between the bands.

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec, ta,
};

struct Bollinger;

fn line(id: &str, label: &str, color: u8) -> SeriesSpec {
    SeriesSpec {
        id: id.into(),
        label: label.into(),
        kind: SeriesKind::Line,
        pane: Pane::Price,
        color,
    }
}

fn values(id: &str, v: Vec<f64>) -> SeriesOut {
    SeriesOut {
        id: id.into(),
        data: SeriesData::Values(v),
    }
}

impl Indicator for Bollinger {
    fn meta() -> Meta {
        Meta {
            id: "builtin.bollinger".into(),
            name: "Bollinger Bands".into(),
            version: "0.2.0".into(),
            description: "Moving average with bands at a number of standard deviations".into(),
            params: vec![
                ParamSpec {
                    id: "period".into(),
                    label: "Period".into(),
                    kind: ParamKind::Int((2, 1000)),
                    default: ParamValue::Int(20),
                },
                ParamSpec {
                    id: "mult".into(),
                    label: "Deviations".into(),
                    kind: ParamKind::Float((0.1, 10.0)),
                    default: ParamValue::Float(2.0),
                },
                ParamSpec {
                    id: "source".into(),
                    label: "Source".into(),
                    kind: ParamKind::Choice(ta::SOURCES.iter().map(|s| s.to_string()).collect()),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![
                line("basis", "Basis", 2),
                line("upper", "Upper", 3),
                line("lower", "Lower", 3),
                SeriesSpec {
                    id: "fill".into(),
                    label: "Fill".into(),
                    kind: SeriesKind::Band(("upper".into(), "lower".into())),
                    pane: Pane::Price,
                    color: 3,
                },
            ],
        }
    }

    fn compute(
        params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let p = Params::new(params);
        let period = usize::try_from(p.int("period")?).map_err(|_| "period must be positive")?;
        let mult = p.float("mult")?;
        let src = ta::source(&candles, p.choice("source")?)?;
        let basis = ta::sma(&src, period);
        let dev = ta::stdev(&src, period);
        let upper = basis.iter().zip(&dev).map(|(m, d)| m + mult * d).collect();
        let lower = basis.iter().zip(&dev).map(|(m, d)| m - mult * d).collect();
        Ok(vec![
            values("basis", basis),
            values("upper", upper),
            values("lower", lower),
            values("fill", Vec::new()),
        ])
    }
}

sandchart_indicator::export!(Bollinger with_types_in sandchart_indicator::bindings);
