//! Time entries: the resource, the activities enumeration, and the create /
//! update / delete inputs.
//!
//! Port of `src/main/schemas/time-entries.ts`.
//!
//! `hours` stays the raw ISO 8601 duration string on the way out, exactly as
//! the Electron app sent it, because the frontend's calendar aggregation parses
//! it with its own copy of `parseHoursToDecimal`. Changing it to a number here
//! would be a breaking contract change for no gain.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::schemas::common::{Collection, Formattable, HalLink};
use crate::util::hal::{parse_activity_id_from_href, TIME_ENTRY_ACTIVITY_PATH, WORK_PACKAGE_PATH};
use crate::util::time::format_decimal_hours_to_iso;
use crate::util::validation::{validate_calendar_date, validate_positive_id};

/// Max comment length accepted before OpenProject is even called.
const COMMENT_MAX_LENGTH: usize = 2000;

/// The `_links` on a time entry.
///
/// `activity` is declared rather than left to unknown-key tolerance because the
/// day modal reads it to prefill edit mode.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TimeEntryLinks {
    #[serde(rename = "self")]
    pub self_link: HalLink,
    #[serde(
        default,
        rename = "workPackage",
        skip_serializing_if = "Option::is_none"
    )]
    pub work_package: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<HalLink>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TimeEntry {
    pub id: i64,
    #[serde(rename = "_type")]
    pub type_name: String,
    /// The raw ISO 8601 duration — see the module note.
    pub hours: String,
    #[serde(rename = "spentOn")]
    pub spent_on: String,
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub comment: Formattable,
    #[serde(rename = "_links")]
    pub links: TimeEntryLinks,
}

pub type TimeEntryCollection = Collection<TimeEntry>;

/// The "what kind of work" enumeration OpenProject requires on every entry.
///
/// `position` and `default` are optional because the form endpoint's link-only
/// representation carries neither.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TimeEntryActivity {
    pub id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

pub type TimeEntryActivityCollection = Collection<TimeEntryActivity>;

/// Pull the allowed activities out of a `POST /api/v3/time_entries/form`
/// response.
///
/// OpenProject offers two representations depending on version and payload:
/// fully `_embedded` resources (which carry `position` and `default`) or
/// `_links` entries (href + title). The embedded form wins when present; the
/// link form is the fallback, with the id read out of the href.
///
/// Anything that fails to yield both a positive-integer id and a non-empty name
/// is skipped rather than raising — a partially malformed form still produces a
/// usable Activity select instead of failing the whole request.
pub fn extract_activities_from_form(form: &Value) -> Vec<TimeEntryActivity> {
    let activity = form
        .get("_embedded")
        .and_then(|e| e.get("schema"))
        .and_then(|s| s.get("activity"));

    let mut out: Vec<TimeEntryActivity> = Vec::new();

    /// Append one activity, skipping anything unusable or already seen.
    ///
    /// A free function rather than a closure so the `out.is_empty()` check
    /// between the two representations can read the vector it appends to.
    fn push(
        out: &mut Vec<TimeEntryActivity>,
        id: Option<i64>,
        name: Option<&str>,
        position: Option<i64>,
        default: Option<bool>,
    ) {
        let Some(id) = id else { return };
        if id <= 0 {
            return;
        }
        let Some(name) = name else { return };
        if name.trim().is_empty() {
            return;
        }
        if out.iter().any(|activity| activity.id == id) {
            return;
        }
        out.push(TimeEntryActivity {
            id,
            name: name.to_string(),
            position,
            default,
        });
    }

    if let Some(embedded) = activity
        .and_then(|a| a.get("_embedded"))
        .and_then(|e| e.get("allowedValues"))
        .and_then(Value::as_array)
    {
        for raw in embedded {
            let id = raw.get("id").and_then(Value::as_i64).or_else(|| {
                parse_activity_id_from_href(
                    raw.get("_links")
                        .and_then(|l| l.get("self"))
                        .and_then(|s| s.get("href"))
                        .and_then(Value::as_str),
                )
            });
            push(
                &mut out,
                id,
                raw.get("name").and_then(Value::as_str),
                raw.get("position").and_then(Value::as_i64),
                raw.get("default").and_then(Value::as_bool),
            );
        }
    }

    if !out.is_empty() {
        return out;
    }

    if let Some(links) = activity
        .and_then(|a| a.get("_links"))
        .and_then(|l| l.get("allowedValues"))
        .and_then(Value::as_array)
    {
        for raw in links {
            let href = raw.get("href").and_then(Value::as_str);
            push(
                &mut out,
                parse_activity_id_from_href(href),
                raw.get("title").and_then(Value::as_str),
                None,
                None,
            );
        }
    }

    out
}

