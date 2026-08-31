//! Opening a work package in the user's browser.
//!
//! Port of `src/main/ipc/shell.ts`, and the security model is the point of the
//! whole file. The only value crossing from the webview is a **numeric id** —
//! not a URL, not an href, not a path. This process validates it as a positive
//! integer, builds `<stored base URL>/work_packages/<id>` itself, and re-asserts
//! http(s) before handing anything to the OS.
//!
//! It never builds the URL from a server-supplied `_links.self.href`: a hostile
//! or compromised instance could otherwise choose what the user's machine is
//! asked to open. The API key is not involved and never appears in the opened
//! URL.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::credentials::CredentialStore;
use crate::error::AppError;
use crate::openproject::url::build_request_url;

/// The web (not API) path a work package is browsable at.
const WORK_PACKAGE_WEB_PATH: &str = "/work_packages";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkPackageInBrowserInput {
    pub work_package_id: i64,
}

/// Build the browsable URL for a work package, refusing anything that is not
/// http(s).
///
/// Separated from the command so the URL rule is testable without an OS opener.
pub fn build_work_package_web_url(
    base_url: &str,
    work_package_id: i64,
) -> Result<String, AppError> {
    let url = build_request_url(
        base_url,
        &format!("{WORK_PACKAGE_WEB_PATH}/{work_package_id}"),
        &[],
    )
    .map_err(|_| {
        AppError::shell_unsafe_target(
            "The configured OpenProject URL could not be used to build a link.",
        )
    })?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::shell_unsafe_target(
            "Refusing to open a link that is not an http(s) address.",
        ));
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn open_work_package_in_browser(
    app: AppHandle,
    input: OpenWorkPackageInBrowserInput,
) -> Result<(), AppError> {
    // Rejected before credentials are even read.
    if input.work_package_id <= 0 {
        return Err(AppError::shell_invalid_input());
    }

    let base_url = CredentialStore::new(&app)?
        .connection_info()?
        .base_url
        .ok_or_else(|| {
            AppError::new(
                "CREDENTIAL_NOT_CONFIGURED",
                "No usable OpenProject URL is configured. Open Settings and re-enter it.",
            )
        })?;

    let url = build_work_package_web_url(&base_url, input.work_package_id)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| AppError::shell_open_failed())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_web_url_from_the_stored_base_url() {
        assert_eq!(
            build_work_package_web_url("https://op.example.com", 42).unwrap(),
            "https://op.example.com/work_packages/42"
        );
        // A base URL with a path prefix keeps it.
        assert_eq!(
            build_work_package_web_url("https://op.example.com/op", 42).unwrap(),
            "https://op.example.com/op/work_packages/42"
        );
    }

    #[test]
    fn refuses_a_non_http_target() {
        let error = build_work_package_web_url("file:///etc/passwd", 42).unwrap_err();
        assert_eq!(error.code, "SHELL_UNSAFE_TARGET");
    }

    #[test]
    fn refuses_an_unparseable_base_url() {
        let error = build_work_package_web_url("not a url", 42).unwrap_err();
        assert_eq!(error.code, "SHELL_UNSAFE_TARGET");
    }

    #[test]
    fn the_opened_url_never_carries_userinfo() {
        let url = build_work_package_web_url("https://user:secret@op.example.com", 42).unwrap();
        assert!(!url.contains("secret"));
        assert_eq!(url, "https://op.example.com/work_packages/42");
    }
}
