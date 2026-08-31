# Security

The app talks to one server — the user's own OpenProject — with one secret. Most
of what follows is about that secret and about who gets to choose a URL.

## The API key

**At rest** it lives in the OS keychain via the `keyring` crate: Credential
Manager (DPAPI) on Windows, Keychain on macOS, Secret Service on Linux. No file
this app writes ever contains it. `src-tauri/src/credentials.rs` is the only
module that reads it.

The base URL is stored separately, in plain JSON under the app config directory.
It is not a secret, and keeping it readable means a user whose keychain entry was
lost still sees which instance they had configured.

**In memory** it exists on `OpenProjectClient` and in one `Authorization`
header. It is:

- never logged — `log_parse_failure` prints a serde field path and nothing else;
- never returned to the webview — there is no command that can produce it;
- never in an error message, which is asserted rather than assumed
  (`no_mapped_error_ever_carries_the_api_key`).

A keychain that exists but refuses to decrypt is an **error**, not an absence.
Treating it as "no key stored" would push the user through onboarding again and
overwrite a key that is merely locked.

## Server-authored text

A response body can echo the request back, so the raw body is never forwarded.
Only the `message` fields OpenProject's own error schema declares are read
(`extract_api_error_message`), and only for statuses where that text is about
*our* request:

| Status | What the user sees |
|---|---|
| 400, 422, other 4xx | OpenProject's `message`, capped at 500 characters |
| 401, 403, 404, 409, 5xx | Our own wording |

409 is deliberately in the second group: the frontend needs the *code* so it can
refetch and discard, and OpenProject's "conflicting modifications" text adds
nothing.

On top of that, `safe_server_detail` drops the forwarded text entirely if the API
key appears anywhere in it. This app is the only party that knows what key it
sent, so it is the only one that can make that check.

## URLs

Every request URL is built by `build_request_url` from the stored base URL plus a
path constant. Two things follow:

- **Userinfo and fragment are stripped** at save time *and* again at request
  time. A stored URL that somehow carries credentials cannot propagate them.
- **A server-supplied href never steers a request.** Where OpenProject's HAL
  points at a collection — the assignee list, an allowed-values set — the backend
  reads the id, validates it, and rebuilds the path from its own constant.

Opening a work package in the browser is the sharpest case, because the target
reaches the OS. The only value crossing from the webview is a numeric id;
`commands/shell.rs` validates it, builds `<stored base URL>/work_packages/<id>`,
and re-asserts http(s) before handing anything over. The webview is not granted
the opener plugin's JS permission, so it cannot ask the OS to open anything else.

## Validation happens at the boundary

A form checking a field is a UI affordance, not a boundary. Everything crossing
from the webview is validated again in Rust, before a request is built:

- ids are positive integers (`lockVersion` may be `0` — a never-edited work
  package reports that);
- dates are real calendar days, so `2026-02-31` is refused here rather than by a
  422 the user cannot act on;
- `subject`, `description`, comments and search terms are length-bounded by
  **hardcoded** limits. OpenProject reports its own `maxLength` in a form
  response, and a server-reported limit cannot be the boundary — a hostile
  instance would report a larger one;
- page sizes are clamped to 200. An absurd one costs a multi-megabyte response
  this process has to fetch and parse.

## Payloads are built, never forwarded

Every request body is constructed field by field from validated input. Nothing is
spread from the caller's object, which is what guarantees the webview cannot
append an `_links` block, a chosen `format`, a rendered `html`, or a
`lockVersion` and have it ride along.

The description's `format` is pinned to `markdown` in the backend. This is not
theoretical: a live instance accepted a payload whose `format` was `"custom"` and
whose `html` was a `<script>` tag, reporting empty validation errors. The server
does not police it, so nothing downstream of here does either. `html` is never
sent at all — it is the server's rendering of `raw`, not an input.

The two form endpoints (`POST …/form`) are a POST that reads. They stay
non-mutating because the body is built here and holds exactly one validated
value — a `lockVersion`, or one type href — so nothing frontend-supplied is ever
forwarded through them.

## The window

`tauri.conf.json` sets a CSP that allows `'self'`, Google Fonts (the webview
loads one font stylesheet), and `ipc:` — no `connect-src` to arbitrary hosts,
because the webview makes no HTTP requests of its own. The capability file grants
`core:default` and nothing else; the app's own commands are the entire surface
the frontend can reach.
