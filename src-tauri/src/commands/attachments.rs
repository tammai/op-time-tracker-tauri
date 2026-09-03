//! The attachment commands: list, upload, delete, save, and preview support.
//!
//! New in this stage — the Electron app had no attachment support, so unlike its
//! siblings this module is not a port.
//!
//! ## Where the file paths live
//!
//! Uploading and saving are the first things this app does that touch the local
//! filesystem, and the boundary rule ("no frontend value ever reaches a request
//! path") has a filesystem counterpart worth stating: **no frontend value
//! becomes a path this process opens, except one.**
//!
//! - **Choosing a file to attach** and **choosing where to save one** both open
//!   the native dialog *here*, in this process. The chosen path is used and
//!   dropped; it never crosses IPC in either direction. The webview asks "attach
//!   something to work package 40023" and learns only what came back.
//! - **The one exception** is `UploadAttachmentFilesInput::paths`, which carries
//!   the paths from a `tauri://drag-drop` event. That is the single case where
//!   the webview legitimately knows a path the user chose, because the OS handed
//!   it there. Each one is still checked to be an existing regular file within
//!   the size ceiling before it is read, and nothing is inferred from its name.
//!   A webview compromised badly enough to fabricate a path could read a file
//!   into the user's own OpenProject; that is the cost of supporting drag-and-
//!   drop, and it is written down here rather than left implicit.
//! - **A pasted screenshot** has no path at all: it arrives as clipboard bytes
//!   through `upload_work_package_attachment_data`.
//!
//! ## Attaching to something that does not exist yet
//!
//! OpenProject attaches to a container, so a *create* has nothing to attach to
//! until it succeeds. The staging commands at the bottom of this file hold the
//! chosen files in `crate::staged_attachments` and hand the webview an opaque
//! token per file, so the create flow keeps the same property as the edit flow:
//! the paths stay in this process.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::credentials::{CredentialStore, Credentials};
use crate::error::AppError;
use crate::openproject::client::OpenProjectClient;
use crate::schemas::attachments::{
    sanitize_file_name, Attachment, AttachmentCollection, AttachmentIdInput,
    UploadAttachmentDataInput, UploadAttachmentFilesInput, WorkPackageAttachmentsInput,
    MAX_ATTACHMENT_BYTES,
};
use crate::staged_attachments::{StagedAttachment, StagingArea};

/// Resolve credentials or fail with the code the onboarding gate watches for.
///
/// Duplicated from `commands::openproject` rather than shared: these two modules
/// are the *only* callers, and a `pub` helper in one of them would read as an
/// invitation to build clients elsewhere.
fn client(app: &AppHandle) -> Result<OpenProjectClient, AppError> {
    let credentials: Credentials = CredentialStore::new(app)?
        .credentials()?
        .ok_or_else(AppError::credential_not_configured)?;
    OpenProjectClient::new(credentials)
}

/// The megabyte figure the size messages quote, so the cap is written once.
fn max_megabytes() -> usize {
    MAX_ATTACHMENT_BYTES / (1024 * 1024)
}

/// Read one file for upload, refusing anything that is not a regular file
/// within the ceiling.
///
/// The `is_file` check is not pedantry: a directory dropped onto the window
/// arrives in the same `paths` array as a file, and reading one yields an OS
/// error rather than a message anybody can act on.
///
/// Error messages name the *file name*, never the full path — the user knows
/// where they dropped it from, and a path in an error string is one more place
/// for something local to end up in a log.
/// Validate a file for upload and report its name and size, without reading it.
///
/// Split out of [`read_upload`] for the staging path, which needs the metadata
/// to draw a list but must not hold a hundred megabytes of bytes while the user
/// finishes typing a subject. The checks are identical, so a file that stages
/// cleanly is one `read_upload` will accept later.
async fn inspect_upload(path: &Path) -> Result<(String, u64), AppError> {
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("that file")
        .to_string();

    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| AppError::invalid_input(format!("“{display_name}” could not be read.")))?;

    if !metadata.is_file() {
        return Err(AppError::invalid_input(format!(
            "“{display_name}” is not a file. Only files can be attached."
        )));
    }
    if metadata.len() == 0 {
        return Err(AppError::invalid_input(format!(
            "“{display_name}” is empty, so there is nothing to attach."
        )));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AppError::invalid_input(format!(
            "“{display_name}” is larger than the {} MB this app will upload.",
            max_megabytes()
        )));
    }

    Ok((display_name, metadata.len()))
}

