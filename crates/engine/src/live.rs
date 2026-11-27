//! Live candle subscription with gap backfill after reconnects.

use std::sync::Arc;

use futures::StreamExt;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{LiveCandle, Provider};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::chart::{Fetched, fetch_catch_up};
use crate::{Engine, EngineError, Shared, blocking};

const EVENT_BUFFER: usize = 256;

/// Health of the connection to the data sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connected,
    Reconnecting,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveEvent {
    /// A candle update; closed ones are already stored.
    Candle(LiveCandle),
    /// Candles missed while the stream was down, ascending and already stored.
    Backfilled(Vec<Candle>),
    /// The stream reported an error; the provider reconnects by itself.
    Disconnected,
}

/// A running subscription. Dropping it aborts the background task and the provider stream.
pub struct LiveHandle {
    events: mpsc::Receiver<LiveEvent>,
    task: JoinHandle<()>,
}

impl LiveHandle {
    /// The event queue. Borrowed mutably, so there is exactly one consumer.
    pub fn receiver(&mut self) -> &mut mpsc::Receiver<LiveEvent> {
        &mut self.events
    }
}

impl Drop for LiveHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Engine {
    /// Subscribes to live candles of `id`. Must be called inside a tokio runtime.
    ///
    /// Closed candles are stored. Any stream error marks the connection as reconnecting;
    /// on the next good message the gap is filled over REST and reported once as
    /// [`LiveEvent::Backfilled`], however many errors came in between.
    pub fn subscribe_live(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<LiveHandle, EngineError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| EngineError::NoRuntime)?;
        let provider = self
            .provider(&id.source)
            .ok_or_else(|| EngineError::UnknownSource(id.source.clone()))?;
        let instrument = crate::lock(&self.shared.store)
            .instrument(id)?
            .ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        let (tx, events) = mpsc::channel(EVENT_BUFFER);
        let task = runtime.spawn(run(self.shared.clone(), provider, instrument, tf, tx));
        Ok(LiveHandle { events, task })
    }
}

/// Counts this stream's gap in the shared connection state; releases it on drop, so an
/// aborted task cannot leave the state stuck on `Reconnecting`.
struct GapGuard {
    shared: Shared,
    open: bool,
}

impl GapGuard {
    fn open(&mut self) {
        if !self.open {
            self.open = true;
            self.shared.gap_opened();
        }
    }

    fn close(&mut self) {
        if self.open {
            self.open = false;
            self.shared.gap_closed();
        }
    }
}

impl Drop for GapGuard {
    fn drop(&mut self) {
        self.close();
    }
}

async fn run(
    shared: Shared,
    provider: Arc<dyn Provider>,
    inst: Instrument,
    tf: Timeframe,
    tx: mpsc::Sender<LiveEvent>,
) {
    let mut stream = provider.live(&inst, tf);
    let mut gap = GapGuard {
        shared: shared.clone(),
        open: false,
    };
    while let Some(item) = stream.next().await {
        let event = match item {
            Err(_) => {
                if gap.open {
                    continue; // already reported; the backfill happens once, on the next Ok
                }
                gap.open();
                LiveEvent::Disconnected
            }
            Ok(live) => {
                if gap.open {
                    match backfill(&shared, provider.as_ref(), &inst, tf).await {
                        Ok(missed) => {
                            gap.close();
                            if !missed.is_empty()
                                && tx.send(LiveEvent::Backfilled(missed)).await.is_err()
                            {
                                return;
                            }
                        }
                        // Keep the gap open so the next good message retries.
                        Err(EngineError::Provider(e)) => shared.note_error(&e),
                        Err(_) => {}
                    }
                }
                if live.closed {
                    let (id, candle) = (inst.id.clone(), live.candle);
                    if blocking(&shared.store, move |s| s.upsert_candles(&id, tf, &[candle]))
                        .await
                        .is_err()
                    {
                        continue;
                    }
                }
                LiveEvent::Candle(live)
            }
        };
        if tx.send(event).await.is_err() {
            return;
        }
    }
}

/// Closes the gap since the newest stored candle with the same rule as `load_chart`:
/// contiguous pages, or a reset of the series when the cap is hit. Returns the new
/// candles (the whole fetched series after a reset).
async fn backfill(
    shared: &Shared,
    provider: &dyn Provider,
    inst: &Instrument,
    tf: Timeframe,
) -> Result<Vec<Candle>, EngineError> {
    let id = inst.id.clone();
    let Some(newest) = blocking(&shared.store, move |s| s.newest_open_time(&id, tf)).await? else {
        return Ok(vec![]); // nothing cached, so there is no gap to fill
    };
    let Fetched { candles, reset } = fetch_catch_up(provider, inst, tf, newest).await?;
    shared.note_ok();
    let missed: Vec<Candle> = if reset {
        candles.clone()
    } else {
        candles
            .iter()
            .copied()
            .filter(|c| c.open_time > newest)
            .collect()
    };
    let (id, to_store) = (inst.id.clone(), candles);
    blocking(&shared.store, move |s| {
        if reset {
            s.delete_series(&id, tf)?;
        }
        s.upsert_candles(&id, tf, &to_store)
    })
    .await?;
    Ok(missed)
}
