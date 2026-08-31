//! Work packages: the resource, the two form endpoints, and the create/update
//! inputs with their payload builders.
//!
//! Port of `src/main/schemas/work-packages.ts`.
//!
//! Two things in here carry most of the weight:
//!
//! - **Form normalization.** A form response is a ~10 KB HAL document holding
//!   every attribute and custom field the instance defines. Four things are read
//!   out of it, flattened to `{ writable, allowedValues: [{id, name}] }`, so the
//!   frontend never handles an href or an `_embedded` block.
//! - **Clear versus omit.** The update payload is *partial*: a field appears if
//!   and only if the caller passed it, and `null` is a separate explicit
//!   instruction meaning "clear this". Collapsing the two would either make
//!   clearing impossible or rewrite fields the user never edited.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};

use crate::schemas::common::{Collection, Formattable, HalLink};
use crate::util::hal::{
    parse_resource_id_from_href, PRIORITY_PATH, PROJECT_PATH, STATUS_PATH, TYPE_PATH, USER_PATH,
};
use crate::util::validation::{
    validate_calendar_date, validate_lock_version, validate_positive_id,
};

/// Cap on the subject, enforced here rather than taken from the server.
///
/// OpenProject's own schema reports `maxLength: 255`, and the form response
/// carries that number — but a server-reported limit cannot be the boundary,
/// because a hostile instance would report a larger one.
pub const WORK_PACKAGE_SUBJECT_MAX_LENGTH: usize = 255;

/// Cap on the description. OpenProject imposes no practical limit of its own on
/// a Formattable, so unlike the subject this is the only bound there is. Its job
/// is to stop the webview handing this process a string it then has to hold,
/// serialize, and upload.
pub const WORK_PACKAGE_DESCRIPTION_MAX_LENGTH: usize = 30_000;

/// The `format` every description is sent with — **pinned here, never taken
/// from the frontend**.
///
/// Not a defensive nicety: a live instance accepted a payload whose `format` was
/// `"custom"` and whose `html` was a `<script>` tag with empty validation
/// errors. The server does not police this, so nothing downstream of here does
/// either. `html` is never sent at all — it is the server's rendering of `raw`,
/// not an input.
pub const WORK_PACKAGE_DESCRIPTION_FORMAT: &str = "markdown";

/// The `_links` on a work package.
///
/// `assignee` and `priority` are declared rather than left to unknown-key
/// tolerance because the detail panel reads their titles and the edit form
/// writes them.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct WorkPackageLinks {
    #[serde(rename = "self")]
    pub self_link: HalLink,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_link: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<HalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<HalLink>,
    /// Always serialized, defaulting to `{}` — an unassigned work package
    /// surfaces either as `assignee: {}` or as `{"href": null}`, and the
    /// frontend reads `_links.assignee.title` unconditionally.
    #[serde(default)]
    pub assignee: HalLink,
}

/// Number **or** ISO-8601 duration string: OpenProject serializes `spentHours`
/// as a duration on current versions, and nothing in the app reads it, so both
/// are accepted rather than failing a whole collection over an unused field.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SpentHours {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkPackage {
    pub id: i64,
    #[serde(rename = "_type")]
    pub type_name: String,
    /// OpenProject's optimistic-locking counter, bumped on every write.
    ///
    /// **Required**, deliberately: a `PATCH` without it is an unconditional
    /// overwrite of whatever the server currently holds, so an instance that
    /// omitted it would silently downgrade every save to last-writer-wins. A
    /// loud parse failure is the better outcome. Non-negative rather than
    /// positive — a never-edited work package reports `0`.
    #[serde(rename = "lockVersion")]
    pub lock_version: i64,
    pub subject: String,
    /// Optional on the wire; `Formattable::Empty` is the one spelling of
    /// "nothing here", so this is not additionally wrapped in an `Option` — two
    /// spellings of empty is how a read-vs-clear bug gets in.
    #[serde(default)]
    pub description: Formattable,
    /// Type title when the API returns it inline (often absent — the canonical
    /// display value is `_links.type.title`).
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, rename = "startDate", skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, rename = "dueDate", skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(
        default,
        rename = "spentHours",
        skip_serializing_if = "Option::is_none"
    )]
    pub spent_hours: Option<SpentHours>,
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(rename = "_links")]
    pub links: WorkPackageLinks,
}

