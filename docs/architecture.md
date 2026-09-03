# Architecture

Two halves and one boundary.

```
┌─────────────────────────────────────┐
│ webview  (Vue 3 + TS, src/)         │
│  views → components → composables   │
│         → queries (Pinia Colada)    │
│                  ↓                  │
│         src/bridge/index.ts         │  the only module that knows
│         window.openproject.*        │  how to reach the backend
└──────────────────┬──────────────────┘
                   │ invoke("list_time_entries", …)
                   │ ← T | { code, message }
┌──────────────────┴──────────────────┐
│ backend  (Rust, src-tauri/src/)     │
│  commands/  ← validate, resolve creds│
│  openproject/client.rs  ← all HTTP   │
│  schemas/   ← parse responses        │
│  credentials.rs ← OS keychain        │
│  attachment_protocol.rs ← opattach:  │
└──────────────────┬──────────────────┘
                   │ HTTPS + Basic apikey:<key>
                   ▼
            your OpenProject
```

## The rule that shapes everything

**The webview never talks to OpenProject and never holds the API key.**

It calls commands. The backend does the HTTP, holds the secret, parses the
answer, and hands back either data or `{ code, message }`. Consequences worth
stating outright:

- There is no `get_credentials` command, and there will not be one. The webview
  can learn *whether* a key is stored and can save or clear one.
- No frontend value ever reaches a request path. Ids cross as plain integers;
  the backend validates them and builds every href itself.
- A server-supplied href never steers a request. Where OpenProject's HAL points
  at a collection, the backend rebuilds the path from its own constant.
- Responses are parsed into declared shapes before crossing. A malformed or
  hostile server can fail a parse; it cannot inject a shape into the UI.
- **A work-package list is parsed element by element.** One work package with an
  instance-specific oddity is skipped and logged rather than failing the whole
  response, which would empty the picker and browse list over a single row —
  `schemas::common` states that rule and element-level strictness was breaking
  it. A response where *nothing* parsed is still an error, `total` still reports
  the server's count, and time entries stay strict on purpose: a dropped work
  package costs a row, a dropped time entry makes a day's total silently wrong.
- **An empty 2xx body is its own error**, not a schema failure. It reaches the
  parser as `null`, where serde reports "invalid type: null" — which classifies
  identically to real drift and sent one investigation after a field that did
  not exist. `OPENPROJECT_EMPTY_RESPONSE` says what it is: a proxy or a loaded
  server, worth retrying.

## The one thing the webview loads directly

There is a single exception to "the webview never talks to OpenProject", and it
exists because an `<img>` tag cannot be made to send a header.

`/api/v3/attachments/{id}/content` requires the auth header, so an inline image
in a description has no URL the webview can load — with or without the instance
origin, it answers HTTP 401. So the app registers its own URI scheme:

```
<img src="opattach://localhost/12345">
        │
        ▼
attachment_protocol::serve  ← parses the id, resolves credentials here
        │
        ▼
client.fetch_attachment_content(12345)  ← the authenticated GET
```

The exception is narrower than it looks. The webview loads a URL *this app*
serves; the API key still never crosses, the path is still rebuilt in Rust from
a validated integer, and a failure is a bare status code. What changed is the
transport — a URL instead of a command — because the consumer is an image tag
rather than code. `docs/security.md` has the full list of what the handler
refuses.

Descriptions are rewritten in both directions to match:
`openproject::attachment_urls` points every stored attachment URL at the scheme
on the way out and restores the relative path on the way in, so the round trip
never persists a URL that only means something inside this app.

## Layer duties

| Layer | Owns | Never does |
|---|---|---|
| `src/views`, `src/components` | Rendering, local UI state | Call `window.openproject.*` directly |
| `src/composables/queries/*` | One resource each; the only callers of the bridge | Hold view state |
| `src/bridge` | Command names, error normalization | Business logic |
| `src-tauri/src/commands` | Input validation, credential resolution | HTTP, request building |
| `src-tauri/src/openproject` | URL assembly, filters, all HTTP, error mapping | Reading the keychain |
| `src-tauri/src/schemas` | Response models, payload builders | Networking |
| `src-tauri/src/credentials` | The keychain and the settings file | Anything network-facing |
| `src-tauri/src/attachment_protocol` | Serving attachment bytes on `opattach:` | Anything a command should do |

The query layer's rule is worth keeping: **each resource is fetched in exactly
one place.** A component that needs work packages uses the query; it does not
reach the bridge itself. That is what makes the cache coherent and what makes a
contract change a one-file edit.

## The contract has two halves, and they are hand-written

In the Electron app the TypeScript types were *inferred* from the main process's
Zod schemas — one source of truth. Rust cannot export TypeScript, so the
contract now lives in two files that must be changed together:

- `src/bridge/types.ts` — what the webview believes
- `src-tauri/src/schemas/*.rs` — what the backend produces

Adding a method or an optional field is additive. Renaming or removing one is a
breaking change, and there is no compiler that will catch a mismatch across the
boundary. The fixture tests in `src-tauri/tests/fixtures.rs` catch drift between
the backend and a *real server*; nothing but review catches drift between the
backend and the webview.

## Ported from Electron

| Electron | here |
|---|---|
| `src/main/openproject/client.ts` (fetch) | `openproject::client` (reqwest) |
| `src/main/schemas/*.ts` (Zod) | `schemas::*` (serde) |
| `src/main/credentials` (`safeStorage` + `electron-store`) | `credentials` (OS keychain + JSON file) |
| `src/main/ipc/*.ts` (`ipcMain.handle`) | `commands::*` (`#[tauri::command]`) |
| `src/preload/index.ts` (`contextBridge`) | `src/bridge/index.ts` (`invoke`) |
| `src/renderer/**` | `src/**`, unchanged apart from imports |
| `tests/main/**` (vitest) | `#[cfg(test)]` modules + `src-tauri/tests/` |
| `tests/renderer/**`, `tests/shared/**` (vitest) | unchanged apart from import paths |

Error **codes** are unchanged, deliberately: the frontend branches on
`OPENPROJECT_CONFLICT`, and that string is as much a part of the contract as any
type.

## Duplicated on purpose

`src/shared/` (TypeScript) and `src-tauri/src/util/` (Rust) implement the same
things twice: ISO duration conversion, href parsing, calendar-date and search
validation.

That is not an oversight. The frontend needs them at runtime for inline
validation and for aggregating a month of durations; the backend needs them
because *its* copy is the one that decides anything. Both are tested. When one
changes, change the other — the round-trip tests on either side are what make a
divergence visible.
