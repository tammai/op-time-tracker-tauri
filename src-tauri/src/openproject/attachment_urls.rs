//! Inline attachment URLs, rewritten at the boundary.
//!
//! Port of `src/main/openproject/attachment-urls.ts`, with the destination
//! changed — see below.
//!
//! OpenProject stores an inline image in a description as a **relative** URL
//! (`/api/v3/attachments/123/content`). That resolves against the page origin,
//! and in a Tauri window the origin is the app itself, so a relative URL is a
//! broken image.
//!
//! Prefixing the instance origin is not enough either, which is what the first
//! version of this module did: `/api/v3/attachments/123/content` requires
//! `Authorization: Basic base64("apikey:<key>")`, and an `<img src>` from the
//! webview sends no headers of ours. An absolute URL there is a *well-formed*
//! URL that is guaranteed to answer HTTP 401. The key cannot move to the
//! webview to fix it — that is the one rule the whole architecture rests on.
//!
//! So every description leaving the client has its attachment URLs pointed at
//! this app's own `opattach:` scheme, which `crate::attachment_protocol` serves
//! by doing the authenticated fetch in *this* process. Every description
//! entering the client has that rewrite undone, so the round trip never
//! persists a URL that only means something inside this app.
//!
//! Both directions key on the numeric attachment id and nothing else. A
//! server-supplied URL never becomes a request path: the id is re-parsed, and
//! the protocol handler rebuilds `/api/v3/attachments/{id}/content` from its own
//! constant.

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use url::Url;

/// The URI scheme this app serves attachment bytes on. Registered in
/// `lib.rs`; served by `crate::attachment_protocol`.
pub const ATTACHMENT_SCHEME: &str = "opattach";

const ATTACHMENT_PREFIX: &str = "/api/v3/attachments/";

/// The proxy URL for one attachment, in the spelling the running platform's
/// webview resolves.
///
/// Windows' WebView2 has no custom-scheme support, so Tauri serves registered
/// schemes there over `http://<scheme>.localhost/…` instead; every other
/// platform gets `<scheme>://localhost/…`. Tauri's own `convertFileSrc` makes
/// exactly this split, and [`deproxify_attachment_urls`] accepts both spellings
/// whichever platform is running — a description written on Windows and edited
/// on macOS must still round-trip.
pub fn attachment_proxy_url(id: i64) -> String {
    if cfg!(windows) {
        format!("http://{ATTACHMENT_SCHEME}.localhost/{id}")
    } else {
        format!("{ATTACHMENT_SCHEME}://localhost/{id}")
    }
}

/// A relative attachment content URL, matched only where a URL can legitimately
/// start: after a quote or an opening paren (markdown and HTML image syntax).
/// Without that anchor the pattern would also rewrite the text of a sentence
/// that happens to mention the path.
static RELATIVE_CONTENT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(["'(])/api/v3/attachments/(\d+)/content"#).expect("attachment pattern is valid")
});

/// Either spelling of a proxy URL, on the same lead-character anchor.
static PROXY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(["'(])(?:{scheme}://localhost|http://{scheme}\.localhost)/(\d+)"#,
        scheme = regex::escape(ATTACHMENT_SCHEME)
    ))
    .expect("proxy pattern is valid")
});

fn origin_of(base_url: &str) -> Option<String> {
    let url = Url::parse(base_url).ok()?;
    Some(url.origin().ascii_serialization())
}

