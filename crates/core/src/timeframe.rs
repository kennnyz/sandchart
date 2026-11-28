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

    /// Start of the bucket (in Unix ms, UTC) that contains `t`, as Binance lays them out:
    /// fixed lengths aligned to the epoch, weeks from Monday 00:00, calendar months. `t`
    /// is a candle time, so inside ±(2^53 - 1).
    pub fn bucket_start(&self, t: i64) -> i64 {
        match (self, self.fixed_ms()) {
            (Timeframe::W1, _) => (t - MONDAY_MS).div_euclid(WEEK_MS) * WEEK_MS + MONDAY_MS,
            (_, Some(ms)) => t.div_euclid(ms) * ms,
            (_, None) => {
                let (y, m) = civil_month(t.div_euclid(DAY_MS));
                days_from_civil(y, m) * DAY_MS
            }
        }
    }

    /// Start of the bucket after the one that contains `t`.
    pub fn bucket_end(&self, t: i64) -> i64 {
        match self.fixed_ms() {
            Some(ms) => self.bucket_start(t) + ms,
            None => {
                let (y, m) = civil_month(t.div_euclid(DAY_MS));
                let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
                days_from_civil(y, m) * DAY_MS
            }
        }
    }

    /// When a candle of this timeframe opening at `open_time` closes: the open time plus
    /// the length, or the start of the next calendar month for 1M. Strictly increasing in
    /// `open_time` for fixed lengths, so a close time names one candle.
    pub fn close_time(&self, open_time: i64) -> i64 {
        match self.fixed_ms() {
            Some(ms) => open_time + ms,
            None => self.bucket_end(open_time),
        }
    }

    /// Whether candles of this timeframe can be built from `base` candles: every bucket
    /// boundary of this timeframe must be one of `base`. True for the timeframe itself.
    pub fn builds_from(&self, base: Timeframe) -> bool {
        if *self == base {
            return true;
        }
        let Some(b) = base.fixed_ms() else {
            return false;
        };
        match self.fixed_ms() {
            // Every month starts at midnight UTC.
            None => DAY_MS % b == 0,
            Some(ms) => {
                let offset = if *self == Timeframe::W1 { MONDAY_MS } else { 0 };
                ms > b && ms % b == 0 && offset % b == 0
            }
        }
    }
}

const WEEK_MS: i64 = 7 * DAY_MS;
/// 1970-01-01 was a Thursday; the first Monday is four days later.
const MONDAY_MS: i64 = 4 * DAY_MS;

/// Year and month (1-12) of the day `days` since 1970-01-01 (proleptic Gregorian, UTC).
/// Howard Hinnant's `civil_from_days`.
fn civil_month(days: i64) -> (i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m)
}

/// Days since 1970-01-01 of the first day of month `m` (1-12) of year `y`. Howard
/// Hinnant's `days_from_civil` with day 1.
fn days_from_civil(y: i64, m: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

    // Expected times were worked out with Python's datetime, not with this code.
    const D: i64 = DAY_MS;

    #[test]
    fn fixed_buckets_are_aligned_to_the_epoch() {
        assert_eq!(Timeframe::H4.bucket_start(5 * HOUR_MS + 1), 4 * HOUR_MS);
        assert_eq!(Timeframe::H4.bucket_end(5 * HOUR_MS + 1), 8 * HOUR_MS);
        assert_eq!(Timeframe::H4.bucket_start(4 * HOUR_MS), 4 * HOUR_MS);
        assert_eq!(Timeframe::M15.bucket_start(-1), -15 * MINUTE_MS);
        assert_eq!(Timeframe::D3.bucket_start(5 * D), 3 * D);
        // 2024-11-29 12:34 UTC is in the 3d bucket that starts 2024-11-28 (day 20 055).
        assert_eq!(
            Timeframe::D3.bucket_start(1_732_883_640_000),
            1_732_752_000_000
        );
    }

    #[test]
    fn weeks_start_on_monday() {
        // Thursday 1970-01-01 is in the week of Monday 1969-12-29.
        assert_eq!(Timeframe::W1.bucket_start(0), -3 * D);
        assert_eq!(Timeframe::W1.bucket_start(4 * D - 1), -3 * D);
        assert_eq!(Timeframe::W1.bucket_start(4 * D), 4 * D);
        assert_eq!(Timeframe::W1.bucket_end(4 * D), 11 * D);
        // Thursday 2026-11-26 is in the week of Monday 2026-11-23.
        assert_eq!(
            Timeframe::W1.bucket_start(1_795_651_200_000),
            1_795_392_000_000
        );
    }

    #[test]
    fn months_are_calendar_months() {
        let m = Timeframe::Mn1;
        // 2024-02-29 (leap day) is in February 2024, which ends on 2024-03-01.
        assert_eq!(m.bucket_start(1_709_164_800_000), 1_706_745_600_000);
        assert_eq!(m.bucket_end(1_709_164_800_000), 1_709_251_200_000);
        // February 2023 has 28 days.
        assert_eq!(m.bucket_end(1_675_209_600_000), 1_677_628_800_000);
        // December rolls over into January: 2023-12-31 23:59:59.999.
        assert_eq!(m.bucket_start(1_704_067_199_999), 1_701_388_800_000);
        assert_eq!(m.bucket_end(1_704_067_199_999), 1_704_067_200_000);
        // Before the epoch: 1969-12-15 is in December 1969.
        assert_eq!(m.bucket_start(-17 * D), -31 * D);
        assert_eq!(m.bucket_end(-17 * D), 0);
        // February 2000 (divisible by 400) has 29 days, February 1900 has 28.
        assert_eq!(m.bucket_end(949_363_200_000), 951_868_800_000);
        assert_eq!(
            m.bucket_end(-2_206_310_400_000) - m.bucket_start(-2_206_310_400_000),
            28 * D
        );
        assert_eq!(m.close_time(1_706_745_600_000), 1_709_251_200_000);
        assert_eq!(Timeframe::H1.close_time(1_800_000), 5_400_000);
    }
}
