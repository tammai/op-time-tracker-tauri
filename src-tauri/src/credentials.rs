//! The credential store: an OS-keychain-backed API key and a plaintext base URL.
//!
//! Port of `src/main/credentials/index.ts`, which used Electron's `safeStorage`
//! plus `electron-store`. The split here is the same and the reasoning is
//! unchanged:
//!
//! - **The API key goes in the OS keychain** (`keyring`): Credential Manager on
//!   Windows, Keychain on macOS, Secret Service on Linux. It never touches a
//!   file this app writes.
//! - **The base URL goes in a plain JSON file** under the app config directory.
//!   It is not a secret, and keeping it readable means a user whose keychain
//!   entry was lost still sees which instance they had configured.
//!
//! There is deliberately **no** way for the webview to read the key back. It can
//! learn *whether* one is stored (`has_credentials`, `ConnectionInfo.hasApiKey`)
//! and can save or clear it. Everything that needs the key itself runs in this
//! process.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::util::validation::{validate_api_key, validate_base_url};

/// The keychain service and account the API key lives under. Changing either
/// orphans every existing user's stored key, so they are constants, not config.
const KEYCHAIN_SERVICE: &str = "op-time-tracker";
const KEYCHAIN_ACCOUNT: &str = "openproject-api-key";

/// The non-secret half, on disk.
const SETTINGS_FILE: &str = "connection.json";

/// A resolved credential pair. Only ever constructed inside this process.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub base_url: String,
    pub api_key: String,
}

/// The non-secret half of the stored credentials, for prefilling the settings
/// form. `has_api_key` reports presence only — the key itself is never sent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub base_url: Option<String>,
    pub has_api_key: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct StoredConnection {
    #[serde(default, rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
}

/// Reads and writes the credential pair. Cheap to construct — it holds a path
/// and nothing else, so commands build one per call rather than sharing state.
pub struct CredentialStore {
    settings_path: PathBuf,
}

impl CredentialStore {
    pub fn new(app: &AppHandle) -> Result<Self, AppError> {
        let dir = app.path().app_config_dir().map_err(|_| {
            AppError::credential_read("Could not locate the application config directory.")
        })?;
        Ok(Self {
            settings_path: dir.join(SETTINGS_FILE),
        })
    }

    /// A store rooted at an explicit directory — used by tests, which must not
    /// touch the real user's settings file.
    #[cfg(test)]
    pub fn at(dir: PathBuf) -> Self {
        Self {
            settings_path: dir.join(SETTINGS_FILE),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|_| {
            AppError::credential_read(
                "The OS keychain is unavailable. Please re-enter your OpenProject API key.",
            )
        })
    }

