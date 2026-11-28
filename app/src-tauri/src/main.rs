// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod commands;
mod dto;
mod update;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sandchart_data::{Binance, ProviderError};
use sandchart_engine::{Engine, EngineError};
use tauri::{AppHandle, Emitter, Manager};

use commands::AppState;
use update::UpdaterState;

/// The only data source of 0.1.
const SOURCE: &str = "binance";

/// Longest wait between two failed instrument syncs (unless the exchange asks for more).
const MAX_SYNC_DELAY_S: u64 = 60;

/// Refreshes the instrument list until it succeeds, then marks it ready and tells the UI,
/// which waits for it on a first run (empty store) to open the default chart.
async fn sync_instruments(engine: Arc<Engine>, ready: Arc<AtomicBool>, app: AppHandle) {
    let mut delay_s = 5;
    loop {
        match engine.sync_instruments(SOURCE).await {
            Ok(_) => break,
            Err(e) => {
                eprintln!("instrument sync failed: {e}");
                let wait_s = match e {
                    EngineError::Provider(ProviderError::RateLimited { retry_after_s }) => {
                        retry_after_s
                    }
                    _ => delay_s,
                };
                delay_s = (delay_s * 2).min(MAX_SYNC_DELAY_S);
                tokio::time::sleep(Duration::from_secs(wait_s)).await;
            }
        }
    }
    ready.store(true, Ordering::Release);
    if let Err(e) = app.emit("instruments-synced", ()) {
        eprintln!("cannot emit instruments-synced: {e}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(UpdaterState::default())
        .setup(|app| {
            let dirs = directories::ProjectDirs::from("", "", "Sandchart")
                .ok_or("cannot find the OS data directory")?;
            std::fs::create_dir_all(dirs.data_dir())?;
            let engine = Arc::new(Engine::open(
                dirs.data_dir(),
                Some(&dirs.cache_dir().join("indicators")),
                vec![Arc::new(Binance::default_hosts())],
            )?);

            // Refresh the instrument list in the background; the cached one serves meanwhile.
            let ready = Arc::new(AtomicBool::new(false));
            tauri::async_runtime::spawn(sync_instruments(
                engine.clone(),
                ready.clone(),
                app.handle().clone(),
            ));

            // Forward connection state changes to the UI.
            let mut connection = engine.connection();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while connection.changed().await.is_ok() {
                    let name = dto::connection_name(*connection.borrow_and_update());
                    if let Err(e) = handle.emit("connection", name) {
                        eprintln!("cannot emit connection: {e}");
                    }
                }
            });

            // Alerts: arm the stored ones, keep their streams, report what fires.
            let russian = Arc::new(AtomicBool::new(false));
            let service = engine.clone();
            tauri::async_runtime::spawn(async move { service.run_alerts().await });
            tauri::async_runtime::spawn(alerts::forward(
                engine.alert_events(),
                app.handle().clone(),
                russian.clone(),
            ));

            app.manage(AppState::new(engine, ready, russian));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window stops every live stream.
            if let tauri::WindowEvent::Destroyed = event
                && let Some(state) = window.try_state::<AppState>()
            {
                state.subscriptions.stop_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_instruments,
            commands::get_candles,
            commands::subscribe_live,
            commands::unsubscribe_live,
            commands::unsubscribe_all,
            commands::get_watchlist,
            commands::set_watchlist,
            commands::get_watchlist_quotes,
            commands::import_csv,
            commands::get_connection,
            commands::get_instruments_ready,
            commands::list_indicators,
            commands::inspect_indicator,
            commands::install_indicator,
            commands::remove_indicator,
            commands::get_chart_indicators,
            commands::set_chart_indicators,
            commands::compute_indicators,
            commands::get_drawings,
            commands::save_drawing,
            commands::delete_drawing,
            commands::save_drawings,
            commands::delete_drawings,
            commands::get_position_outcomes,
            commands::replay_start,
            commands::replay_step,
            commands::replay_command,
            commands::replay_state,
            commands::replay_save,
            commands::replay_open,
            commands::replay_exit,
            commands::get_alerts,
            commands::set_alert,
            commands::rearm_alert,
            commands::delete_alert,
            commands::set_language,
            update::check_update,
            update::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sandchart");
}