pub type WorkPackageCollection = Collection<WorkPackage>;

// The normalized forms (what actually crosses into the webview)

/// One selectable value for an enumerated field, flattened out of HAL.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AllowedValue {
    pub id: i64,
    pub name: String,
}

/// An enumerated field: whether it may be written, and what it may be set to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkPackageFormField {
    pub writable: bool,
    #[serde(rename = "allowedValues")]
    pub allowed_values: Vec<AllowedValue>,
}

/// A free-form field: whether it may be written.
///
/// Carried for every field, not just the enumerated ones: a work package
/// scheduled automatically from its children reports non-writable dates, and
/// offering an input the server will refuse is worse than showing a disabled
/// one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkPackageFormPlainField {
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageForm {
    pub subject: WorkPackageFormPlainField,
    pub description: WorkPackageFormPlainField,
    pub start_date: WorkPackageFormPlainField,
    pub due_date: WorkPackageFormPlainField,
    pub assignee: WorkPackageFormPlainField,
    pub status: WorkPackageFormField,
    #[serde(rename = "type")]
    pub type_field: WorkPackageFormField,
    pub priority: WorkPackageFormField,
}

/// OpenProject's own initial values for the three required links.
///
/// `null` means the form offered none — reported honestly rather than guessed
/// at, so the frontend can gate Create on a type it genuinely cannot supply
/// instead of sending one the project never allowed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageCreateDefaults {
    pub type_id: Option<i64>,
    pub status_id: Option<i64>,
    pub priority_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageCreateForm {
    pub subject: WorkPackageFormPlainField,
    pub description: WorkPackageFormPlainField,
    pub start_date: WorkPackageFormPlainField,
    pub due_date: WorkPackageFormPlainField,
    pub assignee: WorkPackageFormPlainField,
    pub status: WorkPackageFormField,
    #[serde(rename = "type")]
    pub type_field: WorkPackageFormField,
    pub priority: WorkPackageFormField,
    pub defaults: WorkPackageCreateDefaults,
}

/// A property is writable unless the server explicitly said otherwise.
///
/// OpenProject's form schema defaults `writable` to `true` — a property that
/// omits the key is writable, and only an explicit `writable: false` (e.g.
/// `lockVersion`, or dates derived from child work packages) is not. Requiring
/// `== true` greyed out any field whose response left the key off, which a live
/// create form did for `description`.
///
/// A *missing* property is a different case: nothing is known about the field, so
/// `false` is the honest reading.
fn is_writable(property: Option<&Value>) -> bool {
    match property {
        None => false,
        Some(property) => property.get("writable") != Some(&Value::Bool(false)),
    }
}

/// Pull the allowed values for one enumerated property out of a form response.
///
/// The same two representations as the activities list: fully `_embedded`
/// resources (which carry `id` and `name` directly) or `_links` entries (href +
/// title). Embedded wins when present; links are the fallback, with the id read
/// out of the href and anchored on `collection_path`.
///
/// Anything that fails to yield both a usable id and a non-empty name is skipped
/// rather than raising — a partially malformed property still produces a usable
/// select instead of failing the whole request.
fn extract_allowed_values(
    property: Option<&Value>,
    collection_path: &'static str,
) -> Vec<AllowedValue> {
    let mut out: Vec<AllowedValue> = Vec::new();

    /// Append one allowed value, skipping anything unusable or already seen.
    ///
    /// A free function rather than a closure so the `out.is_empty()` check
    /// between the two representations can read the vector it appends to.
    fn push(out: &mut Vec<AllowedValue>, id: Option<i64>, name: Option<&str>) {
        let Some(id) = id else { return };
        if id <= 0 {
            return;
        }
        let Some(name) = name else { return };
        if name.trim().is_empty() {
            return;
        }
        if out.iter().any(|value| value.id == id) {
            return;
        }
        out.push(AllowedValue {
            id,
            name: name.to_string(),
        });
    }

    if let Some(embedded) = property
        .and_then(|p| p.get("_embedded"))
        .and_then(|e| e.get("allowedValues"))
        .and_then(Value::as_array)
    {
        for raw in embedded {
            let id = raw.get("id").and_then(Value::as_i64).or_else(|| {
                parse_resource_id_from_href(
                    collection_path,
                    raw.get("_links")
                        .and_then(|l| l.get("self"))
                        .and_then(|s| s.get("href"))
                        .and_then(Value::as_str),
                )
            });
            push(&mut out, id, raw.get("name").and_then(Value::as_str));
        }
    }

    if !out.is_empty() {
        return out;
    }

    // `_links.allowedValues` is an *array* for status/type/priority but a single
    // object for `assignee` (pointing at the project's available-assignees
    // collection), so a non-array is simply not a source of values here.
    if let Some(links) = property
        .and_then(|p| p.get("_links"))
        .and_then(|l| l.get("allowedValues"))
        .and_then(Value::as_array)
    {
        for raw in links {
            push(
                &mut out,
                parse_resource_id_from_href(
                    collection_path,
                    raw.get("href").and_then(Value::as_str),
                ),
                raw.get("title").and_then(Value::as_str),
            );
        }
    }

    out
}

