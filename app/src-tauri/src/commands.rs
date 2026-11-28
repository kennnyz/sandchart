//! Tauri commands: thin wrappers that parse arguments, call the engine and convert to DTOs.
//! Engine calls that lock SQLite on the calling thread run on the blocking pool.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use sandchart_core::{InstrumentId, Timeframe};
use sandchart_engine::{Engine, EngineError};
use tauri::State;
use tauri::async_runtime::{JoinHandle, spawn, spawn_blocking};
use tauri::ipc::Channel;

use sandchart_indicators::MAX_MODULE_BYTES;

use crate::dto::{
    CandlesDto, DayChangeDto, DrawingDto, DrawingInputDto, IndicatorInfoDto, IndicatorListDto,
    InspectionDto, InstanceDto, InstanceResultDto, InstrumentDto, InstrumentIdDto, LiveDto,
    PositionInputDto, PositionOutcomeDto, ProblemDto, connection_name, to_candles_dto,
    to_day_change_dto, to_live_dto,
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
    /// Set once the instrument list was synced; the `instruments-synced` event follows.
    pub instruments_ready: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(engine: Arc<Engine>, instruments_ready: Arc<AtomicBool>) -> Self {
        Self {
            engine,
            subscriptions: Subscriptions::default(),
            instruments_ready,
        }
    }
}

/// Every command fails with a `ProblemDto`, so the UI can tell the causes apart.
type CmdResult<T> = Result<T, ProblemDto>;

fn timeframe(code: &str) -> CmdResult<Timeframe> {
    Timeframe::from_code(code)
        .ok_or_else(|| ProblemDto::other(format!("unknown timeframe {code:?}")))
}

/// Runs a sync engine call on the blocking pool.
async fn blocking<T, F>(state: &State<'_, AppState>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Engine) -> Result<T, EngineError> + Send + 'static,
{
    let engine = state.engine.clone();
    spawn_blocking(move || f(&engine))
        .await
        .map_err(ProblemDto::other)?
        .map_err(ProblemDto::from)
}

#[tauri::command]
pub async fn search_instruments(
    state: State<'_, AppState>,
    query: String,
) -> CmdResult<Vec<InstrumentDto>> {
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
) -> CmdResult<CandlesDto> {
    let id = InstrumentId { source, symbol };
    let page = state
        .engine
        .load_chart(&id, timeframe(&tf)?, before)
        .await?;
    Ok(to_candles_dto(page)?)
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
) -> CmdResult<u32> {
    let id = InstrumentId { source, symbol };
    let mut handle = state.engine.subscribe_live(&id, timeframe(&tf)?)?;
    // On the cap error `handle` is dropped here, which stops the stream again.
    let started = state.subscriptions.start(async move {
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
    });
    started.map_err(ProblemDto::other)
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
pub async fn get_watchlist(state: State<'_, AppState>) -> CmdResult<Vec<InstrumentIdDto>> {
    let ids = blocking(&state, |e| e.watchlist()).await?;
    Ok(ids.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn set_watchlist(state: State<'_, AppState>, ids: Vec<InstrumentIdDto>) -> CmdResult<()> {
    let ids: Vec<InstrumentId> = ids.into_iter().map(Into::into).collect();
    blocking(&state, move |e| e.set_watchlist(&ids)).await
}

#[tauri::command]
pub async fn get_watchlist_quotes(state: State<'_, AppState>) -> CmdResult<Vec<DayChangeDto>> {
    let quotes = state.engine.watchlist_quotes().await?;
    Ok(quotes
        .into_iter()
        .map(to_day_change_dto)
        .collect::<Result<_, _>>()?)
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    path: String,
    symbol: String,
    tf: String,
) -> CmdResult<InstrumentIdDto> {
    let tf = timeframe(&tf)?;
    let path = PathBuf::from(path);
    let id = blocking(&state, move |e| e.import_csv(&path, &symbol, tf)).await?;
    Ok(id.into())
}

/// True once the first instrument sync succeeded. The UI asks this after it starts
/// listening for `instruments-synced`, so it cannot miss an event sent before.
#[tauri::command]
pub fn get_instruments_ready(state: State<'_, AppState>) -> bool {
    state.instruments_ready.load(Ordering::Acquire)
}

#[tauri::command]
pub fn get_connection(state: State<'_, AppState>) -> &'static str {
    connection_name(*state.engine.connection().borrow())
}

fn check_module_size(bytes: &[u8]) -> CmdResult<()> {
    if bytes.len() > MAX_MODULE_BYTES {
        return Err(ProblemDto::other(format!(
            "the indicator file is {} MiB; the limit is {} MiB",
            bytes.len() / (1024 * 1024),
            MAX_MODULE_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_indicators(state: State<'_, AppState>) -> CmdResult<IndicatorListDto> {
    Ok(state.engine.indicators().await.into())
}

#[tauri::command]
pub async fn inspect_indicator(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> CmdResult<InspectionDto> {
    check_module_size(&bytes)?;
    Ok(state.engine.inspect_indicator(&bytes).await?.into())
}

#[tauri::command]
pub async fn install_indicator(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> CmdResult<IndicatorInfoDto> {
    check_module_size(&bytes)?;
    Ok(state.engine.install_indicator(bytes).await?.into())
}

#[tauri::command]
pub async fn remove_indicator(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.engine.remove_indicator(&id).await?)
}

#[tauri::command]
pub async fn get_chart_indicators(state: State<'_, AppState>) -> CmdResult<Vec<InstanceDto>> {
    Ok(state
        .engine
        .chart_indicators()
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
pub async fn set_chart_indicators(
    state: State<'_, AppState>,
    items: Vec<InstanceDto>,
) -> CmdResult<()> {
    Ok(state
        .engine
        .set_chart_indicators(items.into_iter().map(Into::into).collect())
        .await?)
}

#[tauri::command]
pub async fn compute_indicators(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    tf: String,
    from_time: i64,
) -> CmdResult<Vec<InstanceResultDto>> {
    let id = InstrumentId { source, symbol };
    let results = state
        .engine
        .compute_indicators(&id, timeframe(&tf)?, from_time)
        .await?;
    Ok(results.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn get_drawings(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
) -> CmdResult<Vec<DrawingDto>> {
    let id = InstrumentId { source, symbol };
    let drawings = state.engine.drawings(&id).await?;
    Ok(drawings.into_iter().map(Into::into).collect())
}

/// Returns the drawing as stored, with the engine's price scale and update time.
#[tauri::command]
pub async fn save_drawing(
    state: State<'_, AppState>,
    drawing: DrawingInputDto,
) -> CmdResult<DrawingDto> {
    Ok(state.engine.save_drawing(drawing.into()).await?.into())
}

#[tauri::command]
pub async fn delete_drawing(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.engine.delete_drawing(&id).await?)
}

#[tauri::command]
pub async fn get_position_outcomes(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    tf: String,
    positions: Vec<PositionInputDto>,
) -> CmdResult<Vec<PositionOutcomeDto>> {
    let id = InstrumentId { source, symbol };
    let positions = positions.into_iter().map(|p| (p.id, p.position)).collect();
    let outcomes = state
        .engine
        .position_outcomes(&id, timeframe(&tf)?, positions)
        .await?;
    Ok(outcomes
        .into_iter()
        .map(|(id, outcome)| PositionOutcomeDto { id, outcome })
        .collect())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn oversized_module_files_are_rejected_early() {
        assert!(check_module_size(&[0; 16]).is_ok());
        let err = check_module_size(&vec![0; MAX_MODULE_BYTES + 1]).unwrap_err();
        assert!(err.message.contains("20 MiB"));
    }

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
