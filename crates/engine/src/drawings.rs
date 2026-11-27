//! Drawings: list, save and delete, and the outcome of position drawings.

use sandchart_core::drawing::{validate, validate_id};
use sandchart_core::{Drawing, InstrumentId, Outcome, PositionBody, Timeframe};
use sandchart_store::MAX_DRAWINGS_PER_INSTRUMENT;

use crate::{Engine, EngineError, blocking};

impl Engine {
    /// The drawings of an instrument in paint order, in the instrument's current price
    /// scale. A drawing saved at another scale is rescaled; one that no longer fits (or
    /// breaks a rule after rounding) is left out and logged, and stays stored as it was.
    pub async fn drawings(&self, id: &InstrumentId) -> Result<Vec<Drawing>, EngineError> {
        let key = id.clone();
        let (instrument, stored) = blocking(&self.shared.store, move |s| {
            Ok((s.instrument(&key)?, s.drawings(&key)?))
        })
        .await?;
        let scale = instrument
            .ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?
            .price_scale;
        Ok(stored
            .into_iter()
            .filter_map(|d| {
                if d.price_scale == scale {
                    return Some(d);
                }
                let rescaled = d
                    .rescaled(scale)
                    .ok_or_else(|| "its prices do not fit the new tick size".to_owned())
                    .and_then(|r| validate(&r).map(|()| r));
                rescaled
                    .inspect_err(|e| {
                        eprintln!(
                            "drawing {} cannot move from price scale {} to {scale}: {e}",
                            d.id, d.price_scale
                        );
                    })
                    .ok()
            })
            .collect())
    }

    /// Validates and stores a drawing. The engine sets `price_scale` to the instrument's
    /// and `updated_at` to now; the saved drawing is returned.
    pub async fn save_drawing(&self, mut d: Drawing) -> Result<Drawing, EngineError> {
        let key = d.instrument.clone();
        d.price_scale = blocking(&self.shared.store, move |s| s.instrument(&key))
            .await?
            .ok_or_else(|| EngineError::UnknownInstrument(d.instrument.clone()))?
            .price_scale;
        d.updated_at = self.now_ms();
        validate(&d).map_err(EngineError::Drawing)?;
        let saved = d.clone();
        blocking(&self.shared.store, move |s| s.upsert_drawing(&saved)).await?;
        Ok(d)
    }

    pub async fn delete_drawing(&self, id: &str) -> Result<(), EngineError> {
        validate_id(id).map_err(EngineError::Drawing)?;
        let id = id.to_owned();
        blocking(&self.shared.store, move |s| s.delete_drawing(&id)).await
    }

    /// The outcome of each position over the cached candles of `tf`, in the order given.
    /// Bars that are not cached do not count, so such a position may show as open.
    pub async fn position_outcomes(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        positions: Vec<(String, PositionBody)>,
    ) -> Result<Vec<(String, Outcome)>, EngineError> {
        if positions.len() > MAX_DRAWINGS_PER_INSTRUMENT {
            return Err(EngineError::Drawing(format!(
                "at most {MAX_DRAWINGS_PER_INSTRUMENT} positions per request, not {}",
                positions.len()
            )));
        }
        for (drawing_id, p) in &positions {
            p.validate()
                .map_err(|e| EngineError::Drawing(format!("position {drawing_id}: {e}")))?;
        }
        let id = id.clone();
        blocking(&self.shared.store, move |s| {
            positions
                .into_iter()
                .map(|(drawing_id, p)| {
                    let candles = s.candles_between(&id, tf, p.entry.t, p.end_t)?;
                    Ok((drawing_id, p.resolve(&candles)))
                })
                .collect()
        })
        .await
    }
}
