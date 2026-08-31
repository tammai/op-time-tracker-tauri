//! Request URL assembly.
//!
//! Port of `buildRequestUrl` from `src/main/openproject/client.ts`. Every
//! request URL in the app is built here, from the stored base URL plus a path
//! constant — never from a server-supplied href, and never by string
//! concatenation at a call site.
//!
//! Userinfo and fragment are stripped again here even though the credential
//! store already did it at save time: this is the last point before the network,
//! and a stored URL that somehow carries userinfo must not propagate it.

use url::Url;

/// Join an API path and query params onto a base URL.
///
/// Path joining handles the shapes a user actually pastes:
///
/// - `https://host` + `/api/v3/work_packages` → `https://host/api/v3/work_packages`
/// - `https://host/` + `/api/v3/…` → the same
/// - `https://host/op/` or `https://host/op` + `/api/v3/…` → `https://host/op/api/v3/…`
pub fn build_request_url(
    base_url: &str,
    path: &str,
    params: &[(&str, String)],
) -> Result<Url, String> {
    let mut url =
        Url::parse(base_url).map_err(|_| "The stored base URL is not usable.".to_string())?;

    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    url.set_query(None);

    let normalized_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let base_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base_path}{normalized_path}"));

    if !params.is_empty() {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(base: &str, path: &str) -> String {
        build_request_url(base, path, &[]).unwrap().to_string()
    }

    #[test]
    fn joins_a_path_onto_every_base_url_shape() {
        assert_eq!(
            url("https://op.example.com", "/api/v3/work_packages"),
            "https://op.example.com/api/v3/work_packages"
        );
        assert_eq!(
            url("https://op.example.com/", "/api/v3/work_packages"),
            "https://op.example.com/api/v3/work_packages"
        );
        assert_eq!(
            url("https://op.example.com/op/", "/api/v3/work_packages"),
            "https://op.example.com/op/api/v3/work_packages"
        );
        assert_eq!(
            url("https://op.example.com/op", "/api/v3/work_packages"),
            "https://op.example.com/op/api/v3/work_packages"
        );
    }

    #[test]
    fn accepts_a_path_without_a_leading_slash() {
        assert_eq!(
            url("https://op.example.com", "api/v3"),
            "https://op.example.com/api/v3"
        );
    }

    #[test]
    fn strips_userinfo_fragment_and_any_base_query() {
        let built = url("https://user:pass@op.example.com/op?a=1#frag", "/api/v3");
        assert_eq!(built, "https://op.example.com/op/api/v3");
        assert!(!built.contains("user"));
        assert!(!built.contains("pass"));
    }

    #[test]
    fn percent_encodes_query_values() {
        let built = build_request_url(
            "https://op.example.com",
            "/api/v3/work_packages",
            &[(
                "filters",
                r#"[{"subjectOrId":{"operator":"**","values":["a b&c"]}}]"#.to_string(),
            )],
        )
        .unwrap();
        // The JSON reaches the query string encoded, never as raw punctuation.
        assert!(built.query().unwrap().contains("a+b%26c"));
        assert_eq!(built.path(), "/api/v3/work_packages");
    }

    #[test]
    fn rejects_an_unparseable_base_url() {
        assert!(build_request_url("not a url", "/api/v3", &[]).is_err());
    }
}
