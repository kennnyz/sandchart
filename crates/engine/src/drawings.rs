//! Drawings: list, save and delete, and the outcome of position drawings.

use sandchart_core::drawing::{validate, validate_id};
use sandchart_core::{Drawing, InstrumentId, Outcome, PositionBody, Timeframe};
use sandchart_store::MAX_DRAWINGS_PER_INSTRUMENT;

use crate::{Engine, EngineError, blocking, spawn_blocking};

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
                let (id, from) = (d.id.clone(), d.price_scale);
                at_scale(d, scale)
                    .inspect_err(|e| {
                        eprintln!(
                            "drawing {id} cannot move from price scale {from} to {scale}: {e}"
                        );
                    })
                    .ok()
            })
            .collect())
    }

    /// One stored drawing by id, as stored (not rescaled); `None` when there is none.
    pub async fn drawing(&self, id: &str) -> Result<Option<Drawing>, EngineError> {
        let id = id.to_owned();
        blocking(&self.shared.store, move |s| s.drawing(&id)).await
    }

    /// Validates and stores a drawing whose prices are ticks at `d.price_scale`. When the
    /// instrument's scale has changed since (the UI loaded it before), the ticks are
    /// rescaled to the current one; a drawing that no longer fits or breaks a rule after
    /// rounding is rejected. `updated_at` is set to now; the saved drawing is returned. Alerts
    /// that can no longer follow it (it is no longer a line) are deleted with it.
    pub async fn save_drawing(&self, d: Drawing) -> Result<Drawing, EngineError> {
        let mut saved = self.save_drawings(vec![d]).await?;
        saved
            .pop()
            .ok_or_else(|| EngineError::Drawing("nothing was saved".into()))
    }

    /// `save_drawing` for several drawings as one write: every one is checked (and
    /// rescaled) first, then all are stored in one transaction or none is. The alerts are
    /// re-armed once. Returns them as saved, in the order given.
    pub async fn save_drawings(&self, list: Vec<Drawing>) -> Result<Vec<Drawing>, EngineError> {
        check_batch(list.len())?;
        if list.is_empty() {
            return Ok(list);
        }
        let mut keys: Vec<InstrumentId> = Vec::new();
        for d in &list {
            if !keys.contains(&d.instrument) {
                keys.push(d.instrument.clone());
            }
        }
        let scales = blocking(&self.shared.store, move |s| {
            keys.into_iter()
                .map(|k| Ok((s.instrument(&k)?.map(|i| i.price_scale), k)))
                .collect::<Result<Vec<_>, _>>()
        })
        .await?;
        let now = self.now_ms();
        let list = list
            .into_iter()
            .map(|mut d| {
                let scale = scales
                    .iter()
                    .find(|(_, k)| *k == d.instrument)
                    .and_then(|(scale, _)| *scale)
                    .ok_or_else(|| EngineError::UnknownInstrument(d.instrument.clone()))?;
                d.updated_at = now;
                if d.price_scale == scale {
                    validate(&d).map_err(EngineError::Drawing)?;
                    Ok(d)
                } else {
                    at_scale(d, scale)
                        .map_err(|e| EngineError::Drawing(format!("at price scale {scale}: {e}")))
                }
            })
            .collect::<Result<Vec<_>, EngineError>>()?;
        let rows = list.clone();
        let removed = blocking(&self.shared.store, move |s| s.save_drawings(&rows)).await?;
        self.drawings_saved(&list, removed > 0).await?;
        Ok(list)
    }

    /// Removes a drawing and its alerts; an unknown id is not an error.
    pub async fn delete_drawing(&self, id: &str) -> Result<(), EngineError> {
        self.delete_drawings(vec![id.to_owned()]).await
    }

    /// Removes drawings and their alerts in one write; every id is checked first, and
    /// unknown ones are not an error.
    pub async fn delete_drawings(&self, ids: Vec<String>) -> Result<(), EngineError> {
        check_batch(ids.len())?;
        for id in &ids {
            validate_id(id).map_err(EngineError::Drawing)?;
        }
        if ids.is_empty() {
            return Ok(());
        }
        self.delete_drawings_and_alerts(ids).await
    }

    /// The outcome of each position over the cached candles of `tf`, in the order given.
    /// Bars that are not cached do not count, so such a position may show as open. While a
    /// replay of `(id, tf)` is open, only its revealed bars count.
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
        // In a replay only the revealed bars count, so no outcome gives a later bar away.
        // They are resolved off the replay lock and off the async threads.
        if let Some(r) = self.shared.replay_bars(id, tf)? {
            return spawn_blocking(move || {
                let bars = r.revealed()?;
                Ok(positions
                    .into_iter()
                    .map(|(drawing_id, p)| {
                        let start = bars.partition_point(|c| c.open_time <= p.entry.t);
                        (drawing_id, p.resolve_iter(bars[start..].iter().copied()))
                    })
                    .collect())
            })
            .await;
        }
        let id = id.clone();
        blocking(&self.shared.store, move |s| {
            positions
                .into_iter()
                .map(|(drawing_id, p)| {
                    // Bars are read only up to the one that decides.
                    let outcome = s.scan_candles_between(&id, tf, p.entry.t, p.end_t, |it| {
                        p.resolve_iter(it)
                    })?;
                    Ok((drawing_id, outcome))
                })
                .collect()
        })
        .await
    }
}

/// A batch of drawings is at most what one pair can hold.
fn check_batch(n: usize) -> Result<(), EngineError> {
    if n > MAX_DRAWINGS_PER_INSTRUMENT {
        return Err(EngineError::Drawing(format!(
            "at most {MAX_DRAWINGS_PER_INSTRUMENT} drawings per request, not {n}"
        )));
    }
    Ok(())
}

/// `d` with its prices at `scale`, validated after any rounding.
fn at_scale(d: Drawing, scale: u8) -> Result<Drawing, String> {
    if d.price_scale == scale {
        return Ok(d);
    }
    let r = d
        .rescaled(scale)
        .ok_or_else(|| "its prices do not fit the new tick size".to_owned())?;
    validate(&r)?;
    Ok(r)
}
