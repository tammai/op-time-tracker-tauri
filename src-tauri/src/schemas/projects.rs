//! Projects — specifically the ones a work package may be **created** in.
//!
//! Port of `src/main/schemas/projects.ts`. Deliberately lenient: a project
//! resource carries a large and instance-specific attribute set, and the create
//! form's project select reads two fields out of it.

use serde::{Deserialize, Serialize};

use crate::schemas::common::{Collection, HalLink};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Project {
    pub id: i64,
    #[serde(default, rename = "_type", skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, rename = "_links", skip_serializing_if = "Option::is_none")]
    pub links: Option<ProjectLinks>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectLinks {
    #[serde(default, rename = "self", skip_serializing_if = "Option::is_none")]
    pub self_link: Option<HalLink>,
    /// Present when the API key may create work packages here. Read by the
    /// frontend as a hint; the authoritative answer is which projects the
    /// available-projects collection returned at all.
    #[serde(
        default,
        rename = "createWorkPackage",
        skip_serializing_if = "Option::is_none"
    )]
    pub create_work_package: Option<HalLink>,
}

pub type ProjectCollection = Collection<Project>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_project_with_its_create_link() {
        let json = r#"{"id":5,"_type":"Project","name":"Web","identifier":"web",
                       "active":true,"description":{"raw":"ignored"},
                       "_links":{"self":{"href":"/api/v3/projects/5"},
                                 "createWorkPackage":{"href":"/api/v3/projects/5/work_packages/form"}}}"#;
        let project: Project = serde_json::from_str(json).unwrap();
        assert_eq!(project.id, 5);
        assert_eq!(project.name, "Web");
        assert!(project
            .links
            .unwrap()
            .create_work_package
            .unwrap()
            .href()
            .is_some());
    }

    #[test]
    fn parses_a_minimal_project() {
        let project: Project = serde_json::from_str(r#"{"id":1,"name":"Ops"}"#).unwrap();
        assert_eq!(project.name, "Ops");
        assert!(project.links.is_none());
    }
}
