//! Live candle subscription with gap backfill after reconnects.

use std::sync::Arc;

use futures::StreamExt;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{LiveCandle, Provider};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::{Engine, EngineError, PAGE, Shared, blocking};

/// Upper bound on REST pages fetched to close one gap (20 000 candles).
const MAX_BACKFILL_PAGES: usize = 20;

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

async fn run(
    shared: Shared,
    provider: Arc<dyn Provider>,
    inst: Instrument,
    tf: Timeframe,
    tx: mpsc::Sender<LiveEvent>,
) {
    let mut stream = provider.live(&inst, tf);
    let mut gap = false;
    while let Some(item) = stream.next().await {
        let event = match item {
            Err(_) => {
                shared
                    .connection
                    .send_replace(ConnectionState::Reconnecting);
                if gap {
                    continue; // already reported; the backfill happens once, on the next Ok
                }
                gap = true;
                LiveEvent::Disconnected
            }
            Ok(live) => {
                shared.connection.send_replace(ConnectionState::Connected);
                if gap {
                    match backfill(&shared, provider.as_ref(), &inst, tf).await {
                        Ok(missed) => {
                            gap = false;
                            if !missed.is_empty()
                                && tx.send(LiveEvent::Backfilled(missed)).await.is_err()
                            {
                                return;
                            }
                        }
                        // Keep `gap` set so the next good message retries.
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

/// Fetches and stores every candle newer than the newest stored one.
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
    let mut missed: Vec<Candle> = Vec::new();
    let mut end_before = None;
    for _ in 0..MAX_BACKFILL_PAGES {
        let page = provider.history(inst, tf, end_before, PAGE).await?;
        let first = page.first().map(|c| c.open_time);
        let full = page.len() >= usize::from(PAGE);
        let mut newer: Vec<Candle> = page.into_iter().filter(|c| c.open_time > newest).collect();
        newer.append(&mut missed);
        missed = newer;
        match first {
            Some(f) if full && f > newest => end_before = Some(f),
            _ => break,
        }
    }
    shared.note_ok();
    let (id, to_store) = (inst.id.clone(), missed.clone());
    blocking(&shared.store, move |s| s.upsert_candles(&id, tf, &to_store)).await?;
    Ok(missed)
}
