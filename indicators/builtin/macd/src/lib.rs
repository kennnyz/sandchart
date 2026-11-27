//! Built-in MACD: fast EMA minus slow EMA, a signal EMA of that, and the
//! difference as a histogram.

use sandchart_indicator::{
    Candle, Indicator, Meta, Pane, ParamKind, ParamSpec, ParamValue, Params, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec, ta,
};

struct Macd;

fn spec(id: &str, label: &str, kind: SeriesKind, color: u8) -> SeriesSpec {
    SeriesSpec {
        id: id.into(),
        label: label.into(),
        kind,
        pane: Pane::Own,
        color,
    }
}

fn int(id: &str, label: &str, min: i64, max: i64, default: i64) -> ParamSpec {
    ParamSpec {
        id: id.into(),
        label: label.into(),
        kind: ParamKind::Int((min, max)),
        default: ParamValue::Int(default),
    }
}

impl Indicator for Macd {
    fn meta() -> Meta {
        Meta {
            id: "builtin.macd".into(),
            name: "MACD".into(),
            version: "0.2.0".into(),
            description: "Moving average convergence divergence".into(),
            params: vec![
                int("fast", "Fast period", 1, 500, 12),
                int("slow", "Slow period", 2, 1000, 26),
                int("signal", "Signal period", 1, 500, 9),
                ParamSpec {
                    id: "source".into(),
                    label: "Source".into(),
                    kind: ParamKind::Choice(ta::SOURCES.iter().map(|s| s.to_string()).collect()),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![
                spec("macd", "MACD", SeriesKind::Line, 5),
                spec("signal", "Signal", SeriesKind::Line, 6),
                spec("hist", "Histogram", SeriesKind::Histogram, 7),
            ],
        }
    }

    fn compute(
        params: Vec<(String, ParamValue)>,
        candles: Vec<Candle>,
    ) -> Result<Vec<SeriesOut>, String> {
        let p = Params::new(params);
        let fast = usize::try_from(p.int("fast")?).map_err(|_| "fast must be positive")?;
        let slow = usize::try_from(p.int("slow")?).map_err(|_| "slow must be positive")?;
        let signal = usize::try_from(p.int("signal")?).map_err(|_| "signal must be positive")?;
        if fast >= slow {
            return Err("fast must be less than slow".into());
        }
        let src = ta::source(&candles, p.choice("source")?)?;
        let (f, s) = (ta::ema(&src, fast), ta::ema(&src, slow));
        let macd: Vec<f64> = f.iter().zip(&s).map(|(f, s)| f - s).collect();
        let sig = ta::ema(&macd, signal);
        let hist = macd.iter().zip(&sig).map(|(m, s)| m - s).collect();
        let out = |id: &str, v| SeriesOut {
            id: id.into(),
            data: SeriesData::Values(v),
        };
        Ok(vec![
            out("macd", macd),
            out("signal", sig),
            out("hist", hist),
        ])
    }
}

sandchart_indicator::export!(Macd with_types_in sandchart_indicator::bindings);