fn schema_property<'a>(response: &'a Value, field: &str) -> Option<&'a Value> {
    response
        .get("_embedded")
        .and_then(|e| e.get("schema"))
        .and_then(|s| s.get(field))
}

/// Flatten an edit-form response into the normalized {@link WorkPackageForm}.
pub fn normalize_work_package_form(response: &Value) -> WorkPackageForm {
    WorkPackageForm {
        subject: WorkPackageFormPlainField {
            writable: is_writable(schema_property(response, "subject")),
        },
        description: WorkPackageFormPlainField {
            writable: is_writable(schema_property(response, "description")),
        },
        start_date: WorkPackageFormPlainField {
            writable: is_writable(schema_property(response, "startDate")),
        },
        due_date: WorkPackageFormPlainField {
            writable: is_writable(schema_property(response, "dueDate")),
        },
        assignee: WorkPackageFormPlainField {
            writable: is_writable(schema_property(response, "assignee")),
        },
        status: WorkPackageFormField {
            writable: is_writable(schema_property(response, "status")),
            allowed_values: extract_allowed_values(
                schema_property(response, "status"),
                STATUS_PATH,
            ),
        },
        type_field: WorkPackageFormField {
            writable: is_writable(schema_property(response, "type")),
            allowed_values: extract_allowed_values(schema_property(response, "type"), TYPE_PATH),
        },
        priority: WorkPackageFormField {
            writable: is_writable(schema_property(response, "priority")),
            allowed_values: extract_allowed_values(
                schema_property(response, "priority"),
                PRIORITY_PATH,
            ),
        },
    }
}

/// Flatten a create-form response into the normalized
/// {@link WorkPackageCreateForm}.
///
/// Each default is read out of its href **anchored on its own collection**, so a
/// `status` href sitting in the `type` slot yields `None` rather than a
/// plausible-looking wrong id — the ids overlap freely across collections.
pub fn normalize_work_package_create_form(response: &Value) -> WorkPackageCreateForm {
    let form = normalize_work_package_form(response);
    let payload_links = response
        .get("_embedded")
        .and_then(|e| e.get("payload"))
        .and_then(|p| p.get("_links"));

    let default_id = |field: &str, collection_path: &'static str| -> Option<i64> {
        parse_resource_id_from_href(
            collection_path,
            payload_links
                .and_then(|l| l.get(field))
                .and_then(|f| f.get("href"))
                .and_then(Value::as_str),
        )
    };

    WorkPackageCreateForm {
        subject: form.subject,
        description: form.description,
        start_date: form.start_date,
        due_date: form.due_date,
        assignee: form.assignee,
        status: form.status,
        type_field: form.type_field,
        priority: form.priority,
        defaults: WorkPackageCreateDefaults {
            type_id: default_id("type", TYPE_PATH),
            status_id: default_id("status", STATUS_PATH),
            priority_id: default_id("priority", PRIORITY_PATH),
        },
    }
}

// Inputs (webview → Rust; the webview is an untrusted input source)

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageFormInput {
    pub work_package_id: i64,
    /// Required, not decorative: the form endpoint answers HTTP 409 without one.
    pub lock_version: i64,
}

/// Input for `list_available_assignees`.
///
/// A **project** id, not a work package id: the work-package-scoped
/// `available_assignees` route does not exist (HTTP 404), and the form's
/// `assignee` allowed-values href points at the project collection instead.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAssigneesInput {
    pub project_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageCreateFormInput {
    pub project_id: i64,
    /// Optional, and when present the *only* thing that reaches the request
    /// body — as one href rebuilt from the validated integer. It matters on
    /// instances whose status workflows differ per type.
    #[serde(default)]
    pub type_id: Option<i64>,
}

