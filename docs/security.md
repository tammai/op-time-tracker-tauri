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

## Attachment bytes, and the one scheme this app serves

`/api/v3/attachments/{id}/content` requires the auth header, so an `<img src>` in
the webview cannot load an inline image: with or without the instance origin, the
URL answers HTTP 401. Moving the key into the webview to fix that would give up
the rule everything else here rests on, so instead the app registers its own URI
scheme, `opattach:`, and serves the bytes from Rust
(`src-tauri/src/attachment_protocol.rs`). Every description leaving the client
has its attachment URLs rewritten to it, and every description entering the
client has that undone, so nothing app-specific is ever persisted.

The handler is deliberately narrow:

- **GET only**, refused before credentials are read.
- **The path must be exactly one positive integer.** It is parsed to an `i64`,
  and the request path is then rebuilt by the client from `ATTACHMENT_PATH` — no
  part of the incoming URL reaches a request. A nested path, a traversal, or a
  non-numeric segment is HTTP 400.
- **A failure is a bare status code with no body.** The consumer is an `<img>`
  tag, which can render a broken-image icon and nothing else, so putting server
  error text inside the page would buy nothing.
- **`text/html`, XML and SVG content types are relabelled**
  `application/octet-stream`, and `X-Content-Type-Options: nosniff` is set. An
  uploaded file must not be renderable as a document on this app's own scheme.

Redirects are followed, because OpenProject answers 302 to a presigned storage
URL when attachments do not live in the database. reqwest drops `Authorization`
when a redirect changes host, scheme or port, so the key reaches the configured
instance and nowhere else.

The CSP's `img-src` is widened by exactly `opattach:` for this. The Windows
spelling (`http://opattach.localhost`) is already inside the existing `http:`
allowance.

## Filesystem paths

Uploading and saving are the only things this app does that touch local files,
and the URL rule has a filesystem counterpart: **no frontend value becomes a
path this process opens, with one stated exception.**

- **Choosing a file to attach** and **choosing where to save one** both open the
  native dialog *in Rust*. The chosen path is used and dropped; it never crosses
  IPC in either direction. The webview asks "attach something to work package
  40023" and learns only what came back. The dialog plugin is registered for its
  Rust API only — the frontend is not granted its JS permission.
- **The name a saved file is written under** comes from OpenProject's own
  attachment metadata, fetched for the purpose, not from the webview. It is
  reduced to a base name with separators and quotes stripped before use.
- **A pasted screenshot** has no path at all: it arrives as base64 clipboard
  bytes, length-capped before decoding.
- **A file chosen for a work package that does not exist yet** is held by
  `src-tauri/src/staged_attachments.rs`, which hands the webview an opaque
  process-local token and the metadata to draw a list — never the path. A token
  the webview invents resolves to nothing rather than to a file. This is what
  keeps the create flow on the same footing as the edit flow rather than
  quietly reintroducing frontend-held paths.
- **The exception is drag-and-drop.** Tauri intercepts the window's native drop
  and delivers the OS paths to the webview, which forwards them back. That is the
  one case where the webview legitimately knows a path the user chose, because
  the OS put it there. Each is still checked to be an existing regular file
  within the size ceiling before it is read. A webview compromised badly enough
  to fabricate a path could read that file into the user's own OpenProject; that
  is the cost of supporting drops, and it is written down rather than left
  implicit.

Both directions are capped at 64 MB — not the authority on what is allowed
(OpenProject enforces its own limit, 5 MB by default, and answers 422), but a
ceiling on what this process will buffer.

## Descriptions are rendered, never trusted

OpenProject returns a rendered `description.html`. It is never used: a live
instance accepted a payload whose `format` was `"custom"` and whose `html` was a
`<script>` tag. The frontend renders `raw` itself, with raw HTML escaped and
link and image URLs filtered.

One narrowing was needed, because OpenProject stores an inline image *as HTML* —
CommonMark has no figure node — and escaping it wholesale showed the user the
tags instead of the screenshot. `src/utils/openproject-html.ts` handles that
explicitly, and the shape of it is what keeps it safe: each recognised construct
is **rebuilt** rather than filtered. The tag name comes from that file, and the
only attributes that survive are `src`, `alt` and `title`, re-escaped — so every
event handler, `style` and `class` is dropped by construction, not by a
blocklist. An image source must pass `isSafeImageSrc` (http, https, or the
attachment proxy). Anything not on the list falls through to the blanket escape.

Widening what renders is therefore an edit to that one file, and a fenced code
block containing HTML is a different marked token entirely, so a description
documenting `<figure>` still shows it as a code sample.

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

`tauri.conf.json` sets a CSP that allows `'self'`, `ipc:`, and — for images
only — `data:`, `opattach:` and http(s), which is what lets a description render
an inline attachment through the proxy above and an externally hosted image it
links to. There is no `connect-src` to arbitrary hosts, because the webview makes
no HTTP requests of its own.

The capability file grants `core:default` and nothing else. Neither the opener
plugin nor the dialog plugin is exposed to JavaScript, so the app's own commands
remain the entire surface the frontend can reach.
