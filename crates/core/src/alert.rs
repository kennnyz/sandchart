//! Alerts: a price or a line drawing, a direction, and the rule that decides when one fires
//! (ADR 0007). Prices are ticks at the alert's `price_scale`, as for drawings.

use serde::{Deserialize, Serialize};

use crate::decimal::JS_SAFE_MAX;
use crate::drawing::{Anchor, DrawingBody, MAX_ID_BYTES, rescale_ticks, validate_id};
use crate::model::InstrumentId;

/// What an alert watches. JSON is `{ "kind": "price", "price": 100 }` or
/// `{ "kind": "drawing", "drawingId": "d1" }`, the same in the store and over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AlertKind {
    /// A fixed price in ticks.
    Price { price: i64 },
    /// An `hline` or `trend` drawing of the same instrument.
    Drawing { drawing_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// The price moves from below the level to it or above it.
    Above,
    /// The price moves from above the level to it or below it.
    Below,
    /// Either.
    Cross,
}

impl Direction {
    pub fn code(self) -> &'static str {
        match self {
            Direction::Above => "above",
            Direction::Below => "below",
            Direction::Cross => "cross",
        }
    }

    pub fn from_code(code: &str) -> Option<Direction> {
        match code {
            "above" => Some(Direction::Above),
            "below" => Some(Direction::Below),
            "cross" => Some(Direction::Cross),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    /// Made by the UI: 1 to 64 bytes of `[A-Za-z0-9_-]`.
    pub id: String,
    pub instrument: InstrumentId,
    /// The scale of `kind`'s price and of `triggered_price`.
    pub price_scale: u8,
    pub kind: AlertKind,
    pub direction: Direction,
    /// False once it fired; re-arming sets it again.
    pub active: bool,
    /// Ms since the Unix epoch, set by the engine.
    pub created_at: i64,
    pub triggered_at: Option<i64>,
    pub triggered_price: Option<i64>,
}

/// The level an alert compares the price with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Level {
    /// A price alert or an `hline`.
    Flat { p: i64 },
    /// A trend line: `extend_left` continues it before the earlier anchor, `extend_right`
    /// after the later one.
    Line {
        a: Anchor,
        b: Anchor,
        extend_left: bool,
        extend_right: bool,
    },
}

/// One live update as alerts see it: when it arrived (`t`, ms), the bar it belongs to and
/// that bar's high, low and close so far, in ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub t: i64,
    pub open_time: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
}

fn check_int(what: &str, v: i64) -> Result<(), String> {
    if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
        return Err(format!("{what} {v} is outside ±(2^53 - 1)"));
    }
    Ok(())
}

/// Checks everything that can come from the UI or the store.
pub fn validate(a: &Alert) -> Result<(), String> {
    let ok_byte = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    if a.id.is_empty() || a.id.len() > MAX_ID_BYTES || !a.id.bytes().all(ok_byte) {
        return Err(format!(
            "an alert id must be 1 to {MAX_ID_BYTES} characters from A-Z, a-z, 0-9, _ and -"
        ));
    }
    match &a.kind {
        AlertKind::Price { price } => check_int("alert price", *price)?,
        AlertKind::Drawing { drawing_id } => validate_id(drawing_id)?,
    }
    check_int("created_at", a.created_at)?;
    if let Some(t) = a.triggered_at {
        check_int("triggered_at", t)?;
    }
    if let Some(p) = a.triggered_price {
        check_int("triggered price", p)?;
    }
    Ok(())
}

/// `n / d` rounded half away from zero; `d > 0`.
fn div_round(n: i128, d: i128) -> i128 {
    let (q, r) = (n / d, n % d);
    if r.abs() * 2 >= d { q + n.signum() } else { q }
}

impl Level {
    /// The level of an `hline` or `trend` drawing; `None` for every other kind.
    pub fn of_drawing(body: &DrawingBody) -> Option<Level> {
        match *body {
            DrawingBody::Hline { p } => Some(Level::Flat { p }),
            DrawingBody::Trend {
                a,
                b,
                extend_left,
                extend_right,
            } => Some(Level::Line {
                a,
                b,
                extend_left,
                extend_right,
            }),
            _ => None,
        }
    }

    /// The level at time `t`, in ticks; `None` off the line (outside a segment that is not
    /// extended that way, on a vertical line, or past ±(2^53 - 1)).
    pub fn at(&self, t: i64) -> Option<i64> {
        let (a, b, extend_left, extend_right) = match *self {
            Level::Flat { p } => return Some(p),
            Level::Line {
                a,
                b,
                extend_left,
                extend_right,
            } => (a, b, extend_left, extend_right),
        };
        let (first, last) = if a.t <= b.t { (a, b) } else { (b, a) };
        if first.t == last.t || (t < first.t && !extend_left) || (t > last.t && !extend_right) {
            return None;
        }
        let dt = i128::from(last.t) - i128::from(first.t);
        let n = (i128::from(last.p) - i128::from(first.p)) * (i128::from(t) - i128::from(first.t));
        let p = i128::from(first.p) + div_round(n, dt);
        i64::try_from(p)
            .ok()
            .filter(|p| p.unsigned_abs() <= JS_SAFE_MAX.unsigned_abs())
    }
}

