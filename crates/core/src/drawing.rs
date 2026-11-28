//! Drawings on a chart: the model, its validation and tick rescaling.
//!
//! Points are anchored by time and price (`Anchor`), never by bar index, so they stay put
//! when older candles are loaded. Prices are ticks at the drawing's `price_scale`.

use serde::{Deserialize, Serialize};

use crate::decimal::JS_SAFE_MAX;
use crate::model::InstrumentId;
use crate::position::PositionBody;

pub const MAX_ID_BYTES: usize = 64;
pub const MAX_NOTE_BYTES: usize = 2000;
pub const MIN_BRUSH_POINTS: usize = 2;
pub const MAX_BRUSH_POINTS: usize = 500;
pub const MAX_FIB_LEVELS: usize = 16;
pub const MAX_FIB_LEVEL: f64 = 5.0;
/// Colours are slots of the eight-colour indicator palette.
pub const PALETTE_SLOTS: u8 = 8;
pub const MAX_WIDTH: u8 = 4;

/// A point: `t` in ms since the Unix epoch, `p` in price ticks.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub t: i64,
    pub p: i64,
}

#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Style {
    /// Palette slot, `0..=7`.
    pub color: u8,
    /// Line width in pixels, `1..=4`.
    pub width: u8,
    pub dash: bool,
}

/// What is drawn. JSON is `{ "kind": "trend", ... }` with camelCase fields, the same in the
/// store and over IPC.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DrawingBody {
    Trend {
        a: Anchor,
        b: Anchor,
        extend_left: bool,
        extend_right: bool,
    },
    Hline {
        p: i64,
    },
    Rect {
        a: Anchor,
        b: Anchor,
        extend_right: bool,
    },
    Fib {
        a: Anchor,
        b: Anchor,
        /// Ratios of the a-b range, finite and within `-5..=5`.
        levels: Vec<f64>,
    },
    Position(PositionBody),
    Brush {
        points: Vec<Anchor>,
    },
    Note {
        t: i64,
        text: String,
    },
}

/// A drawing of one instrument; it shows on every timeframe.
#[derive(Debug, Clone, PartialEq)]
pub struct Drawing {
    /// Made by the UI: 1 to 64 bytes of `[A-Za-z0-9_-]`.
    pub id: String,
    pub instrument: InstrumentId,
    /// The instrument's price scale when the drawing was saved.
    pub price_scale: u8,
    pub body: DrawingBody,
    pub style: Style,
    pub locked: bool,
    /// Paint order, lowest first.
    pub z: i64,
    /// Ms since the Unix epoch, set by the engine on save.
    pub updated_at: i64,
}

pub fn validate_id(id: &str) -> Result<(), String> {
    let ok_byte = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    if id.is_empty() || id.len() > MAX_ID_BYTES || !id.bytes().all(ok_byte) {
        return Err(format!(
            "a drawing id must be 1 to {MAX_ID_BYTES} characters from A-Z, a-z, 0-9, _ and -"
        ));
    }
    Ok(())
}

/// JavaScript holds integers exactly only up to 2^53 - 1, so every number must fit.
fn check_int(what: &str, v: i64) -> Result<(), String> {
    if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
        return Err(format!("{what} {v} is outside ±(2^53 - 1)"));
    }
    Ok(())
}

fn check_anchor(what: &str, a: Anchor) -> Result<(), String> {
    check_int(&format!("{what} time"), a.t)?;
    check_int(&format!("{what} price"), a.p)
}

fn check_pair(a: Anchor, b: Anchor) -> Result<(), String> {
    check_anchor("point a", a)?;
    check_anchor("point b", b)?;
    if a == b {
        return Err("the two points of a drawing must differ".into());
    }
    Ok(())
}

