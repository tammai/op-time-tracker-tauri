//! Principals — the users, groups and placeholder users a work package may be
//! assigned to, and the identity the stored API key authenticates as.
//!
//! Port of `src/main/schemas/principals.ts`. `_type` is a plain string because
//! the same shape arrives as `User`, `Group` or `PlaceholderUser` depending on
//! the instance, and the assignee select treats all three alike.

use serde::{Deserialize, Serialize};

use crate::schemas::common::{Collection, HalLink};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Principal {
    pub id: i64,
    #[serde(rename = "_type")]
    pub type_name: String,
    pub name: String,
    #[serde(default, rename = "_links", skip_serializing_if = "Option::is_none")]
    pub links: Option<PrincipalLinks>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PrincipalLinks {
    #[serde(default, rename = "self", skip_serializing_if = "Option::is_none")]
    pub self_link: Option<HalLink>,
}

pub type PrincipalCollection = Collection<Principal>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_three_principal_types() {
        for type_name in ["User", "Group", "PlaceholderUser"] {
            let json = format!(
                r#"{{"id":3,"_type":"{type_name}","name":"Ada","email":"ignored",
                     "_links":{{"self":{{"href":"/api/v3/users/3"}}}}}}"#
            );
            let principal: Principal = serde_json::from_str(&json).unwrap();
            assert_eq!(principal.id, 3);
            assert_eq!(principal.type_name, type_name);
            assert_eq!(principal.name, "Ada");
        }
    }

    #[test]
    fn parses_a_principal_with_no_links_block() {
        let principal: Principal =
            serde_json::from_str(r#"{"id":1,"_type":"User","name":"Ada"}"#).unwrap();
        assert!(principal.links.is_none());
    }
}
