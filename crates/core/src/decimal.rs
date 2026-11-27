//! Fixed-point decimal helpers: exchange strings to integer ticks and back.

use thiserror::Error;

/// Largest integer a JavaScript `number` represents exactly (`2^53 - 1`).
pub const JS_SAFE_MAX: i64 = 9_007_199_254_740_991;

/// Why a decimal string could not be converted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DecimalError {
    #[error("not a valid decimal number")]
    Invalid,
    #[error("non-zero digits beyond the allowed scale")]
    ExtraPrecision,
    #[error("value does not fit in i64")]
    Overflow,
}

/// Number of decimal places of an exchange step such as `"0.01000000"` (-> 2).
///
/// Trailing zeros are ignored. The step must be a positive plain decimal.
pub fn scale_from_step(step: &str) -> Result<u8, DecimalError> {
    let (int, frac) = step.split_once('.').unwrap_or((step, ""));
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if int.is_empty() || !all_digits(int) || !all_digits(frac) {
        return Err(DecimalError::Invalid);
    }
    if int.bytes().chain(frac.bytes()).all(|b| b == b'0') {
        return Err(DecimalError::Invalid);
    }
    u8::try_from(frac.trim_end_matches('0').len()).map_err(|_| DecimalError::Overflow)
}

/// Parses a decimal string into ticks of `10^-scale`.
///
/// Zeros past `scale` are accepted (`"61443.01000000"` at scale 2); a non-zero
/// digit past `scale` is [`DecimalError::ExtraPrecision`].
pub fn parse_scaled(s: &str, scale: u8) -> Result<i64, DecimalError> {
    let (negative, unsigned) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let (int, frac) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if int.is_empty() && frac.is_empty() {
        return Err(DecimalError::Invalid);
    }
    let digit = |b: u8| -> Result<i64, DecimalError> {
        b.is_ascii_digit()
            .then(|| i64::from(b - b'0'))
            .ok_or(DecimalError::Invalid)
    };
    // Validate everything first so a malformed tail is `Invalid`, not `Overflow`.
    for b in int.bytes().chain(frac.bytes()) {
        digit(b)?;
    }
    let scale = usize::from(scale);
    if frac.len() > scale && frac.as_bytes()[scale..].iter().any(|&b| b != b'0') {
        return Err(DecimalError::ExtraPrecision);
    }
    let kept = &frac.as_bytes()[..frac.len().min(scale)];
    let padding = scale - kept.len();

    let mut acc: i64 = 0;
    for &b in int.as_bytes().iter().chain(kept) {
        acc = push_digit(acc, digit(b)?)?;
    }
    for _ in 0..padding {
        acc = push_digit(acc, 0)?;
    }
    Ok(if negative { -acc } else { acc })
}

fn push_digit(acc: i64, d: i64) -> Result<i64, DecimalError> {
    acc.checked_mul(10)
        .and_then(|v| v.checked_add(d))
        .ok_or(DecimalError::Overflow)
}

/// Formats ticks as a decimal string with exactly `scale` fraction digits.
pub fn format_scaled(v: i64, scale: u8) -> String {
    let scale = usize::from(scale);
    let sign = if v < 0 { "-" } else { "" };
    let digits = v.unsigned_abs().to_string();
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = format!("{digits:0>width$}", width = scale + 1);
    let (int, frac) = padded.split_at(padded.len() - scale);
    format!("{sign}{int}.{frac}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_from_binance_steps() {
        assert_eq!(scale_from_step("0.01000000").unwrap(), 2);
        assert_eq!(scale_from_step("1.00000000").unwrap(), 0);
        assert_eq!(scale_from_step("0.00000001").unwrap(), 8);
    }
    #[test]
    fn parse_and_format_round_trip() {
        assert_eq!(parse_scaled("61443.01000000", 2).unwrap(), 6_144_301);
        assert_eq!(format_scaled(6_144_301, 2), "61443.01");
        assert_eq!(parse_scaled("-0.5", 1).unwrap(), -5);
    }
    #[test]
    fn parse_rejects_extra_precision() {
        assert_eq!(parse_scaled("1.234", 2), Err(DecimalError::ExtraPrecision));
    }
    #[test]
    fn parse_tiny_tick() {
        assert_eq!(parse_scaled("0.00001234", 8).unwrap(), 1234);
        assert_eq!(format_scaled(1234, 8), "0.00001234");
    }
    #[test]
    fn parse_negative_and_padding() {
        assert_eq!(parse_scaled("-0.05", 2).unwrap(), -5);
        assert_eq!(parse_scaled("+7", 3).unwrap(), 7000);
        assert_eq!(parse_scaled("1.", 1).unwrap(), 10);
        assert_eq!(parse_scaled(".5", 1).unwrap(), 5);
    }
    #[test]
    fn parse_rejects_malformed() {
        for s in ["", "-", ".", "abc", "1.2.3", "1e5", " 1", "--1", "1,5"] {
            assert_eq!(parse_scaled(s, 2), Err(DecimalError::Invalid), "{s:?}");
        }
    }
    #[test]
    fn parse_i64_bounds() {
        assert_eq!(parse_scaled("9223372036854775807", 0).unwrap(), i64::MAX);
        assert_eq!(parse_scaled("-9223372036854775807", 0).unwrap(), -i64::MAX);
        assert_eq!(
            parse_scaled("9223372036854775808", 0),
            Err(DecimalError::Overflow)
        );
        assert_eq!(parse_scaled("1", 255), Err(DecimalError::Overflow));
    }
    #[test]
    fn format_negative_and_extremes() {
        assert_eq!(format_scaled(-5, 2), "-0.05");
        assert_eq!(format_scaled(0, 3), "0.000");
        assert_eq!(format_scaled(42, 0), "42");
        assert_eq!(format_scaled(i64::MIN, 0), "-9223372036854775808");
    }
    #[test]
    fn scale_from_step_rejects_bad_input() {
        for s in ["", "0", "0.000", "abc", "1e-8", "-0.01", "0.0.1"] {
            assert_eq!(scale_from_step(s), Err(DecimalError::Invalid), "{s:?}");
        }
    }
    #[test]
    fn js_safe_max_is_two_pow_53_minus_one() {
        assert_eq!(JS_SAFE_MAX, (1_i64 << 53) - 1);
    }
    #[test]
    fn parse_overflow() {
        assert_eq!(
            parse_scaled("99999999999999999999", 0),
            Err(DecimalError::Overflow)
        );
    }
}
