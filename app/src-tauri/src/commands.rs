//! Tauri commands: thin wrappers that parse arguments, call the engine and convert to DTOs.
//! Engine calls that lock SQLite on the calling thread run on the blocking pool.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use sandchart_core::{InstrumentId, Timeframe};
use sandchart_engine::{Engine, EngineError};
use tauri::async_runtime::{JoinHandle, spawn, spawn_blocking};
use tauri::{AppHandle, Emitter, State};

use crate::dto::{
    CandlesDto, DayChangeDto, InstrumentDto, InstrumentIdDto, to_candles_dto, to_day_change_dto,
    to_live_dto,
};

/// Most results one search returns.
const SEARCH_LIMIT: usize = 50;

pub struct AppState {
    pub engine: std::sync::Arc<Engine>,
    next_id: AtomicU32,
    /// Forwarder tasks by subscription id. A task owns its `LiveHandle`, so aborting the
    /// task drops the handle and stops the provider stream.
    subscriptions: Mutex<HashMap<u32, JoinHandle<()>>>,
}

impl AppState {
    pub fn new(engine: std::sync::Arc<Engine>) -> Self {
        Self {
            engine,
            next_id: AtomicU32::new(1),
            subscriptions: Mutex::default(),
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

#[tauri::command]
pub async fn subscribe_live(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    tf: String,
) -> Result<u32, String> {
    let id = InstrumentId { source, symbol };
    let mut handle = state
        .engine
        .subscribe_live(&id, timeframe(&tf)?)
        .map_err(err)?;
    let sub = state.next_id.fetch_add(1, Ordering::Relaxed);
    let event = format!("live:{sub}");
    let task = spawn(async move {
        while let Some(live) = handle.receiver().recv().await {
            match to_live_dto(live) {
                Ok(dto) => {
                    if let Err(e) = app.emit(&event, dto) {
                        eprintln!("cannot emit {event}: {e}");
                    }
                }
                Err(e) => eprintln!("dropping live event of {event}: {e}"),
            }
        }
    });
    state
        .subscriptions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(sub, task);
    Ok(sub)
}

#[tauri::command]
pub fn unsubscribe_live(state: State<'_, AppState>, id: u32) {
    let task = state
        .subscriptions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);
    if let Some(task) = task {
        task.abort();
    }
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
