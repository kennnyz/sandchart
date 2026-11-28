//! Alerts (ADR 0007): stored in SQLite, armed in memory, evaluated on every live update of
//! the stream that feeds their pair. A pair with an active alert always has a stream: the
//! chart's when it shows that pair, else one the engine opens itself.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use sandchart_core::alert::{Alert, AlertKind, Level, Update, fires, validate};
use sandchart_core::drawing::validate_id;
use sandchart_core::{Candle, InstrumentId, Timeframe};
use sandchart_store::{MAX_ALERT_PAIRS, Store, StoreError};
use tokio::sync::{Notify, broadcast};
use tokio::task::JoinHandle;

use crate::{Engine, EngineError, blocking, lock};

/// Most live streams at once, the chart's and the alerts' together.
pub const MAX_LIVE_STREAMS: usize = 32;
// The chart must always find a stream, even while one is being replaced by the next.
const _: () = assert!(MAX_ALERT_PAIRS + 2 <= MAX_LIVE_STREAMS);

/// The timeframe of the streams the engine opens for alerts: the shortest, so a new high
/// or low of the bar is close to the moment it happened.
const ALERT_TF: Timeframe = Timeframe::M1;

/// How soon a stream that could not be opened is tried again.
const RETRY: Duration = Duration::from_secs(5);

const EVENT_BUFFER: usize = 64;

/// What the alert service reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertEvent {
    /// An alert fired; it is stored as inactive with when and at what price.
    Fired(Alert),
    /// Alerts were added, changed or removed (also by deleting a drawing).
    Changed,
}

/// An active alert with the level it watches, at the instrument's current price scale.
struct Armed {
    alert: Alert,
    level: Level,
    /// Engine time it was armed in memory: an update from before cannot fire it.
    armed_at: i64,
}

/// A live stream of a pair; `own` when the engine opened it for alerts.
#[derive(Clone, Copy)]
struct Stream {
    key: u64,
    own: bool,
}

#[derive(Default)]
struct State {
    armed: HashMap<InstrumentId, Vec<Armed>>,
    /// The last update of each armed pair and the stream it came from.
    last: HashMap<InstrumentId, (u64, Update)>,
    streams: HashMap<InstrumentId, Vec<Stream>>,
    /// The streams the engine opened, by pair: a task that owns the `LiveHandle`.
    own: HashMap<InstrumentId, JoinHandle<()>>,
    /// Generation of the armed set that is applied (see `reload`).
    applied: u64,
    /// Running streams of every pair.
    open: usize,
}

impl State {
    /// The stream whose updates count for `id`: the chart's first, else the engine's own.
    fn feeder(&self, id: &InstrumentId) -> Option<u64> {
        let streams = self.streams.get(id)?;
        streams
            .iter()
            .find(|s| !s.own)
            .or_else(|| streams.first())
            .map(|s| s.key)
    }
}

pub(crate) struct Hub {
    state: Mutex<State>,
    /// Wakes the service loop: a stream closed, or the armed set changed.
    wake: Notify,
    events: broadcast::Sender<AlertEvent>,
    next_key: AtomicU64,
    reloads: AtomicU64,
}

impl Default for Hub {
    fn default() -> Self {
        Hub {
            state: Mutex::default(),
            wake: Notify::new(),
            events: broadcast::channel(EVENT_BUFFER).0,
            next_key: AtomicU64::new(1),
            reloads: AtomicU64::new(0),
        }
    }
}

/// Registers a running stream for its pair and releases it on drop, so an aborted task
/// frees its slot and lets the service open a replacement.
pub(crate) struct StreamGuard {
    hub: Arc<Hub>,
    id: InstrumentId,
    pub key: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let mut st = self.hub.state();
        if let Some(v) = st.streams.get_mut(&self.id) {
            v.retain(|s| s.key != self.key);
            if v.is_empty() {
                st.streams.remove(&self.id);
            }
        }
        st.open -= 1;
        drop(st);
        self.hub.wake.notify_one();
    }
}

impl Hub {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes a slot under [`MAX_LIVE_STREAMS`] for a stream of `id`.
    pub(crate) fn open_stream(
        self: &Arc<Self>,
        id: &InstrumentId,
        own: bool,
    ) -> Result<StreamGuard, EngineError> {
        let mut st = self.state();
        if st.open >= MAX_LIVE_STREAMS {
            return Err(EngineError::Alert(format!(
                "too many live streams (max {MAX_LIVE_STREAMS})"
            )));
        }
        st.open += 1;
        let key = self.next_key.fetch_add(1, Ordering::Relaxed);
        st.streams
            .entry(id.clone())
            .or_default()
            .push(Stream { key, own });
        drop(st);
        if !own {
            self.wake.notify_one(); // the engine's own stream of this pair can go
        }
        Ok(StreamGuard {
            hub: Arc::clone(self),
            id: id.clone(),
            key,
        })
    }

