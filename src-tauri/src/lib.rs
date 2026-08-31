//! OpenProject Time Tracker — the Rust half.
//!
//! A rewrite of the Electron app's main process. The Vue 3 frontend is carried
//! over as-is; everything that used to run in Node now runs here:
//!
//! | Electron                                  | here                        |
//! |-------------------------------------------|-----------------------------|
//! | `src/main/openproject/client.ts` (fetch)  | `openproject::client` (reqwest) |
//! | `src/main/schemas/*.ts` (Zod)             | `schemas::*` (serde)        |
//! | `src/main/credentials` (safeStorage)      | `credentials` (OS keychain) |
//! | `src/main/ipc/*.ts` (`ipcMain.handle`)    | `commands::*` (`#[tauri::command]`) |
//! | `src/preload/index.ts` (contextBridge)    | `src/bridge/index.ts` (`invoke`) |
//!
//! The architecture rule the port preserves: **the webview never talks to
//! OpenProject and never holds the API key.** It calls commands; this side does
//! the HTTP, holds the secret, and hands back parsed data or a
//! `{ code, message }` error.

pub mod commands;
pub mod credentials;
pub mod error;
pub mod openproject;
pub mod schemas;
pub mod util;

/// The floor the frontend is built for.
///
/// Below ~800 the day modal (`max-w-2xl`) stops fitting its own width, so the
/// work package and activity selects sharing a row squeeze to unreadable; below
/// ~600 the seven-column grid loses the row height a day's entries need.
/// Resizing stays free above it.
const MIN_WINDOW_WIDTH: f64 = 800.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered so the *Rust* side can hand a URL to the OS
        // (`commands::shell`). The frontend is deliberately not granted the
        // plugin's JS permission — it can ask to open a work package by id and
        // nothing else.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(
                    MIN_WINDOW_WIDTH,
                    MIN_WINDOW_HEIGHT,
                )));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Credentials + the connection probe
            commands::credentials::has_credentials,
            commands::credentials::get_connection_info,
            commands::credentials::save_credentials,
            commands::credentials::clear_credentials,
            commands::credentials::test_connection,
            // Reads
            commands::openproject::list_work_packages,
            commands::openproject::list_time_entries,
            commands::openproject::list_statuses,
            commands::openproject::list_time_entry_activities,
            commands::openproject::get_work_package_form,
            commands::openproject::get_work_package_create_form,
            commands::openproject::list_available_assignees,
            commands::openproject::get_current_user,
            commands::openproject::list_projects,
            // Writes
            commands::openproject::create_time_entry,
            commands::openproject::update_time_entry,
            commands::openproject::delete_time_entry,
            commands::openproject::update_work_package,
            commands::openproject::create_work_package,
            // Shell
            commands::shell::open_work_package_in_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the OpenProject Time Tracker");
}