async fn read_upload(path: &Path) -> Result<(String, Vec<u8>), AppError> {
    // Re-validated rather than trusted from an earlier `inspect_upload`: a
    // staged file can be moved, deleted or grown while the user is still
    // filling in the form.
    let (display_name, _) = inspect_upload(path).await?;

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| AppError::invalid_input(format!("“{display_name}” could not be read.")))?;

    Ok((display_name, bytes))
}

/// Open the native multi-file picker and wait for the answer.
///
/// The callback form rather than `blocking_pick_files`: the blocking variant
/// parks the thread it is called on until the user answers, and on the async
/// runtime that is a worker taken out of service for as long as the dialog is
/// open.
async fn pick_files(app: &AppHandle) -> Result<Vec<PathBuf>, AppError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Attach files")
        .pick_files(move |picked| {
            // The receiver is gone only if this command was cancelled, in which
            // case there is nobody left to tell.
            let _ = sender.send(picked);
        });

    let picked = receiver
        .await
        .map_err(|_| AppError::server_error("The file picker closed unexpectedly."))?;

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect())
}

/// Open the native save dialog, prefilled with `suggested_name`.
async fn pick_save_path(
    app: &AppHandle,
    suggested_name: &str,
) -> Result<Option<PathBuf>, AppError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save attachment")
        .set_file_name(suggested_name)
        .save_file(move |picked| {
            let _ = sender.send(picked);
        });

    let picked = receiver
        .await
        .map_err(|_| AppError::server_error("The save dialog closed unexpectedly."))?;

    Ok(picked.and_then(|file| file.into_path().ok()))
}

/// Every attachment on one work package.
#[tauri::command]
pub async fn list_work_package_attachments(
    app: AppHandle,
    input: WorkPackageAttachmentsInput,
) -> Result<AttachmentCollection, AppError> {
    let work_package_id = input.validate().map_err(AppError::invalid_input)?;
    client(&app)?
        .list_work_package_attachments(work_package_id)
        .await
}

/// Attach one or more files.
///
/// `input.paths` absent opens the native picker here; present means the paths
/// came from a drag-and-drop event — see the module note on which of those the
/// boundary trusts and why.
///
/// Uploads run **sequentially and stop at the first failure**, returning what
/// landed. That is deliberate: OpenProject has no batch endpoint and no
/// transaction across several, so a partial upload is the only honest outcome,
/// and continuing past an error would bury the reason under later successes. The
/// caller refetches the list either way, so what actually landed is never in
/// doubt.
#[tauri::command]
pub async fn upload_work_package_attachments(
    app: AppHandle,
    input: UploadAttachmentFilesInput,
) -> Result<Vec<Attachment>, AppError> {
    let work_package_id =
        crate::util::validation::validate_positive_id(input.work_package_id, "The work package id")
            .map_err(AppError::invalid_input)?;

    let paths = match input.paths {
        Some(paths) => paths.into_iter().map(PathBuf::from).collect(),
        None => pick_files(&app).await?,
    };
    // Cancelling the picker is not an error — it is the user saying "never
    // mind", and an empty list is how that reaches the caller.
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let client = client(&app)?;
    let mut uploaded = Vec::with_capacity(paths.len());
    for path in &paths {
        let (file_name, bytes) = read_upload(path).await?;
        uploaded.push(
            client
                .upload_work_package_attachment(work_package_id, &file_name, None, bytes)
                .await?,
        );
    }
    Ok(uploaded)
}

/// Attach bytes that never had a path — a screenshot pasted into the
/// description editor.
///
/// The base64 is decoded here and capped before it is decoded, so a webview
/// sending a gigabyte of payload is refused on the string length rather than
/// after allocating the bytes.
#[tauri::command]
pub async fn upload_work_package_attachment_data(
    app: AppHandle,
    input: UploadAttachmentDataInput,
) -> Result<Attachment, AppError> {
    let work_package_id =
        crate::util::validation::validate_positive_id(input.work_package_id, "The work package id")
            .map_err(AppError::invalid_input)?;

    // Base64 is 4 characters per 3 bytes, so this rejects anything whose decoded
    // size could exceed the ceiling without doing the decode first.
    if input.data.len() / 4 * 3 > MAX_ATTACHMENT_BYTES {
        return Err(AppError::invalid_input(format!(
            "That image is larger than the {} MB this app will upload.",
            max_megabytes()
        )));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.data.trim())
        .map_err(|_| AppError::invalid_input("That image could not be read."))?;

    client(&app)?
        .upload_work_package_attachment(
            work_package_id,
            &sanitize_file_name(&input.file_name),
            input.content_type.as_deref(),
            bytes,
        )
        .await
}

