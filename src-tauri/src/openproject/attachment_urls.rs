//! Inline attachment URLs, rewritten at the boundary.
//!
//! Port of `src/main/openproject/attachment-urls.ts`.
//!
//! OpenProject stores an inline image in a description as a **relative** URL
//! (`/api/v3/attachments/123/content`). That resolves against the page origin,
//! and in a Tauri window the origin is the app itself — so a relative URL is a
//! broken image. Every description leaving the client therefore gets the stored
//! origin prefixed, and every description entering it gets that prefix removed
//! again, so the round trip never persists an absolute URL that would break if
//! the instance moved.

use once_cell::sync::Lazy;
use regex::Regex;
use url::Url;

const ATTACHMENT_PREFIX: &str = "/api/v3/attachments/";

/// A relative attachment URL, matched only where a URL can legitimately start:
/// after a quote or an opening paren (markdown and HTML image syntax). Without
/// that anchor the pattern would also rewrite the text of a sentence that
/// happens to mention the path.
static RELATIVE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(["'(])/api/v3/attachments/"#).expect("attachment pattern is valid")
});

fn origin_of(base_url: &str) -> Option<String> {
    let url = Url::parse(base_url).ok()?;
    Some(url.origin().ascii_serialization())
}

/// Prefix relative attachment URLs with the instance origin.
pub fn absolutize_attachment_urls(text: &str, base_url: &str) -> String {
    if !text.contains(ATTACHMENT_PREFIX) {
        return text.to_string();
    }
    let Some(origin) = origin_of(base_url) else {
        return text.to_string();
    };
    RELATIVE_RE
        .replace_all(text, format!("${{1}}{origin}{ATTACHMENT_PREFIX}").as_str())
        .into_owned()
}

/// Strip the instance origin back off attachment URLs.
pub fn relativize_attachment_urls(text: &str, base_url: &str) -> String {
    if !text.contains(ATTACHMENT_PREFIX) {
        return text.to_string();
    }
    let Some(origin) = origin_of(base_url) else {
        return text.to_string();
    };
    let pattern = format!(r#"(["'(]){}{}"#, regex::escape(&origin), ATTACHMENT_PREFIX);
    let Ok(re) = Regex::new(&pattern) else {
        return text.to_string();
    };
    re.replace_all(text, format!("${{1}}{ATTACHMENT_PREFIX}").as_str())
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://op.example.com/op";

    #[test]
    fn absolutizes_markdown_and_html_image_urls() {
        let text = "![shot](/api/v3/attachments/12/content) and <img src=\"/api/v3/attachments/13/content\">";
        let out = absolutize_attachment_urls(text, BASE);
        assert!(out.contains("(https://op.example.com/api/v3/attachments/12/content)"));
        assert!(out.contains("\"https://op.example.com/api/v3/attachments/13/content\""));
    }

    #[test]
    fn leaves_text_without_attachments_untouched() {
        let text = "no images here";
        assert_eq!(absolutize_attachment_urls(text, BASE), text);
        assert_eq!(relativize_attachment_urls(text, BASE), text);
    }

    #[test]
    fn round_trips() {
        let original = "![a](/api/v3/attachments/12/content)";
        let absolute = absolutize_attachment_urls(original, BASE);
        assert_ne!(absolute, original);
        assert_eq!(relativize_attachment_urls(&absolute, BASE), original);
    }

    #[test]
    fn only_the_instance_origin_is_stripped() {
        let text = "![a](https://other.example.com/api/v3/attachments/12/content)";
        assert_eq!(relativize_attachment_urls(text, BASE), text);
    }

    #[test]
    fn an_unparseable_base_url_leaves_the_text_alone() {
        let text = "![a](/api/v3/attachments/12/content)";
        assert_eq!(absolutize_attachment_urls(text, "nonsense"), text);
    }

    #[test]
    fn a_bare_mention_of_the_path_is_not_rewritten() {
        // No quote or paren in front, so it is prose, not a URL.
        let text = "see /api/v3/attachments/12/content for details";
        assert_eq!(absolutize_attachment_urls(text, BASE), text);
    }
}
