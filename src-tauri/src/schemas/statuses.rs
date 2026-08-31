//! Statuses — the instance-wide status set.
//!
//! Port of `src/main/schemas/statuses.ts`. Fetched so the frontend can resolve
//! the status *titles* it filters by into the resource **ids** OpenProject's
//! `status` filter `=` operator requires; passing titles answers HTTP 400.
//!
//! This is not the source of *legal transitions* — only `get_work_package_form`
//! knows which statuses are reachable from where a work package currently is.

use serde::{Deserialize, Serialize};

use crate::schemas::common::Collection;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Status {
    pub id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, rename = "isDefault", skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(default, rename = "isClosed", skip_serializing_if = "Option::is_none")]
    pub is_closed: Option<bool>,
}

pub type StatusCollection = Collection<Status>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_status_collection() {
        let json = r##"{"_type":"Collection","total":2,"count":2,"_embedded":{"elements":[
            {"id":1,"_type":"Status","name":"New","isDefault":true,"isClosed":false,
             "position":1,"color":"#1A67A3"},
            {"id":14,"name":"Closed","isClosed":true}
        ]}}"##;
        let collection: StatusCollection = serde_json::from_str(json).unwrap();
        assert_eq!(collection.elements().len(), 2);
        assert_eq!(collection.elements()[0].name, "New");
        assert_eq!(collection.elements()[0].is_default, Some(true));
        assert_eq!(collection.elements()[1].color, None);
    }
}