// Inputs (webview → Rust; the webview is an untrusted input source)

/// Input for creating a time entry.
///
/// Plain numeric ids, never hrefs or paths: the client builds every `_links`
/// href itself from a validated integer, so no frontend string can be injected
/// into a request URL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTimeEntryInput {
    pub work_package_id: i64,
    pub activity_id: i64,
    pub spent_on: String,
    /// Decimal hours.
    pub hours: f64,
    #[serde(default)]
    pub comment: Option<String>,
}

/// Input for updating an entry: the create fields plus the id to replace.
///
/// Semantics are **full replacement**, not a partial patch — the edit form
/// always holds every field, so every field is sent, which is what makes an
/// omitted `comment` mean "clear it".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimeEntryInput {
    pub id: i64,
    #[serde(flatten)]
    pub fields: CreateTimeEntryInput,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteTimeEntryInput {
    pub id: i64,
}

/// A create/update input with every field checked: ids positive, `spentOn` a
/// real calendar day, `hours` in `(0, 24]`, comment length-bounded.
#[derive(Debug, Clone)]
pub struct ValidatedTimeEntryFields {
    pub work_package_id: i64,
    pub activity_id: i64,
    pub spent_on: String,
    pub hours: f64,
    pub comment: Option<String>,
}

impl CreateTimeEntryInput {
    pub fn validate(&self) -> Result<ValidatedTimeEntryFields, String> {
        let work_package_id = validate_positive_id(self.work_package_id, "The work package id")?;
        let activity_id = validate_positive_id(self.activity_id, "The activity id")?;
        let spent_on = validate_calendar_date(&self.spent_on, "spentOn")?;

        // A zero-hour entry is meaningless and a single entry cannot exceed a
        // day — the same bounds the Zod schema enforced.
        if !self.hours.is_finite() || self.hours <= 0.0 {
            return Err("The hours must be greater than zero.".to_string());
        }
        if self.hours > 24.0 {
            return Err("A single entry cannot exceed 24 hours.".to_string());
        }

        let comment = match &self.comment {
            Some(comment) if comment.chars().count() > COMMENT_MAX_LENGTH => {
                return Err(format!(
                    "The comment cannot be longer than {COMMENT_MAX_LENGTH} characters."
                ))
            }
            other => other.clone(),
        };

        Ok(ValidatedTimeEntryFields {
            work_package_id,
            activity_id,
            spent_on,
            hours: self.hours,
            comment,
        })
    }
}

