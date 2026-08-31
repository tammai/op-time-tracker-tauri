//! The OpenProject REST API v3 client.
//!
//! Port of `src/main/openproject/client.ts`. This is the **single** place
//! OpenProject HTTP happens. The webview never sees the API key, the auth
//! header, or a raw response body — it receives parsed models, or an
//! `AppError` carrying a stable code.
//!
//! Security properties this file is responsible for (`docs/security.md`):
//!
//! - The API key is a secret: never logged, never in an error message, never
//!   returned. It exists on the client struct and in one header.
//! - Request URLs come from `build_request_url` plus a path constant. A
//!   server-supplied href never steers a request — where OpenProject's own HAL
//!   points at a collection, the constant is rebuilt from a validated integer
//!   instead of following the href.
//! - Responses are parsed into declared shapes. A malformed or hostile server
//!   cannot inject an arbitrary shape into the webview; the worst it can do is
//!   fail the parse, which surfaces as `OPENPROJECT_SCHEMA_FAILED`.
//! - Error text is ours, except for the statuses where OpenProject's own
//!   `message` explains *our* request (400, 422, other 4xx) — and even then only
//!   the schema-declared `message` fields, length-capped.

use std::time::Duration;

use base64::Engine;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::credentials::Credentials;
use crate::error::AppError;
use crate::openproject::attachment_urls::{absolutize_attachment_urls, relativize_attachment_urls};
use crate::openproject::filters::{
    clamp_page_size, encode_time_entry_params, encode_work_package_params, TimeEntryFilters,
    WorkPackageFilters,
};
use crate::openproject::url::build_request_url;
use crate::schemas::common::Collection;
use crate::schemas::principals::{Principal, PrincipalCollection};
use crate::schemas::projects::ProjectCollection;
use crate::schemas::statuses::StatusCollection;
use crate::schemas::time_entries::{
    build_time_entry_payload, extract_activities_from_form, CreateTimeEntryInput, TimeEntry,
    TimeEntryActivityCollection, TimeEntryCollection, UpdateTimeEntryInput,
};
use crate::schemas::work_packages::{
    normalize_work_package_create_form, normalize_work_package_form, AvailableAssigneesInput,
    CreateWorkPackageInput, UpdateWorkPackageInput, WorkPackage, WorkPackageCollection,
    WorkPackageCreateForm, WorkPackageCreateFormInput, WorkPackageForm, WorkPackageFormInput,
};
use crate::util::hal::{PROJECT_PATH, TIME_ENTRY_PATH, TYPE_PATH, USER_PATH, WORK_PACKAGE_PATH};
use crate::util::validation::validate_positive_id;

/// Default request timeout.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Page size used when `list_time_entries` follows pagination itself. Large
/// enough that a month of entries is one request in practice; the loop stays
/// correct if the instance clamps it lower.
const ALL_ENTRIES_PAGE_SIZE: i64 = 200;

/// Hard ceiling on pages `list_time_entries` will follow.
const MAX_FOLLOWED_PAGES: i64 = 25;

/// Page size for the assignees and projects selects. Both answer a small
/// question ("who may be assigned here?", "where may I create?") and neither
/// select paginates, so one generous page is the whole list in practice — still
/// passed through `clamp_page_size` so the ceiling lives in one place.
const SMALL_COLLECTION_PAGE_SIZE: i64 = 200;

/// The collection of projects a work package may be created in.
///
/// Deliberately not `/api/v3/projects`: that lists what the key can *see*, which
/// includes projects it cannot create in, and offering one produces a create that
/// fails only after the form is filled in.
fn available_projects_path() -> String {
    format!("{WORK_PACKAGE_PATH}/available_projects")
}

/// Cap on how much server-authored error text is forwarded.
const MAX_API_ERROR_MESSAGE_LENGTH: usize = 500;

