//! Shapes every OpenProject resource shares: HAL links, Formattables, and the
//! collection envelope.
//!
//! These are the Rust counterparts of the Zod schemas in `src/main/schemas/` of
//! the Electron app, and they keep its two governing decisions:
//!
//! - **Strict where the UI depends on it, lenient where the server adds keys.**
//!   Unknown fields are ignored rather than rejected (serde's default), which is
//!   what `.passthrough()` bought: an instance-specific custom field can never
//!   fail a whole month's parse.
//! - **`href: null` is how HAL spells "unset".** A work package with no assignee
//!   sends `{"href": null}`, not an omitted key, so every href is an
//!   `Option<String>` and both spellings parse.

use serde::{Deserialize, Serialize};

/// A HAL link. Both fields are optional *and* nullable — see the module note.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct HalLink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl HalLink {
    pub fn href(&self) -> Option<&str> {
        self.href.as_deref()
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
}

/// OpenProject's Formattable, in all three spellings seen in the wild: the
/// `{format, raw, html}` object a current instance sends, a bare string on older
/// ones, and `null` for an empty value.
///
/// Only `raw` is ever read. Accepting the other two spellings is what keeps a
/// single differently-serialized description from failing an entire collection.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Formattable {
    Object {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        html: Option<String>,
    },
    Text(String),
    /// The default: nothing here. `null` on the wire, and the one spelling of
    /// an absent Formattable.
    #[default]
    Empty,
}

impl Formattable {
    /// The raw text a Formattable holds, whichever spelling it arrived in.
    /// Never `None` — an absent value reads as empty, which is what the editor
    /// binds to.
    pub fn raw(&self) -> &str {
        match self {
            Formattable::Object { raw, .. } => raw.as_deref().unwrap_or(""),
            Formattable::Text(text) => text,
            Formattable::Empty => "",
        }
    }

    /// Rebuild with different raw text, preserving the arrival spelling. Used to
    /// rewrite inline attachment URLs on the way out.
    pub fn with_raw(&self, new_raw: String) -> Formattable {
        match self {
            Formattable::Object { format, html, .. } => Formattable::Object {
                format: format.clone(),
                raw: Some(new_raw),
                html: html.clone(),
            },
            Formattable::Text(_) => Formattable::Text(new_raw),
            Formattable::Empty => Formattable::Empty,
        }
    }
}

/// The collection envelope OpenProject wraps every list in.
///
/// `_type` is a plain string, not a literal: instances send `"Collection"` or a
/// typed variant like `"WorkPackageCollection"` depending on version, and the
/// elements array is what actually matters.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Collection<T> {
    #[serde(rename = "_type")]
    pub type_name: String,
    pub total: i64,
    pub count: i64,
    #[serde(rename = "_embedded")]
    pub embedded: CollectionElements<T>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CollectionElements<T> {
    pub elements: Vec<T>,
}

impl<T> Collection<T> {
    /// Build an envelope around elements assembled here rather than received —
    /// the activities list, which is flattened out of a form response.
    pub fn of(type_name: &str, elements: Vec<T>) -> Self {
        let count = elements.len() as i64;
        Collection {
            type_name: type_name.to_string(),
            total: count,
            count,
            embedded: CollectionElements { elements },
        }
    }

    pub fn elements(&self) -> &[T] {
        &self.embedded.elements
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_null_href_parses_as_unset() {
        let link: HalLink = serde_json::from_str(r#"{"href": null}"#).unwrap();
        assert_eq!(link.href(), None);
        let link: HalLink = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(link.href(), None);
        let link: HalLink =
            serde_json::from_str(r#"{"href": "/api/v3/users/3", "title": "Ada"}"#).unwrap();
        assert_eq!(link.href(), Some("/api/v3/users/3"));
        assert_eq!(link.title(), Some("Ada"));
    }

    #[test]
    fn unknown_keys_are_ignored_rather_than_rejected() {
        let link: HalLink =
            serde_json::from_str(r#"{"href": "/x", "templated": false, "method": "get"}"#).unwrap();
        assert_eq!(link.href(), Some("/x"));
    }

    #[test]
    fn a_formattable_reads_the_same_in_all_three_spellings() {
        let object: Formattable =
            serde_json::from_str(r#"{"format":"markdown","raw":"hi","html":"<p>hi</p>"}"#).unwrap();
        assert_eq!(object.raw(), "hi");
        let text: Formattable = serde_json::from_str(r#""hi""#).unwrap();
        assert_eq!(text.raw(), "hi");
        let empty: Formattable = serde_json::from_str("null").unwrap();
        assert_eq!(empty.raw(), "");
    }

    #[test]
    fn rewriting_raw_preserves_the_arrival_spelling() {
        let object: Formattable =
            serde_json::from_str(r#"{"format":"markdown","raw":"a"}"#).unwrap();
        let rewritten = object.with_raw("b".to_string());
        assert_eq!(rewritten.raw(), "b");
        assert!(matches!(rewritten, Formattable::Object { .. }));

        let text = Formattable::Text("a".to_string()).with_raw("b".to_string());
        assert!(matches!(text, Formattable::Text(_)));
    }

    #[test]
    fn a_typed_collection_type_name_parses() {
        let json = r#"{"_type":"WorkPackageCollection","total":2,"count":1,
                       "_embedded":{"elements":[7]}}"#;
        let collection: Collection<i64> = serde_json::from_str(json).unwrap();
        assert_eq!(collection.type_name, "WorkPackageCollection");
        assert_eq!(collection.total, 2);
        assert_eq!(collection.elements(), &[7]);
    }
}
