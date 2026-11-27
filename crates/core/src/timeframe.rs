//! Chart timeframes and their wire codes.

use serde::{Deserialize, Serialize};

/// A candle interval. Codes match Binance (`"1m"` ... `"1w"`, `"1M"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Timeframe {
    M1,
    M3,
    M5,
    M15,
    M30,
    H1,
    H2,
    H4,
    H6,
    H8,
    H12,
    D1,
    D3,
    W1,
    Mn1,
}

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

impl Timeframe {
    pub const ALL: [Timeframe; 15] = [
        Timeframe::M1,
        Timeframe::M3,
        Timeframe::M5,
        Timeframe::M15,
        Timeframe::M30,
        Timeframe::H1,
        Timeframe::H2,
        Timeframe::H4,
        Timeframe::H6,
        Timeframe::H8,
        Timeframe::H12,
        Timeframe::D1,
        Timeframe::D3,
        Timeframe::W1,
        Timeframe::Mn1,
    ];

    /// The exchange code, e.g. `"4h"`. Months are `"1M"`, minutes `"1m"`.
    pub fn code(&self) -> &'static str {
        match self {
            Timeframe::M1 => "1m",
            Timeframe::M3 => "3m",
            Timeframe::M5 => "5m",
            Timeframe::M15 => "15m",
            Timeframe::M30 => "30m",
            Timeframe::H1 => "1h",
            Timeframe::H2 => "2h",
            Timeframe::H4 => "4h",
            Timeframe::H6 => "6h",
            Timeframe::H8 => "8h",
            Timeframe::H12 => "12h",
            Timeframe::D1 => "1d",
            Timeframe::D3 => "3d",
            Timeframe::W1 => "1w",
            Timeframe::Mn1 => "1M",
        }
    }

    /// Case-sensitive inverse of [`Timeframe::code`].
    pub fn from_code(code: &str) -> Option<Timeframe> {
        Self::ALL.into_iter().find(|tf| tf.code() == code)
    }

    /// Length in milliseconds, or `None` for the calendar-month timeframe.
    pub fn fixed_ms(&self) -> Option<i64> {
        Some(match self {
            Timeframe::M1 => MINUTE_MS,
            Timeframe::M3 => 3 * MINUTE_MS,
            Timeframe::M5 => 5 * MINUTE_MS,
            Timeframe::M15 => 15 * MINUTE_MS,
            Timeframe::M30 => 30 * MINUTE_MS,
            Timeframe::H1 => HOUR_MS,
            Timeframe::H2 => 2 * HOUR_MS,
            Timeframe::H4 => 4 * HOUR_MS,
            Timeframe::H6 => 6 * HOUR_MS,
            Timeframe::H8 => 8 * HOUR_MS,
            Timeframe::H12 => 12 * HOUR_MS,
            Timeframe::D1 => DAY_MS,
            Timeframe::D3 => 3 * DAY_MS,
            Timeframe::W1 => 7 * DAY_MS,
            Timeframe::Mn1 => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeframe_codes_round_trip() {
        for tf in Timeframe::ALL {
            assert_eq!(Timeframe::from_code(tf.code()), Some(tf));
        }
        assert_eq!(Timeframe::H4.fixed_ms(), Some(14_400_000));
        assert_eq!(Timeframe::Mn1.fixed_ms(), None);
    }

    #[test]
    fn codes_are_case_sensitive_and_unknown_is_none() {
        assert_eq!(Timeframe::from_code("1m"), Some(Timeframe::M1));
        assert_eq!(Timeframe::from_code("1M"), Some(Timeframe::Mn1));
        assert_eq!(Timeframe::from_code("2m"), None);
        assert_eq!(Timeframe::from_code(""), None);
    }

    #[test]
    fn fixed_lengths_are_strictly_increasing() {
        let ms: Vec<i64> = Timeframe::ALL
            .iter()
            .filter_map(Timeframe::fixed_ms)
            .collect();
        assert_eq!(ms.len(), 14);
        assert!(ms.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(Timeframe::W1.fixed_ms(), Some(604_800_000));
    }
}
