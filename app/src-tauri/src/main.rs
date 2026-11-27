// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dto;

use std::sync::Arc;

use sandchart_data::Binance;
use sandchart_engine::Engine;
use tauri::{Emitter, Manager};

use commands::AppState;

/// The only data source of 0.1.
const SOURCE: &str = "binance";

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
            let syncing = engine.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = syncing.sync_instruments(SOURCE).await {
                    eprintln!("instrument sync failed: {e}");
                }
            });

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

            app.manage(AppState::new(engine));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sandchart");
}