    /// Checks the armed alerts of `id` against a live update of stream `key` at engine time
    /// `now`; the ones that fire are disarmed and returned with their trigger filled in.
    pub(crate) fn evaluate(
        &self,
        id: &InstrumentId,
        key: u64,
        candle: &Candle,
        now: i64,
    ) -> Vec<Alert> {
        let mut st = self.state();
        if !st.armed.contains_key(id) || st.feeder(id) != Some(key) {
            return Vec::new();
        }
        let cur = Update {
            t: now,
            open_time: candle.open_time,
            high: candle.high,
            low: candle.low,
            close: candle.close,
        };
        let Some((prev_key, prev)) = st.last.insert(id.clone(), (key, cur)) else {
            return Vec::new();
        };
        let mut fired = Vec::new();
        let Some(armed) = st.armed.get_mut(id) else {
            return fired;
        };
        armed.retain(|a| {
            if prev.t < a.armed_at {
                return true;
            }
            match fires(a.alert.direction, &a.level, &prev, &cur, prev_key == key) {
                Some(price) => {
                    fired.push(Alert {
                        active: false,
                        triggered_at: Some(now),
                        triggered_price: Some(price),
                        ..a.alert.clone()
                    });
                    false
                }
                None => true,
            }
        });
        if armed.is_empty() {
            st.armed.remove(id);
            st.last.remove(id);
            self.wake.notify_one(); // its own stream can go
        }
        fired
    }

    pub(crate) fn events(&self) -> broadcast::Receiver<AlertEvent> {
        self.events.subscribe()
    }

    fn send(&self, e: AlertEvent) {
        // No receiver (no UI yet) is fine: the store has the state.
        let _ = self.events.send(e);
    }

    /// Whether a drawing has an armed alert, so a change of it must re-arm.
    fn follows(&self, drawing_id: &str) -> bool {
        self.state().armed.values().flatten().any(
            |a| matches!(&a.alert.kind, AlertKind::Drawing { drawing_id: d } if d == drawing_id),
        )
    }

    /// Re-reads the active alerts from the store and arms them. Each call takes a
    /// generation after the write it follows; only a newer one replaces the armed set,
    /// so two reloads that finish out of order cannot leave the older one armed.
    fn reload(&self, store: &Mutex<Store>, now: i64) -> Result<(), StoreError> {
        let generation = self.reloads.fetch_add(1, Ordering::AcqRel) + 1;
        let fresh = read_armed(&lock(store))?;
        let mut st = self.state();
        if generation <= st.applied {
            return Ok(());
        }
        st.applied = generation;
        let old: HashMap<String, (i64, i64)> = st
            .armed
            .values()
            .flatten()
            .map(|a| (a.alert.id.clone(), (a.alert.created_at, a.armed_at)))
            .collect();
        let mut armed: HashMap<InstrumentId, Vec<Armed>> = HashMap::new();
        for (alert, level) in fresh {
            let armed_at = match old.get(&alert.id) {
                Some(&(created, at)) if created == alert.created_at => at,
                _ => now,
            };
            armed
                .entry(alert.instrument.clone())
                .or_default()
                .push(Armed {
                    alert,
                    level,
                    armed_at,
                });
        }
        st.last.retain(|id, _| armed.contains_key(id));
        st.armed = armed;
        drop(st);
        self.wake.notify_one();
        Ok(())
    }
}

/// The active alerts with their levels at their instrument's current price scale. An alert
/// whose instrument, drawing or price no longer works is left out and logged.
fn read_armed(s: &Store) -> Result<Vec<(Alert, Level)>, StoreError> {
    let mut out = Vec::new();
    for a in s.alerts()?.into_iter().filter(|a| a.active) {
        match armed_level(s, &a)? {
            Ok(armed) => out.push(armed),
            Err(e) => eprintln!("alert {} is not armed: {e}", a.id),
        }
    }
    Ok(out)
}