/// Checks everything that can come from the UI.
pub fn validate(d: &Drawing) -> Result<(), String> {
    validate_id(&d.id)?;
    if d.style.color >= PALETTE_SLOTS {
        return Err(format!(
            "colour slot {} is not in 0..={}",
            d.style.color,
            PALETTE_SLOTS - 1
        ));
    }
    if !(1..=MAX_WIDTH).contains(&d.style.width) {
        return Err(format!(
            "line width {} is not in 1..={MAX_WIDTH}",
            d.style.width
        ));
    }
    check_int("z", d.z)?;
    check_int("updated_at", d.updated_at)?;
    match &d.body {
        DrawingBody::Trend { a, b, .. } | DrawingBody::Rect { a, b, .. } => check_pair(*a, *b),
        DrawingBody::Hline { p } => check_int("price", *p),
        DrawingBody::Fib { a, b, levels } => {
            check_pair(*a, *b)?;
            if levels.is_empty() || levels.len() > MAX_FIB_LEVELS {
                return Err(format!(
                    "a Fibonacci drawing needs 1 to {MAX_FIB_LEVELS} levels, not {}",
                    levels.len()
                ));
            }
            if let Some(l) = levels
                .iter()
                .find(|l| !(l.is_finite() && l.abs() <= MAX_FIB_LEVEL))
            {
                return Err(format!(
                    "Fibonacci level {l} is not a number in -{MAX_FIB_LEVEL}..={MAX_FIB_LEVEL}"
                ));
            }
            Ok(())
        }
        DrawingBody::Position(p) => p.validate(),
        DrawingBody::Brush { points } => {
            if !(MIN_BRUSH_POINTS..=MAX_BRUSH_POINTS).contains(&points.len()) {
                return Err(format!(
                    "a brush stroke needs {MIN_BRUSH_POINTS} to {MAX_BRUSH_POINTS} points, not {}",
                    points.len()
                ));
            }
            points
                .iter()
                .try_for_each(|a| check_anchor("brush point", *a))
        }
        DrawingBody::Note { t, text } => {
            check_int("note time", *t)?;
            if text.is_empty() || text.len() > MAX_NOTE_BYTES {
                return Err(format!(
                    "a note needs 1 to {MAX_NOTE_BYTES} bytes of text, not {}",
                    text.len()
                ));
            }
            Ok(())
        }
    }
}

/// `v` ticks at `from` decimal places expressed at `to` places, rounded half away from
/// zero; `None` on overflow.
pub fn rescale_ticks(v: i64, from: u8, to: u8) -> Option<i64> {
    if to >= from {
        return v.checked_mul(10i64.checked_pow(u32::from(to - from))?);
    }
    // In i128, 10^38 still fits; |v| < 2^63 < 10^38 / 2, so larger divisors round to zero.
    let Some(d) = 10i128.checked_pow(u32::from(from - to)) else {
        return Some(0);
    };
    let v = i128::from(v);
    let (q, r) = (v / d, v % d);
    let q = if r.abs() * 2 >= d { q + v.signum() } else { q };
    i64::try_from(q).ok()
}

