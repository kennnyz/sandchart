//! Cache-then-fetch chart loading.

use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{Provider, ProviderError};

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
    pub warning: Option<ProviderError>,
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

/// Candles fetched for one request; `reset` means the old cached series must be dropped first.
pub(crate) struct Fetched {
    pub candles: Vec<Candle>,
    pub reset: bool,
}

/// Pages walked back from now to reach the cache before the old series is given up.
pub(crate) const MAX_CATCH_UP_PAGES: usize = 10;

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
            None => cache
                .newest
                .is_none_or(|n| self.refresh_newest || self.is_stale(n, tf)),
            Some(_) => {
                cache.candles.len() < usize::from(PAGE)
                    && !reached_start(&cache.candles, cache.history_start)
            }
        };

        let mut warning = None;
        if need_fetch {
            let fetched = match (before, cache.newest) {
                (None, Some(newest)) => {
                    fetch_catch_up(provider.as_ref(), &instrument, tf, newest).await
                }
                _ => provider
                    .history(&instrument, tf, before, PAGE)
                    .await
                    .map(|page| Fetched {
                        candles: page,
                        reset: false,
                    }),
            };
            match fetched {
                Ok(Fetched { candles, reset }) => {
                    self.shared.note_ok();
                    let key = id.clone();
                    let oldest_cached = cache.candles.first().map(|c| c.open_time);
                    let writes_candles = reset || !candles.is_empty();
                    let written = blocking(store, move |s| {
                        if reset {
                            s.delete_series(&key, tf)?;
                        }
                        if !candles.is_empty() {
                            s.upsert_candles(&key, tf, &candles)
                        } else if let Some(t) = before {
                            // Nothing older than `t` exists at all.
                            s.set_history_start(&key, tf, oldest_cached.unwrap_or(t))
                        } else {
                            Ok(())
                        }
                    })
                    .await;
                    if writes_candles {
                        self.shared.drop_bars(id, tf);
                    }
                    written?;
                }
                Err(e) => {
                    self.shared.note_error(&e);
                    if cache.candles.is_empty() {
                        return Err(e.into());
                    }
                    warning = Some(e);
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

/// Walks pages back from now until one reaches `newest` (the newest cached candle), so
/// the stored series stays contiguous. If `MAX_CATCH_UP_PAGES` pages do not reach it,
/// the old series cannot be joined and is replaced by the fetched pages. Nothing is
/// returned for storing when any request fails.
pub(crate) async fn fetch_catch_up(
    provider: &dyn Provider,
    inst: &Instrument,
    tf: Timeframe,
    newest: i64,
) -> Result<Fetched, ProviderError> {
    let mut candles: Vec<Candle> = Vec::new();
    let mut end_before = None;
    for _ in 0..MAX_CATCH_UP_PAGES {
        let mut page = provider.history(inst, tf, end_before, PAGE).await?;
        let first = page.first().map(|c| c.open_time);
        let full = page.len() >= usize::from(PAGE);
        page.append(&mut candles);
        candles = page;
        match first {
            // The page overlaps the cache, or the exchange has nothing older to give.
            Some(f) if f > newest && full => end_before = Some(f),
            _ => {
                return Ok(Fetched {
                    candles,
                    reset: false,
                });
            }
        }
    }
    Ok(Fetched {
        candles,
        reset: true,
    })
}

/// The closed `tf` candles with `from <= open_time` that close at or before `to`, at most
/// `limit` of them from `from` on, ascending: pages walked back from the end of that window
/// until one reaches `from`. Kept in memory: the cached series stays contiguous only when
/// pages join it, which a window in the middle of the history does not.
pub(crate) async fn fetch_window(
    provider: &dyn Provider,
    inst: &Instrument,
    tf: Timeframe,
    from: i64,
    to: i64,
    limit: usize,
) -> Result<Vec<Candle>, ProviderError> {
    let end = match tf.fixed_ms() {
        Some(ms) => to.min(from.saturating_add(ms.saturating_mul(limit as i64))),
        None => to,
    };
    let mut out: Vec<Candle> = Vec::new();
    let mut before = end;
    // Never more pages than the window can hold, plus one for a partial first page.
    for _ in 0..=limit / usize::from(PAGE) + 1 {
        let mut page = provider.history(inst, tf, Some(before), PAGE).await?;
        let Some(first) = page.first().map(|c| c.open_time) else {
            break;
        };
        let short = page.len() < usize::from(PAGE);
        page.append(&mut out);
        out = page;
        if first <= from || short || first >= before {
            break;
        }
        before = first;
    }
    out.retain(|c| c.open_time >= from && tf.close_time(c.open_time) <= to);
    out.dedup_by_key(|c| c.open_time);
    out.truncate(limit);
    Ok(out)
}
