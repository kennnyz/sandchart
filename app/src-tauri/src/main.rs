// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dto;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sandchart_data::{Binance, ProviderError};
use sandchart_engine::{Engine, EngineError};
use tauri::{AppHandle, Emitter, Manager};

use commands::AppState;

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
        .setup(|app| {
            let dirs = directories::ProjectDirs::from("", "", "Sandchart")
                .ok_or("cannot find the OS data directory")?;
            std::fs::create_dir_all(dirs.data_dir())?;
            let engine = Arc::new(Engine::open(
                dirs.data_dir(),
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

            app.manage(AppState::new(engine, ready));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sandchart");
}
