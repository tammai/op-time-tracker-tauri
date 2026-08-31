# Backend conventions

Applies to `src-tauri/src/**` — the Rust half, and the **sole caller** of the
OpenProject REST API.

## Naming

- Commands: snake_case, named for what they do (`list_work_packages`)
- Modules: snake_case files; types PascalCase

The frontend's camelCase method (`listWorkPackages`) maps to the snake_case
command in `src/bridge/index.ts` — that mapping lives in one file.

## The command boundary

`src-tauri/src/commands/` is the only surface the webview can reach. A command
does three things and delegates the rest:

1. validates its input, before anything is built from it;
2. resolves credentials in this process;
3. returns `Result<T, AppError>`.

```rust
#[tauri::command]
pub async fn list_statuses(app: AppHandle) -> Result<StatusCollection, AppError> {
    client(&app)?.list_statuses().await
}
```

Keep them thin. Request building belongs to the client; parsing belongs to the
schemas.

Every new command must be added to `generate_handler!` in `lib.rs` — a command
that is not listed there does not exist as far as the webview is concerned, and
the failure looks like a bad command name at runtime.

## Response models

Every OpenProject shape is a serde model in `src-tauri/src/schemas/`, one file
per resource. Serde's default tolerance of unknown fields is deliberate and does
the job Zod's `.passthrough()` did: **strict on what the UI depends on, lenient
about what an instance adds.**

- `href: null` is how HAL spells "unset" — every href is an `Option<String>`.
- A Formattable arrives in three spellings (object, bare string, `null`); read it
  through `Formattable::raw()`, never off a field.
- Never hand the webview a raw `serde_json::Value` for a resource. A form
  response is normalized into a declared shape first.

## Payloads are built, never forwarded

A request body is constructed field by field from validated input — never spread
from the caller's object. See `build_payload` on the two work-package inputs and
`build_time_entry_payload`; the reasoning is in [security.md](security.md).

Two semantics coexist and must not be conflated:

- **Time entry update: full replacement.** Every field is sent; an absent comment
  clears the stored one.
- **Work package update: partial.** A field appears if and only if the caller
  passed it, and `null` means *clear*. That is why the input uses `Tristate<T>`
  with a custom deserializer — `Option<Option<T>>` alone collapses missing and
  null into the same `None`.

## Auth and credentials

- `credentials.rs` is the only module that touches the keychain.
- The API key never crosses to the webview, is never logged, and never appears in
  an error message.
- The base URL is validated as http(s) before any request is built from it.

## HTTP client

- One client, `openproject/client.rs`. It centralizes the base URL, the
  `Authorization: Basic base64("apikey:<key>")` header, timeouts, pagination, and
  error mapping.
- Every URL comes from `build_request_url` plus a path constant from
  `util::hal`. No string-concatenated URLs at call sites, and no following a
  server-supplied href.
- Every non-GET carries `Content-Type` — OpenProject answers HTTP 406 to a write
  without it, *including* a bodyless DELETE.

## Errors

Return `AppError`, which serializes to `{ code, message }`. The codes are the
frontend's API — `OPENPROJECT_CONFLICT` in particular is what tells the UI to
refetch and discard rather than retry — so treat them as a contract, not as
strings. Map at one place per concern: `map_error_status` for HTTP, and
`AppError::invalid_input` for anything rejected before a request is made.
