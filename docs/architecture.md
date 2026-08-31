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