fn armed_level(s: &Store, a: &Alert) -> Result<Result<(Alert, Level), String>, StoreError> {
    let Some(inst) = s.instrument(&a.instrument)? else {
        return Ok(Err("its instrument is unknown".into()));
    };
    let Some(a) = a.rescaled(inst.price_scale) else {
        return Ok(Err("its price does not fit the new tick size".into()));
    };
    let level = match &a.kind {
        AlertKind::Price { price } => Level::Flat { p: *price },
        AlertKind::Drawing { drawing_id } => match drawing_level(s, &a, drawing_id)? {
            Ok(l) => l,
            Err(e) => return Ok(Err(e)),
        },
    };
    Ok(Ok((a, level)))
}

fn drawing_level(
    s: &Store,
    a: &Alert,
    drawing_id: &str,
) -> Result<Result<Level, String>, StoreError> {
    let Some(d) = s.drawing(drawing_id)? else {
        return Ok(Err(format!("drawing {drawing_id} does not exist")));
    };
    if d.instrument != a.instrument {
        return Ok(Err(format!("drawing {drawing_id} is on another pair")));
    }
    let Some(d) = d.rescaled(a.price_scale) else {
        return Ok(Err("the line does not fit the new tick size".into()));
    };
    Ok(Level::of_drawing(&d.body)
        .ok_or_else(|| "an alert can follow only a horizontal or a trend line".to_owned()))
}

impl Engine {
    /// Every alert, oldest first, at its instrument's current price scale.
    pub async fn alerts(&self) -> Result<Vec<Alert>, EngineError> {
        blocking(&self.shared.store, |s| {
            let mut out = Vec::new();
            for a in s.alerts()? {
                let scale = s.instrument(&a.instrument)?.map(|i| i.price_scale);
                out.push(match scale {
                    Some(to) if to != a.price_scale => a.rescaled(to).unwrap_or(a),
                    _ => a,
                });
            }
            Ok(out)
        })
        .await
    }

    /// Validates, stores and arms an alert (insert or replace by id). It is active from now
    /// on, with no trigger. A line alert must follow an `hline` or `trend` drawing of the
    /// same pair. Refused past the caps, and when the pair would need a live stream while
    /// all [`MAX_LIVE_STREAMS`] are open.
    pub async fn set_alert(&self, mut a: Alert) -> Result<Alert, EngineError> {
        a.active = true;
        a.created_at = self.now_ms();
        a.triggered_at = None;
        a.triggered_price = None;
        validate(&a).map_err(EngineError::Alert)?;
        self.arm(a).await
    }

    /// Arms a fired alert again; it fires on the next crossing from now on.
    pub async fn rearm_alert(&self, id: &str) -> Result<Alert, EngineError> {
        let key = id.to_owned();
        let mut a = blocking(&self.shared.store, move |s| s.alert(&key))
            .await?
            .ok_or_else(|| EngineError::Alert(format!("no alert {id:?}")))?;
        a.active = true;
        a.triggered_at = None;
        a.triggered_price = None;
        self.arm(a).await
    }

    async fn arm(&self, a: Alert) -> Result<Alert, EngineError> {
        let full = {
            let st = self.shared.alerts.state();
            !st.streams.contains_key(&a.instrument) && st.open >= MAX_LIVE_STREAMS
        };
        if full {
            return Err(EngineError::Alert(format!(
                "too many live streams (max {MAX_LIVE_STREAMS}) for an alert on another pair"
            )));
        }
        let now = self.now_ms();
        let store = Arc::clone(&self.shared.store);
        let hub = Arc::clone(&self.shared.alerts);
        let saved = crate::spawn_blocking(move || {
            let a = {
                let mut s = lock(&store);
                let inst = s
                    .instrument(&a.instrument)?
                    .ok_or_else(|| EngineError::UnknownInstrument(a.instrument.clone()))?;
                let a = a.rescaled(inst.price_scale).ok_or_else(|| {
                    EngineError::Alert("the price does not fit the tick size".into())
                })?;
                // The same checks as arming from the store, so what is saved can be armed.
                armed_level(&s, &a)?.map_err(EngineError::Alert)?;
                s.upsert_alert(&a)?;
                a
            };
            hub.reload(&store, now)?;
            Ok(a)
        })
        .await?;
        self.shared.alerts.send(AlertEvent::Changed);
        Ok(saved)
    }

    pub async fn delete_alert(&self, id: &str) -> Result<(), EngineError> {
        validate_id(id).map_err(|_| EngineError::Alert(format!("no alert {id:?}")))?;
        let id = id.to_owned();
        self.store_and_reload(move |s| s.delete_alert(&id)).await?;
        self.shared.alerts.send(AlertEvent::Changed);
        Ok(())
    }

    /// Alert events, for the UI and the OS notification.
    pub fn alert_events(&self) -> broadcast::Receiver<AlertEvent> {
        self.shared.alerts.events()
    }