/// Pull a human-readable message out of an OpenProject error body.
///
/// Reads **only** the `message` fields — the top-level one and those of any
/// `_embedded.errors` entries — never the raw body, which can echo request
/// content. `None` when the body is not a recognisable OpenProject error, so the
/// caller falls back to a generic message.
pub fn extract_api_error_message(raw_body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw_body).ok()?;

    let mut messages: Vec<String> = Vec::new();
    if let Some(message) = parsed.get("message").and_then(Value::as_str) {
        messages.push(message.to_string());
    }
    if let Some(errors) = parsed
        .get("_embedded")
        .and_then(|e| e.get("errors"))
        .and_then(Value::as_array)
    {
        for error in errors {
            if let Some(message) = error.get("message").and_then(Value::as_str) {
                if !messages.iter().any(|existing| existing == message) {
                    messages.push(message.to_string());
                }
            }
        }
    }

    let joined = messages
        .iter()
        .map(|message| message.trim())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if joined.is_empty() {
        return None;
    }
    if joined.chars().count() > MAX_API_ERROR_MESSAGE_LENGTH {
        let truncated: String = joined.chars().take(MAX_API_ERROR_MESSAGE_LENGTH).collect();
        return Some(format!("{truncated}…"));
    }
    Some(joined)
}

/// Log **where** a response failed to parse — the serde path and reason — so
/// schema drift is diagnosable without that detail reaching the webview.
///
/// serde reports a field path and a type mismatch, not the offending value, so
/// nothing user-authored is logged: a work package subject or comment never
/// reaches stderr.
fn log_parse_failure(context: &str, error: &serde_json::Error) {
    eprintln!(
        "[openproject] {context}: response did not match the expected shape at line {}, column {} — {}",
        error.line(),
        error.column(),
        error.classify_as_str()
    );
}

/// serde's error classification, as a short label.
trait ClassifyAsStr {
    fn classify_as_str(&self) -> &'static str;
}

impl ClassifyAsStr for serde_json::Error {
    fn classify_as_str(&self) -> &'static str {
        match self.classify() {
            serde_json::error::Category::Io => "io error",
            serde_json::error::Category::Syntax => "malformed JSON",
            serde_json::error::Category::Data => "unexpected type or missing field",
            serde_json::error::Category::Eof => "truncated response",
        }
    }
}

pub struct OpenProjectClient {
    credentials: Credentials,
    http: reqwest::Client,
    timeout: Duration,
}

