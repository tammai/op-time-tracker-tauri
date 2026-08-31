//! The one error type that crosses into the webview.
//!
//! Every command returns `Result<T, AppError>`, and `AppError` serializes to
//! `{ "code", "message" }` — the same contract the Electron app's `IpcError`
//! carried, so the frontend's `err.code === 'OPENPROJECT_CONFLICT'` branches
//! and its `err.message` alerts work unchanged.
//!
//! Two rules hold for every message built here (`docs/security.md`):
//!
//! 1. The API key never appears in one. Not in a URL, not in a header dump, not
//!    in a "could not reach" cause chain.
//! 2. A raw response body is never forwarded. Only the `message` fields
//!    OpenProject's own error schema declares are, and only for the statuses
//!    where the text is about *our* request (400, 422, other 4xx) rather than
//!    about user data.

use serde::Serialize;

/// A stable machine-readable code plus a human-facing message.
///
/// The codes are the Electron app's, verbatim — they are the frontend's API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    // Credential store

    pub fn credential_validation(message: impl Into<String>) -> Self {
        Self::new("CREDENTIAL_VALIDATION_FAILED", message)
    }

    pub fn credential_read(message: impl Into<String>) -> Self {
        Self::new("CREDENTIAL_READ_FAILED", message)
    }

    pub fn credential_not_configured() -> Self {
        Self::new(
            "CREDENTIAL_NOT_CONFIGURED",
            "No OpenProject credentials are configured. Please complete onboarding.",
        )
    }

    // OpenProject client

    /// Input rejected **before** any HTTP call, because it failed validation
    /// here. The message is ours, so it is safe to forward.
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_INVALID_INPUT", message)
    }

    pub fn auth_failed(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_AUTH_FAILED", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_NOT_FOUND", message)
    }

    pub fn server_error(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_SERVER_ERROR", message)
    }

    pub fn http_error(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_HTTP_ERROR", message)
    }

    /// The response body did not match the shape we parse. Deliberately
    /// generic: where it failed is logged, not returned.
    pub fn schema_failed() -> Self {
        Self::new(
            "OPENPROJECT_SCHEMA_FAILED",
            "The OpenProject server returned an unexpected response shape.",
        )
    }

    /// HTTP 422 — the one place a server-authored string is forwarded, because
    /// the whole point is to say *which* field OpenProject refused.
    pub fn validation_failed(message: impl Into<String>) -> Self {
        Self::new("OPENPROJECT_VALIDATION_FAILED", message)
    }

    /// HTTP 409 — optimistic-locking failure. Its own code is what lets the
    /// frontend refetch-and-discard instead of retrying.
    pub fn conflict() -> Self {
        Self::new(
            "OPENPROJECT_CONFLICT",
            "This item was changed on the server since you loaded it.",
        )
    }

    pub fn timeout(timeout_secs: u64) -> Self {
        Self::new(
            "OPENPROJECT_TIMEOUT",
            format!("The OpenProject server did not respond within {timeout_secs}s."),
        )
    }

    // Shell

    pub fn shell_invalid_input() -> Self {
        Self::new(
            "SHELL_INVALID_INPUT",
            "A work package id must be a positive integer.",
        )
    }

    pub fn shell_unsafe_target(message: impl Into<String>) -> Self {
        Self::new("SHELL_UNSAFE_TARGET", message)
    }

    pub fn shell_open_failed() -> Self {
        Self::new(
            "SHELL_OPEN_FAILED",
            "Could not open the work package in your browser.",
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_code_message_pair_the_frontend_reads() {
        let json = serde_json::to_value(AppError::conflict()).unwrap();
        assert_eq!(json["code"], "OPENPROJECT_CONFLICT");
        assert_eq!(
            json["message"],
            "This item was changed on the server since you loaded it."
        );
        // Nothing else — no cause chain, no stack, no request detail.
        assert_eq!(json.as_object().unwrap().len(), 2);
    }
}
