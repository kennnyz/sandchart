//! Technical-analysis helpers. Every function returns a vector of the same
//! length as its input, `NaN` until the first full window (and for a period of
//! zero or longer than the input).

use crate::Candle;

/// Applies `f` to every full window of `period` values; a window that
/// contains a `NaN` yields `NaN`.
fn windowed(src: &[f64], period: usize, f: impl Fn(&[f64]) -> f64) -> Vec<f64> {
    let mut out = vec![f64::NAN; src.len()];
    if period == 0 || period > src.len() {
        return out;
    }
    for (i, w) in src.windows(period).enumerate() {
        if w.iter().all(|v| !v.is_nan()) {
            out[i + period - 1] = f(w);
        }
    }
    out
}

/// Applies `f` to every full window of `period` values and returns `NaN`
/// elsewhere. Unlike [`windowed`] it does not look for `NaN` first: `f` must
/// itself give `NaN` for a window that holds one (a sum or a mean does).
fn windowed_nan_through(src: &[f64], period: usize, f: impl Fn(&[f64]) -> f64) -> Vec<f64> {
    let mut out = vec![f64::NAN; src.len()];
    if period == 0 || period > src.len() {
        return out;
    }
    for (slot, w) in out[period - 1..].iter_mut().zip(src.windows(period)) {
        *slot = f(w);
    }
    out
}

/// Simple moving average.
pub fn sma(src: &[f64], period: usize) -> Vec<f64> {
    let n = period as f64;
    windowed_nan_through(src, period, |w| w.iter().sum::<f64>() / n)
}

/// Recursive average `prev + alpha * (x - prev)`, seeded with the SMA of the
/// first `period` values and re-seeded after a `NaN`.
fn recursive(src: &[f64], period: usize, alpha: f64) -> Vec<f64> {
    let mut out = vec![f64::NAN; src.len()];
    if period == 0 {
        return out;
    }
    let mut prev = f64::NAN;
    let mut run = 0usize; // consecutive finite values seen
    for (i, &x) in src.iter().enumerate() {
        if x.is_nan() {
            run = 0;
            prev = f64::NAN;
            continue;
        }
        run += 1;
        if run < period {
            continue;
        }
        prev = if run == period {
            src[i + 1 - period..=i].iter().sum::<f64>() / period as f64
        } else {
            prev + alpha * (x - prev)
        };
        out[i] = prev;
    }
    out
}

/// Exponential moving average, alpha `2 / (period + 1)`.
pub fn ema(src: &[f64], period: usize) -> Vec<f64> {
    recursive(src, period, 2.0 / (period as f64 + 1.0))
}

/// Wilder's moving average (RMA), alpha `1 / period`.
pub fn rma(src: &[f64], period: usize) -> Vec<f64> {
    recursive(src, period, 1.0 / period.max(1) as f64)
}

/// Population standard deviation over a rolling window.
pub fn stdev(src: &[f64], period: usize) -> Vec<f64> {
    let n = period as f64;
    windowed_nan_through(src, period, |w| {
        let mean = w.iter().sum::<f64>() / n;
        (w.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n).sqrt()
    })
}

/// Highest value over a rolling window.
pub fn highest(src: &[f64], period: usize) -> Vec<f64> {
    windowed(src, period, |w| {
        w.iter().copied().fold(f64::NEG_INFINITY, f64::max)
    })
}

/// Lowest value over a rolling window.
pub fn lowest(src: &[f64], period: usize) -> Vec<f64> {
    windowed(src, period, |w| {
        w.iter().copied().fold(f64::INFINITY, f64::min)
    })
}

/// The price sources [`source`] understands, for a `choice` parameter.
pub const SOURCES: [&str; 7] = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"];

