//! The `opattach:` URI scheme — an authenticated proxy for attachment bytes.
//!
//! ## Why this exists
//!
//! `/api/v3/attachments/{id}/content` requires
//! `Authorization: Basic base64("apikey:<key>")`. An `<img src>` in the webview
//! sends no such header, and the key cannot be moved to the webview to make it:
//! "the webview never holds the API key" is the rule the whole architecture
//! rests on (`docs/architecture.md`). So an inline image in a description has
//! no URL the webview can load *directly* — with or without the instance
//! origin, it answers HTTP 401.
//!
//! Registering a scheme closes that gap without moving the secret. The webview
//! loads `opattach://localhost/{id}`; this handler resolves the credentials in
//! *this* process, fetches the bytes, and answers with them. From the page's
//! point of view it is an ordinary image URL.
//!
//! A Tauri command returning base64 would have worked too, and was rejected:
//! every `<img>` would need async src resolution and blob-URL bookkeeping, the
//! webview's own image cache would be bypassed, and the description editor —
//! which renders the same images through ProseMirror — would need the same
//! plumbing a second time.
//!
//! ## What it will and will not serve
//!
//! - **GET only.** Nothing here mutates, so any other method is refused before
//!   credentials are read.
//! - **A positive integer id, and nothing else.** The URL path is parsed to an
//!   `i64`; the request path is then rebuilt by the client from its own
//!   constant. No part of the incoming URL reaches a request.
//! - **The response body is bytes and a content type.** No error detail crosses
//!   into the page: a failure is a bare status code, because this response is
//!   read by an `<img>` tag, not by code that could render a message.
//!
//! On Windows, where WebView2 has no custom-scheme support, Tauri serves this
//! over `http://opattach.localhost/…` instead. Both spellings are produced by
//! `openproject::attachment_urls::attachment_proxy_url`, which is the only
//! place that split is written down.

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, UriSchemeResponder, Wry};

use crate::credentials::CredentialStore;
use crate::openproject::client::OpenProjectClient;

/// Cache attachment bytes in the webview for an hour.
///
/// An attachment's content is immutable in OpenProject — replacing a file means
/// uploading a new attachment with a new id — so the only thing a stale cache
/// entry can outlive is a delete, and a deleted attachment's image is broken
/// either way. Without this, every re-render of a description refetches every
/// inline image over the network.
const CACHE_CONTROL: &str = "private, max-age=3600";

/// Register the handler on the Tauri builder.
///
/// Asynchronous rather than blocking: the fetch is a network round trip, and the
/// synchronous form would hold the webview's resource-loading thread for its
/// duration — a description with six screenshots in it would load them one at a
/// time behind a stalled UI.
pub fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(&app, &request).await);
    });
}

/// The attachment id a proxy URL names.
///
/// `Some` only for a path that is exactly one positive-integer segment. A
/// trailing slash is tolerated (a webview may normalize the URL); anything else
/// — a nested path, a traversal attempt, a non-numeric segment — is `None`, and
/// the request is refused rather than guessed at.
fn attachment_id(path: &str) -> Option<i64> {
    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains('/') {
        return None;
    }
    match trimmed.parse::<i64>() {
        Ok(id) if id > 0 => Some(id),
        _ => None,
    }
}

/// A bare status, with no body.
///
/// The consumer is an `<img>` tag, which can render a broken-image icon and
/// nothing else. A message here would be unreadable *and* would put server
/// error text inside the page, which no other path in this app does.
fn refuse(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("a bodyless response builds")
}

async fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some(id) = attachment_id(request.uri().path()) else {
        return refuse(StatusCode::BAD_REQUEST);
    };

    let credentials = match CredentialStore::new(app).and_then(|store| store.credentials()) {
        Ok(Some(credentials)) => credentials,
        // No key stored, or the keychain refused. Either way there is nothing
        // to authenticate with, and onboarding is the frontend's job to raise.
        Ok(None) | Err(_) => return refuse(StatusCode::UNAUTHORIZED),
    };

    let client = match OpenProjectClient::new(credentials) {
        Ok(client) => client,
        Err(_) => return refuse(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let content = match client.fetch_attachment_content(id).await {
        Ok(content) => content,
        Err(error) => return refuse(status_for(&error.code)),
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, CACHE_CONTROL)
        // The bytes are a document, never a script or a page: a hostile
        // instance must not be able to have its own HTML rendered on this
        // app's own scheme just because a description linked to it.
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CONTENT_LENGTH, content.bytes.len());

    if let Some(content_type) = safe_content_type(content.content_type.as_deref()) {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }

    builder
        .body(content.bytes)
        .unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR))
}