impl OpenProjectClient {
    pub fn new(credentials: Credentials) -> Result<Self, AppError> {
        Self::with_timeout(credentials, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(credentials: Credentials, timeout: Duration) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            // Auth is a header on every request; the client holds no cookie
            // jar of its own (the `cookies` feature is not enabled).
            .timeout(timeout)
            .build()
            .map_err(|_| AppError::server_error("Could not initialize the HTTP client."))?;
        Ok(Self {
            credentials,
            http,
            timeout,
        })
    }

    // Reads

    /// `GET /api/v3/work_packages`.
    ///
    /// A title search is an ordinary filtered collection request — one round
    /// trip, server-ordered, whatever the user can see.
    pub async fn list_work_packages(
        &self,
        filters: &WorkPackageFilters,
    ) -> Result<WorkPackageCollection, AppError> {
        let params = encode_work_package_params(filters).map_err(AppError::invalid_input)?;
        let url = build_request_url(&self.credentials.base_url, WORK_PACKAGE_PATH, &params)
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        let mut collection: WorkPackageCollection = self.parse(body, "list_work_packages")?;
        for work_package in &mut collection.embedded.elements {
            self.absolutize_description(work_package);
        }
        Ok(collection)
    }

    /// `GET /api/v3/time_entries`, returning **every** matching entry rather
    /// than the first page.
    ///
    /// Callers ask a question about a date range — "how much did I log this
    /// month" — so a partial answer is a wrong answer, and OpenProject's default
    /// page size is 20. Pages are followed until the collected count reaches the
    /// server's reported total, and the merged result reports what was actually
    /// collected.
    ///
    /// An explicit `offset` means the caller is driving pagination itself, so
    /// that request is passed straight through as a single page.
    pub async fn list_time_entries(
        &self,
        filters: &TimeEntryFilters,
    ) -> Result<TimeEntryCollection, AppError> {
        if filters.offset.is_some() {
            return self.fetch_time_entry_page(filters).await;
        }

        let page_size = filters.page_size.unwrap_or(ALL_ENTRIES_PAGE_SIZE);
        let first = self
            .fetch_time_entry_page(&TimeEntryFilters {
                page_size: Some(page_size),
                offset: Some(1),
                ..filters.clone()
            })
            .await?;

        let total = first.total;
        let type_name = first.type_name.clone();
        let mut elements = first.embedded.elements;

        let mut page = 2;
        while (elements.len() as i64) < total {
            // Safety valve: a server that keeps reporting an unreachable total
            // (or clamps `pageSize` to 1) must not spin forever.
            if page > MAX_FOLLOWED_PAGES {
                break;
            }
            let next = self
                .fetch_time_entry_page(&TimeEntryFilters {
                    page_size: Some(page_size),
                    offset: Some(page),
                    ..filters.clone()
                })
                .await?;
            // An empty page means there is nothing left, whatever `total` claims.
            if next.embedded.elements.is_empty() {
                break;
            }
            elements.extend(next.embedded.elements);
            page += 1;
        }

        let count = elements.len() as i64;
        Ok(TimeEntryCollection {
            type_name,
            total,
            count,
            embedded: crate::schemas::common::CollectionElements { elements },
        })
    }

    async fn fetch_time_entry_page(
        &self,
        filters: &TimeEntryFilters,
    ) -> Result<TimeEntryCollection, AppError> {
        let params = encode_time_entry_params(filters);
        let url = build_request_url(&self.credentials.base_url, TIME_ENTRY_PATH, &params)
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        self.parse(body, "list_time_entries")
    }

    /// `GET /api/v3/statuses` — the whole instance-wide status set. No filters
    /// or pagination; the set is small.
    pub async fn list_statuses(&self) -> Result<StatusCollection, AppError> {
        let url = build_request_url(&self.credentials.base_url, "/api/v3/statuses", &[])
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        self.parse(body, "list_statuses")
    }

    /// The activities that may be assigned to a time entry.
    ///
    /// Uses the form endpoint rather than a dedicated activities collection: the
    /// form's schema is the authoritative source of *allowed* values, and its
    /// shape is stable across OpenProject versions. Passing `work_package_id`
    /// scopes the allowed set to that work package's project, which is what the
    /// form does for a real entry.
    pub async fn list_time_entry_activities(
        &self,
        work_package_id: Option<i64>,
    ) -> Result<TimeEntryActivityCollection, AppError> {
        // Only a validated positive integer is ever interpolated into the href.
        let payload = match work_package_id {
            Some(id) if id > 0 => json!({
                "_links": { "workPackage": { "href": format!("{WORK_PACKAGE_PATH}/{id}") } }
            }),
            _ => json!({}),
        };

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{TIME_ENTRY_PATH}/form"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::POST, url, Some(payload)).await?;
        let form: Value = self.parse(body, "list_time_entry_activities")?;
        Ok(Collection::of(
            "Collection",
            extract_activities_from_form(&form),
        ))
    }

    /// `POST /api/v3/work_packages/{id}/form` — the allowed values for the
    /// editable fields of one work package.
    ///
    /// A POST that reads: OpenProject's form endpoint validates a hypothetical
    /// payload and answers with the resulting schema without persisting anything.
    /// Two things keep that safe — the body is built here and holds exactly the
    /// validated `lockVersion`, so nothing frontend-supplied is forwarded and
    /// this cannot become a write primitive; and the id is a validated positive
    /// integer before it reaches the path.
    ///
    /// `lockVersion` is required, not decorative: the endpoint answers HTTP 409
    /// without one, which makes a stale lock version surface here, before the
    /// user has typed anything.
    pub async fn get_work_package_form(
        &self,
        input: &WorkPackageFormInput,
    ) -> Result<WorkPackageForm, AppError> {
        let (work_package_id, lock_version) = input.validate().map_err(AppError::invalid_input)?;

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{WORK_PACKAGE_PATH}/{work_package_id}/form"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        // Rebuilt from the validated integer — never the caller's object, so no
        // extra key can ride along.
        let body = self
            .request(
                Method::POST,
                url,
                Some(json!({ "lockVersion": lock_version })),
            )
            .await?;
        let form: Value = self.parse(body, "get_work_package_form")?;
        Ok(normalize_work_package_form(&form))
    }

    /// `POST /api/v3/projects/{id}/work_packages/form` — the allowed values,
    /// writability, and OpenProject's own defaults for a *new* work package.
    ///
    /// A POST that reads, on the same terms as `get_work_package_form`, but it
    /// takes **no** lock version: nothing exists yet to be stale against, so an
    /// empty body is accepted. When a type is chosen the body is one href,
    /// rebuilt here from the validated integer.
    pub async fn get_work_package_create_form(
        &self,
        input: &WorkPackageCreateFormInput,
    ) -> Result<WorkPackageCreateForm, AppError> {
        let (project_id, type_id) = input.validate().map_err(AppError::invalid_input)?;

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{PROJECT_PATH}/{project_id}/work_packages/form"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let payload = match type_id {
            None => json!({}),
            Some(type_id) => {
                json!({ "_links": { "type": { "href": format!("{TYPE_PATH}/{type_id}") } } })
            }
        };
        let body = self.request(Method::POST, url, Some(payload)).await?;
        let form: Value = self.parse(body, "get_work_package_create_form")?;
        Ok(normalize_work_package_create_form(&form))
    }

