//! Filter and pagination encoding.
//!
//! Port of the `encode*` helpers in `src/main/openproject/client.ts`.
//! OpenProject's filter format is a JSON-encoded array of
//! `{ field: { operator, values } }` — see
//! <https://www.openproject.org/docs/api/filters/>.
//!
//! Kept separate from the HTTP client so every operator choice is unit-testable
//! without a server: an operator typo is otherwise only visible as a 400 from a
//! live instance.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::util::validation::validate_work_package_search_term;

/// Hard ceiling on `pageSize`, applied here rather than trusted from the
/// webview.
///
/// A page size is a frontend value, and a frontend value is not a trusted value:
/// an absurd one costs a multi-megabyte response this process has to fetch and
/// parse in full. Comfortably above every page size the app actually asks for.
pub const MAX_PAGE_SIZE: i64 = 200;

/// Filters for `list_work_packages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackageFilters {
    /// Only work packages assigned to the current user (`assignee = "me"`).
    #[serde(default)]
    pub only_mine: Option<bool>,
    /// Only open work packages (status operator `o`).
    #[serde(default)]
    pub only_open: Option<bool>,
    /// Specific status resource **ids**, stringified. Takes precedence over
    /// `only_open`. OpenProject's `status` filter `=` operator requires ids, not
    /// titles — titles answer HTTP 400.
    #[serde(default)]
    pub statuses: Option<Vec<String>>,
    /// Title search, via the `subjectOrId` filter with the `**` operator: a
    /// substring match on the subject plus an exact match on the id.
    #[serde(default)]
    pub search: Option<String>,
    /// Server-side ordering as `[[field, "asc" | "desc"], …]`. Worth setting on
    /// any search: OpenProject's default is `id asc`, i.e. creation order, so a
    /// truncated result page otherwise shows the *oldest* matches.
    #[serde(default)]
    pub sort_by: Option<Vec<(String, String)>>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

/// The `spentOn` half of a time-entry filter: a closed range or a single day.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpentOnFilter {
    #[serde(rename = "between")]
    Between([String; 2]),
    #[serde(rename = "on")]
    On(String),
}

/// Filters for `list_time_entries`. The calendar passes a month range.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntryFilters {
    /// Only entries belonging to the current user (`user = "me"`).
    #[serde(default)]
    pub only_mine: Option<bool>,
    #[serde(default)]
    pub spent_on: Option<SpentOnFilter>,
    #[serde(default)]
    pub work_package_id: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

/// Bound a frontend-supplied page size to something this process is willing to
/// fetch and parse.
///
/// Clamped rather than rejected: an out-of-range page size is a caller bug, not
/// something the user can act on, and failing the whole request over it would be
/// a denial of service of its own.
pub fn clamp_page_size(page_size: i64) -> i64 {
    page_size.clamp(1, MAX_PAGE_SIZE)
}

fn filter(field: &str, operator: &str, values: Value) -> Value {
    json!({ field: { "operator": operator, "values": values } })
}

/// Encode `TimeEntryFilters` into the `filters` query value, or `None` when
/// there is nothing to send.
pub fn encode_time_entry_filters(filters: &TimeEntryFilters) -> Option<String> {
    let mut out: Vec<Value> = Vec::new();

    match &filters.spent_on {
        // `<>d` is OpenProject's inclusive between-two-dates operator.
        Some(SpentOnFilter::Between([from, to])) => {
            out.push(filter("spentOn", "<>d", json!([from, to])));
        }
        Some(SpentOnFilter::On(day)) => {
            out.push(filter("spentOn", "=d", json!([day])));
        }
        None => {}
    }

    if let Some(work_package_id) = filters.work_package_id {
        out.push(filter(
            "workPackage",
            "=",
            json!([work_package_id.to_string()]),
        ));
    }

    if filters.only_mine == Some(true) {
        out.push(filter("user", "=", json!(["me"])));
    }

    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out).to_string())
    }
}