    /// Runs `f` on the store, then re-arms the alerts from what it left.
    pub(crate) async fn store_and_reload<T, F>(&self, f: F) -> Result<T, EngineError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T, StoreError> + Send + 'static,
    {
        let now = self.now_ms();
        let store = Arc::clone(&self.shared.store);
        let hub = Arc::clone(&self.shared.alerts);
        crate::spawn_blocking(move || {
            let out = f(&mut lock(&store))?;
            hub.reload(&store, now)?;
            Ok(out)
        })
        .await
    }

    /// A drawing was saved: its armed alerts follow its new place.
    pub(crate) async fn drawing_saved(&self, drawing_id: &str) -> Result<(), EngineError> {
        if self.shared.alerts.follows(drawing_id) {
            self.store_and_reload(|_| Ok(())).await?;
            self.shared.alerts.send(AlertEvent::Changed);
        }
        Ok(())
    }

    /// Deletes a drawing and its alerts in one transaction, then disarms them.
    pub(crate) async fn delete_drawing_and_alerts(&self, id: String) -> Result<(), EngineError> {
        let removed = self
            .store_and_reload(move |s| s.delete_drawing(&id))
            .await?;
        if removed > 0 {
            self.shared.alerts.send(AlertEvent::Changed);
        }
        Ok(())
    }

    /// The alert service: arms the stored alerts and keeps a live stream open for every
    /// pair with an active one. Runs until the engine's runtime stops; spawn it once.
    pub async fn run_alerts(&self) {
        let hub = Arc::clone(&self.shared.alerts);
        if let Err(e) = self.store_and_reload(|_| Ok(())).await {
            eprintln!("cannot arm the alerts: {e}");
        }
        let mut failing: HashSet<InstrumentId> = HashSet::new();
        loop {
            let notified = hub.wake.notified();
            let retry = self.reconcile(&mut failing);
            if retry {
                let _ = tokio::time::timeout(RETRY, notified).await;
            } else {
                notified.await;
            }
        }
    }

    /// Opens the engine's own stream for every armed pair without one and closes the ones
    /// no longer needed. Returns whether a stream could not be opened (retry later).
    fn reconcile(&self, failing: &mut HashSet<InstrumentId>) -> bool {
        let hub = &self.shared.alerts;
        let (start, stop) = {
            let mut st = hub.state();
            st.own.retain(|_, task| !task.is_finished());
            let chart = |st: &State, id: &InstrumentId| {
                st.streams.get(id).is_some_and(|v| v.iter().any(|s| !s.own))
            };
            let stop: Vec<InstrumentId> = st
                .own
                .keys()
                .filter(|id| !st.armed.contains_key(*id) || chart(&st, id))
                .cloned()
                .collect();
            let stop: Vec<JoinHandle<()>> =
                stop.iter().filter_map(|id| st.own.remove(id)).collect();
            let start: Vec<InstrumentId> = st
                .armed
                .keys()
                .filter(|id| !st.own.contains_key(*id) && !chart(&st, id))
                .cloned()
                .collect();
            (start, stop)
        };
        for task in stop {
            task.abort();
        }
        failing.retain(|id| start.contains(id));
        let mut retry = false;
        for id in start {
            match self.open_live(&id, ALERT_TF, true) {
                Ok(mut handle) => {
                    failing.remove(&id);
                    // Nobody reads the events of this stream; its updates are evaluated
                    // in the stream task itself.
                    let task =
                        tokio::spawn(
                            async move { while handle.receiver().recv().await.is_some() {} },
                        );
                    hub.state().own.insert(id, task);
                }
                Err(e) => {
                    retry = true;
                    if failing.insert(id.clone()) {
                        eprintln!(
                            "no live stream for the alerts of {}/{}: {e}",
                            id.source, id.symbol
                        );
                    }
                }
            }
        }
        retry
    }
}

/// Stores alerts that fired in the stream task of their pair, then reports them. Runs as a
/// task of its own: the stream may be stopped right after (its last alert fired), and that
/// must not cancel the write.
pub(crate) async fn record_fired(shared: crate::Shared, fired: Vec<Alert>) {
    for a in fired {
        let stored = a.clone();
        match blocking(&shared.store, move |s| s.fire_alert(&stored)).await {
            Ok(true) => shared.alerts.send(AlertEvent::Fired(a)),
            Ok(false) => {} // deleted or fired meanwhile
            Err(e) => eprintln!("alert {} fired but cannot be stored: {e}", a.id),
        }
    }
}
