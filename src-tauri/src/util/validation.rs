//! Boundary validation: base URLs, API keys, calendar dates, search terms.
//!
//! Port of `src/shared/validation/*.ts`. The frontend keeps its own copies for
//! inline field messages; these are the ones that decide anything. Everything
//! crossing from the webview is validated here before a request is built —
//! nothing arrives trusted just because a form checked it first.

use once_cell::sync::Lazy;
use regex::Regex;
use url::Url;

// Base URL

/// Parse and normalize an OpenProject base URL.
///
/// http(s) with a host, and nothing else — the scheme check is what keeps a
/// `file:` or `javascript:` URL from ever reaching a request builder or the OS.
/// Userinfo is stripped here rather than rejected, so a URL pasted with
/// credentials in it still works while the credentials never leave this
/// function.
pub fn validate_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Base URL is required.".to_string());
    }
    let mut parsed = Url::parse(trimmed)
        .map_err(|_| "Base URL must be a well-formed http(s) URL.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "Base URL must use http or https (got \"{}:\").",
            parsed.scheme()
        ));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("Base URL must include a host.".to_string());
    }
    // Defense in depth: drop userinfo and fragment so neither can propagate
    // into a request URL later.
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

// API key

/// The API key is opaque — OpenProject does not document a format, so the only
/// thing worth asserting is that the user actually typed one.
///
/// **Trimmed**, which the Electron original did not do. An OpenProject key is a
/// hex token with no whitespace in it, and it is *pasted* — often from a dialog
/// that hands over a trailing newline. Sent as-is, that key authenticates as
/// nothing and the user is told "Authentication failed. Check your API key.",
/// which points at the wrong problem entirely. Trimming here rather than in the
/// form because this is the boundary that builds the auth header.
pub fn validate_api_key(input: &str) -> Result<String, String> {
    if input.is_empty() {
        return Err("API key is required.".to_string());
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be whitespace only.".to_string());
    }
    Ok(trimmed.to_string())
}

// Calendar dates

static CALENDAR_DATE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("date pattern is valid"));

