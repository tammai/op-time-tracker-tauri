//! HAL collection paths and href readers.
//!
//! Port of `src/shared/utils/hal.ts` from the Electron app. OpenProject speaks
//! HAL+JSON: a resource reference is an href like `/api/v3/statuses/7`, and the
//! id has to be read back out of it. Every path constant lives here so a
//! request URL is never assembled from a string literal at the call site, and
//! so `parse_resource_id_from_href` can be *anchored* — a `status` href sitting
//! in the `type` slot yields `None` rather than a plausible-looking wrong id.
//!
//! The frontend keeps its own TypeScript copy of this module (it reads hrefs off
//! validated resources to seed forms); the two are deliberately parallel, and
//! both are covered by tests.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Mutex;

pub const TIME_ENTRY_ACTIVITY_PATH: &str = "/api/v3/time_entries/activities";
pub const TIME_ENTRY_PATH: &str = "/api/v3/time_entries";
pub const WORK_PACKAGE_PATH: &str = "/api/v3/work_packages";
pub const STATUS_PATH: &str = "/api/v3/statuses";
pub const TYPE_PATH: &str = "/api/v3/types";
pub const PRIORITY_PATH: &str = "/api/v3/priorities";
pub const PROJECT_PATH: &str = "/api/v3/projects";
pub const USER_PATH: &str = "/api/v3/users";
pub const GROUP_PATH: &str = "/api/v3/groups";
pub const PLACEHOLDER_USER_PATH: &str = "/api/v3/placeholder_users";
pub const ATTACHMENT_PATH: &str = "/api/v3/attachments";

/// Compiled `<collection>/<digits>` matchers, one per collection path.
///
/// The set of paths is closed (the constants above), so the cache can never
/// grow unbounded from server input.
static ID_MATCHERS: Lazy<Mutex<HashMap<&'static str, Regex>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn id_matcher(collection_path: &'static str) -> Regex {
    let mut cache = ID_MATCHERS.lock().expect("href matcher cache poisoned");
    cache
        .entry(collection_path)
        .or_insert_with(|| {
            Regex::new(&format!("{}/(\\d+)/?$", regex::escape(collection_path)))
                .expect("collection path is a valid regex literal")
        })
        .clone()
}

/// Read the resource id out of an href, anchored on the collection it must
/// belong to.
///
/// `None` for anything that is not `<collection_path>/<positive integer>` —
/// including a null href, which is how HAL spells "unset".
pub fn parse_resource_id_from_href(
    collection_path: &'static str,
    href: Option<&str>,
) -> Option<i64> {
    let href = href?;
    let captures = id_matcher(collection_path).captures(href)?;
    let id: i64 = captures.get(1)?.as_str().parse().ok()?;
    if id > 0 {
        Some(id)
    } else {
        None
    }
}

pub fn parse_activity_id_from_href(href: Option<&str>) -> Option<i64> {
    parse_resource_id_from_href(TIME_ENTRY_ACTIVITY_PATH, href)
}

pub fn parse_work_package_id_from_href(href: Option<&str>) -> Option<i64> {
    parse_resource_id_from_href(WORK_PACKAGE_PATH, href)
}

/// A principal may be a user, a group, or a placeholder user — three
/// collections, one id. Tried in that order.
pub fn parse_principal_id_from_href(href: Option<&str>) -> Option<i64> {
    [USER_PATH, GROUP_PATH, PLACEHOLDER_USER_PATH]
        .into_iter()
        .find_map(|path| parse_resource_id_from_href(path, href))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_id_out_of_a_matching_href() {
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/statuses/7")),
            Some(7)
        );
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/statuses/7/")),
            Some(7)
        );
    }

    #[test]
    fn is_anchored_on_its_own_collection() {
        // The ids overlap freely across collections, so a type href in the
        // status slot must not yield a plausible-looking wrong id.
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/types/7")),
            None
        );
    }

    #[test]
    fn rejects_non_ids_and_unset_links() {
        assert_eq!(parse_resource_id_from_href(STATUS_PATH, None), None);
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/statuses/abc")),
            None
        );
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/statuses/0")),
            None
        );
        assert_eq!(
            parse_resource_id_from_href(STATUS_PATH, Some("/api/v3/statuses/7/extra")),
            None
        );
    }

    #[test]
    fn a_principal_id_comes_from_any_of_its_three_collections() {
        assert_eq!(
            parse_principal_id_from_href(Some("/api/v3/users/12")),
            Some(12)
        );
        assert_eq!(
            parse_principal_id_from_href(Some("/api/v3/groups/12")),
            Some(12)
        );
        assert_eq!(
            parse_principal_id_from_href(Some("/api/v3/placeholder_users/12")),
            Some(12)
        );
        assert_eq!(
            parse_principal_id_from_href(Some("/api/v3/statuses/12")),
            None
        );
    }
}
