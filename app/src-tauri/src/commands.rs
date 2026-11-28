//! Tauri commands: thin wrappers that parse arguments, call the engine and convert to DTOs.
//! Engine calls that lock SQLite on the calling thread run on the blocking pool.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use sandchart_core::replay::Command;
use sandchart_core::{InstrumentId, Timeframe};
use sandchart_engine::{Engine, EngineError};
use tauri::async_runtime::{JoinHandle, spawn, spawn_blocking};
use tauri::ipc::Channel;
use tauri::ipc::{InvokeBody, Request};
use tauri::plugin::PermissionState;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use sandchart_indicators::MAX_MODULE_BYTES;

use crate::dto::{
    AlertDto, AlertInputDto, CandlesDto, DayChangeDto, DrawingDto, DrawingInputDto,
    IndicatorInfoDto, IndicatorListDto, InspectionDto, InstanceDto, InstanceResultDto,
    InstrumentDto, InstrumentIdDto, LiveDto, PositionInputDto, PositionOutcomeDto, ProblemDto,
    ReplayStateDto, connection_name, to_candles_dto, to_day_change_dto, to_live_dto,
    to_replay_state_dto,
};

/// Most results one search returns.
const SEARCH_LIMIT: usize = 50;

/// Most live subscriptions at once; a runaway UI cannot open unbounded Binance streams. The
/// engine keeps the same cap over these and the streams it opens for alerts together.
const MAX_SUBSCRIPTIONS: usize = sandchart_engine::MAX_LIVE_STREAMS;

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
    /// The UI is in Russian: OS notifications follow its language.
    pub russian: Arc<AtomicBool>,
    /// The notification permission was asked for in this run.
    asked_permission: AtomicBool,
}

impl AppState {
    pub fn new(
        engine: Arc<Engine>,
        instruments_ready: Arc<AtomicBool>,
        russian: Arc<AtomicBool>,
    ) -> Self {
        Self {
            engine,
            subscriptions: Subscriptions::default(),
            instruments_ready,
            russian,
            asked_permission: AtomicBool::new(false),
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

/// Saves several drawings in one write, all or none; returns them as stored, in order.
#[tauri::command]
pub async fn save_drawings(
    state: State<'_, AppState>,
    drawings: Vec<DrawingInputDto>,
) -> CmdResult<Vec<DrawingDto>> {
    let list = drawings.into_iter().map(Into::into).collect();
    let saved = state.engine.save_drawings(list).await?;
    Ok(saved.into_iter().map(Into::into).collect())
}

/// Deletes several drawings and their alerts in one write; unknown ids are not an error.
#[tauri::command]
pub async fn delete_drawings(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    Ok(state.engine.delete_drawings(ids).await?)
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

/// Starts a replay stepping `base` at the cached candle opening at `start_time`; the
/// state is of `base`, with every revealed bar.
#[tauri::command]
pub async fn replay_start(
    state: State<'_, AppState>,
    source: String,
    symbol: String,
    base: String,
    start_time: i64,
) -> CmdResult<ReplayStateDto> {
    let id = InstrumentId { source, symbol };
    let st = state
        .engine
        .replay_start(&id, timeframe(&base)?, start_time)
        .await?;
    Ok(to_replay_state_dto(st)?)
}

/// Reveals up to `n` base candles; returns the cut.
#[tauri::command]
pub async fn replay_step(state: State<'_, AppState>, n: u32) -> CmdResult<i64> {
    let cut = state.engine.replay_step(n).await?;
    Ok(crate::dto::safe(cut)?)
}

/// Changes the step resolution to `base`; the state is of `base`, with every revealed bar.
#[tauri::command]
pub async fn replay_set_base(
    state: State<'_, AppState>,
    base: String,
) -> CmdResult<ReplayStateDto> {
    let st = state.engine.replay_set_base(timeframe(&base)?).await?;
    Ok(to_replay_state_dto(st)?)
}

#[tauri::command]
pub async fn replay_command(state: State<'_, AppState>, command: Command) -> CmdResult<()> {
    blocking(&state, move |e| e.replay_command(command)).await
}

/// The session as a chart of `tf` shows it: the revealed bars from index `cursor` on and
/// the trades from index `trades_from` on.
#[tauri::command]
pub async fn replay_state(
    state: State<'_, AppState>,
    tf: String,
    cursor: u32,
    trades_from: u32,
) -> CmdResult<ReplayStateDto> {
    let tf = timeframe(&tf)?;
    let st = blocking(&state, move |e| e.replay_state(tf, cursor, trades_from)).await?;
    Ok(to_replay_state_dto(st)?)
}

/// Asks where to save the session with the native save panel and writes the file there.
/// Returns the path, or `None` when the user cancelled.
#[tauri::command]
pub async fn replay_save(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let (name, bytes) =
        blocking(&state, |e| Ok((e.replay_file_name()?, e.replay_export()?))).await?;
    spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Sandchart replay", &["replay"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(ProblemDto::other)?;
        std::fs::write(&path, bytes)
            .map_err(|e| ProblemDto::other(format!("cannot write {}: {e}", path.display())))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(ProblemDto::other)?
}

/// Opens a `.replay` file sent as the raw request body (no JSON array of 32 MiB numbers).
#[tauri::command]
pub async fn replay_open(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> CmdResult<ReplayStateDto> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ProblemDto::other(
            "the replay file must be sent as raw bytes",
        ));
    };
    let bytes = bytes.clone();
    let st = blocking(&state, move |e| e.replay_open(&bytes)).await?;
    Ok(to_replay_state_dto(st)?)
}

#[tauri::command]
pub fn replay_exit(state: State<'_, AppState>) {
    state.engine.replay_exit();
}

#[tauri::command]
pub async fn get_alerts(state: State<'_, AppState>) -> CmdResult<Vec<AlertDto>> {
    let alerts = state.engine.alerts().await?;
    Ok(alerts.into_iter().map(Into::into).collect())
}

/// Arms an alert (insert or replace by id). The first one asks for the permission to show
/// notifications, not the app's start: most users never set an alert.
#[tauri::command]
pub async fn set_alert(
    app: AppHandle,
    state: State<'_, AppState>,
    alert: AlertInputDto,
) -> CmdResult<AlertDto> {
    let saved = state.engine.set_alert(alert.into()).await?;
    if !state.asked_permission.swap(true, Ordering::AcqRel) {
        let n = app.notification();
        let asked = match n.permission_state() {
            Ok(PermissionState::Granted | PermissionState::Denied) => Ok(()),
            Ok(_) => n.request_permission().map(|_| ()),
            Err(e) => Err(e),
        };
        if let Err(e) = asked {
            eprintln!("cannot ask for the notification permission: {e}");
        }
    }
    Ok(saved.into())
}

#[tauri::command]
pub async fn rearm_alert(state: State<'_, AppState>, id: String) -> CmdResult<AlertDto> {
    Ok(state.engine.rearm_alert(&id).await?.into())
}

#[tauri::command]
pub async fn delete_alert(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.engine.delete_alert(&id).await?)
}

/// The UI's language, for the text of OS notifications (`en` unless `ru`).
#[tauri::command]
pub fn set_language(state: State<'_, AppState>, lang: String) {
    state.russian.store(lang == "ru", Ordering::Release);
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
