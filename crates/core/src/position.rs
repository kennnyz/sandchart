//! The outcome of a long or short position over candles. Replay uses the same function.

use serde::{Deserialize, Serialize};

use crate::Candle;
use crate::decimal::JS_SAFE_MAX;
use crate::drawing::Anchor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Neither stop nor take was reached by `end_t` (or the cached candles end before).
    Open,
    Take,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: Status,
    /// Open time of the bar that hit the stop or the take.
    pub exit_time: Option<i64>,
    /// That bar touched both stop and take; it counts as a stop.
    pub ambiguous: bool,
    /// Reward over risk on a take, -1 on a stop, 0 while open.
    pub r: f64,
}

/// A position: entry anchor, stop and take in price ticks, and the time it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionBody {
    pub side: Side,
    pub entry: Anchor,
    pub stop: i64,
    pub take: i64,
    pub end_t: i64,
}

impl PositionBody {
    /// Long: stop < entry < take. Short: take < entry < stop. The end is after the entry.
    pub fn validate(&self) -> Result<(), String> {
        for (name, v) in [
            ("entry time", self.entry.t),
            ("entry price", self.entry.p),
            ("stop", self.stop),
            ("take", self.take),
            ("end time", self.end_t),
        ] {
            if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
                return Err(format!("position {name} {v} is outside ±(2^53 - 1)"));
            }
        }
        let p = self.entry.p;
        match self.side {
            Side::Long if !(self.stop < p && p < self.take) => {
                return Err("a long position needs stop < entry < take".into());
            }
            Side::Short if !(self.take < p && p < self.stop) => {
                return Err("a short position needs take < entry < stop".into());
            }
            _ => {}
        }
        if self.end_t <= self.entry.t {
            return Err("a position must end after its entry".into());
        }
        Ok(())
    }

    pub fn resolve(&self, candles: &[Candle]) -> Outcome {
        resolve(
            self.side, self.entry, self.stop, self.take, self.end_t, candles,
        )
    }
}

/// Scans `candles` (ascending by `open_time`) after the bar that contains `entry.t`, up to
/// and including the bar that opens at `end_t`. The first bar that reaches the stop or the
/// take decides; a bar that reaches both is a stop and flagged ambiguous.
pub fn resolve(
    side: Side,
    entry: Anchor,
    stop: i64,
    take: i64,
    end_t: i64,
    candles: &[Candle],
) -> Outcome {
    // The bar containing entry.t is the last with open_time <= entry.t; skip it and older ones.
    let start = candles.partition_point(|c| c.open_time <= entry.t);
    for c in candles[start..].iter().take_while(|c| c.open_time <= end_t) {
        let (hit_stop, hit_take) = match side {
            Side::Long => (c.low <= stop, c.high >= take),
            Side::Short => (c.high >= stop, c.low <= take),
        };
        if hit_stop {
            return Outcome {
                status: Status::Stop,
                exit_time: Some(c.open_time),
                ambiguous: hit_take,
                r: -1.0,
            };
        }
        if hit_take {
            let (p, stop, take) = (i128::from(entry.p), i128::from(stop), i128::from(take));
            // Long and short alike: both differences have the same sign.
            let r = (take - p) as f64 / (p - stop) as f64;
            return Outcome {
                status: Status::Take,
                exit_time: Some(c.open_time),
                ambiguous: false,
                r,
            };
        }
    }
    Outcome {
        status: Status::Open,
        exit_time: None,
        ambiguous: false,
        r: 0.0,
    }
}
