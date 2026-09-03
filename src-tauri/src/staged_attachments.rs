//! Files chosen before the work package they belong to exists.
//!
//! OpenProject attaches to a container: `POST /api/v3/work_packages/{id}/attachments`
//! needs an id, and during a create there isn't one yet. So the create flow
//! stages files and uploads them the moment the work package is real.
//!
//! ## Why the staging lives here and not in the webview
//!
//! The obvious implementation is to let the frontend hold the chosen paths and
//! hand them back after the create. That would quietly undo the property
//! `commands::attachments` is built around: the native picker opens in *this*
//! process precisely so a path is never chosen by, or handed to, the webview.
//!
//! Instead this holds the paths and gives the webview an opaque **token** per
//! file, plus the metadata it needs to draw a list — name, size, type. The
//! webview can show a staged file, drop one, and ask for all of them to be
//! uploaded to a work package id. It never learns where any of them are.
//!
//! Tokens are process-local and meaningless outside this store, so a token the
//! webview invents resolves to nothing rather than to a file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::schemas::attachments::guess_content_type;

/// What the webview learns about a file it has staged.
///
/// Deliberately not the path. `token` is the handle for every later operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachment {
    pub token: String,
    pub file_name: String,
    pub file_size: u64,
    pub content_type: String,
}

#[derive(Default)]
struct Inner {
    /// Monotonic, so a token is never reused within a run — a discarded token
    /// cannot come back pointing at a different file.
    next: u64,
    files: HashMap<String, PathBuf>,
}

/// The staging store, held as Tauri managed state.
#[derive(Default)]
pub struct StagingArea(Mutex<Inner>);

impl StagingArea {
    /// Recover from a poisoned lock rather than propagating a panic.
    ///
    /// Nothing in the guarded section can panic today, so this is belt and
    /// braces — but the failure mode it avoids is the whole create flow
    /// becoming permanently unusable for the rest of the session.
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Take custody of one file, returning the handle the webview will use.
    pub fn stage(&self, path: PathBuf, file_name: String, file_size: u64) -> StagedAttachment {
        let mut inner = self.inner();
        inner.next += 1;
        let token = format!("staged-{}", inner.next);
        inner.files.insert(token.clone(), path);

        StagedAttachment {
            content_type: guess_content_type(&file_name).to_string(),
            file_name,
            file_size,
            token,
        }
    }

    /// The paths behind `tokens`, in the order asked for, **without** removing
    /// them.
    ///
    /// Not removing is what makes a partly-failed upload recoverable: the
    /// caller removes each file only once it has actually landed. An unknown
    /// token is skipped rather than erroring — it means the webview is holding a
    /// staged file this store has already handed over.
    pub fn paths_for(&self, tokens: &[String]) -> Vec<(String, PathBuf)> {
        let inner = self.inner();
        tokens
            .iter()
            .filter_map(|token| {
                inner
                    .files
                    .get(token)
                    .map(|path| (token.clone(), path.clone()))
            })
            .collect()
    }

    /// Forget one file — the user removed it from the staged list, or it has
    /// been uploaded.
    pub fn discard(&self, token: &str) {
        self.inner().files.remove(token);
    }

    /// Forget everything. Called when a create is cancelled, so a discarded
    /// draft does not leave paths held for the rest of the session.
    pub fn clear(&self) {
        self.inner().files.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> StagingArea {
        StagingArea::default()
    }

    #[test]
    fn staging_returns_metadata_and_a_handle_but_never_the_path() {
        let staged = area().stage(
            PathBuf::from("/Users/ada/secret/shot.png"),
            "shot.png".to_string(),
            2048,
        );

        assert_eq!(staged.file_name, "shot.png");
        assert_eq!(staged.file_size, 2048);
        assert_eq!(staged.content_type, "image/png");
        // The whole point: nothing in what crosses names a location on disk.
        let serialized = serde_json::to_string(&staged).unwrap();
        assert!(!serialized.contains("Users"), "{serialized}");
        assert!(!serialized.contains("secret"), "{serialized}");
    }

    #[test]
    fn a_token_resolves_back_to_its_path() {
        let area = area();
        let staged = area.stage(PathBuf::from("/tmp/a.png"), "a.png".to_string(), 1);

        let resolved = area.paths_for(std::slice::from_ref(&staged.token));
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].1, PathBuf::from("/tmp/a.png"));
    }

    #[test]
    fn resolving_does_not_consume_so_a_failed_upload_can_be_retried() {
        let area = area();
        let staged = area.stage(PathBuf::from("/tmp/a.png"), "a.png".to_string(), 1);

        assert_eq!(area.paths_for(std::slice::from_ref(&staged.token)).len(), 1);
        assert_eq!(area.paths_for(std::slice::from_ref(&staged.token)).len(), 1);
    }

    #[test]
    fn resolution_preserves_the_order_asked_for() {
        let area = area();
        let first = area.stage(PathBuf::from("/tmp/1.png"), "1.png".to_string(), 1);
        let second = area.stage(PathBuf::from("/tmp/2.png"), "2.png".to_string(), 1);

        let resolved = area.paths_for(&[second.token.clone(), first.token.clone()]);
        assert_eq!(
            resolved.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>(),
            vec![PathBuf::from("/tmp/2.png"), PathBuf::from("/tmp/1.png")]
        );
    }

    #[test]
    fn a_token_the_webview_invented_resolves_to_nothing() {
        let area = area();
        area.stage(PathBuf::from("/tmp/a.png"), "a.png".to_string(), 1);

        assert!(area.paths_for(&["staged-999".to_string()]).is_empty());
        assert!(area.paths_for(&["../../etc/passwd".to_string()]).is_empty());
        assert!(area.paths_for(&["/etc/passwd".to_string()]).is_empty());
    }

    #[test]
    fn a_discarded_file_is_gone_and_its_token_is_never_reissued() {
        let area = area();
        let staged = area.stage(PathBuf::from("/tmp/a.png"), "a.png".to_string(), 1);
        area.discard(&staged.token);
        assert!(area
            .paths_for(std::slice::from_ref(&staged.token))
            .is_empty());

        // The next file gets a fresh token, so the discarded one cannot come
        // back pointing somewhere else.
        let next = area.stage(PathBuf::from("/tmp/b.png"), "b.png".to_string(), 1);
        assert_ne!(next.token, staged.token);
    }

    #[test]
    fn clearing_releases_every_held_path() {
        let area = area();
        let first = area.stage(PathBuf::from("/tmp/1.png"), "1.png".to_string(), 1);
        let second = area.stage(PathBuf::from("/tmp/2.png"), "2.png".to_string(), 1);

        area.clear();
        assert!(area.paths_for(&[first.token, second.token]).is_empty());
    }
}
