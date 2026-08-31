//! Credential commands, plus the connection probe.
//!
//! Port of `src/main/ipc/credentials.ts` and `src/main/ipc/test-connection.ts`.

use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;

use crate::credentials::{ConnectionInfo, CredentialStore, Credentials};
use crate::error::AppError;
use crate::openproject::client::OpenProjectClient;
use crate::util::validation::{validate_api_key, validate_base_url};

/// The probe gets a shorter leash than a data request: it runs while the user
/// watches a spinner in a form, so a slow failure is worse than an early one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialsInput {
    pub base_url: String,
    /// Omit (or pass empty) to keep the API key already in the keychain — the
    /// webview can't echo back a key it never receives, so this is how a
    /// URL-only change is expressed. Required when nothing is stored yet.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Input for the connection probe: unsaved form values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionInput {
    pub base_url: String,
    /// Omit to probe with the stored key (resolved here, never sent back).
    #[serde(default)]
    pub api_key: Option<String>,
}

/// The probe's result.
///
/// A failure is a **value**, not an error: "your key is wrong" is the normal,
/// expected outcome of a test button, and the form shows it inline rather than
/// treating it as an exception. Never includes the key or the base URL.
#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub enum TestConnectionResult {
    Ok { ok: bool },
    Err { ok: bool, error: String },
}

impl TestConnectionResult {
    fn success() -> Self {
        TestConnectionResult::Ok { ok: true }
    }

    fn failure(error: impl Into<String>) -> Self {
        TestConnectionResult::Err {
            ok: false,
            error: error.into(),
        }
    }
}

#[tauri::command]
pub fn has_credentials(app: AppHandle) -> Result<bool, AppError> {
    CredentialStore::new(&app)?.has_credentials()
}

#[tauri::command]
pub fn get_connection_info(app: AppHandle) -> Result<ConnectionInfo, AppError> {
    CredentialStore::new(&app)?.connection_info()
}

#[tauri::command]
pub fn save_credentials(app: AppHandle, input: SaveCredentialsInput) -> Result<(), AppError> {
    CredentialStore::new(&app)?.save(&input.base_url, input.api_key.as_deref())
}

#[tauri::command]
pub fn clear_credentials(app: AppHandle) -> Result<(), AppError> {
    CredentialStore::new(&app)?.clear()
}

/// Probe the server with the unsaved form values to verify the pair
/// authenticates before saving.
///
/// The key is user-entered, used once here, never logged, never persisted by
/// this command, and never returned in the result.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    input: TestConnectionInput,
) -> Result<TestConnectionResult, AppError> {
    let base_url = match validate_base_url(&input.base_url) {
        Ok(base_url) => base_url,
        Err(error) => return Ok(TestConnectionResult::failure(error)),
    };

    let candidate = match input.api_key {
        Some(key) if !key.trim().is_empty() => key,
        // Nothing typed: probe with the stored key, so "test" works on a
        // settings form that shows a saved key it cannot display.
        _ => match CredentialStore::new(&app)?.credentials() {
            Ok(Some(stored)) => stored.api_key,
            Ok(None) => {
                return Ok(TestConnectionResult::failure(
                    "Enter an API key to test the connection.",
                ))
            }
            Err(error) => return Ok(TestConnectionResult::failure(error.message)),
        },
    };
    let api_key = match validate_api_key(&candidate) {
        Ok(api_key) => api_key,
        Err(error) => return Ok(TestConnectionResult::failure(error)),
    };

    let client = OpenProjectClient::with_timeout(Credentials { base_url, api_key }, PROBE_TIMEOUT)?;
    match client.test_connection().await {
        Ok(()) => Ok(TestConnectionResult::success()),
        Err(error) => Ok(TestConnectionResult::failure(error.message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_result_serializes_as_the_discriminated_union_the_form_reads() {
        let ok = serde_json::to_value(TestConnectionResult::success()).unwrap();
        assert_eq!(ok["ok"], true);
        assert!(ok.get("error").is_none());

        let err = serde_json::to_value(TestConnectionResult::failure("nope")).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"], "nope");
    }

    #[test]
    fn save_input_accepts_a_url_only_change() {
        let input: SaveCredentialsInput =
            serde_json::from_str(r#"{"baseUrl":"https://op.example.com"}"#).unwrap();
        assert_eq!(input.base_url, "https://op.example.com");
        assert_eq!(input.api_key, None);
    }
}