/// `YYYY-MM-DD` that is also a real day.
///
/// The shape check alone admits `2026-02-31`, which OpenProject then rejects
/// with a 422 the user cannot act on — so the day count per month, leap years
/// included, is checked here.
pub fn is_calendar_date(value: &str) -> bool {
    if !CALENDAR_DATE_RE.is_match(value) {
        return false;
    }
    let (year, rest) = value.split_at(4);
    let month = &rest[1..3];
    let day = &rest[4..6];
    let (Ok(year), Ok(month), Ok(day)) = (
        year.parse::<i32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    day <= days_in_month(year, month)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// A validated calendar date, or the message the user should see.
pub fn validate_calendar_date(value: &str, field: &str) -> Result<String, String> {
    if !CALENDAR_DATE_RE.is_match(value) {
        return Err(format!("{field} must be an ISO YYYY-MM-DD date."));
    }
    if !is_calendar_date(value) {
        return Err(format!("{field} must be a real calendar date."));
    }
    Ok(value.to_string())
}

// Work package search terms

pub const WORK_PACKAGE_SEARCH_MIN_CHARS: usize = 2;
pub const WORK_PACKAGE_SEARCH_MAX_CHARS: usize = 100;

static ID_SEARCH_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^#\d+$").expect("id search pattern is valid"));

/// Drop a leading `#` from an id-shaped term — `#1234` is how people write a
/// work package id, and OpenProject's `subjectOrId` filter wants the bare
/// number.
pub fn normalize_work_package_search_term(raw: &str) -> String {
    let trimmed = raw.trim();
    if ID_SEARCH_RE.is_match(trimmed) {
        trimmed[1..].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Validate a search term and return it normalized.
///
/// Length-bounded here rather than at the caller: the term reaches a filter
/// JSON blob in a query string, and an unbounded one is a request this process
/// has to build, send, and parse the answer to.
pub fn validate_work_package_search_term(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let length = trimmed.chars().count();
    if length < WORK_PACKAGE_SEARCH_MIN_CHARS {
        return Err(format!(
            "Search must be at least {WORK_PACKAGE_SEARCH_MIN_CHARS} characters."
        ));
    }
    if length > WORK_PACKAGE_SEARCH_MAX_CHARS {
        return Err(format!(
            "Search must be at most {WORK_PACKAGE_SEARCH_MAX_CHARS} characters."
        ));
    }
    Ok(normalize_work_package_search_term(trimmed))
}

// Ids

/// Every id that reaches a request path or an href goes through this first.
pub fn validate_positive_id(id: i64, field: &str) -> Result<i64, String> {
    if id <= 0 {
        return Err(format!("{field} must be a positive integer."));
    }
    Ok(id)
}

/// `lockVersion` is the one id-shaped value that may legitimately be zero — a
/// work package that has never been edited reports `0`.
pub fn validate_lock_version(lock_version: i64) -> Result<i64, String> {
    if lock_version < 0 {
        return Err("The lock version must not be negative.".to_string());
    }
    Ok(lock_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_base_urls() {
        assert_eq!(
            validate_base_url("https://op.example.com").unwrap(),
            "https://op.example.com"
        );
        assert_eq!(
            validate_base_url("  http://localhost:8080/op/  ").unwrap(),
            "http://localhost:8080/op"
        );
    }

    #[test]
    fn rejects_non_http_schemes_and_empty_input() {
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("   ").is_err());
        assert!(validate_base_url("ftp://op.example.com").is_err());
        assert!(validate_base_url("javascript:alert(1)").is_err());
        assert!(validate_base_url("not a url").is_err());
    }

    #[test]
    fn strips_userinfo_and_fragment_from_a_base_url() {
        let cleaned = validate_base_url("https://user:secret@op.example.com/op#frag").unwrap();
        assert!(!cleaned.contains("user"));
        assert!(!cleaned.contains("secret"));
        assert!(!cleaned.contains('#'));
        assert_eq!(cleaned, "https://op.example.com/op");
    }

    #[test]
    fn api_keys_only_have_to_be_non_blank() {
        assert_eq!(validate_api_key("abc123").unwrap(), "abc123");
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("   ").is_err());
    }

    #[test]
    fn a_pasted_api_key_is_trimmed() {
        // The failure this prevents: a key pasted with a trailing newline
        // authenticates as nothing, and the user reads "check your API key"
        // about a key that is perfectly valid.
        assert_eq!(
            validate_api_key(
                "  abc123
"
            )
            .unwrap(),
            "abc123"
        );
        assert_eq!(
            validate_api_key(
                "	abc123
"
            )
            .unwrap(),
            "abc123"
        );
    }

    #[test]
    fn calendar_dates_must_be_real_days() {
        assert!(is_calendar_date("2026-01-31"));
        assert!(is_calendar_date("2024-02-29"));
        assert!(!is_calendar_date("2026-02-29"));
        assert!(!is_calendar_date("2026-02-31"));
        assert!(!is_calendar_date("2026-13-01"));
        assert!(!is_calendar_date("2026-00-10"));
        assert!(!is_calendar_date("2026-01-00"));
        assert!(!is_calendar_date("2026-1-1"));
        assert!(!is_calendar_date("20260101"));
        assert!(!is_calendar_date(""));
    }

    #[test]
    fn century_leap_years_follow_the_gregorian_rule() {
        assert!(is_calendar_date("2000-02-29"));
        assert!(!is_calendar_date("1900-02-29"));
    }

    #[test]
    fn search_terms_are_trimmed_bounded_and_hash_stripped() {
        assert_eq!(
            validate_work_package_search_term(" #1234 ").unwrap(),
            "1234"
        );
        assert_eq!(
            validate_work_package_search_term("  login bug  ").unwrap(),
            "login bug"
        );
        assert!(validate_work_package_search_term("a").is_err());
        assert!(validate_work_package_search_term(&"x".repeat(101)).is_err());
        // A `#` that isn't a bare id is content, not a prefix.
        assert_eq!(
            normalize_work_package_search_term("#12 fix"),
            "#12 fix".to_string()
        );
    }

    #[test]
    fn ids_must_be_positive_but_lock_versions_may_be_zero() {
        assert!(validate_positive_id(1, "The id").is_ok());
        assert!(validate_positive_id(0, "The id").is_err());
        assert!(validate_positive_id(-3, "The id").is_err());
        assert!(validate_lock_version(0).is_ok());
        assert!(validate_lock_version(-1).is_err());
    }
}