/// The content type to label the response with, if the server's is usable.
///
/// `text/html` and friends are rewritten rather than forwarded: an attachment is
/// a download, and labelling one as HTML is what would let an uploaded file be
/// rendered as a document on this app's own scheme. `nosniff` above covers the
/// unlabelled case, so dropping the header entirely would be safe too.
fn safe_content_type(supplied: Option<&str>) -> Option<String> {
    const NEUTRAL: &str = "application/octet-stream";
    let value = supplied?.trim();
    if value.is_empty() || !value.is_ascii() || value.chars().any(char::is_control) {
        return Some(NEUTRAL.to_string());
    }
    let kind = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let renderable_as_a_document = matches!(
        kind.as_str(),
        "text/html" | "application/xhtml+xml" | "application/xml" | "text/xml" | "image/svg+xml"
    );
    if renderable_as_a_document {
        return Some(NEUTRAL.to_string());
    }
    Some(value.to_string())
}

/// Map our own error codes back onto HTTP, so a broken image at least carries a
/// diagnosable status in the devtools network panel.
fn status_for(code: &str) -> StatusCode {
    match code {
        "OPENPROJECT_AUTH_FAILED" => StatusCode::UNAUTHORIZED,
        "OPENPROJECT_NOT_FOUND" => StatusCode::NOT_FOUND,
        "OPENPROJECT_INVALID_INPUT" => StatusCode::BAD_REQUEST,
        "OPENPROJECT_TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_id_out_of_a_proxy_path() {
        assert_eq!(attachment_id("/391"), Some(391));
        assert_eq!(attachment_id("391"), Some(391));
        assert_eq!(attachment_id("/391/"), Some(391));
    }

    #[test]
    fn refuses_anything_that_is_not_one_positive_integer() {
        for path in [
            "/",
            "",
            "/0",
            "/-1",
            "/abc",
            "/391/content",
            "/../../etc/passwd",
            "/391abc",
            "/3 91",
        ] {
            assert_eq!(attachment_id(path), None, "{path}");
        }
    }

    #[test]
    fn an_id_too_large_for_an_i64_is_refused_rather_than_wrapped() {
        assert_eq!(attachment_id("/99999999999999999999999"), None);
    }

    #[test]
    fn a_document_content_type_is_neutralised() {
        for value in [
            "text/html",
            "TEXT/HTML; charset=utf-8",
            "image/svg+xml",
            "application/xhtml+xml",
        ] {
            assert_eq!(
                safe_content_type(Some(value)).as_deref(),
                Some("application/octet-stream"),
                "{value}"
            );
        }
    }

    #[test]
    fn an_ordinary_content_type_is_forwarded_verbatim() {
        assert_eq!(
            safe_content_type(Some("image/png")).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            safe_content_type(Some("application/pdf")).as_deref(),
            Some("application/pdf")
        );
    }

    #[test]
    fn a_missing_content_type_sets_no_header() {
        assert_eq!(safe_content_type(None), None);
    }

    #[test]
    fn a_content_type_that_could_forge_a_header_is_neutralised() {
        assert_eq!(
            safe_content_type(Some("image/png\r\nX-Evil: 1")).as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(
            safe_content_type(Some("   ")).as_deref(),
            Some("application/octet-stream")
        );
    }

    #[test]
    fn error_codes_map_onto_diagnosable_statuses() {
        assert_eq!(
            status_for("OPENPROJECT_AUTH_FAILED"),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(status_for("OPENPROJECT_NOT_FOUND"), StatusCode::NOT_FOUND);
        assert_eq!(
            status_for("OPENPROJECT_SCHEMA_FAILED"),
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn a_refusal_carries_no_body() {
        let response = refuse(StatusCode::UNAUTHORIZED);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.body().is_empty());
    }
}
