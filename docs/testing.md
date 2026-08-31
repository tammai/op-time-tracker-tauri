# Testing conventions

Two suites, split by which half of the app they cover.

## Frontend — `pnpm test` (vitest)

Tests live under `tests/`, mirroring `src/` — never co-located with source.

- `src/utils/day-total.ts` → `tests/renderer/utils/day-total.test.ts`
- `src/shared/utils/time.ts` → `tests/shared/utils/time.test.ts`

`vitest.config.ts`'s `test.include` is scoped to `tests/**/*.test.ts`, so a stray
`*.test.ts` next to source silently will not run.

Imports use the same aliases the app uses — `@renderer/…`, `@shared/…`,
`@opentracker/preload` — never relative paths across trees. A test's directory
depth mirrors the source's, so `../../../src/…` breaks on any reshuffle.

What belongs here: pure logic (calendar aggregation, drafts, filters, label
formatting, the shared validators) and composables driven with a stubbed
`window.openproject`. Stub the bridge — the true I/O boundary — and wire real
implementations of your own collaborators. Mocking internals couples tests to
implementation and hides real breakage.

## Backend — `pnpm test:rust` (cargo)

Unit tests live in a `#[cfg(test)] mod tests` at the bottom of the module they
cover, which is Rust's convention and keeps a helper testable without exporting
it.

What belongs here: URL assembly, filter operators, payload builders, form
normalization, validation, error mapping, and the invariants worth asserting
outright — `no_mapped_error_ever_carries_the_api_key` is a test, not a comment.

Nothing here talks to the network. The client's request path is exercised through
its pure parts (URL building, filter encoding, status mapping, parsing); a live
server is not a test dependency.

`credentials.rs` tests cover the settings-file half against a temp directory. The
keychain half is deliberately untested: `keyring` talks to a real OS service, so a
unit test would either write to the developer's own keychain or need a mock of
the OS. The file format and the validation around it are where the bugs live.

## Fixtures — `src-tauri/tests/fixtures.rs`

`src-tauri/tests/fixtures/*.json` are responses captured from a live OpenProject
instance. They are the check a hand-written JSON literal cannot make: an
instance-specific attribute, a differently spelled Formattable, a
`{"href": null}` where a string was assumed.

When a fixture stops parsing, the serde models have drifted from what a real
server sends. Add a new fixture whenever an endpoint's real shape surprises you —
that surprise is exactly what the next reader needs to inherit.

## The contract

`pnpm check` runs both suites plus `vue-tsc` and `cargo clippy -D warnings`.
Neither type-checker sees the other side of the IPC boundary, so a change to
`src/bridge/types.ts` or `src-tauri/src/schemas/*.rs` needs the matching edit
made by hand — see [architecture.md](architecture.md).