    /// `GET /api/v3/projects/{id}/available_assignees` — who a work package in
    /// this project may be assigned to.
    ///
    /// A **project** resource, not a work-package one: the work-package-scoped
    /// route answers HTTP 404 on a real instance, and the form's `assignee`
    /// allowed-values href points here instead. That href is deliberately *not*
    /// followed — the frontend sends the project id it read off the work package
    /// it already holds, and the path is rebuilt here.
    pub async fn list_available_assignees(
        &self,
        input: &AvailableAssigneesInput,
    ) -> Result<PrincipalCollection, AppError> {
        let project_id = input.validate().map_err(AppError::invalid_input)?;

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{PROJECT_PATH}/{project_id}/available_assignees"),
            &[(
                "pageSize",
                clamp_page_size(SMALL_COLLECTION_PAGE_SIZE).to_string(),
            )],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        self.parse(body, "list_available_assignees")
    }

    /// `GET /api/v3/users/me` — who the stored API key belongs to.
    ///
    /// Takes no arguments, and that is the security property rather than an
    /// omission: the identity is whatever the key authenticates as, so there is
    /// no frontend-supplied value anywhere near the path.
    pub async fn get_current_user(&self) -> Result<Principal, AppError> {
        let url = build_request_url(&self.credentials.base_url, &format!("{USER_PATH}/me"), &[])
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        self.parse(body, "get_current_user")
    }

    /// `GET /api/v3/work_packages/available_projects` — where a work package may
    /// be created. An empty collection is a real answer, not an error: this key
    /// may create nowhere.
    pub async fn list_projects(&self) -> Result<ProjectCollection, AppError> {
        let url = build_request_url(
            &self.credentials.base_url,
            &available_projects_path(),
            &[(
                "pageSize",
                clamp_page_size(SMALL_COLLECTION_PAGE_SIZE).to_string(),
            )],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        self.parse(body, "list_projects")
    }

    // Writes

    /// `POST /api/v3/time_entries`.
    pub async fn create_time_entry(
        &self,
        input: &CreateTimeEntryInput,
    ) -> Result<TimeEntry, AppError> {
        let fields = input.validate().map_err(AppError::invalid_input)?;
        // On create an absent comment is simply not sent — there is nothing to
        // clear, and OpenProject defaults it to empty.
        let payload = build_time_entry_payload(&fields, false).map_err(AppError::invalid_input)?;

        let url = build_request_url(&self.credentials.base_url, TIME_ENTRY_PATH, &[])
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::POST, url, Some(payload)).await?;
        self.parse(body, "create_time_entry")
    }

    /// `PATCH /api/v3/time_entries/{id}` — a **full replacement**, unlike the
    /// work package update. The edit form holds every field, so every field is
    /// sent, and an absent comment clears the stored one.
    pub async fn update_time_entry(
        &self,
        input: &UpdateTimeEntryInput,
    ) -> Result<TimeEntry, AppError> {
        let id =
            validate_positive_id(input.id, "The time entry id").map_err(AppError::invalid_input)?;
        let fields = input.fields.validate().map_err(AppError::invalid_input)?;
        let payload = build_time_entry_payload(&fields, true).map_err(AppError::invalid_input)?;

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{TIME_ENTRY_PATH}/{id}"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::PATCH, url, Some(payload)).await?;
        self.parse(body, "update_time_entry")
    }

    /// `DELETE /api/v3/time_entries/{id}`.
    ///
    /// A 404 (already deleted, or never visible to this key) surfaces rather
    /// than being swallowed — "it was already gone" and "your key can't see it"
    /// are different problems for the user.
    pub async fn delete_time_entry(&self, id: i64) -> Result<(), AppError> {
        let id = validate_positive_id(id, "The time entry id").map_err(AppError::invalid_input)?;
        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{TIME_ENTRY_PATH}/{id}"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        self.request(Method::DELETE, url, None).await?;
        Ok(())
    }