/// Whether an alert of `direction` on `level` fires between the consecutive updates `prev`
/// and `cur`; returns the price it fired at: the close when the close is past the level,
/// else the level (only a wick reached it).
///
/// `above` fires when `prev`'s close was below the level and the price since reached it:
/// in the same bar the close or a new high; in a new bar its high (so a bar that opens past
/// the level, a gap, fires too). `below` mirrors it. An update of an older bar is ignored.
/// When `same_stream` is false (another timeframe fed `prev`), only the closes count, since
/// a longer bar's high may be from before `prev`.
pub fn fires(
    direction: Direction,
    level: &Level,
    prev: &Update,
    cur: &Update,
    same_stream: bool,
) -> Option<i64> {
    let (lo, hi) = if !same_stream {
        (cur.close, cur.close)
    } else if cur.open_time == prev.open_time {
        (
            if cur.low < prev.low {
                cur.low
            } else {
                cur.close
            },
            if cur.high > prev.high {
                cur.high
            } else {
                cur.close
            },
        )
    } else if cur.open_time > prev.open_time {
        (cur.low, cur.high)
    } else {
        return None;
    };
    let was = level.at(prev.t)?;
    let now = level.at(cur.t)?;
    let up = prev.close < was && hi >= now;
    let down = prev.close > was && lo <= now;
    match direction {
        Direction::Above | Direction::Cross if up => Some(cur.close.max(now)),
        Direction::Below | Direction::Cross if down => Some(cur.close.min(now)),
        _ => None,
    }
}

impl Alert {
    /// The alert with its prices at `to` decimal places; `None` on overflow.
    pub fn rescaled(&self, to: u8) -> Option<Alert> {
        let from = self.price_scale;
        let kind = match &self.kind {
            AlertKind::Price { price } => AlertKind::Price {
                price: rescale_ticks(*price, from, to)?,
            },
            AlertKind::Drawing { .. } => self.kind.clone(),
        };
        let triggered_price = match self.triggered_price {
            Some(p) => Some(rescale_ticks(p, from, to)?),
            None => None,
        };
        Some(Alert {
            price_scale: to,
            kind,
            triggered_price,
            ..self.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_and_direction_json() {
        assert_eq!(
            serde_json::to_value(AlertKind::Drawing {
                drawing_id: "d1".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "drawing", "drawingId": "d1" })
        );
        assert_eq!(
            serde_json::to_value(AlertKind::Price { price: 5 }).unwrap(),
            serde_json::json!({ "kind": "price", "price": 5 })
        );
        for d in [Direction::Above, Direction::Below, Direction::Cross] {
            assert_eq!(serde_json::to_value(d).unwrap(), d.code());
            assert_eq!(Direction::from_code(d.code()), Some(d));
        }
        assert_eq!(Direction::from_code("up"), None);
    }

    #[test]
    fn of_drawing_takes_hlines_and_trend_lines_only() {
        assert_eq!(
            Level::of_drawing(&DrawingBody::Hline { p: 7 }),
            Some(Level::Flat { p: 7 })
        );
        let note = DrawingBody::Note {
            t: 0,
            text: "x".into(),
        };
        assert_eq!(Level::of_drawing(&note), None);
    }

    #[test]
    fn rescaled_moves_the_price_and_the_triggered_price() {
        let a = Alert {
            id: "a".into(),
            instrument: InstrumentId {
                source: "binance".into(),
                symbol: "X".into(),
            },
            price_scale: 2,
            kind: AlertKind::Price { price: 12_345 },
            direction: Direction::Cross,
            active: false,
            created_at: 1,
            triggered_at: Some(2),
            triggered_price: Some(12_350),
        };
        let r = a.rescaled(1).unwrap();
        assert_eq!(r.kind, AlertKind::Price { price: 1_235 });
        assert_eq!(r.triggered_price, Some(1_235));
        assert_eq!(r.price_scale, 1);
        assert_eq!(a.rescaled(30), None);
    }

    #[test]
    fn rules_outside_the_shared_fixture() {
        let mut a = Alert {
            id: "a".into(),
            instrument: InstrumentId {
                source: "binance".into(),
                symbol: "X".into(),
            },
            price_scale: 2,
            kind: AlertKind::Price { price: 1 },
            direction: Direction::Above,
            active: true,
            created_at: JS_SAFE_MAX + 1,
            triggered_at: None,
            triggered_price: None,
        };
        assert!(validate(&a).unwrap_err().contains("created_at"));
        a.created_at = 0;
        a.triggered_price = Some(-JS_SAFE_MAX - 1);
        assert!(validate(&a).unwrap_err().contains("triggered price"));
    }
}