/// Input for `create_work_package`.
///
/// Deliberately **not** nullable anywhere, which is the one place its semantics
/// differ from the update input. On an update, `null` means *clear this field*
/// and is distinct from an absent key; on a create there is nothing to clear, so
/// `null` would be a second spelling of "absent" — and two spellings of one
/// meaning is exactly how the clear-vs-omit bug gets in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkPackageInput {
    pub project_id: i64,
    pub type_id: i64,
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status_id: Option<i64>,
    #[serde(default)]
    pub priority_id: Option<i64>,
    #[serde(default)]
    pub assignee_id: Option<i64>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
}

/// `undefined` versus `null` versus a value, kept apart.
///
/// Absent means "don't touch"; `null` means "clear". That distinction is the
/// whole contract of a partial update, so the two cannot collapse into one
/// `None` — hence the double wrap, read as `None` / `Some(None)` / `Some(Some)`.
pub type Tristate<T> = Option<Option<T>>;

/// Deserialize a [`Tristate`] so a **present** `null` stays distinguishable from
/// an absent key.
///
/// `#[serde(default)]` alone is not enough: serde hands a plain
/// `Option<Option<T>>` field `None` for *both* cases, which silently turned
/// every "clear this date" into "leave it alone". Wrapping the inner result in
/// `Some` here is what keeps them apart — the field is only `None` when serde
/// never called this function at all, i.e. the key was missing.
fn deserialize_tristate<'de, T, D>(deserializer: D) -> Result<Tristate<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Input for `update_work_package` — a **partial** update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkPackageInput {
    pub id: i64,
    pub lock_version: i64,
    #[serde(default)]
    pub subject: Option<String>,
    /// `""` is a real instruction here — *clear the description* — expressed as
    /// an empty `raw`, because a Formattable has no null spelling the way a date
    /// link does.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_tristate")]
    pub start_date: Tristate<String>,
    #[serde(default, deserialize_with = "deserialize_tristate")]
    pub due_date: Tristate<String>,
    #[serde(default)]
    pub status_id: Option<i64>,
    #[serde(default)]
    pub type_id: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_tristate")]
    pub assignee_id: Tristate<i64>,
    #[serde(default)]
    pub priority_id: Option<i64>,
}

fn validate_subject(subject: &str) -> Result<String, String> {
    let trimmed = subject.trim();
    if trimmed.is_empty() {
        return Err("The subject cannot be empty.".to_string());
    }
    if trimmed.chars().count() > WORK_PACKAGE_SUBJECT_MAX_LENGTH {
        return Err(format!(
            "The subject cannot be longer than {WORK_PACKAGE_SUBJECT_MAX_LENGTH} characters."
        ));
    }
    Ok(trimmed.to_string())
}

/// Length-bounded, never trimmed: trailing whitespace is meaningful in markdown
/// (two spaces end a line), so unlike the subject this one is taken as typed.
fn validate_description(description: &str) -> Result<String, String> {
    if description.chars().count() > WORK_PACKAGE_DESCRIPTION_MAX_LENGTH {
        return Err(format!(
            "The description cannot be longer than {WORK_PACKAGE_DESCRIPTION_MAX_LENGTH} characters."
        ));
    }
    Ok(description.to_string())
}

/// The Formattable a description is sent as, with the format pinned above.
fn description_payload(raw: &str) -> Value {
    json!({ "format": WORK_PACKAGE_DESCRIPTION_FORMAT, "raw": raw })
}

impl WorkPackageFormInput {
    pub fn validate(&self) -> Result<(i64, i64), String> {
        Ok((
            validate_positive_id(self.work_package_id, "The work package id")?,
            validate_lock_version(self.lock_version)?,
        ))
    }
}

impl AvailableAssigneesInput {
    pub fn validate(&self) -> Result<i64, String> {
        validate_positive_id(self.project_id, "The project id")
    }
}

impl WorkPackageCreateFormInput {
    pub fn validate(&self) -> Result<(i64, Option<i64>), String> {
        let project_id = validate_positive_id(self.project_id, "The project id")?;
        let type_id = match self.type_id {
            Some(type_id) => Some(validate_positive_id(type_id, "The type id")?),
            None => None,
        };
        Ok((project_id, type_id))
    }
}