/// Delete one attachment.
///
/// Irreversible, and it can break a description: an inline image whose
/// attachment is gone renders as a broken image. The UI confirms first.
#[tauri::command]
pub async fn delete_attachment(app: AppHandle, input: AttachmentIdInput) -> Result<(), AppError> {
    let id = input.validate().map_err(AppError::invalid_input)?;
    client(&app)?.delete_attachment(id).await
}

/// Save one attachment to a location the user picks.
///
/// The suggested file name comes from **OpenProject**, not from the webview:
/// the metadata resource is fetched here for it. That is one extra round trip
/// on a user-initiated action, and it is what keeps a frontend string out of a
/// path this process writes to.
///
/// Returns the file name written, for the confirmation toast, or `None` when the
/// user cancelled the dialog — cancelling is not a failure.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    input: AttachmentIdInput,
) -> Result<Option<String>, AppError> {
    let id = input.validate().map_err(AppError::invalid_input)?;
    let client = client(&app)?;

    let attachment = client.get_attachment(id).await?;
    let suggested_name = sanitize_file_name(&attachment.file_name);

    let Some(destination) = pick_save_path(&app, &suggested_name).await? else {
        return Ok(None);
    };

    let content = client.fetch_attachment_content(id).await?;
    tokio::fs::write(&destination, &content.bytes)
        .await
        .map_err(|_| {
            AppError::new(
                "ATTACHMENT_SAVE_FAILED",
                format!("“{suggested_name}” could not be written to that location."),
            )
        })?;

    Ok(Some(
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&suggested_name)
            .to_string(),
    ))
}

// Staging, for a work package that does not exist yet

/// Which staged file to forget.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedTokenInput {
    pub token: String,
}

/// The staged files to upload, and where to.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStagedAttachmentsInput {
    pub work_package_id: i64,
    pub tokens: Vec<String>,
}

/// Choose files for a work package that does not exist yet.
///
/// Same split as `upload_work_package_attachments`: `paths` absent opens the
/// native picker here, `paths` present carries the paths from a drag-and-drop
/// event. Nothing is uploaded and nothing is read beyond metadata — each file
/// is validated now, so an oversized or unreadable one is reported while the
/// user is still filling in the form rather than after the create.
#[tauri::command]
pub async fn stage_attachment_files(
    app: AppHandle,
    staging: State<'_, StagingArea>,
    input: UploadAttachmentFilesInput,
) -> Result<Vec<StagedAttachment>, AppError> {
    let paths = match input.paths {
        Some(paths) => paths.into_iter().map(PathBuf::from).collect(),
        None => pick_files(&app).await?,
    };
    // Cancelling the picker is not an error.
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut staged = Vec::with_capacity(paths.len());
    for path in paths {
        let (file_name, file_size) = inspect_upload(&path).await?;
        staged.push(staging.stage(path, file_name, file_size));
    }
    Ok(staged)
}

/// Drop one staged file. Also used to clear a cancelled draft, one token at a
/// time, so there is no command that can wipe another surface's staging.
#[tauri::command]
pub fn discard_staged_attachment(staging: State<'_, StagingArea>, input: StagedTokenInput) {
    staging.discard(&input.token);
}

/// Upload every staged file to the work package that was just created.
///
/// A token is removed from the store only once its file has actually landed, so
/// a failure part-way through leaves the rest staged rather than losing them.
/// Like the other upload path this stops at the first refusal and returns what
/// succeeded — the caller refetches the attachments list, which is the honest
/// account of what is there.
#[tauri::command]
pub async fn upload_staged_attachments(
    app: AppHandle,
    staging: State<'_, StagingArea>,
    input: UploadStagedAttachmentsInput,
) -> Result<Vec<Attachment>, AppError> {
    let work_package_id =
        crate::util::validation::validate_positive_id(input.work_package_id, "The work package id")
            .map_err(AppError::invalid_input)?;

    let resolved = staging.paths_for(&input.tokens);
    if resolved.is_empty() {
        return Ok(Vec::new());
    }

    let client = client(&app)?;
    let mut uploaded = Vec::with_capacity(resolved.len());
    for (token, path) in resolved {
        let (file_name, bytes) = read_upload(&path).await?;
        uploaded.push(
            client
                .upload_work_package_attachment(work_package_id, &file_name, None, bytes)
                .await?,
        );
        // Only now: a token discarded before the upload landed would lose the
        // file on a retry.
        staging.discard(&token);
    }
    Ok(uploaded)
}
