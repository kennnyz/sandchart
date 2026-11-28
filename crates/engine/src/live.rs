//! Live candle subscription with gap backfill after reconnects.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_data::{LiveCandle, Provider, ProviderError};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::alerts::{StreamGuard, record_fired};
use crate::chart::{Fetched, fetch_catch_up};
use crate::{Engine, EngineError, Shared, blocking};

const EVENT_BUFFER: usize = 256;

/// Longest wait between two failed backfill attempts (unless the exchange asks for more).
const MAX_BACKFILL_DELAY: Duration = Duration::from_secs(30);

/// Health of the connection to the data sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    /// Nothing has answered yet since the engine started.
    Connecting,
    Connected,
    Reconnecting,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveEvent {
    /// A candle update; closed ones are already stored (unless the write failed).
    Candle(LiveCandle),
    /// Candles missed while the stream was down, ascending and already stored. With
    /// `reset` the cached series was replaced, so these candles replace the chart.
    Backfilled { candles: Vec<Candle>, reset: bool },
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
    ///
    /// It also feeds the alerts of `id` (ADR 0007) and counts toward [`MAX_LIVE_STREAMS`],
    /// together with the streams the engine opens for alerts.
    ///
    /// [`MAX_LIVE_STREAMS`]: crate::MAX_LIVE_STREAMS
    pub fn subscribe_live(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<LiveHandle, EngineError> {
        self.open_live(id, tf, false)
    }

    /// `subscribe_live`; `own` marks a stream the engine opened for alerts.
    pub(crate) fn open_live(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        own: bool,
    ) -> Result<LiveHandle, EngineError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| EngineError::NoRuntime)?;
        let provider = self
            .provider(&id.source)
            .ok_or_else(|| EngineError::UnknownSource(id.source.clone()))?;
        let instrument = crate::lock(&self.shared.store)
            .instrument(id)?
            .ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        let guard = self.shared.alerts.open_stream(id, own)?;
        let (tx, events) = mpsc::channel(EVENT_BUFFER);
        let task = runtime.spawn(run(
            self.shared.clone(),
            provider,
            instrument,
            tf,
            tx,
            guard,
            own,
        ));
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

/// When the next backfill attempt may run: 1, 2, 4 ... 30 s after consecutive failures,
/// or the exchange's `Retry-After` when it rate-limits us.
#[derive(Default)]
struct Backoff {
    failures: u32,
    next: Option<Instant>,
}

impl Backoff {
    fn due(&self) -> bool {
        self.next.is_none_or(|t| Instant::now() >= t)
    }

    fn failed(&mut self, err: &EngineError) {
        let delay = match err {
            EngineError::Provider(ProviderError::RateLimited { retry_after_s }) => {
                Duration::from_secs(*retry_after_s)
            }
            _ => Duration::from_secs(1 << self.failures.min(5)).min(MAX_BACKFILL_DELAY),
        };
        self.failures = self.failures.saturating_add(1);
        self.next = Some(Instant::now() + delay);
    }
}

/// Runs one live stream. A stream the engine opened for alerts (`own`) only evaluates
/// them: nothing reads its candles, so it stores none, feeds no indicator bars, sends no
/// events and fills no gaps (the alert rule compares the update after a gap with the last
/// one before, which is what a gap needs).
async fn run(
    shared: Shared,
    provider: Arc<dyn Provider>,
    inst: Instrument,
    tf: Timeframe,
    tx: mpsc::Sender<LiveEvent>,
    stream_slot: StreamGuard,
    own: bool,
) {
    let mut stream = provider.live(&inst, tf);
    let mut gap = GapGuard {
        shared: shared.clone(),
        open: false,
    };
    let mut backoff = Backoff::default();
    while let Some(item) = stream.next().await {
        if own {
            if let Ok(live) = item {
                shared.note_ok();
                evaluate(&shared, &inst.id, stream_slot.key, &live.candle);
            }
            continue;
        }
        let event = match item {
            Err(_) => {
                if gap.open {
                    continue; // already reported; the backfill happens once, on the next Ok
                }
                gap.open();
                LiveEvent::Disconnected
            }
            Ok(live) => {
                if gap.open && backoff.due() {
                    match backfill(&shared, provider.as_ref(), &inst, tf).await {
                        Ok(Fetched { candles, reset }) => {
                            gap.close();
                            backoff = Backoff::default();
                            if !candles.is_empty()
                                && !shared.replaying(&inst.id)
                                && tx
                                    .send(LiveEvent::Backfilled { candles, reset })
                                    .await
                                    .is_err()
                            {
                                return;
                            }
                        }
                        // Keep the gap open; a good message after the delay retries.
                        Err(e) => {
                            if let EngineError::Provider(p) = &e {
                                shared.note_error(p);
                            }
                            backoff.failed(&e);
                        }
                    }
                }
                // A live message proves the network is up. While a gap is open the
                // backfill result decides instead, so a failing REST stays visible.
                if !gap.open {
                    shared.note_ok();
                }
                if live.closed {
                    let (id, candle) = (inst.id.clone(), live.candle);
                    // The cache misses this candle (a later page load fetches it again), but
                    // the price still counts for the chart and the alerts.
                    if let Err(e) =
                        blocking(&shared.store, move |s| s.upsert_candles(&id, tf, &[candle])).await
                    {
                        eprintln!(
                            "a closed candle of {}/{} cannot be stored: {e}",
                            inst.id.source, inst.id.symbol
                        );
                    }
                }
                // Forming candles reach the indicator bars too, in memory only.
                shared.live_bar(&inst, tf, &live.candle);
                evaluate(&shared, &inst.id, stream_slot.key, &live.candle);
                LiveEvent::Candle(live)
            }
        };
        // Closed candles are stored above all the same; the UI reloads after the replay.
        if shared.replaying(&inst.id) {
            continue;
        }
        if tx.send(event).await.is_err() {
            return;
        }
    }
}

/// Checks the alerts of `id` against an update of stream `key` and stores the ones that
/// fired. A replayed pair's alerts wait: the first update after the replay is compared with
/// the last one before it.
fn evaluate(shared: &Shared, id: &InstrumentId, key: u64, candle: &Candle) {
    if shared.replaying(id) {
        return;
    }
    let fired = shared.alerts.evaluate(id, key, candle, (shared.clock)());
    if !fired.is_empty() {
        tokio::spawn(record_fired(shared.clone(), fired));
    }
}

/// Closes the gap since the newest stored candle with the same rule as `load_chart`:
/// contiguous pages, or a reset of the series when the cap is hit. Returns the candles
/// from the newest stored one on (it may have been stored while still forming, so its
/// final values are new), or the whole fetched series after a reset.
async fn backfill(
    shared: &Shared,
    provider: &dyn Provider,
    inst: &Instrument,
    tf: Timeframe,
) -> Result<Fetched, EngineError> {
    let id = inst.id.clone();
    let Some(newest) = blocking(&shared.store, move |s| s.newest_open_time(&id, tf)).await? else {
        // Nothing cached, so there is no gap to fill.
        return Ok(Fetched {
            candles: vec![],
            reset: false,
        });
    };
    let Fetched { candles, reset } = fetch_catch_up(provider, inst, tf, newest).await?;
    shared.note_ok();
    let missed: Vec<Candle> = if reset {
        candles.clone()
    } else {
        candles
            .iter()
            .copied()
            .filter(|c| c.open_time >= newest)
            .collect()
    };
    let (id, to_store) = (inst.id.clone(), candles);
    let written = blocking(&shared.store, move |s| {
        if reset {
            s.delete_series(&id, tf)?;
        }
        s.upsert_candles(&id, tf, &to_store)
    })
    .await;
    // Dropped even on an error: the series may have been reset before it.
    shared.drop_bars(&inst.id, tf);
    written?;
    Ok(Fetched {
        candles: missed,
        reset,
    })
}
