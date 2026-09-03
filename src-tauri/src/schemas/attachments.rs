//! The attachment resource, its collection, and the inputs the commands take.
//!
//! New in this stage — the Electron app had no attachment support, so unlike its
//! siblings this module is not a port.
//!
//! Two fields are computed here rather than received, and both exist so the
//! webview never has to build anything itself:
//!
//! - `canDelete` — OpenProject expresses "you may delete this" as the *presence*
//!   of a `_links.delete`, which is permission information the UI needs and
//!   would otherwise have to infer from a failed request.
//! - `proxyUrl` — the `opattach:` URL that renders this attachment's bytes in an
//!   `<img>`. Built here because the platform spelling of a custom scheme lives
//!   in `openproject::attachment_urls` and nowhere else.

use serde::{Deserialize, Serialize};

use crate::openproject::attachment_urls::attachment_proxy_url;
use crate::schemas::common::{Collection, HalLink};
use crate::util::validation::validate_positive_id;

/// Cap on an upload's own byte count, and on how much of a download is held in
/// memory at once.
///
/// OpenProject enforces its own instance-wide limit (5 MB by default,
/// configurable), so this is not the authority on what is allowed — it is the
/// ceiling on what *this process* will buffer, so a mis-picked disk image
/// cannot exhaust memory before the server gets the chance to refuse it.
pub const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;

/// The links an attachment carries. Only the ones the UI reads are declared;
/// serde ignores the rest.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AttachmentLinks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<HalLink>,
    /// Present only when this key may delete the attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete: Option<HalLink>,
}

/// One attachment, as it arrives from OpenProject.
///
/// Deserialized from the wire and re-serialized to the webview, so the field
/// names are OpenProject's — with the two computed additions the module note
/// explains. `file_size` and `content_type` are optional because an instance
/// that failed to inspect an upload sends neither.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "_links", default)]
    pub links: AttachmentLinks,

    /// Whether this key may delete it — see the module note. Never read from the
    /// wire; `#[serde(skip_deserializing)]` so a server cannot assert it.
    #[serde(default, skip_deserializing)]
    pub can_delete: bool,
    /// The `opattach:` URL for this attachment's bytes. Same treatment.
    #[serde(default, skip_deserializing)]
    pub proxy_url: String,
}

impl Attachment {
    /// Fill in the two computed fields. Called by the client on everything
    /// leaving it, so no code path can hand the webview an attachment with an
    /// empty `proxyUrl`.
    pub fn with_computed_fields(mut self) -> Self {
        self.can_delete = self.links.delete.is_some();
        self.proxy_url = attachment_proxy_url(self.id);
        self
    }

    /// Whether the UI should offer an inline preview rather than a save.
    ///
    /// Reads the server-reported content type, which is why it is a prefix test
    /// and not an equality one: `image/png`, `image/svg+xml`, and
    /// `image/jpeg; charset=binary` have all been seen.
    pub fn is_image(&self) -> bool {
        self.content_type.as_deref().is_some_and(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("image/")
        })
    }
}

pub type AttachmentCollection = Collection<Attachment>;

// Inputs

/// Whose attachments to list, or upload to.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageAttachmentsInput {
    pub work_package_id: i64,
}

impl WorkPackageAttachmentsInput {
    pub fn validate(&self) -> Result<i64, String> {
        validate_positive_id(self.work_package_id, "The work package id")
    }
}

/// One attachment, by id — used by delete, save, and preview.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIdInput {
    pub id: i64,
}

impl AttachmentIdInput {
    pub fn validate(&self) -> Result<i64, String> {
        validate_positive_id(self.id, "The attachment id")
    }
}

/// An upload whose bytes came through the webview — a screenshot pasted into
/// the description editor, which arrives as clipboard data and has no path on
/// disk.
///
/// `data` is base64 rather than a byte array because Tauri serializes `Vec<u8>`
/// as a JSON array of numbers, which costs roughly six bytes of IPC per byte of
/// image.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAttachmentDataInput {
    pub work_package_id: i64,
    pub file_name: String,
    #[serde(default)]
    pub content_type: Option<String>,
    pub data: String,
}