/// Build the body shared by create (`POST`) and update (`PATCH`).
///
/// Both endpoints take the same representation, so it is built in one place — a
/// field added to one cannot silently miss the other. Every href comes from an
/// already-validated numeric id.
///
/// `clear_absent_comment` is the one real difference: `POST` omits an absent
/// comment (there is nothing to clear), while `PATCH` sends an empty `raw`,
/// because the update replaces and omitting the key would leave the old comment
/// in place — making "clear this comment" unexpressible.
pub fn build_time_entry_payload(
    fields: &ValidatedTimeEntryFields,
    clear_absent_comment: bool,
) -> Result<Value, String> {
    let has_comment = fields
        .comment
        .as_ref()
        .is_some_and(|comment| !comment.is_empty());

    let mut payload = json!({
        "spentOn": fields.spent_on,
        "hours": format_decimal_hours_to_iso(fields.hours)?,
        "_links": {
            "workPackage": { "href": format!("{WORK_PACKAGE_PATH}/{}", fields.work_package_id) },
            "activity": { "href": format!("{TIME_ENTRY_ACTIVITY_PATH}/{}", fields.activity_id) }
        }
    });

    if has_comment {
        payload["comment"] = json!({ "raw": fields.comment.clone().unwrap_or_default() });
    } else if clear_absent_comment {
        payload["comment"] = json!({ "raw": "" });
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> ValidatedTimeEntryFields {
        ValidatedTimeEntryFields {
            work_package_id: 42,
            activity_id: 3,
            spent_on: "2026-03-04".to_string(),
            hours: 1.5,
            comment: None,
        }
    }

    #[test]
    fn parses_a_real_time_entry() {
        let json = r#"{
            "id": 12, "_type": "TimeEntry", "hours": "PT1H30M", "spentOn": "2026-03-04",
            "comment": {"format": "plain", "raw": "worked", "html": "<p>worked</p>"},
            "customField7": "ignored",
            "_links": {"self": {"href": "/api/v3/time_entries/12"},
                       "workPackage": {"href": "/api/v3/work_packages/42", "title": "Fix"},
                       "activity": {"href": "/api/v3/time_entries/activities/3"}}
        }"#;
        let entry: TimeEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.id, 12);
        assert_eq!(entry.hours, "PT1H30M");
        assert_eq!(entry.comment.raw(), "worked");
        assert_eq!(
            entry.links.work_package.unwrap().href(),
            Some("/api/v3/work_packages/42")
        );
    }

    #[test]
    fn parses_an_entry_with_no_comment_at_all() {
        let json = r#"{"id":1,"_type":"TimeEntry","hours":"PT0S","spentOn":"2026-01-01",
                       "_links":{"self":{"href":"/api/v3/time_entries/1"}}}"#;
        let entry: TimeEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.comment.raw(), "");
    }

    #[test]
    fn validation_rejects_bad_ids_dates_and_hours() {
        let base = CreateTimeEntryInput {
            work_package_id: 1,
            activity_id: 1,
            spent_on: "2026-03-04".to_string(),
            hours: 1.0,
            comment: None,
        };
        assert!(base.validate().is_ok());

        let bad_wp = CreateTimeEntryInput {
            work_package_id: 0,
            ..base.clone()
        };
        assert!(bad_wp.validate().is_err());

        let bad_date = CreateTimeEntryInput {
            spent_on: "2026-02-31".into(),
            ..base.clone()
        };
        assert!(bad_date.validate().is_err());

        let zero_hours = CreateTimeEntryInput {
            hours: 0.0,
            ..base.clone()
        };
        assert!(zero_hours.validate().is_err());

        let too_many_hours = CreateTimeEntryInput {
            hours: 24.5,
            ..base.clone()
        };
        assert!(too_many_hours.validate().is_err());

        let long_comment = CreateTimeEntryInput {
            comment: Some("x".repeat(2001)),
            ..base
        };
        assert!(long_comment.validate().is_err());
    }

    #[test]
    fn a_create_payload_omits_an_absent_comment() {
        let payload = build_time_entry_payload(&fields(), false).unwrap();
        assert_eq!(payload["spentOn"], "2026-03-04");
        assert_eq!(payload["hours"], "PT1H30M");
        assert!(payload.get("comment").is_none());
        assert_eq!(
            payload["_links"]["workPackage"]["href"],
            "/api/v3/work_packages/42"
        );
        assert_eq!(
            payload["_links"]["activity"]["href"],
            "/api/v3/time_entries/activities/3"
        );
    }

    #[test]
    fn an_update_payload_clears_an_absent_comment() {
        let payload = build_time_entry_payload(&fields(), true).unwrap();
        assert_eq!(payload["comment"]["raw"], "");
    }

    #[test]
    fn a_present_comment_is_sent_either_way() {
        let with_comment = ValidatedTimeEntryFields {
            comment: Some("note".to_string()),
            ..fields()
        };
        for clear in [true, false] {
            let payload = build_time_entry_payload(&with_comment, clear).unwrap();
            assert_eq!(payload["comment"]["raw"], "note");
        }
    }

    #[test]
    fn activities_come_from_the_embedded_representation_first() {
        let form = serde_json::json!({
            "_embedded": {"schema": {"activity": {"_embedded": {"allowedValues": [
                {"id": 3, "name": "Development", "position": 1, "default": true},
                {"id": 4, "name": "Management"}
            ]}, "_links": {"allowedValues": [
                {"href": "/api/v3/time_entries/activities/9", "title": "Ignored"}
            ]}}}}
        });
        let activities = extract_activities_from_form(&form);
        assert_eq!(activities.len(), 2);
        assert_eq!(activities[0].id, 3);
        assert_eq!(activities[0].position, Some(1));
        assert_eq!(activities[0].default, Some(true));
        assert_eq!(activities[1].name, "Management");
    }

    #[test]
    fn activities_fall_back_to_the_link_representation() {
        let form = serde_json::json!({
            "_embedded": {"schema": {"activity": {"_links": {"allowedValues": [
                {"href": "/api/v3/time_entries/activities/3", "title": "Development"},
                {"href": "/api/v3/time_entries/activities/3", "title": "Duplicate"},
                {"href": "/api/v3/time_entries/activities/0", "title": "Bad id"},
                {"href": "/api/v3/time_entries/activities/5", "title": "  "},
                {"title": "No href"}
            ]}}}}
        });
        let activities = extract_activities_from_form(&form);
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].id, 3);
        assert_eq!(activities[0].name, "Development");
    }

    #[test]
    fn a_form_with_no_activity_property_yields_an_empty_list() {
        assert!(extract_activities_from_form(&serde_json::json!({})).is_empty());
    }
}