impl CreateWorkPackageInput {
    /// Validate, then build the `POST /api/v3/work_packages` body.
    ///
    /// Rebuilt field by field — never spread from the caller's object. That is
    /// what guarantees the frontend cannot append an `_links` block, a `format`,
    /// a rendered `html`, or a `lockVersion` and have it ride along: anything
    /// not named here simply does not exist in the request.
    pub fn build_payload(&self) -> Result<Value, String> {
        let project_id = validate_positive_id(self.project_id, "The project id")?;
        let type_id = validate_positive_id(self.type_id, "The type id")?;
        let subject = validate_subject(&self.subject)?;

        let mut payload = Map::new();
        payload.insert("subject".to_string(), json!(subject));

        // An empty description is nothing to send: there is no stored value to
        // clear, and OpenProject defaults it to empty anyway.
        if let Some(description) = &self.description {
            let description = validate_description(description)?;
            if !description.is_empty() {
                payload.insert("description".to_string(), description_payload(&description));
            }
        }
        if let Some(start_date) = &self.start_date {
            payload.insert(
                "startDate".to_string(),
                json!(validate_calendar_date(start_date, "The start date")?),
            );
        }
        if let Some(due_date) = &self.due_date {
            payload.insert(
                "dueDate".to_string(),
                json!(validate_calendar_date(due_date, "The due date")?),
            );
        }

        let mut links = Map::new();
        links.insert(
            "project".to_string(),
            json!({ "href": format!("{PROJECT_PATH}/{project_id}") }),
        );
        links.insert(
            "type".to_string(),
            json!({ "href": format!("{TYPE_PATH}/{type_id}") }),
        );
        if let Some(status_id) = self.status_id {
            let status_id = validate_positive_id(status_id, "The status id")?;
            links.insert(
                "status".to_string(),
                json!({ "href": format!("{STATUS_PATH}/{status_id}") }),
            );
        }
        if let Some(priority_id) = self.priority_id {
            let priority_id = validate_positive_id(priority_id, "The priority id")?;
            links.insert(
                "priority".to_string(),
                json!({ "href": format!("{PRIORITY_PATH}/{priority_id}") }),
            );
        }
        if let Some(assignee_id) = self.assignee_id {
            // Users only, exactly as on the update path: the href is built from
            // a bare number and has no way to express a group.
            let assignee_id = validate_positive_id(assignee_id, "The assignee id")?;
            links.insert(
                "assignee".to_string(),
                json!({ "href": format!("{USER_PATH}/{assignee_id}") }),
            );
        }
        payload.insert("_links".to_string(), Value::Object(links));

        Ok(Value::Object(payload))
    }

    /// Rewrite the description's inline attachment URLs before it is sent.
    pub fn map_description(&self, f: impl Fn(&str) -> String) -> CreateWorkPackageInput {
        CreateWorkPackageInput {
            description: self.description.as_deref().map(f),
            ..self.clone()
        }
    }
}

