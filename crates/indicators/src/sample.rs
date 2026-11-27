//! Deterministic sample bars for tests, benchmarks and the repaint check.

use crate::Bar;

/// A seeded random walk of `n` hourly bars: xorshift64 with seed 42, the
/// price starts at 30 000 and moves by up to 0.5 % per bar. `high` and `low`
/// bracket `open` and `close`; volume is 1..=100.
pub fn sample_bars(n: usize) -> Vec<Bar> {
    let mut state: u64 = 42;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let unit = |x: u64| (x >> 11) as f64 / (1u64 << 53) as f64;

    let mut price = 30_000.0_f64;
    let mut bars = Vec::with_capacity(n);
    for i in 0..n {
        let open = price;
        let close = open * (1.0 + (unit(next()) - 0.5) * 0.01);
        let high = open.max(close) * (1.0 + unit(next()) * 0.002);
        let low = open.min(close) * (1.0 - unit(next()) * 0.002);
        bars.push(Bar {
            time: 1_700_000_000_000 + i as i64 * 3_600_000,
            open,
            high,
            low,
            close,
            volume: (1 + next() % 100) as f64,
        });
        price = close;
    }
    bars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_well_formed() {
        let a = sample_bars(500);
        assert_eq!(a, sample_bars(500));
        assert_eq!(a[0].time, 1_700_000_000_000);
        assert_eq!(a[1].time - a[0].time, 3_600_000);
        assert_eq!(a[0].open, 30_000.0);
        for b in &a {
            assert!(b.high >= b.open.max(b.close));
            assert!(b.low <= b.open.min(b.close));
            assert!((1.0..=100.0).contains(&b.volume));
        }
    }

    #[test]
    fn prefix_of_a_longer_run_is_the_same() {
        assert_eq!(sample_bars(10), sample_bars(100)[..10]);
    }
}