/// Strip the instance origin off attachment URLs, leaving them relative.
///
/// Kept as its own step because two different inputs need it: a description
/// written by an older build of this app (which stored the origin inline), and
/// one where OpenProject itself sent an absolute URL.
fn relativize(text: &str, base_url: &str) -> String {
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

/// Point every inline attachment URL at this app's proxy scheme.
///
/// Applied to every description leaving the client. An id that is not a positive
/// integer is left exactly as it arrived rather than being rewritten into a URL
/// the protocol handler would refuse: the text stays honest about what the
/// server actually stored.
pub fn proxify_attachment_urls(text: &str, base_url: &str) -> String {
    if !text.contains(ATTACHMENT_PREFIX) {
        return text.to_string();
    }
    // Normalize first, so a description carrying the absolute form reaches the
    // proxy too.
    let relative = relativize(text, base_url);
    RELATIVE_CONTENT_RE
        .replace_all(&relative, |captures: &Captures| {
            let lead = &captures[1];
            match captures[2].parse::<i64>() {
                Ok(id) if id > 0 => format!("{lead}{}", attachment_proxy_url(id)),
                _ => captures[0].to_string(),
            }
        })
        .into_owned()
}

/// Undo [`proxify_attachment_urls`], restoring the relative URL OpenProject
/// stores.
///
/// Applied to every description entering the client. `relativize` runs after the
/// proxy rewrite as well, so a description that somehow still holds an absolute
/// instance URL is stored relative — the stored value never depends on where the
/// instance happens to live today.
pub fn deproxify_attachment_urls(text: &str, base_url: &str) -> String {
    let restored = PROXY_RE
        .replace_all(
            text,
            format!("${{1}}{ATTACHMENT_PREFIX}${{2}}/content").as_str(),
        )
        .into_owned();
    if !restored.contains(ATTACHMENT_PREFIX) {
        return restored;
    }
    relativize(&restored, base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://op.example.com/op";

    /// The spelling this build produces, whichever platform is compiling.
    fn proxy(id: i64) -> String {
        attachment_proxy_url(id)
    }

    #[test]
    fn proxifies_markdown_and_html_image_urls() {
        let text = "![shot](/api/v3/attachments/12/content) and <img src=\"/api/v3/attachments/13/content\">";
        let out = proxify_attachment_urls(text, BASE);
        assert!(out.contains(&format!("({})", proxy(12))), "{out}");
        assert!(out.contains(&format!("\"{}\"", proxy(13))), "{out}");
        // Nothing that would 401 from the webview is left behind.
        assert!(!out.contains("op.example.com"));
        assert!(!out.contains(ATTACHMENT_PREFIX));
    }

    #[test]
    fn proxifies_the_absolute_form_an_older_build_stored() {
        let text = "![a](https://op.example.com/api/v3/attachments/12/content)";
        assert_eq!(
            proxify_attachment_urls(text, BASE),
            format!("![a]({})", proxy(12))
        );
    }

    #[test]
    fn leaves_text_without_attachments_untouched() {
        let text = "no images here";
        assert_eq!(proxify_attachment_urls(text, BASE), text);
        assert_eq!(deproxify_attachment_urls(text, BASE), text);
    }

    #[test]
    fn round_trips() {
        let original = "![a](/api/v3/attachments/12/content)";
        let proxied = proxify_attachment_urls(original, BASE);
        assert_ne!(proxied, original);
        assert_eq!(deproxify_attachment_urls(&proxied, BASE), original);
    }

    #[test]
    fn deproxifies_both_platform_spellings() {
        // A description edited on the other OS must still save correctly.
        for url in ["opattach://localhost/12", "http://opattach.localhost/12"] {
            assert_eq!(
                deproxify_attachment_urls(&format!("![a]({url})"), BASE),
                "![a](/api/v3/attachments/12/content)"
            );
        }
    }

    #[test]
    fn only_the_instance_origin_is_stripped() {
        let text = "![a](https://other.example.com/api/v3/attachments/12/content)";
        assert_eq!(deproxify_attachment_urls(text, BASE), text);
    }

    #[test]
    fn an_unparseable_base_url_leaves_the_relative_url_alone() {
        // Nothing to strip and nothing to prefix, so the URL is still rewritten
        // to the proxy — the proxy does not depend on the base URL being
        // parseable *here*, only on the client resolving it later.
        let text = "![a](/api/v3/attachments/12/content)";
        assert_eq!(
            proxify_attachment_urls(text, "nonsense"),
            format!("![a]({})", proxy(12))
        );
    }

    #[test]
    fn a_bare_mention_of_the_path_is_not_rewritten() {
        // No quote or paren in front, so it is prose, not a URL.
        let text = "see /api/v3/attachments/12/content for details";
        assert_eq!(proxify_attachment_urls(text, BASE), text);
    }

    #[test]
    fn a_non_numeric_id_is_left_as_it_arrived() {
        let text = "![a](/api/v3/attachments/abc/content)";
        assert_eq!(proxify_attachment_urls(text, BASE), text);
    }

    #[test]
    fn a_url_without_the_content_suffix_is_not_a_proxy_candidate() {
        // `/api/v3/attachments/12` is the metadata resource, not the bytes.
        let text = "![a](/api/v3/attachments/12)";
        assert_eq!(proxify_attachment_urls(text, BASE), text);
    }
}