    /// `PATCH /api/v3/work_packages/{id}` — a **partial** update.
    ///
    /// A stale `lockVersion` answers HTTP 409 → `OPENPROJECT_CONFLICT`, which the
    /// frontend uses to refetch and discard rather than retrying blindly.
    pub async fn update_work_package(
        &self,
        input: &UpdateWorkPackageInput,
    ) -> Result<WorkPackage, AppError> {
        let id = validate_positive_id(input.id, "The work package id")
            .map_err(AppError::invalid_input)?;
        let relativized = input
            .map_description(|raw| relativize_attachment_urls(raw, &self.credentials.base_url));
        let payload = relativized
            .build_payload()
            .map_err(AppError::invalid_input)?;

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{WORK_PACKAGE_PATH}/{id}"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::PATCH, url, Some(payload)).await?;
        let mut work_package: WorkPackage = self.parse(body, "update_work_package")?;
        self.absolutize_description(&mut work_package);
        Ok(work_package)
    }

    /// `POST /api/v3/work_packages`.
    ///
    /// No lock version, unlike the update: there is no prior revision to write
    /// against, so nothing here can conflict.
    pub async fn create_work_package(
        &self,
        input: &CreateWorkPackageInput,
    ) -> Result<WorkPackage, AppError> {
        let relativized = input
            .map_description(|raw| relativize_attachment_urls(raw, &self.credentials.base_url));
        let payload = relativized
            .build_payload()
            .map_err(AppError::invalid_input)?;

        let url = build_request_url(&self.credentials.base_url, WORK_PACKAGE_PATH, &[])
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::POST, url, Some(payload)).await?;
        let mut work_package: WorkPackage = self.parse(body, "create_work_package")?;
        self.absolutize_description(&mut work_package);
        Ok(work_package)
    }

    /// Probe the API root — used by the test-connection command.
    pub async fn test_connection(&self) -> Result<(), AppError> {
        let url = build_request_url(&self.credentials.base_url, "/api/v3", &[])
            .map_err(AppError::invalid_input)?;
        self.request(Method::GET, url, None).await?;
        Ok(())
    }

    // Internals

    /// Inline attachment URLs are stored relative and are useless from the
    /// webview's origin. Applied to every work package leaving the client;
    /// reversed on everything entering it.
    fn absolutize_description(&self, work_package: &mut WorkPackage) {
        let raw = work_package.description.raw();
        if raw.is_empty() {
            return;
        }
        let absolute = absolutize_attachment_urls(raw, &self.credentials.base_url);
        work_package.description = work_package.description.with_raw(absolute);
    }

    /// Perform a request with auth and a timeout, returning the raw JSON body.
    ///
    /// Every non-GET carries `Content-Type`, body or not — OpenProject answers
    /// HTTP 406 ("client did not send a Content-Type header") to a write that
    /// omits it, *including* a bodyless DELETE, which is what made
    /// `delete_time_entry` fail against a real instance in the Electron app.
    async fn request(
        &self,
        method: Method,
        url: url::Url,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let auth = self.authorization_header();

        let send_content_type = method != Method::GET;
        let mut request = self
            .http
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, auth)
            .header(reqwest::header::ACCEPT, "application/json");
        if send_content_type {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        if let Some(body) = &body {
            request = request.json(body);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_timeout() => {
                return Err(AppError::timeout(self.timeout.as_secs()))
            }
            Err(error) => {
                // A transport failure. The message names the kind of failure,
                // never the key or the auth header — and reqwest's own display
                // for a connect error carries the URL, so it is not forwarded.
                let reason = if error.is_connect() {
                    "the connection was refused or the host could not be resolved"
                } else if error.is_request() {
                    "the request could not be sent"
                } else if error.is_body() || error.is_decode() {
                    "the response could not be read"
                } else {
                    "the request failed"
                };
                return Err(AppError::server_error(format!(
                    "Could not reach the OpenProject server: {reason}."
                )));
            }
        };

        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if status.is_success() {
            // 2xx. An empty body (204 from DELETE) reads as null.
            if text.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|_| {
                AppError::new(
                    "OPENPROJECT_SCHEMA_FAILED",
                    format!(
                        "The OpenProject server returned a non-JSON response (HTTP {}).",
                        status.as_u16()
                    ),
                )
            });
        }

        Err(self.map_error_status(status, &text))
    }

    /// OpenProject API key auth: `Basic base64("apikey:<key>")` — the literal
    /// username `apikey`, not the user's login.
    ///
    /// Its own method so the encoding is pinned by a test. A wrong header here
    /// fails as HTTP 401 on *every* key, valid ones included, which is
    /// indistinguishable from "your key is wrong" from inside the app — the one
    /// bug in this file that would send every user hunting in the wrong place.
    fn authorization_header(&self) -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("apikey:{}", self.credentials.api_key))
        )
    }

    /// The server-authored explanation for a failed request, if it is safe to
    /// forward.
    ///
    /// Only the schema-declared `message` fields ever get this far
    /// ([`extract_api_error_message`]), but a message can still *echo the request
    /// back* — OpenProject's 400 for a malformed filter quotes what it was sent,
    /// and this app is the only party that knows the key it sent. So the text is
    /// dropped entirely if the key appears anywhere in it, and the caller falls
    /// back to its own generic wording. Belt and braces over a boundary that is
    /// otherwise only as tight as another system's error formatting.
    fn safe_server_detail(&self, body: &str) -> Option<String> {
        let detail = extract_api_error_message(body)?;
        if detail.contains(&self.credentials.api_key) {
            return None;
        }
        Some(detail)
    }

    /// Map a non-2xx status onto a typed error.
    ///
    /// Never includes the raw body (it may echo request content) or the key.
    /// OpenProject's own `message` is forwarded for the statuses where it
    /// explains *our* request; 401/403/404/5xx get our own wording, and 409 does
    /// too — the frontend needs the *code* there so it can refetch and discard,
    /// and OpenProject's "conflicting modifications" text says nothing more.
    fn map_error_status(&self, status: StatusCode, body: &str) -> AppError {
        match status.as_u16() {
            401 | 403 => AppError::auth_failed(format!(
                "Authentication failed (HTTP {}). Check your API key.",
                status.as_u16()
            )),
            404 => AppError::not_found(
                "The OpenProject server responded with HTTP 404. Check the base URL.",
            ),
            // A 400 is OpenProject rejecting the query *we* built — an
            // unsupported filter, a bad operator. The reason describes our own
            // request, so it is forwarded on the same terms as the 422 below.
            // Without it a bad filter is undiagnosable from the app.
            400 => AppError::http_error(self.safe_server_detail(body).unwrap_or_else(|| {
                "The OpenProject server rejected the request (HTTP 400).".to_string()
            })),
            409 => AppError::conflict(),
            422 => {
                AppError::validation_failed(self.safe_server_detail(body).unwrap_or_else(|| {
                    "OpenProject rejected the change. Check the activity, date, and work package."
                        .to_string()
                }))
            }
            500..=599 => AppError::server_error(format!(
                "The OpenProject server returned HTTP {}.",
                status.as_u16()
            )),
            // Any other 4xx. A bare "returned HTTP 406" says nothing about
            // *what* was unacceptable, which reduces debugging to guesswork.
            other => AppError::http_error(
                self.safe_server_detail(body)
                    .unwrap_or_else(|| format!("The OpenProject server returned HTTP {other}.")),
            ),
        }
    }

    /// Parse a body into a declared shape.
    ///
    /// The webview-visible message stays generic; `log_parse_failure` records
    /// where the mismatch was so drift is diagnosable without that detail
    /// crossing the boundary.
    fn parse<T: DeserializeOwned>(&self, body: Value, context: &str) -> Result<T, AppError> {
        serde_json::from_value(body).map_err(|error| {
            log_parse_failure(context, &error);
            AppError::schema_failed()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_top_level_message_out_of_an_error_body() {
        let body = r#"{"_type":"Error","errorIdentifier":"urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
                       "message":"Activity is not set to one of the allowed values."}"#;
        assert_eq!(
            extract_api_error_message(body).unwrap(),
            "Activity is not set to one of the allowed values."
        );
    }

    #[test]
    fn joins_embedded_error_messages_without_duplicates() {
        let body = r#"{"message":"Multiple field constraints failed.",
                       "_embedded":{"errors":[
                         {"message":"Subject can't be blank."},
                         {"message":"Subject can't be blank."},
                         {"message":"Type is not writable."}
                       ]}}"#;
        assert_eq!(
            extract_api_error_message(body).unwrap(),
            "Multiple field constraints failed. Subject can't be blank. Type is not writable."
        );
    }

    #[test]
    fn forwards_nothing_from_an_unrecognizable_body() {
        assert_eq!(extract_api_error_message("<html>500</html>"), None);
        assert_eq!(extract_api_error_message(""), None);
        assert_eq!(extract_api_error_message(r#"{"detail":"nope"}"#), None);
        assert_eq!(extract_api_error_message(r#"{"message":"   "}"#), None);
    }

    #[test]
    fn caps_the_length_of_forwarded_server_text() {
        let body = format!(r#"{{"message":"{}"}}"#, "x".repeat(900));
        let message = extract_api_error_message(&body).unwrap();
        assert_eq!(message.chars().count(), MAX_API_ERROR_MESSAGE_LENGTH + 1);
        assert!(message.ends_with('…'));
    }

    fn client() -> OpenProjectClient {
        OpenProjectClient::new(Credentials {
            base_url: "https://op.example.com".to_string(),
            api_key: "secret-key".to_string(),
        })
        .expect("client builds")
    }

    #[test]
    fn maps_each_status_onto_its_own_code() {
        let client = client();
        let cases: Vec<(u16, &str)> = vec![
            (401, "OPENPROJECT_AUTH_FAILED"),
            (403, "OPENPROJECT_AUTH_FAILED"),
            (404, "OPENPROJECT_NOT_FOUND"),
            (400, "OPENPROJECT_HTTP_ERROR"),
            (406, "OPENPROJECT_HTTP_ERROR"),
            (409, "OPENPROJECT_CONFLICT"),
            (422, "OPENPROJECT_VALIDATION_FAILED"),
            (500, "OPENPROJECT_SERVER_ERROR"),
            (503, "OPENPROJECT_SERVER_ERROR"),
        ];
        for (status, code) in cases {
            let error = client.map_error_status(StatusCode::from_u16(status).unwrap(), "");
            assert_eq!(error.code, code, "HTTP {status}");
        }
    }

    #[test]
    fn a_422_forwards_openprojects_own_explanation() {
        let error = client().map_error_status(
            StatusCode::UNPROCESSABLE_ENTITY,
            r#"{"message":"Activity is not set to one of the allowed values."}"#,
        );
        assert_eq!(
            error.message,
            "Activity is not set to one of the allowed values."
        );
    }

    #[test]
    fn a_409_never_forwards_the_server_body() {
        let error = client().map_error_status(
            StatusCode::CONFLICT,
            r#"{"message":"Conflicting modifications on the server."}"#,
        );
        assert_eq!(
            error.message,
            "This item was changed on the server since you loaded it."
        );
    }

    #[test]
    fn no_mapped_error_ever_carries_the_api_key() {
        let client = client();
        let body = r#"{"message":"echoed apikey:secret-key back"}"#;
        for status in [400u16, 401, 404, 409, 422, 500, 406] {
            let error = client.map_error_status(StatusCode::from_u16(status).unwrap(), body);
            assert!(
                !error.message.contains("secret-key"),
                "HTTP {status} leaked the key"
            );
        }
    }

    #[test]
    fn the_authorization_header_is_basic_apikey_colon_key() {
        // Pinned against an independently computed value: base64 of
        // "apikey:secret-key". Node's
        // Buffer.from('apikey:secret-key').toString('base64') — the Electron
        // app's own expression — produces the same string, which is what makes
        // this a port check and not just a restatement of the code.
        assert_eq!(
            client().authorization_header(),
            "Basic YXBpa2V5OnNlY3JldC1rZXk="
        );
    }

    #[test]
    fn descriptions_are_absolutized_on_the_way_out() {
        let mut work_package: WorkPackage = serde_json::from_str(
            r#"{"id":1,"_type":"WorkPackage","lockVersion":0,"subject":"x",
                "description":{"format":"markdown","raw":"![a](/api/v3/attachments/9/content)"},
                "_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#,
        )
        .unwrap();
        client().absolutize_description(&mut work_package);
        assert_eq!(
            work_package.description.raw(),
            "![a](https://op.example.com/api/v3/attachments/9/content)"
        );
    }

    #[test]
    fn an_empty_description_is_left_alone() {
        let mut work_package: WorkPackage = serde_json::from_str(
            r#"{"id":1,"_type":"WorkPackage","lockVersion":0,"subject":"x",
                "description":null,
                "_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#,
        )
        .unwrap();
        client().absolutize_description(&mut work_package);
        assert_eq!(work_package.description.raw(), "");
    }
}
