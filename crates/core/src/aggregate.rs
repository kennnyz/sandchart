//! Candles of a higher timeframe built from base candles, as a replay shows them (ADR 0008).

use crate::model::Candle;
use crate::timeframe::Timeframe;

/// Builds `tf` candles from `candles` of the `base` timeframe (ascending by `open_time`):
/// per bucket of `tf` ([`Timeframe::bucket_start`]) the open of the first, the highest
/// high, the lowest low, the close of the last and the summed volume, stamped with the
/// bucket's start. The last bucket may be partial (the forming bar); a bucket without base
/// candles gives none. `tf == base` returns the candles unchanged. Fails when `tf` does
/// not build from `base` ([`Timeframe::builds_from`]).
pub fn aggregate(
    candles: &[Candle],
    base: Timeframe,
    tf: Timeframe,
) -> Result<Vec<Candle>, String> {
    if !tf.builds_from(base) {
        return Err(format!(
            "{} candles cannot be built from {} candles",
            tf.code(),
            base.code()
        ));
    }
    if tf == base {
        return Ok(candles.to_vec());
    }
    let mut out: Vec<Candle> = Vec::new();
    for c in candles {
        let start = tf.bucket_start(c.open_time);
        match out.last_mut() {
            Some(b) if b.open_time == start => {
                b.high = b.high.max(c.high);
                b.low = b.low.min(c.low);
                b.close = c.close;
                b.volume = b.volume.saturating_add(c.volume);
            }
            _ => out.push(Candle {
                open_time: start,
                ..*c
            }),
        }
    }
    Ok(out)
}
