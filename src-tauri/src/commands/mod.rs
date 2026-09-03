//! The command surface — the boundary the webview talks through.
//!
//! Port of `src/main/ipc/*.ts`. One `#[tauri::command]` per method of the old
//! `window.openproject` bridge, with the same names in snake_case and the same
//! argument shapes, so the frontend's bridge module is a thin `invoke` wrapper
//! rather than a rewrite.
//!
//! Every command:
//!
//! 1. validates its input here, before anything is built from it — the webview
//!    is an untrusted input source, whatever the form did first;
//! 2. resolves credentials in this process, so the API key never crosses;
//! 3. returns `Result<T, AppError>`, i.e. `{ code, message }` on failure.
//!
//! There is deliberately no `get_credentials` command. The webview can learn
//! *whether* a key is stored and can save or clear one; it can never read one.

pub mod attachments;
pub mod credentials;
pub mod openproject;
pub mod shell;
