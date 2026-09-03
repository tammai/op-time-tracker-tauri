//! The response and input models.
//!
//! Ports of `src/main/schemas/*.ts`, where Zod did this job. serde's default
//! tolerance of unknown fields is what `.passthrough()` bought there: strict on
//! the fields the UI depends on, lenient about everything an instance adds. A
//! response that fails to parse surfaces as `OPENPROJECT_SCHEMA_FAILED` — a
//! malformed or hostile server can never hand the webview an arbitrary shape.

pub mod attachments;
pub mod common;
pub mod principals;
pub mod projects;
pub mod statuses;
pub mod time_entries;
pub mod work_packages;