impl Drawing {
    /// The drawing with every price expressed at `to` decimal places. `None` on overflow.
    /// The result may break a rule (a rounded stop meeting the entry): validate it.
    pub fn rescaled(&self, to: u8) -> Option<Drawing> {
        let from = self.price_scale;
        let px = |v: i64| rescale_ticks(v, from, to);
        let anchor = |a: Anchor| {
            Some(Anchor {
                t: a.t,
                p: px(a.p)?,
            })
        };
        let body = match &self.body {
            DrawingBody::Trend {
                a,
                b,
                extend_left,
                extend_right,
            } => DrawingBody::Trend {
                a: anchor(*a)?,
                b: anchor(*b)?,
                extend_left: *extend_left,
                extend_right: *extend_right,
            },
            DrawingBody::Hline { p } => DrawingBody::Hline { p: px(*p)? },
            DrawingBody::Rect { a, b, extend_right } => DrawingBody::Rect {
                a: anchor(*a)?,
                b: anchor(*b)?,
                extend_right: *extend_right,
            },
            DrawingBody::Fib { a, b, levels } => DrawingBody::Fib {
                a: anchor(*a)?,
                b: anchor(*b)?,
                levels: levels.clone(),
            },
            DrawingBody::Position(p) => DrawingBody::Position(PositionBody {
                entry: anchor(p.entry)?,
                stop: px(p.stop)?,
                take: px(p.take)?,
                ..*p
            }),
            DrawingBody::Brush { points } => DrawingBody::Brush {
                points: points.iter().map(|a| anchor(*a)).collect::<Option<_>>()?,
            },
            DrawingBody::Note { .. } => self.body.clone(),
        };
        Some(Drawing {
            price_scale: to,
            body,
            ..self.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::position::Side;

    fn at(t: i64, p: i64) -> Anchor {
        Anchor { t, p }
    }

    fn drawing(body: DrawingBody) -> Drawing {
        Drawing {
            id: "d-1_A".into(),
            instrument: InstrumentId {
                source: "binance".into(),
                symbol: "BTCUSDT".into(),
            },
            price_scale: 2,
            body,
            style: Style {
                color: 0,
                width: 1,
                dash: false,
            },
            locked: false,
            z: 0,
            updated_at: 0,
        }
    }

    fn trend() -> DrawingBody {
        DrawingBody::Trend {
            a: at(1, 100),
            b: at(2, 200),
            extend_left: false,
            extend_right: true,
        }
    }

    fn position(side: Side, stop: i64, entry: i64, take: i64, end_t: i64) -> DrawingBody {
        DrawingBody::Position(PositionBody {
            side,
            entry: at(1_000, entry),
            stop,
            take,
            end_t,
        })
    }

    fn fib(levels: Vec<f64>) -> DrawingBody {
        DrawingBody::Fib {
            a: at(1, 100),
            b: at(2, 200),
            levels,
        }
    }

    fn brush(n: usize) -> DrawingBody {
        DrawingBody::Brush {
            points: (0..n as i64).map(|i| at(i, i)).collect(),
        }
    }

    fn note(text: String) -> DrawingBody {
        DrawingBody::Note { t: 5, text }
    }

    const BIG: i64 = JS_SAFE_MAX + 1;

    /// The other rules are in `tests/fixtures/drawings_*.json`, shared with the UI mock;
    /// these cannot be written there (JSON has no NaN) or are not sent by the UI.
    #[test]
    fn rules_outside_the_shared_fixture() {
        for (levels, expected) in [
            (vec![f64::NAN], "level NaN"),
            (vec![f64::INFINITY], "level inf"),
            (vec![0.5, f64::NEG_INFINITY], "level -inf"),
        ] {
            let err = validate(&drawing(fib(levels))).unwrap_err();
            assert!(err.contains(expected), "{err:?}");
        }
        let mut d = drawing(trend());
        d.updated_at = -BIG;
        assert!(validate(&d).unwrap_err().contains("updated_at"));
        d.updated_at = JS_SAFE_MAX;
        assert_eq!(validate(&d), Ok(()));
    }

    #[test]
    fn body_json_is_tagged_with_camel_case_fields() {
        let json = serde_json::to_value(trend()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "trend", "a": { "t": 1, "p": 100 }, "b": { "t": 2, "p": 200 },
                "extendLeft": false, "extendRight": true
            })
        );
        let json = serde_json::to_value(position(Side::Short, 110, 100, 85, 2_000)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "position", "side": "short", "entry": { "t": 1_000, "p": 100 },
                "stop": 110, "take": 85, "endT": 2_000
            })
        );
        for body in [
            trend(),
            DrawingBody::Hline { p: 5 },
            fib(vec![0.236]),
            position(Side::Long, 90, 100, 120, 1_001),
            brush(3),
            note("hi".into()),
        ] {
            let text = serde_json::to_string(&body).unwrap();
            assert_eq!(serde_json::from_str::<DrawingBody>(&text).unwrap(), body);
        }
        assert!(serde_json::from_str::<DrawingBody>(r#"{"kind":"spiral"}"#).is_err());
    }

    #[test]
    fn rescale_ticks_scales_up_and_rounds_down_half_away_from_zero() {
        assert_eq!(rescale_ticks(12_345, 2, 4), Some(1_234_500));
        assert_eq!(rescale_ticks(12_345, 2, 2), Some(12_345));
        assert_eq!(rescale_ticks(12_345, 4, 2), Some(123));
        assert_eq!(rescale_ticks(12_350, 4, 2), Some(124));
        assert_eq!(rescale_ticks(-12_350, 4, 2), Some(-124));
        assert_eq!(rescale_ticks(-12_349, 4, 2), Some(-123));
        assert_eq!(rescale_ticks(i64::MAX, 0, 1), None);
        assert_eq!(rescale_ticks(1, 0, 19), None);
        assert_eq!(rescale_ticks(i64::MAX, 30, 0), Some(0));
        assert_eq!(rescale_ticks(i64::MIN, 19, 0), Some(-1));
    }

    #[test]
    fn rescaled_moves_every_price_but_no_time() {
        let mut d = drawing(position(Side::Long, 90, 100, 120, 5_000));
        let up = d.rescaled(4).unwrap();
        assert_eq!(up.price_scale, 4);
        assert_eq!(up.body, position(Side::Long, 9_000, 10_000, 12_000, 5_000));
        d.body = brush(3);
        assert_eq!(
            d.rescaled(3).unwrap().body,
            DrawingBody::Brush {
                points: vec![at(0, 0), at(1, 10), at(2, 20)]
            }
        );
        d.body = note("n".into());
        assert_eq!(d.rescaled(0).unwrap().body, d.body);
        d.body = DrawingBody::Hline { p: i64::MAX / 2 };
        assert_eq!(d.rescaled(3), None);
    }
}