/// Encode `TimeEntryFilters` into the full query params (pagination + filters).
pub fn encode_time_entry_params(filters: &TimeEntryFilters) -> Vec<(&'static str, String)> {
    let mut params: Vec<(&'static str, String)> = Vec::new();
    if let Some(page_size) = filters.page_size {
        params.push(("pageSize", clamp_page_size(page_size).to_string()));
    }
    if let Some(offset) = filters.offset {
        params.push(("offset", offset.to_string()));
    }
    if let Some(encoded) = encode_time_entry_filters(filters) {
        params.push(("filters", encoded));
    }
    params
}

/// Encode `WorkPackageFilters` into query params.
///
/// The search term is re-validated here even though the picker sanitizes its own
/// input: that is a UI affordance, not a boundary. An invalid term is an error
/// rather than a silently dropped filter — dropping it would answer a search
/// with the unfiltered list.
pub fn encode_work_package_params(
    filters: &WorkPackageFilters,
) -> Result<Vec<(&'static str, String)>, String> {
    let mut params: Vec<(&'static str, String)> = Vec::new();

    if let Some(page_size) = filters.page_size {
        params.push(("pageSize", clamp_page_size(page_size).to_string()));
    }
    if let Some(offset) = filters.offset {
        params.push(("offset", offset.to_string()));
    }
    if let Some(sort_by) = &filters.sort_by {
        if !sort_by.is_empty() {
            let pairs: Vec<Value> = sort_by
                .iter()
                .map(|(field, direction)| json!([field, direction]))
                .collect();
            params.push(("sortBy", Value::Array(pairs).to_string()));
        }
    }

    let mut op_filters: Vec<Value> = Vec::new();

    if filters.only_mine == Some(true) {
        op_filters.push(filter("assignee", "=", json!(["me"])));
    }

    // `statuses` and `only_open` both write the OpenProject `status` field, so
    // they are mutually exclusive in practice and `statuses` wins. An *empty*
    // `statuses` array falls through to `only_open` — treated as "not
    // specified" — so a caller can pass an empty array without accidentally
    // dropping the open-status filter.
    match &filters.statuses {
        Some(statuses) if !statuses.is_empty() => {
            op_filters.push(filter("status", "=", json!(statuses)));
        }
        _ if filters.only_open == Some(true) => {
            // `o` = "status is open" — no values needed.
            op_filters.push(filter("status", "o", json!([])));
        }
        _ => {}
    }

    if let Some(search) = &filters.search {
        let term = validate_work_package_search_term(search)?;
        if !term.is_empty() {
            op_filters.push(filter("subjectOrId", "**", json!([term])));
        }
    }

    if !op_filters.is_empty() {
        params.push(("filters", Value::Array(op_filters).to_string()));
    }

    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters_value(params: &[(&str, String)]) -> Value {
        let raw = params
            .iter()
            .find(|(key, _)| *key == "filters")
            .map(|(_, value)| value.clone())
            .expect("a filters param");
        serde_json::from_str(&raw).unwrap()
    }

    fn param(params: &[(&str, String)], key: &str) -> Option<String> {
        params
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn clamps_page_sizes_into_range() {
        assert_eq!(clamp_page_size(20), 20);
        assert_eq!(clamp_page_size(0), 1);
        assert_eq!(clamp_page_size(-5), 1);
        assert_eq!(clamp_page_size(10_000), MAX_PAGE_SIZE);
    }

    #[test]
    fn a_month_range_uses_the_inclusive_between_operator() {
        let filters = TimeEntryFilters {
            spent_on: Some(SpentOnFilter::Between([
                "2026-03-01".into(),
                "2026-03-31".into(),
            ])),
            only_mine: Some(true),
            ..Default::default()
        };
        let value = filters_value(&encode_time_entry_params(&filters));
        assert_eq!(value[0]["spentOn"]["operator"], "<>d");
        assert_eq!(value[0]["spentOn"]["values"][0], "2026-03-01");
        assert_eq!(value[0]["spentOn"]["values"][1], "2026-03-31");
        assert_eq!(value[1]["user"]["values"][0], "me");
    }

    #[test]
    fn a_single_day_uses_the_equals_date_operator() {
        let filters = TimeEntryFilters {
            spent_on: Some(SpentOnFilter::On("2026-03-04".into())),
            ..Default::default()
        };
        let value = filters_value(&encode_time_entry_params(&filters));
        assert_eq!(value[0]["spentOn"]["operator"], "=d");
    }

    #[test]
    fn a_work_package_filter_stringifies_its_id() {
        let filters = TimeEntryFilters {
            work_package_id: Some(42),
            ..Default::default()
        };
        let value = filters_value(&encode_time_entry_params(&filters));
        assert_eq!(value[0]["workPackage"]["values"][0], "42");
    }

    #[test]
    fn no_time_entry_filters_means_no_filters_param() {
        let params = encode_time_entry_params(&TimeEntryFilters::default());
        assert!(param(&params, "filters").is_none());
        assert_eq!(
            encode_time_entry_filters(&TimeEntryFilters::default()),
            None
        );
    }

    #[test]
    fn time_entry_pagination_is_clamped() {
        let filters = TimeEntryFilters {
            page_size: Some(5_000),
            offset: Some(3),
            ..Default::default()
        };
        let params = encode_time_entry_params(&filters);
        assert_eq!(param(&params, "pageSize").unwrap(), "200");
        assert_eq!(param(&params, "offset").unwrap(), "3");
    }

    #[test]
    fn only_mine_and_only_open_become_assignee_and_status_filters() {
        let filters = WorkPackageFilters {
            only_mine: Some(true),
            only_open: Some(true),
            ..Default::default()
        };
        let value = filters_value(&encode_work_package_params(&filters).unwrap());
        assert_eq!(value[0]["assignee"]["values"][0], "me");
        assert_eq!(value[1]["status"]["operator"], "o");
        assert_eq!(value[1]["status"]["values"], json!([]));
    }

    #[test]
    fn explicit_statuses_take_precedence_over_only_open() {
        let filters = WorkPackageFilters {
            only_open: Some(true),
            statuses: Some(vec!["7".into(), "14".into()]),
            ..Default::default()
        };
        let value = filters_value(&encode_work_package_params(&filters).unwrap());
        assert_eq!(value[0]["status"]["operator"], "=");
        assert_eq!(value[0]["status"]["values"], json!(["7", "14"]));
    }

    #[test]
    fn an_empty_statuses_array_falls_through_to_only_open() {
        let filters = WorkPackageFilters {
            only_open: Some(true),
            statuses: Some(vec![]),
            ..Default::default()
        };
        let value = filters_value(&encode_work_package_params(&filters).unwrap());
        assert_eq!(value[0]["status"]["operator"], "o");
    }

    #[test]
    fn a_search_term_is_normalized_into_the_subject_or_id_filter() {
        let filters = WorkPackageFilters {
            search: Some(" #1234 ".into()),
            ..Default::default()
        };
        let value = filters_value(&encode_work_package_params(&filters).unwrap());
        assert_eq!(value[0]["subjectOrId"]["operator"], "**");
        assert_eq!(value[0]["subjectOrId"]["values"][0], "1234");
    }

    #[test]
    fn an_invalid_search_term_is_an_error_not_a_dropped_filter() {
        let filters = WorkPackageFilters {
            search: Some("a".into()),
            ..Default::default()
        };
        assert!(encode_work_package_params(&filters).is_err());
    }

    #[test]
    fn sort_by_is_encoded_as_pairs() {
        let filters = WorkPackageFilters {
            sort_by: Some(vec![("updatedAt".into(), "desc".into())]),
            ..Default::default()
        };
        let params = encode_work_package_params(&filters).unwrap();
        assert_eq!(
            param(&params, "sortBy").unwrap(),
            r#"[["updatedAt","desc"]]"#
        );
    }

    #[test]
    fn no_work_package_filters_means_no_filters_param() {
        let params = encode_work_package_params(&WorkPackageFilters::default()).unwrap();
        assert!(param(&params, "filters").is_none());
        assert!(params.is_empty());
    }
}
