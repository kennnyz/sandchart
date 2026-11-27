//! Tauri commands: thin wrappers that parse arguments, call the engine and convert to DTOs.
//! Engine calls that lock SQLite on the calling thread run on the blocking pool.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use sandchart_core::{InstrumentId, Timeframe};
use sandchart_engine::{Engine, EngineError};
use tauri::State;
use tauri::async_runtime::{JoinHandle, spawn, spawn_blocking};
use tauri::ipc::Channel;

use crate::dto::{
    CandlesDto, DayChangeDto, InstrumentDto, InstrumentIdDto, LiveDto, connection_name,
    to_candles_dto, to_day_change_dto, to_live_dto,
};

/// Most results one search returns.
const SEARCH_LIMIT: usize = 50;

/// Most live subscriptions at once; a runaway UI cannot open unbounded Binance streams.
const MAX_SUBSCRIPTIONS: usize = 32;

type Tasks = Arc<Mutex<HashMap<u32, JoinHandle<()>>>>;

/// Running forwarder tasks by subscription id. A task owns its `LiveHandle`, so aborting
/// it drops the handle and stops the provider stream. A task that ends by itself removes
/// its own entry.
#[derive(Default)]
pub struct Subscriptions {
    next_id: AtomicU32,
    tasks: Tasks,
}

impl Subscriptions {
    /// Runs `work` as a subscription and returns its id; errors at the cap.
    fn start(&self, work: impl Future<Output = ()> + Send + 'static) -> Result<u32, String> {
        let mut tasks = lock(&self.tasks);
        if tasks.len() >= MAX_SUBSCRIPTIONS {
            return Err(format!(
                "too many live subscriptions (max {MAX_SUBSCRIPTIONS})"
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let registry = self.tasks.clone();
        // The task cannot reach `remove` before `insert` below: it needs the lock we hold.
        let task = spawn(async move {
            work.await;
            lock(&registry).remove(&id);
        });
        tasks.insert(id, task);
        Ok(id)
    }

    fn stop(&self, id: u32) {
        if let Some(task) = lock(&self.tasks).remove(&id) {
            task.abort();
        }
    }

    pub fn stop_all(&self) {
        for (_, task) in lock(&self.tasks).drain() {
            task.abort();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.tasks).len()
    }
}

fn lock(tasks: &Tasks) -> std::sync::MutexGuard<'_, HashMap<u32, JoinHandle<()>>> {
    tasks.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct AppState {
    pub engine: Arc<Engine>,
    pub subscriptions: Subscriptions,
}

impl AppState {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self {
            engine,
            subscriptions: Subscriptions::default(),
        }
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn timeframe(code: &str) -> Result<Timeframe, String> {
    Timeframe::from_code(code).ok_or_else(|| format!("unknown timeframe {code:?}"))
}

/// Runs a sync engine call on the blocking pool.
async fn blocking<T, F>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Engine) -> Result<T, EngineError> + Send + 'static,
{
    let engine = state.engine.clone();
    spawn_blocking(move || f(&engine))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
pub async fn search_instruments(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<InstrumentDto>, String> {
    let found = blocking(&state, move |e| e.search(&query, SEARCH_LIMIT)).await?;
    Ok(found.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn get_candles(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    tf: String,
    before: Option<i64>,
) -> Result<CandlesDto, String> {
    let id = InstrumentId { source, symbol };
    let page = state
        .engine
        .load_chart(&id, timeframe(&tf)?, before)
        .await
        .map_err(err)?;
    to_candles_dto(page).map_err(err)
}

/// Live events arrive on `on_event`, a channel the UI creates before calling, so none is
/// lost to a listener that registers late.
#[tauri::command]
pub async fn subscribe_live(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    tf: String,
    on_event: Channel<LiveDto>,
) -> Result<u32, String> {
    let id = InstrumentId { source, symbol };
    let mut handle = state
        .engine
        .subscribe_live(&id, timeframe(&tf)?)
        .map_err(err)?;
    // On the cap error `handle` is dropped here, which stops the stream again.
    state.subscriptions.start(async move {
        while let Some(live) = handle.receiver().recv().await {
            match to_live_dto(live) {
                Ok(dto) => {
                    if on_event.send(dto).is_err() {
                        return; // the page is gone
                    }
                }
                Err(e) => eprintln!("dropping a live event: {e}"),
            }
        }
    })
}

#[tauri::command]
pub fn unsubscribe_live(state: State<'_, AppState>, id: u32) {
    state.subscriptions.stop(id);
}

/// Called by the UI on startup: a reloaded page forgets its subscription ids.
#[tauri::command]
pub fn unsubscribe_all(state: State<'_, AppState>) {
    state.subscriptions.stop_all();
}

#[tauri::command]
pub async fn get_watchlist(state: State<'_, AppState>) -> Result<Vec<InstrumentIdDto>, String> {
    let ids = blocking(&state, |e| e.watchlist()).await?;
    Ok(ids.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn set_watchlist(
    state: State<'_, AppState>,
    ids: Vec<InstrumentIdDto>,
) -> Result<(), String> {
    let ids: Vec<InstrumentId> = ids.into_iter().map(Into::into).collect();
    blocking(&state, move |e| e.set_watchlist(&ids)).await
}

#[tauri::command]
pub async fn get_watchlist_quotes(state: State<'_, AppState>) -> Result<Vec<DayChangeDto>, String> {
    let quotes = state.engine.watchlist_quotes().await.map_err(err)?;
    quotes
        .into_iter()
        .map(|q| to_day_change_dto(q).map_err(err))
        .collect()
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    path: String,
    symbol: String,
    tf: String,
) -> Result<InstrumentIdDto, String> {
    let tf = timeframe(&tf)?;
    let path = PathBuf::from(path);
    let id = blocking(&state, move |e| e.import_csv(&path, &symbol, tf)).await?;
    Ok(id.into())
}

#[tauri::command]
pub fn get_connection(state: State<'_, AppState>) -> &'static str {
    connection_name(*state.engine.connection().borrow())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn finished_forwarder_removes_its_entry() {
        let subs = Subscriptions::default();
        subs.start(async {}).unwrap();
        for _ in 0..100 {
            if subs.len() == 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("entry of a finished subscription was not removed");
    }

    #[test]
    fn rejects_the_33rd_subscription_and_stop_frees_a_slot() {
        let subs = Subscriptions::default();
        let ids: Vec<u32> = (0..MAX_SUBSCRIPTIONS)
            .map(|_| subs.start(std::future::pending()).unwrap())
            .collect();
        assert!(subs.start(std::future::pending()).is_err());
        subs.stop(ids[0]);
        assert!(subs.start(std::future::pending()).is_ok());
        subs.stop_all();
        assert_eq!(subs.len(), 0);
    }
}
