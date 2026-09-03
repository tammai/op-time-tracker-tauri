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

pub mod attachment_protocol;
pub mod commands;
pub mod credentials;
pub mod error;
pub mod openproject;
pub mod schemas;
pub mod staged_attachments;
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
        // Registered for its *Rust* API only — the native file picker and save
        // dialog, opened by `commands::attachments`. The frontend is not
        // granted the plugin's JS permission, so a filesystem path is never
        // chosen by, or handed to, the webview.
        .plugin(tauri_plugin_dialog::init())
        // The `opattach:` scheme: an authenticated proxy for attachment bytes,
        // so an inline image in a description has a URL an `<img>` can actually
        // load without the webview ever holding the API key. See
        // `attachment_protocol`.
        .register_asynchronous_uri_scheme_protocol(
            openproject::attachment_urls::ATTACHMENT_SCHEME,
            attachment_protocol::handle,
        )
        // Files chosen for a work package that does not exist yet. Held here so
        // the paths never cross into the webview — see `staged_attachments`.
        .manage(staged_attachments::StagingArea::default())
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
            commands::attachments::list_work_package_attachments,
            // Writes
            commands::openproject::create_time_entry,
            commands::openproject::update_time_entry,
            commands::openproject::delete_time_entry,
            commands::openproject::update_work_package,
            commands::openproject::create_work_package,
            commands::attachments::upload_work_package_attachments,
            commands::attachments::upload_work_package_attachment_data,
            commands::attachments::delete_attachment,
            commands::attachments::save_attachment,
            commands::attachments::stage_attachment_files,
            commands::attachments::discard_staged_attachment,
            commands::attachments::upload_staged_attachments,
            // Shell
            commands::shell::open_work_package_in_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the OpenProject Time Tracker");
}