impl UpdateWorkPackageInput {
    /// Validate, then build the `PATCH /api/v3/work_packages/{id}` body.
    ///
    /// **Partial, not a replacement.** Only `lockVersion` is unconditional; a
    /// field appears if and only if the caller passed it. `id` is not in the
    /// body at all — it belongs to the URL.
    pub fn build_payload(&self) -> Result<Value, String> {
        validate_positive_id(self.id, "The work package id")?;
        let lock_version = validate_lock_version(self.lock_version)?;

        let mut payload = Map::new();
        payload.insert("lockVersion".to_string(), json!(lock_version));

        if let Some(subject) = &self.subject {
            payload.insert("subject".to_string(), json!(validate_subject(subject)?));
        }
        // The format is ours, never the caller's.
        if let Some(description) = &self.description {
            payload.insert(
                "description".to_string(),
                description_payload(&validate_description(description)?),
            );
        }
        if let Some(start_date) = &self.start_date {
            payload.insert(
                "startDate".to_string(),
                match start_date {
                    Some(date) => json!(validate_calendar_date(date, "The start date")?),
                    None => Value::Null,
                },
            );
        }
        if let Some(due_date) = &self.due_date {
            payload.insert(
                "dueDate".to_string(),
                match due_date {
                    Some(date) => json!(validate_calendar_date(date, "The due date")?),
                    None => Value::Null,
                },
            );
        }

        let mut links = Map::new();
        if let Some(status_id) = self.status_id {
            let status_id = validate_positive_id(status_id, "The status id")?;
            links.insert(
                "status".to_string(),
                json!({ "href": format!("{STATUS_PATH}/{status_id}") }),
            );
        }
        if let Some(type_id) = self.type_id {
            let type_id = validate_positive_id(type_id, "The type id")?;
            links.insert(
                "type".to_string(),
                json!({ "href": format!("{TYPE_PATH}/{type_id}") }),
            );
        }
        if let Some(priority_id) = self.priority_id {
            let priority_id = validate_positive_id(priority_id, "The priority id")?;
            links.insert(
                "priority".to_string(),
                json!({ "href": format!("{PRIORITY_PATH}/{priority_id}") }),
            );
        }
        if let Some(assignee_id) = &self.assignee_id {
            // The one link that can be cleared. HAL says so with an explicit
            // null href, not by omitting the key — omitting would mean
            // "unchanged".
            links.insert(
                "assignee".to_string(),
                match assignee_id {
                    Some(id) => {
                        let id = validate_positive_id(*id, "The assignee id")?;
                        json!({ "href": format!("{USER_PATH}/{id}") })
                    }
                    None => json!({ "href": Value::Null }),
                },
            );
        }
        if !links.is_empty() {
            payload.insert("_links".to_string(), Value::Object(links));
        }

        Ok(Value::Object(payload))
    }

    pub fn map_description(&self, f: impl Fn(&str) -> String) -> UpdateWorkPackageInput {
        UpdateWorkPackageInput {
            description: self.description.as_deref().map(f),
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form_response() -> Value {
        json!({
            "_type": "Form",
            "_embedded": {
                "schema": {
                    "lockVersion": { "writable": false },
                    "subject": { "writable": true },
                    // No `writable` key at all — writable by OpenProject's own
                    // default, which a live create form relied on.
                    "description": {},
                    "startDate": { "writable": false },
                    "dueDate": { "writable": true },
                    "assignee": {
                        "writable": true,
                        // A single object, not an array — the assignee list is
                        // fetched separately, so this yields no values.
                        "_links": { "allowedValues": { "href": "/api/v3/projects/5/available_assignees" } }
                    },
                    "status": {
                        "writable": true,
                        "_links": { "allowedValues": [
                            { "href": "/api/v3/statuses/1", "title": "New" },
                            { "href": "/api/v3/statuses/7", "title": "In progress" }
                        ]}
                    },
                    "type": {
                        "writable": true,
                        "_embedded": { "allowedValues": [
                            { "id": 1, "name": "Task" },
                            { "_links": { "self": { "href": "/api/v3/types/6" } }, "name": "Bug" }
                        ]}
                    },
                    "priority": { "writable": true }
                }
            }
        })
    }

    #[test]
    fn parses_a_real_work_package() {
        let json = r#"{
            "id": 42, "_type": "WorkPackage", "lockVersion": 3, "subject": "Fix login",
            "description": {"format": "markdown", "raw": "body", "html": "<p>body</p>"},
            "startDate": null, "dueDate": "2026-04-01", "spentHours": "PT3H30M",
            "customField12": {"anything": true},
            "_links": {
                "self": {"href": "/api/v3/work_packages/42"},
                "type": {"href": "/api/v3/types/1", "title": "Task"},
                "status": {"href": "/api/v3/statuses/7", "title": "In progress"},
                "project": {"href": "/api/v3/projects/5", "title": "Web"},
                "priority": {"href": "/api/v3/priorities/8", "title": "Normal"},
                "assignee": {"href": null}
            }
        }"#;
        let wp: WorkPackage = serde_json::from_str(json).unwrap();
        assert_eq!(wp.id, 42);
        assert_eq!(wp.lock_version, 3);
        assert_eq!(wp.description.raw(), "body");
        assert_eq!(wp.links.assignee.href(), None);
        assert_eq!(wp.links.status.unwrap().title(), Some("In progress"));
    }

    #[test]
    fn a_work_package_without_a_lock_version_fails_loudly() {
        let json = r#"{"id":1,"_type":"WorkPackage","subject":"x",
                       "_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#;
        assert!(serde_json::from_str::<WorkPackage>(json).is_err());
    }

    #[test]
    fn a_work_package_with_no_assignee_link_at_all_still_parses() {
        let json = r#"{"id":1,"_type":"WorkPackage","lockVersion":0,"subject":"x",
                       "_links":{"self":{"href":"/api/v3/work_packages/1"}}}"#;
        let wp: WorkPackage = serde_json::from_str(json).unwrap();
        assert_eq!(wp.links.assignee.href(), None);
    }