/// An upload whose bytes are on disk.
///
/// `paths` absent means "ask the user" — the native file picker opens in *this*
/// process and the chosen paths never cross IPC at all. `paths` present carries
/// the paths from a `tauri://drag-drop` event, which is the one case where the
/// webview legitimately knows a path the user chose: the OS handed it there.
/// Those are still checked as existing regular files before anything is read.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAttachmentFilesInput {
    pub work_package_id: i64,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

/// The multipart `metadata` part OpenProject requires alongside the file.
///
/// `description` is sent empty rather than omitted: OpenProject's own uploader
/// sends the key, and an instance with a required-description validation would
/// otherwise refuse every upload from here.
pub fn upload_metadata(file_name: &str) -> serde_json::Value {
    serde_json::json!({
        "fileName": file_name,
        "description": { "format": "plain", "raw": "" }
    })
}

/// A filename that is safe to send as a multipart part name.
///
/// Path separators are stripped rather than rejected: a drop on Windows yields
/// a backslash-separated path, and the base name is what OpenProject should
/// store. An empty or all-separator result falls back to a generic name so an
/// upload never fails on cosmetics alone.
pub fn sanitize_file_name(input: &str) -> String {
    const FALLBACK: &str = "attachment";
    const MAX_LENGTH: usize = 255;

    let base = input
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(input)
        .trim()
        // A quote or a newline in a part name would break the multipart header
        // it is interpolated into.
        .replace(['"', '\r', '\n', '\0'], "");

    let trimmed: String = base.chars().take(MAX_LENGTH).collect();
    let trimmed = trimmed.trim_matches('.').trim();
    if trimmed.is_empty() {
        return FALLBACK.to_string();
    }
    trimmed.to_string()
}