/// Price source by name, one of [`SOURCES`].
pub fn source(candles: &[Candle], name: &str) -> Result<Vec<f64>, String> {
    let f: fn(&Candle) -> f64 = match name {
        "open" => |c| c.open,
        "high" => |c| c.high,
        "low" => |c| c.low,
        "close" => |c| c.close,
        "hl2" => |c| (c.high + c.low) / 2.0,
        "hlc3" => |c| (c.high + c.low + c.close) / 3.0,
        "ohlc4" => |c| (c.open + c.high + c.low + c.close) / 4.0,
        _ => return Err(format!("unknown source \"{name}\"")),
    };
    Ok(candles.iter().map(f).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: f64 = f64::NAN;

    fn assert_close(got: &[f64], want: &[f64]) {
        assert_eq!(got.len(), want.len(), "{got:?} vs {want:?}");
        for (g, w) in got.iter().zip(want) {
            assert!(
                (g.is_nan() && w.is_nan()) || (g - w).abs() < 1e-12,
                "{got:?} vs {want:?}"
            );
        }
    }

    #[test]
    fn sma_basic() {
        assert_close(&sma(&[1., 2., 3., 4.], 2), &[N, 1.5, 2.5, 3.5]);
    }

    #[test]
    fn ema_seeds_with_sma() {
        assert_close(&ema(&[1., 2., 3., 4.], 2), &[N, 1.5, 2.5, 3.5]);
    }

    #[test]
    fn rma_basic() {
        assert_close(&rma(&[1., 2., 3., 4.], 2), &[N, 1.5, 2.25, 3.125]);
    }

    #[test]
    fn stdev_is_population() {
        let s = stdev(&[2., 4., 4., 4., 5., 5., 7., 9.], 8);
        assert!((s[7] - 2.0).abs() < 1e-12);
        assert!(s[..7].iter().all(|v| v.is_nan()));
    }

    #[test]
    fn infinity_in_a_window_gives_infinity_or_nan() {
        let m = sma(&[1., f64::INFINITY, 3.], 2);
        assert!(m[0].is_nan() && m[1] == f64::INFINITY && m[2] == f64::INFINITY);
        assert!(stdev(&[1., f64::INFINITY, 3.], 2)[1].is_nan());
    }

    #[test]
    fn highest_and_lowest() {
        assert_close(&highest(&[1., 3., 2.], 2), &[N, 3., 3.]);
        assert_close(&lowest(&[1., 3., 2.], 2), &[N, 1., 2.]);
    }

    #[test]
    fn short_input_and_zero_period_give_nan() {
        for f in [sma, ema, rma, stdev, highest, lowest] {
            assert_close(&f(&[1., 2.], 3), &[N, N]);
            assert_close(&f(&[1., 2.], 0), &[N, N]);
        }
    }

    #[test]
    fn nan_in_window_gives_nan() {
        assert_close(&sma(&[1., N, 3., 4.], 2), &[N, N, N, 3.5]);
    }

    #[test]
    fn ema_reseeds_after_nan() {
        assert_close(&ema(&[1., 2., N, 4., 6., 8.], 2), &[N, 1.5, N, N, 5., 7.]);
    }

    #[test]
    fn every_listed_source_is_known() {
        let c = Candle {
            time: 0,
            open: 1.,
            high: 2.,
            low: 1.,
            close: 2.,
            volume: 0.,
        };
        for name in SOURCES {
            assert!(source(std::slice::from_ref(&c), name).is_ok(), "{name}");
        }
    }

    #[test]
    fn sources() {
        let c = Candle {
            time: 0,
            open: 1.,
            high: 5.,
            low: 1.,
            close: 3.,
            volume: 0.,
        };
        let one = std::slice::from_ref(&c);
        assert_eq!(source(one, "hl2").unwrap(), vec![3.]);
        assert_eq!(source(one, "hlc3").unwrap(), vec![3.]);
        assert_eq!(source(one, "ohlc4").unwrap(), vec![2.5]);
        assert_eq!(source(one, "close").unwrap(), vec![3.]);
        assert!(source(one, "vwap").is_err());
    }
}