    #[test]
    fn normalizing_a_form_flattens_both_allowed_value_representations() {
        let form = normalize_work_package_form(&form_response());

        assert!(form.subject.writable);
        // Absent `writable` means writable.
        assert!(form.description.writable);
        assert!(!form.start_date.writable);

        assert_eq!(
            form.status.allowed_values,
            vec![
                AllowedValue {
                    id: 1,
                    name: "New".into()
                },
                AllowedValue {
                    id: 7,
                    name: "In progress".into()
                },
            ]
        );
        // Embedded values, one with an explicit id and one via its self href.
        assert_eq!(
            form.type_field.allowed_values,
            vec![
                AllowedValue {
                    id: 1,
                    name: "Task".into()
                },
                AllowedValue {
                    id: 6,
                    name: "Bug".into()
                },
            ]
        );
        // Writable, but the workflow offered nothing.
        assert!(form.priority.writable);
        assert!(form.priority.allowed_values.is_empty());
        // A single-object `allowedValues` is not a source of values.
        assert!(form.assignee.writable);
    }

    #[test]
    fn a_missing_property_is_reported_as_not_writable_with_no_values() {
        let form = normalize_work_package_form(&json!({}));
        assert!(!form.subject.writable);
        assert!(!form.status.writable);
        assert!(form.status.allowed_values.is_empty());
    }

    #[test]
    fn create_form_defaults_are_anchored_on_their_own_collections() {
        let mut response = form_response();
        response["_embedded"]["payload"] = json!({
            "_links": {
                "type": { "href": "/api/v3/types/1" },
                // Wrong collection for this slot — must not yield id 9.
                "status": { "href": "/api/v3/types/9" },
                "priority": { "href": null }
            }
        });
        let form = normalize_work_package_create_form(&response);
        assert_eq!(form.defaults.type_id, Some(1));
        assert_eq!(form.defaults.status_id, None);
        assert_eq!(form.defaults.priority_id, None);
        // The field half is normalized exactly as the edit form is.
        assert_eq!(form.status.allowed_values.len(), 2);
    }

    fn update(json: &str) -> UpdateWorkPackageInput {
        serde_json::from_str(json).expect("valid update input")
    }

