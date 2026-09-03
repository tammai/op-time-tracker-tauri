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
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::credentials::Credentials;
use crate::error::AppError;
use crate::openproject::attachment_urls::{deproxify_attachment_urls, proxify_attachment_urls};
use crate::openproject::filters::{
    clamp_page_size, encode_time_entry_params, encode_work_package_params, TimeEntryFilters,
    WorkPackageFilters,
};
use crate::openproject::url::build_request_url;
use crate::schemas::attachments::{
    guess_content_type, sanitize_file_name, upload_metadata, Attachment, AttachmentCollection,
    MAX_ATTACHMENT_BYTES,
};
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
use crate::util::hal::{
    ATTACHMENT_PATH, PROJECT_PATH, TIME_ENTRY_PATH, TYPE_PATH, USER_PATH, WORK_PACKAGE_PATH,
};
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

/// A quoted string literal in a serde message.
///
/// serde embeds the *offending value* for some mismatches — `invalid type:
/// string "…", expected i64` — and on this API that value is user-authored: a
/// work package subject, a comment. Field names are delimited with backticks
/// rather than quotes, so redacting double-quoted runs keeps the half that
/// diagnoses the drift and drops the half that must not be logged.
static QUOTED_LITERAL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""[^"]*""#).expect("quoted literal pattern is valid"));

/// serde's own message, with any quoted value redacted.
fn redact_literals(message: &str) -> String {
    QUOTED_LITERAL.replace_all(message, "\"…\"").into_owned()
}

/// Log **which field** a response failed to parse on, so schema drift is
/// diagnosable without that detail reaching the webview.
///
/// serde's message is what carries the field path (`missing field
/// \`lockVersion\``, `invalid type: null, expected a string`), and it is the
/// only thing here that turns "something drifted" into a one-line fix. It is
/// passed through [`redact_literals`] first, so nothing user-authored reaches
/// stderr — that is the property the category-only version bought by throwing
/// the path away as well.
///
/// No line or column: every caller reaches this through `parse`, which uses
/// `serde_json::from_value`, and a value has no textual position — both were
/// always `0`.
fn log_parse_failure(context: &str, error: &serde_json::Error) {
    eprintln!(
        "[openproject] {context}: response did not match the expected shape — {} ({})",
        redact_literals(&error.to_string()),
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

/// An attachment's bytes plus the content type the server labelled them with.
///
/// The content type is forwarded rather than re-guessed: the protocol handler
/// hands it straight to the webview, and the webview decides how to render on
/// the strength of it.
pub struct AttachmentContent {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

/// The content type to label an upload's file part with.
///
/// A caller-supplied type wins — the clipboard reports the real type of a
/// pasted screenshot, which is better than any guess from a synthesised file
/// name. Anything unusable as a MIME string is discarded rather than passed on:
/// `Part::mime_str` would reject it and fail the whole upload, so a throwaway
/// part is used to test it first.
fn resolve_upload_content_type(supplied: Option<&str>, file_name: &str) -> String {
    let candidate = supplied
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Some(candidate) = candidate {
        if reqwest::multipart::Part::text("")
            .mime_str(&candidate)
            .is_ok()
        {
            return candidate;
        }
    }
    guess_content_type(file_name).to_string()
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
        // Element-tolerant: one work package with an instance-specific oddity
        // must not empty the whole list. See `parse_collection`.
        let mut collection: WorkPackageCollection =
            self.parse_collection(body, "list_work_packages")?;
        for work_package in &mut collection.embedded.elements {
            self.proxify_description(work_package);
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

    // Attachments

    /// `GET /api/v3/work_packages/{id}/attachments`.
    ///
    /// No pagination: OpenProject returns a work package's attachments in one
    /// collection, and a work package with more than a screenful of them is not
    /// a case this list needs to page through.
    pub async fn list_work_package_attachments(
        &self,
        work_package_id: i64,
    ) -> Result<AttachmentCollection, AppError> {
        let id = validate_positive_id(work_package_id, "The work package id")
            .map_err(AppError::invalid_input)?;
        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{WORK_PACKAGE_PATH}/{id}/attachments"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        let mut collection: AttachmentCollection =
            self.parse(body, "list_work_package_attachments")?;
        // `canDelete` and `proxyUrl` are filled in here rather than in the
        // command, so no path can hand the webview an attachment without them.
        collection.embedded.elements = collection
            .embedded
            .elements
            .into_iter()
            .map(Attachment::with_computed_fields)
            .collect();
        Ok(collection)
    }

    /// `GET /api/v3/attachments/{id}` — one attachment's metadata.
    ///
    /// Fetched for its `fileName` alone, by the save command, so the name a file
    /// is written under comes from OpenProject rather than from the webview.
    pub async fn get_attachment(&self, attachment_id: i64) -> Result<Attachment, AppError> {
        let id = validate_positive_id(attachment_id, "The attachment id")
            .map_err(AppError::invalid_input)?;
        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{ATTACHMENT_PATH}/{id}"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request(Method::GET, url, None).await?;
        let attachment: Attachment = self.parse(body, "get_attachment")?;
        Ok(attachment.with_computed_fields())
    }

    /// `GET /api/v3/attachments/{id}/content` — the bytes.
    ///
    /// Serves both the `opattach:` protocol handler (which renders them in an
    /// `<img>`) and the save-to-disk command. The id is validated and the path
    /// rebuilt from `ATTACHMENT_PATH`; a `downloadLocation` href the server
    /// supplied is never followed as given.
    pub async fn fetch_attachment_content(
        &self,
        attachment_id: i64,
    ) -> Result<AttachmentContent, AppError> {
        let id = validate_positive_id(attachment_id, "The attachment id")
            .map_err(AppError::invalid_input)?;
        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{ATTACHMENT_PATH}/{id}/content"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        self.request_bytes(url).await
    }

    /// `POST /api/v3/work_packages/{id}/attachments` — a multipart upload.
    ///
    /// OpenProject requires two parts and refuses the request without both: a
    /// `metadata` JSON part naming the file, and the `file` part itself.
    ///
    /// The instance enforces its own size limit (5 MB by default) and answers
    /// HTTP 422 when a file exceeds it, which surfaces with OpenProject's own
    /// wording. `MAX_ATTACHMENT_BYTES` is a separate, much higher ceiling on
    /// what this process will buffer at all.
    pub async fn upload_work_package_attachment(
        &self,
        work_package_id: i64,
        file_name: &str,
        content_type: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<Attachment, AppError> {
        let id = validate_positive_id(work_package_id, "The work package id")
            .map_err(AppError::invalid_input)?;
        if bytes.is_empty() {
            return Err(AppError::invalid_input("An empty file cannot be attached."));
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AppError::invalid_input(format!(
                "That file is larger than the {} MB this app will upload.",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            )));
        }

        let file_name = sanitize_file_name(file_name);
        let content_type = resolve_upload_content_type(content_type, &file_name);

        let metadata = reqwest::multipart::Part::text(upload_metadata(&file_name).to_string())
            .mime_str("application/json")
            .map_err(|_| AppError::server_error("Could not build the upload request."))?;
        let file = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name)
            .mime_str(&content_type)
            .map_err(|_| AppError::server_error("Could not build the upload request."))?;
        let form = reqwest::multipart::Form::new()
            .part("metadata", metadata)
            .part("file", file);

        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{WORK_PACKAGE_PATH}/{id}/attachments"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        let body = self.request_multipart(url, form).await?;
        let attachment: Attachment = self.parse(body, "upload_work_package_attachment")?;
        Ok(attachment.with_computed_fields())
    }

    /// `DELETE /api/v3/attachments/{id}`.
    ///
    /// Irreversible: OpenProject has no undo for a deleted attachment, and an
    /// inline image in a description whose attachment is gone renders broken.
    /// The UI confirms before calling this.
    pub async fn delete_attachment(&self, attachment_id: i64) -> Result<(), AppError> {
        let id = validate_positive_id(attachment_id, "The attachment id")
            .map_err(AppError::invalid_input)?;
        let url = build_request_url(
            &self.credentials.base_url,
            &format!("{ATTACHMENT_PATH}/{id}"),
            &[],
        )
        .map_err(AppError::invalid_input)?;
        self.request(Method::DELETE, url, None).await?;
        Ok(())
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
        let relativized =
            input.map_description(|raw| deproxify_attachment_urls(raw, &self.credentials.base_url));
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
        self.proxify_description(&mut work_package);
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
        let relativized =
            input.map_description(|raw| deproxify_attachment_urls(raw, &self.credentials.base_url));
        let payload = relativized
            .build_payload()
            .map_err(AppError::invalid_input)?;

        let url = build_request_url(&self.credentials.base_url, WORK_PACKAGE_PATH, &[])
            .map_err(AppError::invalid_input)?;
        let body = self.request(Method::POST, url, Some(payload)).await?;
        let mut work_package: WorkPackage = self.parse(body, "create_work_package")?;
        self.proxify_description(&mut work_package);
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

    /// Inline attachment URLs are stored relative, and even made absolute they
    /// need an auth header an `<img>` cannot send. Every work package leaving
    /// the client has them pointed at this app's `opattach:` proxy; everything
    /// entering it has that undone. See `openproject::attachment_urls`.
    fn proxify_description(&self, work_package: &mut WorkPackage) {
        let raw = work_package.description.raw();
        if raw.is_empty() {
            return;
        }
        let proxied = proxify_attachment_urls(raw, &self.credentials.base_url);
        work_package.description = work_package.description.with_raw(proxied);
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

        let response = self.send(request).await?;

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

    /// Send a prepared request, mapping every transport failure onto our own
    /// wording.
    ///
    /// Shared by the JSON, bytes, and multipart paths so all three fail
    /// identically — and so the rule that no message names the key, the auth
    /// header, or the URL holds in one place rather than three. reqwest's own
    /// display for a connect error carries the URL, which is why the reason is
    /// re-derived from the error's kind rather than forwarded.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        request.send().await.map_err(|error| {
            if error.is_timeout() {
                return AppError::timeout(self.timeout.as_secs());
            }
            let reason = if error.is_connect() {
                "the connection was refused or the host could not be resolved"
            } else if error.is_request() {
                "the request could not be sent"
            } else if error.is_body() || error.is_decode() {
                "the response could not be read"
            } else {
                "the request failed"
            };
            AppError::server_error(format!("Could not reach the OpenProject server: {reason}."))
        })
    }

    /// Fetch a URL's raw bytes rather than a JSON body — attachment content,
    /// which is the one response this client reads that is not JSON.
    ///
    /// The size cap is checked twice on purpose: against `Content-Length`
    /// before anything is read, so an oversized file costs one round trip and
    /// no memory, and against the collected length afterwards, because a
    /// chunked response declares no length at all.
    ///
    /// Redirects are followed (OpenProject answers HTTP 302 to a presigned
    /// storage URL when attachments live outside the database). reqwest drops
    /// `Authorization` when a redirect changes host, scheme or port, so the key
    /// reaches the instance and nothing else.
    async fn request_bytes(&self, url: url::Url) -> Result<AttachmentContent, AppError> {
        let request = self
            .http
            .request(Method::GET, url)
            .header(reqwest::header::AUTHORIZATION, self.authorization_header());
        let response = self.send(request).await?;

        let status = response.status();
        if !status.is_success() {
            // The body of a failed content request is JSON, like every other
            // error OpenProject returns.
            let text = response.text().await.unwrap_or_default();
            return Err(self.map_error_status(status, &text));
        }

        if let Some(length) = response.content_length() {
            if length > MAX_ATTACHMENT_BYTES as u64 {
                return Err(AppError::invalid_input(format!(
                    "That attachment is larger than the {} MB this app will load.",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                )));
            }
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        let bytes = response.bytes().await.map_err(|_| {
            AppError::server_error("The attachment could not be read from the server.")
        })?;
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AppError::invalid_input(format!(
                "That attachment is larger than the {} MB this app will load.",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            )));
        }

        Ok(AttachmentContent {
            bytes: bytes.to_vec(),
            content_type,
        })
    }

    /// POST a multipart body — the attachment upload, and the only request here
    /// that does not send `Content-Type: application/json`. reqwest sets the
    /// multipart content type with its own generated boundary, so this must not.
    async fn request_multipart(
        &self,
        url: url::Url,
        form: reqwest::multipart::Form,
    ) -> Result<Value, AppError> {
        let request = self
            .http
            .request(Method::POST, url)
            .header(reqwest::header::AUTHORIZATION, self.authorization_header())
            .header(reqwest::header::ACCEPT, "application/json")
            .multipart(form);
        let response = self.send(request).await?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(self.map_error_status(status, &text));
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| {
            AppError::new(
                "OPENPROJECT_SCHEMA_FAILED",
                format!(
                    "The OpenProject server returned a non-JSON response (HTTP {}).",
                    status.as_u16()
                ),
            )
        })
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

    /// Parse a collection **element by element**, skipping any element that does
    /// not match and logging which field it failed on.
    ///
    /// The strict `parse` fails the whole response on one bad element, and that
    /// is the wrong trade for a list: one work package with an
    /// instance-specific oddity would empty the entire picker and browse list,
    /// with nothing on screen to say why. `schemas::common` already states the
    /// rule this restores — "a single differently-serialized description" must
    /// not fail "an entire collection" — and element-level strictness was
    /// quietly breaking it.
    ///
    /// **Not** written in response to an observed failure. The one parse error
    /// reported from a live instance looked like element drift and was actually
    /// an empty 2xx body (see `parse`); this is the latent fragility that
    /// investigation exposed, fixed on its own merits.
    ///
    /// Two things keep this from becoming a silent data-loss hatch:
    ///
    /// - **A wholesale break is still loud.** If the server sent elements and
    ///   *none* of them parsed, the shape really has changed and this returns
    ///   `OPENPROJECT_SCHEMA_FAILED` rather than an empty list.
    /// - **`total` stays the server's.** Only `count` reflects what survived, so
    ///   a caller comparing the two can still tell it is not seeing everything —
    ///   which is what the browse list's "showing the first N" notice reads.
    ///
    /// Deliberately **not** used for time entries. A dropped work package costs
    /// one row in a list; a dropped time entry makes a day's total silently
    /// wrong, and a wrong number is worse than an error.
    fn parse_collection<T: DeserializeOwned>(
        &self,
        body: Value,
        context: &str,
    ) -> Result<Collection<T>, AppError> {
        let raw: Collection<Value> = self.parse(body, context)?;
        let received = raw.embedded.elements.len();

        let mut elements = Vec::with_capacity(received);
        let mut skipped = 0usize;
        for element in raw.embedded.elements {
            match serde_json::from_value::<T>(element) {
                Ok(parsed) => elements.push(parsed),
                Err(error) => {
                    skipped += 1;
                    log_parse_failure(&format!("{context} (one element, skipped)"), &error);
                }
            }
        }

        // Everything failed, and there was something to fail: this is drift in
        // the shape itself, not one odd row.
        if received > 0 && elements.is_empty() {
            return Err(AppError::schema_failed());
        }
        if skipped > 0 {
            eprintln!(
                "[openproject] {context}: skipped {skipped} of {received} elements that did not match the expected shape"
            );
        }

        Ok(Collection {
            type_name: raw.type_name,
            total: raw.total,
            count: elements.len() as i64,
            embedded: crate::schemas::common::CollectionElements { elements },
        })
    }

    /// Parse a body into a declared shape.
    ///
    /// The webview-visible message stays generic; `log_parse_failure` records
    /// where the mismatch was so drift is diagnosable without that detail
    /// crossing the boundary.
    fn parse<T: DeserializeOwned>(&self, body: Value, context: &str) -> Result<T, AppError> {
        // An empty 2xx body arrives here as `Value::Null` (see `request`).
        //
        // Rejected explicitly, before serde sees it, for two reasons. It
        // otherwise produced "invalid type: null, expected struct Collection",
        // which classifies as *"unexpected type or missing field"* — a server
        // that sent nothing was reported as a schema mismatch, and the field it
        // named did not exist. And the three call sites that parse into a bare
        // `Value` would not have failed at all: `from_value::<Value>(Null)`
        // succeeds, so an empty form response became zero allowed activities
        // and an all-read-only form, with nothing anywhere saying why.
        //
        // A bodyless DELETE is unaffected — it discards the body and never
        // reaches here.
        if body.is_null() {
            eprintln!("[openproject] {context}: the server answered 2xx with an empty body");
            return Err(AppError::empty_response());
        }

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
    fn a_parse_failure_names_the_field_but_never_the_value() {
        // An absent field is named, in backticks. *Which* one is serde's choice
        // (the first it misses), so the assertion is that a name is there at
        // all — that is what turns drift into a one-line fix.
        let missing = serde_json::from_value::<WorkPackage>(json!({"id": 1}))
            .expect_err("a work package needs more than an id");
        let logged = redact_literals(&missing.to_string());
        assert!(logged.contains("missing field"), "{logged}");
        assert!(logged.contains('`'), "no field name in {logged:?}");

        // A mismatched type embeds the offending value, and on this API that
        // value is user-authored — a subject, a comment. It must not reach
        // stderr, and the field path must survive anyway.
        let wrong_type = serde_json::from_value::<WorkPackage>(json!({
            "_type": "WorkPackage",
            "id": 1,
            "lockVersion": 0,
            "subject": {"nested": "a confidential subject"},
            "_links": {"self": {"href": "/api/v3/work_packages/1"}}
        }))
        .expect_err("a subject is not an object");
        let logged = redact_literals(&wrong_type.to_string());
        assert!(
            !logged.contains("confidential"),
            "value leaked into {logged:?}"
        );
        assert!(logged.contains("invalid type"), "{logged}");
    }

    #[test]
    fn redaction_leaves_a_message_with_no_quoted_value_alone() {
        assert_eq!(
            redact_literals("missing field `lockVersion`"),
            "missing field `lockVersion`"
        );
        assert_eq!(
            redact_literals("invalid type: null, expected a string"),
            "invalid type: null, expected a string"
        );
    }

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

    /// A work-package collection body with the given elements.
    fn collection_body(elements: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"_type":"WorkPackageCollection","total":9,"count":2,
                 "_embedded":{{"elements":[{elements}]}}}}"#
        ))
        .expect("test body is valid JSON")
    }

    const GOOD_ELEMENT: &str = r#"{"id":1,"_type":"WorkPackage","lockVersion":0,
        "subject":"fine","_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#;

    #[test]
    fn an_empty_2xx_body_is_reported_as_such_and_not_as_schema_drift() {
        // The bug this closes: an empty body reaches the parser as `null`,
        // serde says "invalid type: null, expected struct Collection", and that
        // classifies as "unexpected type or missing field" — so a server that
        // sent nothing was reported as a shape mismatch, naming a field that
        // did not exist.
        let error = client()
            .parse::<WorkPackageCollection>(Value::Null, "list_work_packages")
            .expect_err("null is not a collection");

        assert_eq!(error.code, "OPENPROJECT_EMPTY_RESPONSE");
        assert_ne!(error.code, "OPENPROJECT_SCHEMA_FAILED");
        // The message names the likely cause, because both of them are worth
        // retrying rather than investigating.
        assert!(error.message.contains("try again"), "{}", error.message);
    }

    #[test]
    fn an_empty_body_no_longer_slips_through_a_bare_value_parse() {
        // `from_value::<Value>(Null)` *succeeds*, so the three form endpoints
        // that parse into a bare `Value` did not fail at all — an empty
        // response became zero allowed activities and an all-read-only form,
        // with nothing anywhere saying why.
        let error = client()
            .parse::<Value>(Value::Null, "get_work_package_form")
            .expect_err("an empty form response is a server problem");

        assert_eq!(error.code, "OPENPROJECT_EMPTY_RESPONSE");
    }

    #[test]
    fn an_empty_collection_body_is_not_confused_with_an_empty_list() {
        // `{"count":0,…,"elements":[]}` is a real answer; no body at all is not.
        let real_empty = collection_body("");
        assert!(client()
            .parse_collection::<WorkPackage>(real_empty, "list_work_packages")
            .is_ok());

        let no_body = client()
            .parse_collection::<WorkPackage>(Value::Null, "list_work_packages")
            .expect_err("no body");
        assert_eq!(no_body.code, "OPENPROJECT_EMPTY_RESPONSE");
    }

    #[test]
    fn a_genuine_shape_mismatch_is_still_reported_as_schema_drift() {
        // The null check must not swallow the case it was mistaken for.
        let wrong_shape: Value = serde_json::from_str(r#"{"unexpected":true}"#).unwrap();
        let error = client()
            .parse::<WorkPackageCollection>(wrong_shape, "list_work_packages")
            .expect_err("not a collection");

        assert_eq!(error.code, "OPENPROJECT_SCHEMA_FAILED");
    }

    #[test]
    fn one_unparseable_work_package_does_not_empty_the_whole_list() {
        // The bug this restores the codebase's own rule against: a single odd
        // element used to fail the entire response, emptying the picker and the
        // browse list with nothing on screen to explain it.
        let body = collection_body(&format!(
            r#"{GOOD_ELEMENT}, {{"id":2,"_type":"WorkPackage"}}"#
        ));
        let collection: WorkPackageCollection = client()
            .parse_collection(body, "list_work_packages")
            .expect("the good element survives");

        assert_eq!(collection.elements().len(), 1);
        assert_eq!(collection.elements()[0].subject, "fine");
    }

    #[test]
    fn count_reports_what_survived_while_total_stays_the_servers() {
        // `total` is how a caller can still tell it is not seeing everything —
        // the browse list's "showing the first N" notice reads exactly this.
        let body = collection_body(&format!(r#"{GOOD_ELEMENT}, {{"id":2}}"#));
        let collection: WorkPackageCollection = client()
            .parse_collection(body, "list_work_packages")
            .expect("parses");

        assert_eq!(collection.count, 1);
        assert_eq!(collection.total, 9);
    }

    #[test]
    fn a_wholesale_shape_change_is_still_an_error() {
        // Tolerating one odd row must not turn real drift into a silently empty
        // list.
        let body = collection_body(r#"{"id":1}, {"id":2}"#);
        let error = client()
            .parse_collection::<WorkPackage>(body, "list_work_packages")
            .expect_err("nothing parsed, so the shape itself changed");

        assert_eq!(error.code, "OPENPROJECT_SCHEMA_FAILED");
    }

    #[test]
    fn a_genuinely_empty_collection_is_not_an_error() {
        let body = collection_body("");
        let collection: WorkPackageCollection = client()
            .parse_collection(body, "list_work_packages")
            .expect("an empty list is a real answer");

        assert_eq!(collection.count, 0);
        assert!(collection.elements().is_empty());
    }

    #[test]
    fn a_broken_envelope_is_still_rejected() {
        // Element tolerance does not extend to the collection wrapper: without
        // `_embedded` there is nothing to be tolerant about.
        let body: Value = serde_json::from_str(r#"{"_type":"WorkPackageCollection"}"#).unwrap();
        let error = client()
            .parse_collection::<WorkPackage>(body, "list_work_packages")
            .expect_err("no envelope");

        assert_eq!(error.code, "OPENPROJECT_SCHEMA_FAILED");
    }

    #[test]
    fn descriptions_are_proxified_on_the_way_out() {
        let mut work_package: WorkPackage = serde_json::from_str(
            r#"{"id":1,"_type":"WorkPackage","lockVersion":0,"subject":"x",
                "description":{"format":"markdown","raw":"![a](/api/v3/attachments/9/content)"},
                "_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#,
        )
        .unwrap();
        client().proxify_description(&mut work_package);
        assert_eq!(
            work_package.description.raw(),
            format!(
                "![a]({})",
                crate::openproject::attachment_urls::attachment_proxy_url(9)
            )
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
        client().proxify_description(&mut work_package);
        assert_eq!(work_package.description.raw(), "");
    }
}