/// The content type for a file name, from its extension.
///
/// A small table rather than a mime database: OpenProject sniffs the bytes
/// itself and this only has to be good enough that an image is not stored as
/// `application/octet-stream` (which would make it non-previewable). Anything
/// unrecognised gets the generic type and OpenProject decides.
pub fn guess_content_type(file_name: &str) -> &'static str {
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(json: &str) -> Attachment {
        serde_json::from_str::<Attachment>(json)
            .expect("parses")
            .with_computed_fields()
    }

    #[test]
    fn parses_the_fields_the_list_renders() {
        let parsed = attachment(
            r#"{"_type":"Attachment","id":391,"fileName":"Blue_screen.png","fileSize":24551,
                "contentType":"image/png","createdAt":"2014-05-21T08:51:20Z",
                "description":{"format":"plain","raw":"","html":""},
                "digest":{"algorithm":"md5","hash":"abc"},
                "_links":{"self":{"href":"/api/v3/attachments/391"},
                          "author":{"href":"/api/v3/users/1","title":"Ada"},
                          "delete":{"href":"/api/v3/attachments/391","method":"delete"}}}"#,
        );
        assert_eq!(parsed.id, 391);
        assert_eq!(parsed.file_name, "Blue_screen.png");
        assert_eq!(parsed.file_size, Some(24551));
        assert_eq!(
            parsed.links.author.as_ref().and_then(HalLink::title),
            Some("Ada")
        );
        assert!(parsed.can_delete);
        assert!(parsed.is_image());
    }

    #[test]
    fn an_attachment_without_a_delete_link_is_not_deletable() {
        let parsed = attachment(
            r#"{"id":7,"fileName":"a.pdf","contentType":"application/pdf","_links":{}}"#,
        );
        assert!(!parsed.can_delete);
        assert!(!parsed.is_image());
    }

    #[test]
    fn a_server_cannot_assert_the_computed_fields() {
        // Both are `skip_deserializing`, so a hostile instance claiming
        // `canDelete` or supplying its own `proxyUrl` is ignored outright.
        let parsed = attachment(
            r#"{"id":7,"fileName":"a.png","canDelete":true,
                "proxyUrl":"https://evil.example.com/x","_links":{}}"#,
        );
        assert!(!parsed.can_delete);
        assert_eq!(parsed.proxy_url, attachment_proxy_url(7));
    }

    #[test]
    fn a_missing_content_type_is_not_an_image() {
        let parsed = attachment(r#"{"id":7,"fileName":"a","_links":{}}"#);
        assert!(!parsed.is_image());
    }

    #[test]
    fn an_image_content_type_is_recognised_with_a_charset_or_padding() {
        for value in [
            "image/png",
            " IMAGE/JPEG",
            "image/svg+xml",
            "image/jpeg; x=1",
        ] {
            let parsed = attachment(&format!(
                r#"{{"id":7,"fileName":"a","contentType":"{value}","_links":{{}}}}"#
            ));
            assert!(parsed.is_image(), "{value}");
        }
        for value in ["text/plain", "application/pdf", "notimage/png"] {
            let parsed = attachment(&format!(
                r#"{{"id":7,"fileName":"a","contentType":"{value}","_links":{{}}}}"#
            ));
            assert!(!parsed.is_image(), "{value}");
        }
    }

    #[test]
    fn a_collection_of_attachments_parses() {
        let collection: AttachmentCollection = serde_json::from_str(
            r#"{"_type":"Collection","total":1,"count":1,
                "_embedded":{"elements":[{"id":1,"fileName":"a.png","_links":{}}]}}"#,
        )
        .unwrap();
        assert_eq!(collection.elements().len(), 1);
    }

    #[test]
    fn a_file_name_is_reduced_to_its_base_name() {
        assert_eq!(sanitize_file_name("/Users/ada/shot.png"), "shot.png");
        assert_eq!(sanitize_file_name(r"C:\Users\ada\shot.png"), "shot.png");
        assert_eq!(sanitize_file_name("  shot.png  "), "shot.png");
    }

    #[test]
    fn a_file_name_cannot_break_out_of_its_multipart_header() {
        assert_eq!(
            sanitize_file_name("a\"; filename=\"b.png"),
            "a; filename=b.png"
        );
        assert!(!sanitize_file_name("a\r\nX-Evil: 1").contains('\n'));
    }

    #[test]
    fn an_unusable_file_name_falls_back_rather_than_failing() {
        assert_eq!(sanitize_file_name(""), "attachment");
        assert_eq!(sanitize_file_name("/"), "attachment");
        assert_eq!(sanitize_file_name("..."), "attachment");
    }

    #[test]
    fn a_long_file_name_is_capped() {
        let name = format!("{}.png", "x".repeat(400));
        assert!(sanitize_file_name(&name).chars().count() <= 255);
    }

    #[test]
    fn content_types_cover_the_image_formats_a_screenshot_arrives_as() {
        assert_eq!(guess_content_type("shot.PNG"), "image/png");
        assert_eq!(guess_content_type("a.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("a.pdf"), "application/pdf");
        assert_eq!(
            guess_content_type("noextension"),
            "application/octet-stream"
        );
        assert_eq!(
            guess_content_type("a.unknownext"),
            "application/octet-stream"
        );
    }

    #[test]
    fn the_metadata_part_carries_the_file_name_and_an_empty_description() {
        let metadata = upload_metadata("shot.png");
        assert_eq!(metadata["fileName"], "shot.png");
        assert_eq!(metadata["description"]["raw"], "");
        assert_eq!(metadata["description"]["format"], "plain");
    }

    #[test]
    fn ids_are_validated_before_anything_is_built_from_them() {
        assert!(WorkPackageAttachmentsInput { work_package_id: 0 }
            .validate()
            .is_err());
        assert!(WorkPackageAttachmentsInput {
            work_package_id: -1
        }
        .validate()
        .is_err());
        assert_eq!(
            WorkPackageAttachmentsInput {
                work_package_id: 40023
            }
            .validate()
            .unwrap(),
            40023
        );
        assert!(AttachmentIdInput { id: 0 }.validate().is_err());
    }
}