    #[test]
    fn a_patch_payload_carries_only_what_the_caller_passed() {
        let payload = update(r#"{"id":42,"lockVersion":3,"subject":"New subject"}"#)
            .build_payload()
            .unwrap();
        let object = payload.as_object().unwrap();
        assert_eq!(object["lockVersion"], 3);
        assert_eq!(object["subject"], "New subject");
        // Absent means "don't touch" — the keys must not exist at all.
        assert!(!object.contains_key("startDate"));
        assert!(!object.contains_key("dueDate"));
        assert!(!object.contains_key("description"));
        assert!(!object.contains_key("_links"));
    }

    #[test]
    fn an_explicit_null_clears_a_date_while_absence_leaves_it_alone() {
        let payload = update(r#"{"id":42,"lockVersion":3,"startDate":null}"#)
            .build_payload()
            .unwrap();
        assert!(payload.as_object().unwrap().contains_key("startDate"));
        assert_eq!(payload["startDate"], Value::Null);
        assert!(!payload.as_object().unwrap().contains_key("dueDate"));
    }

    #[test]
    fn an_explicit_null_assignee_clears_it_with_a_null_href() {
        let payload = update(r#"{"id":42,"lockVersion":3,"assigneeId":null}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["_links"]["assignee"]["href"], Value::Null);

        let payload = update(r#"{"id":42,"lockVersion":3,"assigneeId":9}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["_links"]["assignee"]["href"], "/api/v3/users/9");
    }

    #[test]
    fn a_patch_description_is_sent_with_our_own_pinned_format() {
        let payload = update(r#"{"id":42,"lockVersion":3,"description":"body"}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["description"]["format"], "markdown");
        assert_eq!(payload["description"]["raw"], "body");
        assert!(payload["description"].get("html").is_none());

        // An empty description is a real instruction on the update path.
        let payload = update(r#"{"id":42,"lockVersion":3,"description":""}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["description"]["raw"], "");
    }

    #[test]
    fn a_patch_builds_every_enumerated_link_from_a_numeric_id() {
        let payload = update(r#"{"id":42,"lockVersion":0,"statusId":7,"typeId":1,"priorityId":8}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["_links"]["status"]["href"], "/api/v3/statuses/7");
        assert_eq!(payload["_links"]["type"]["href"], "/api/v3/types/1");
        assert_eq!(
            payload["_links"]["priority"]["href"],
            "/api/v3/priorities/8"
        );
    }

    #[test]
    fn a_patch_rejects_bad_ids_dates_and_subjects_before_building() {
        assert!(update(r#"{"id":0,"lockVersion":3}"#)
            .build_payload()
            .is_err());
        assert!(update(r#"{"id":1,"lockVersion":-1}"#)
            .build_payload()
            .is_err());
        assert!(update(r#"{"id":1,"lockVersion":3,"subject":"  "}"#)
            .build_payload()
            .is_err());
        assert!(update(&format!(
            r#"{{"id":1,"lockVersion":3,"subject":"{}"}}"#,
            "x".repeat(256)
        ))
        .build_payload()
        .is_err());
        assert!(
            update(r#"{"id":1,"lockVersion":3,"startDate":"2026-02-31"}"#)
                .build_payload()
                .is_err()
        );
        assert!(update(r#"{"id":1,"lockVersion":3,"assigneeId":-2}"#)
            .build_payload()
            .is_err());
    }

    fn create(json: &str) -> CreateWorkPackageInput {
        serde_json::from_str(json).expect("valid create input")
    }

    #[test]
    fn a_create_payload_always_carries_project_and_type() {
        let payload = create(r#"{"projectId":5,"typeId":1,"subject":"  New task  "}"#)
            .build_payload()
            .unwrap();
        assert_eq!(payload["subject"], "New task");
        assert_eq!(payload["_links"]["project"]["href"], "/api/v3/projects/5");
        assert_eq!(payload["_links"]["type"]["href"], "/api/v3/types/1");
        // Nothing else was passed, so nothing else is sent.
        assert_eq!(payload["_links"].as_object().unwrap().len(), 2);
        assert!(!payload.as_object().unwrap().contains_key("description"));
    }

    #[test]
    fn a_create_payload_omits_an_empty_description() {
        let payload = create(r#"{"projectId":5,"typeId":1,"subject":"x","description":""}"#)
            .build_payload()
            .unwrap();
        assert!(!payload.as_object().unwrap().contains_key("description"));
    }

    #[test]
    fn a_create_payload_cannot_carry_smuggled_keys() {
        // `lockVersion`, `_links` and a chosen `format` are all present in the
        // input and none of them may reach the request.
        let input: CreateWorkPackageInput = serde_json::from_str(
            r#"{"projectId":5,"typeId":1,"subject":"x","lockVersion":9,
                "_links":{"assignee":{"href":"/api/v3/users/1"}},
                "description":"body","format":"custom","html":"<script>alert(1)</script>"}"#,
        )
        .unwrap();
        let payload = input.build_payload().unwrap();
        assert!(!payload.as_object().unwrap().contains_key("lockVersion"));
        assert!(!payload.as_object().unwrap().contains_key("html"));
        assert_eq!(payload["description"]["format"], "markdown");
        assert!(payload["_links"].get("assignee").is_none());
    }

    #[test]
    fn a_create_rejects_bad_input_before_building() {
        assert!(create(r#"{"projectId":0,"typeId":1,"subject":"x"}"#)
            .build_payload()
            .is_err());
        assert!(create(r#"{"projectId":5,"typeId":0,"subject":"x"}"#)
            .build_payload()
            .is_err());
        assert!(create(r#"{"projectId":5,"typeId":1,"subject":""}"#)
            .build_payload()
            .is_err());
        assert!(
            create(r#"{"projectId":5,"typeId":1,"subject":"x","dueDate":"2026-13-01"}"#)
                .build_payload()
                .is_err()
        );
    }
}
