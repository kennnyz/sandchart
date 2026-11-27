//! Cache-then-fetch chart loading.

use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};

use crate::{Engine, EngineError, PAGE, blocking};

/// Fallback candle length for calendar months when judging staleness.
const MONTH_MS: i64 = 31 * 24 * 60 * 60 * 1000;

/// One page of candles for a chart, ascending by `open_time`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartPage {
    pub instrument: Instrument,
    pub candles: Vec<Candle>,
    /// True when nothing older exists, so scrolling further back is pointless.
    pub at_history_start: bool,
    /// Set when the provider failed and the cache was served instead.
    pub warning: Option<String>,
}

struct CacheView {
    candles: Vec<Candle>,
    newest: Option<i64>,
    history_start: Option<i64>,
}

/// Nothing older than `candles[0]` exists when the stored marker reaches it.
fn reached_start(candles: &[Candle], history_start: Option<i64>) -> bool {
    history_start.is_some_and(|h| candles.first().is_none_or(|c| c.open_time <= h))
}

impl Engine {
    /// Loads up to 1000 candles ending before `before` (the newest ones when `None`).
    ///
    /// Served from the cache when possible; otherwise one page is fetched, stored and
    /// re-read. A provider failure returns the cached candles with `warning` set, or the
    /// error when the cache is empty.
    pub async fn load_chart(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        before: Option<i64>,
    ) -> Result<ChartPage, EngineError> {
        let store = &self.shared.store;
        let key = id.clone();
        let instrument = blocking(store, move |s| s.instrument(&key))
            .await?
            .ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        let cache = self.read_cache(id, tf, before).await?;

        let Some(provider) = self.provider(&id.source) else {
            // Cache-only source (CSV): a short page means we are at the oldest candle.
            let at_history_start = cache.candles.len() < usize::from(PAGE);
            return Ok(ChartPage {
                instrument,
                candles: cache.candles,
                at_history_start,
                warning: None,
            });
        };

        let need_fetch = match before {
            None => cache.newest.is_none_or(|n| self.is_stale(n, tf)),
            Some(_) => {
                cache.candles.len() < usize::from(PAGE)
                    && !reached_start(&cache.candles, cache.history_start)
            }
        };

        let mut warning = None;
        if need_fetch {
            match provider.history(&instrument, tf, before, PAGE).await {
                Ok(page) => {
                    self.shared.note_ok();
                    let key = id.clone();
                    let oldest_cached = cache.candles.first().map(|c| c.open_time);
                    blocking(store, move |s| {
                        if !page.is_empty() {
                            s.upsert_candles(&key, tf, &page)
                        } else if let Some(t) = before {
                            // Nothing older than `t` exists at all.
                            s.set_history_start(&key, tf, oldest_cached.unwrap_or(t))
                        } else {
                            Ok(())
                        }
                    })
                    .await?;
                }
                Err(e) => {
                    self.shared.note_error(&e);
                    if cache.candles.is_empty() {
                        return Err(e.into());
                    }
                    warning = Some(e.to_string());
                }
            }
        }

        let fresh = if need_fetch && warning.is_none() {
            self.read_cache(id, tf, before).await?
        } else {
            cache
        };
        Ok(ChartPage {
            instrument,
            at_history_start: reached_start(&fresh.candles, fresh.history_start),
            candles: fresh.candles,
            warning,
        })
    }

    async fn read_cache(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        before: Option<i64>,
    ) -> Result<CacheView, EngineError> {
        let id = id.clone();
        blocking(&self.shared.store, move |s| {
            Ok(CacheView {
                candles: s.candles_before(&id, tf, before, usize::from(PAGE))?,
                newest: s.newest_open_time(&id, tf)?,
                history_start: s.history_start(&id, tf)?,
            })
        })
        .await
    }

    /// The newest cached candle is older than one candle length, so a newer one exists.
    fn is_stale(&self, newest: i64, tf: Timeframe) -> bool {
        newest.saturating_add(tf.fixed_ms().unwrap_or(MONTH_MS)) <= self.now_ms()
    }
}