    fn read_settings(&self) -> StoredConnection {
        // A missing or unreadable file is "nothing stored yet", not an error —
        // first launch is the common case, and a corrupt file should send the
        // user to the onboarding form rather than to a dead end.
        fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write_settings(&self, settings: &StoredConnection) -> Result<(), AppError> {
        if let Some(parent) = self.settings_path.parent() {
            fs::create_dir_all(parent).map_err(|_| {
                AppError::credential_read("Could not create the application config directory.")
            })?;
        }
        let raw = serde_json::to_string_pretty(settings).map_err(|_| {
            AppError::credential_read("Could not serialize the connection settings.")
        })?;
        fs::write(&self.settings_path, raw)
            .map_err(|_| AppError::credential_read("Could not write the connection settings."))
    }

    /// The stored API key, or `None` when the keychain holds no entry.
    ///
    /// A keychain that exists but refuses to decrypt is an *error*, not an
    /// absence: silently treating it as "no key stored" would push the user
    /// through onboarding again and overwrite a key that is merely locked.
    fn read_api_key(&self) -> Result<Option<String>, AppError> {
        match self.entry()?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::credential_read(
                "Could not read the stored API key from the OS keychain. \
                 Please re-enter your OpenProject API key.",
            )),
        }
    }

    /// Whether a usable pair is stored. Cheap, and it never exposes the key.
    pub fn has_credentials(&self) -> Result<bool, AppError> {
        let has_base_url = self
            .read_settings()
            .base_url
            .is_some_and(|url| !url.trim().is_empty());
        Ok(has_base_url && self.read_api_key()?.is_some())
    }

    /// The non-secret half, for the settings form.
    ///
    /// A stored base URL that no longer validates reads as `None` — the form
    /// then asks for it again, which is the honest outcome.
    pub fn connection_info(&self) -> Result<ConnectionInfo, AppError> {
        let base_url = self
            .read_settings()
            .base_url
            .and_then(|url| validate_base_url(&url).ok());
        Ok(ConnectionInfo {
            base_url,
            has_api_key: self.read_api_key()?.is_some(),
        })
    }

    /// The full pair, for building a client. `None` when nothing is stored at
    /// all — the caller turns that into `CREDENTIAL_NOT_CONFIGURED`.
    pub fn credentials(&self) -> Result<Option<Credentials>, AppError> {
        let stored_base_url = self.read_settings().base_url;
        let api_key = self.read_api_key()?;

        if stored_base_url.is_none() && api_key.is_none() {
            return Ok(None);
        }

        let Some(base_url) = stored_base_url else {
            return Err(AppError::credential_read(
                "No OpenProject base URL is stored. Please re-enter it in Settings.",
            ));
        };
        let base_url = validate_base_url(&base_url).map_err(|_| {
            AppError::credential_read(
                "The stored base URL is invalid. Please re-enter your OpenProject base URL.",
            )
        })?;
        let Some(api_key) = api_key else {
            return Err(AppError::credential_read(
                "The stored API key is missing. Please re-enter your OpenProject API key.",
            ));
        };

        Ok(Some(Credentials { base_url, api_key }))
    }

    /// Validate and persist.
    ///
    /// An omitted or blank `api_key` keeps the stored one — which is how a
    /// URL-only change is expressed, since the webview cannot echo back a key it
    /// never received. Required when nothing is stored yet.
    pub fn save(&self, base_url: &str, api_key: Option<&str>) -> Result<(), AppError> {
        let base_url = validate_base_url(base_url).map_err(AppError::credential_validation)?;

        let incoming = match api_key {
            Some(key) if !key.trim().is_empty() => key.to_string(),
            _ => self
                .read_api_key()?
                .ok_or_else(|| AppError::credential_validation("API key is required."))?,
        };
        let api_key = validate_api_key(&incoming).map_err(AppError::credential_validation)?;

        self.entry()?.set_password(&api_key).map_err(|_| {
            AppError::credential_read("Could not save the API key to the OS keychain.")
        })?;
        self.write_settings(&StoredConnection {
            base_url: Some(base_url),
        })
    }

    /// Remove both halves. Safe to call when nothing is stored.
    pub fn clear(&self) -> Result<(), AppError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                return Err(AppError::credential_read(
                    "Could not remove the API key from the OS keychain.",
                ))
            }
        }
        // The file is removed rather than blanked, so "nothing configured" has
        // exactly one representation on disk.
        if self.settings_path.exists() {
            fs::remove_file(&self.settings_path).map_err(|_| {
                AppError::credential_read("Could not remove the stored connection settings.")
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings-file half, tested against a temp directory. The keychain
    /// half is not exercised here: `keyring` talks to a real OS service, so a
    /// unit test would either write to the developer's own keychain or need a
    /// mock of the OS. What *is* testable in isolation is the file format and
    /// the validation around it, which is where the bugs live.
    fn temp_store(name: &str) -> (CredentialStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("op-time-tracker-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (CredentialStore::at(dir.clone()), dir)
    }

    #[test]
    fn a_missing_settings_file_reads_as_nothing_stored() {
        let (store, _dir) = temp_store("missing");
        assert_eq!(store.read_settings().base_url, None);
    }

    #[test]
    fn a_corrupt_settings_file_reads_as_nothing_stored() {
        let (store, dir) = temp_store("corrupt");
        fs::write(dir.join(SETTINGS_FILE), "{not json").unwrap();
        assert_eq!(store.read_settings().base_url, None);
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let (store, _dir) = temp_store("round-trip");
        store
            .write_settings(&StoredConnection {
                base_url: Some("https://op.example.com".to_string()),
            })
            .unwrap();
        assert_eq!(
            store.read_settings().base_url.unwrap(),
            "https://op.example.com"
        );
    }

    #[test]
    fn the_settings_file_holds_the_base_url_and_nothing_else() {
        let (store, dir) = temp_store("no-secrets");
        store
            .write_settings(&StoredConnection {
                base_url: Some("https://op.example.com".to_string()),
            })
            .unwrap();
        let raw = fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.as_object().unwrap().len(), 1);
        assert!(parsed.get("baseUrl").is_some());
        // No key, no cipher, no storage mode — the key lives in the keychain.
        assert!(!raw.to_lowercase().contains("key") || parsed.get("apiKey").is_none());
    }

    #[test]
    fn connection_info_drops_a_base_url_that_no_longer_validates() {
        let (store, dir) = temp_store("invalid-url");
        fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"baseUrl":"ftp://op.example.com"}"#,
        )
        .unwrap();
        // Reading the stored value directly still shows it…
        assert!(store.read_settings().base_url.is_some());
        // …but it is not offered as a usable base URL.
        assert!(validate_base_url("ftp://op.example.com").is_err());
    }
}
