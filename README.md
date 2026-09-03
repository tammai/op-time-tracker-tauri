# OpenProject Time Tracker

Desktop app for tracking OpenProject time entries. **Tauri 2 + Rust** backend,
Vue 3 + TypeScript frontend.

A rewrite of the [Electron version](https://github.com/tammai/op-time-tracker):
same app, same screens, same behaviour — the Node main process was replaced by
Rust, and the preload bridge by Tauri commands. See
[docs/architecture.md](docs/architecture.md) for what moved where.

---

# User guide

A month calendar over your own OpenProject time entries: see at a glance which
days are short, click a day to log against it. It talks to nothing but your
OpenProject server.

![The month view — each day shows its logged total and entry count, green for a full 8-hour day](docs/images/calendar-month-view.png)

## 1. Install

Build it yourself (see [Development](#development)) or take an installer from
your team's release channel:

| Platform | File |
|---|---|
| **Windows 10/11** — x64 | `OP.Time.Tracker_<version>_x64-setup.exe` |
| **macOS** — Apple Silicon (M1 and later) | `OP.Time.Tracker_<version>_aarch64.dmg` |
| **macOS** — Intel | `OP.Time.Tracker_<version>_x64.dmg` |

**The two macOS builds are not interchangeable.** An Apple Silicon DMG will not
open on an Intel Mac — Rosetta translates Intel code to run on Apple Silicon,
not the other way round — and the failure is silent, so it reads as a broken
download rather than the wrong one. If you're unsure which you have: **Apple
menu → About This Mac**. A line saying **Chip** means Apple Silicon; one saying
**Processor** means Intel.

Windows installs for the current user only — no admin password. The builds are
unsigned, so each OS warns once on first launch: on Windows choose **More info →
Run anyway**; on macOS **right-click → Open → Open**. Once per install.

Windows needs the WebView2 runtime, which ships with Windows 11 and current
Windows 10. The installer fetches it if it is missing.

## 2. Connect to OpenProject

On first run you get a **Connect to OpenProject** screen with two fields.

- **OpenProject base URL** — your instance, e.g. `https://op.bigin.vn`.
- **API key** — in OpenProject: avatar → **My account** → **Access tokens** →
  generate an **API** token. Copy it before closing the dialog; OpenProject
  shows it once.

Hit **Test connection** to check the pair, then **Save & continue**.

Your key goes into the OS keychain — Credential Manager on Windows, Keychain on
macOS, Secret Service on Linux — on your machine only. It is never sent anywhere
except your own OpenProject server. See [docs/security.md](docs/security.md).

## 3. The calendar

One screen: the month, with a header row above it.

- **Header** — month and year on the left, the **month total** in the middle,
  `‹ Today ›` navigation and the ⚙ settings button on the right.
- **Each day** shows its logged total and entry count. A day with nothing logged
  shows just its number. Today's cell is outlined.
- **The total's colour is the point:**

  | Colour | Meaning |
  |---|---|
  | 🟡 Amber | Under 8h — the day is short |
  | 🟢 Green | Exactly 8h |
  | 🔴 Red | Over 8h |

Only days in the displayed month are clickable — greyed leading/trailing days
belong to the neighbouring month, so use `‹` / `›` to get to them.

Everything shown is **your** time only. Entries your colleagues logged against
the same work packages don't appear.

## 4. Log time

Click a day. The day modal opens with a form on top and that day's entries below.

1. **Work package** — the dropdown starts with your own open items (status
   *In Progress* or *To Do*, most relevant first). Type to filter them. To reach
   anything else — someone else's item, a closed one — type its **full 5-digit
   ID** and the app fetches it directly.
2. **Activity** — required by OpenProject, and the available options depend on
   the work package's project, so pick the work package first.
3. **Hours** — defaults to `1`, moves in quarter-hour steps, minimum `0.25`.
   New entries cap at `8`; typing more snaps back down.
4. **Comment** — optional.

**Log time** saves it, and the calendar and the day's list both update at once.
The form then keeps your work package and activity but resets hours to `1` and
clears the comment — so logging a second slot against the same item is just
hours, comment, save.

## 5. Fix what's already logged

Each row under **Logged entries** carries three actions on the right:

| Icon | Action |
|---|---|
| ✏️ Pencil | Loads the entry into the form above. Change anything, then **Save changes** — or **Cancel** to back out. The row is highlighted and locked while you edit it. |
| 📅 Calendar | Move the entry to another day. Pick the day, hit **Move** — it leaves this day's list. |
| 🗑 Trash | Delete. Confirms inline first, because there's no undo. |

Only one change at a time: starting one disables the others until it lands.

An entry logged elsewhere in an unusual shape may have its pencil greyed out —
the form can't safely read it back. Delete still works, and you can always edit
it in OpenProject's own UI.

## 6. Files on a work package

The work package screen shows an **Attachments** list under the fields, and the
description above it renders inline images — screenshots, diagrams, anything
somebody pasted into OpenProject's own editor.

Those images need your API key to load, which a browser tab gets from its login
session and this app does not. It fetches them itself instead, so they appear
without you doing anything. If one shows as broken, your key is the first thing
to check in Settings.

**On a work package that doesn't exist yet** — the create form has the same
Attachments section. Files added there are held locally and uploaded the moment
the work package is created, because OpenProject has nothing to attach them to
until then. Remove one with the ✕ before creating and it is simply dropped.
Cancelling the draft discards them all.

That is also why the description editor offers no image button while creating:
an inline image points at an attachment id, and there is no attachment until the
work package exists. Create it, then paste your screenshots into the description.

**Adding files** — two ways, and both attach to whichever work package is
selected:

- **Add files** opens a normal file picker. Pick several at once if you like.
- **Drop them on the panel.** Dropping on the *description editor* instead
  attaches the file **and** places the image in the text at your cursor.

While editing a description you can also **paste a screenshot straight in** —
copy, click into the description, paste. It uploads and appears in place. The
🖼 button in the editor toolbar does the same from a file picker.

Pasting or dropping into the description while you have unsaved edits is safe:
the edit is kept, not discarded.

**Reading them** — click an image to open it full-size; ← and → step through the
other images, Escape closes. Click anything else, or the ⬇ button on any row, to
save it to disk.

**Deleting** — the 🗑 button, which confirms first. It's worth reading that
confirm: deleting a file that a description uses as an inline image leaves a
broken image behind. The button only appears at all if your OpenProject account
may delete that file.

Uploads are subject to your instance's own size limit — 5 MB unless your admin
raised it. Over it, OpenProject's own message says so.

## 7. Settings

The ⚙ button, top right:

- **Appearance** — light or dark.
- **OpenProject connection** — change the URL or paste a new API key (leave the
  key blank to keep the stored one). **Test connection** before saving.
- **Disconnect** — wipes the stored credentials and returns you to the connect
  screen. Nothing in OpenProject is touched.
- The app version is in the footer — worth quoting if you report a problem.

## 8. When something goes wrong

| What you see | What it usually is |
|---|---|
| **Connection failed** while testing | Wrong URL, expired/revoked API key, or the VPN isn't up. |
| **Couldn't load time entries** on the calendar | Server unreachable or credentials no longer valid. **Retry**; if it persists, re-check the key in Settings. |
| **Server accepted the request but sent no data back** (`OPENPROJECT_EMPTY_RESPONSE`) | The server answered OK with an empty body — usually a proxy or gateway in front of OpenProject, or the server dropping the body under load. **Retry**; it is not a problem with your key or the app. |
| A work package you expected is **missing from the list** | One item OpenProject sent didn't match what the app parses, so it was skipped rather than emptying the whole list. The rest are unaffected. The dev log names the field; quote it when reporting. |
| **Couldn't load activities**, saving disabled | OpenProject didn't return the activity list for that project. **Retry**; if it sticks, you likely lack permission to log time on that project. |
| **Entry no longer exists** | Someone deleted it in OpenProject while you had it open. The list refreshes itself. |
| Hours snapped down to 8 | The cap for new entries. Log the rest as a second entry, or edit an existing one (editing allows up to 24). |
| A description's image shows as **broken** | The app couldn't fetch it. Usually an expired or revoked API key — re-enter it in Settings. It can also mean the attachment was deleted in OpenProject. |
| **Some files were not attached** | Files upload one at a time and stop at the first refusal, so earlier ones did land. The message carries OpenProject's reason — most often the file is over the instance's size limit. |
| An attached file **wasn't inserted** into the description | The upload worked; only the placement failed. Click into the description where you want it and use the 🖼 button. |

Each error box shows a short code (e.g. `OPENPROJECT_NOT_FOUND`) — include it
when asking for help.

---

# Development

## Prerequisites

- **Node 22+** and **pnpm 10+**
- **Rust 1.77+** (stable)
- Platform toolchain for Tauri 2: Visual Studio Build Tools with the C++
  workload and the Windows SDK on Windows; Xcode command-line tools on macOS;
  `webkit2gtk-4.1` and `libsoup-3` dev packages on Linux. The
  [Tauri prerequisites page](https://tauri.app/start/prerequisites/) is the
  authority.

```bash
pnpm install
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the app: Vite dev server on :1420 plus `cargo run`, with hot reload on the frontend |
| `pnpm build` | Release build and installers for the current platform |
| `pnpm dist:win` / `pnpm dist:mac` | One bundle type only (NSIS / DMG) |
| `pnpm test` | Frontend tests (vitest) |
| `pnpm test:rust` | Backend tests (`cargo test`) |
| `pnpm type-check` | `vue-tsc` over the app and the tests |
| `pnpm lint` | ESLint over the webview half |
| `pnpm check` | All of the above, plus `cargo clippy -D warnings` |
| `pnpm icons` | Regenerate `src-tauri/icons/` from `build/icon.png` |

`pnpm dev:vite` / `pnpm build:vite` drive the frontend alone; `tauri.conf.json`
calls them, and they are occasionally useful directly.

## Layout

```
index.html            the one page
src/                  Vue 3 frontend (was src/renderer/)
  bridge/             window.openproject.* over invoke (was src/preload/)
  shared/             validation + utils the UI needs at runtime
src-tauri/
  src/commands/       the command surface (was src/main/ipc/)
  src/openproject/    URL building, filters, the HTTP client
  src/schemas/        serde response models + payload builders (was Zod)
  src/credentials.rs  OS keychain + the base-URL settings file
  src/attachment_protocol.rs  the opattach: scheme, for inline images
  src/staged_attachments.rs   files picked before the work package exists
  src/util/           hal / time / validation, the Rust half of src/shared
  tests/fixtures/     captured live responses, parsed in CI
tests/                frontend tests (vitest)
docs/                 architecture + security
```

## Tests

Two suites, split by which half they cover:

- **`pnpm test`** — 495 frontend tests: calendar aggregation, drafts, filters,
  the three composables, the shared validators, and the description renderer's
  HTML rules.
- **`pnpm test:rust`** — 145 backend tests: URL assembly, filter operators,
  payload builders (including clear-vs-omit), error-status mapping, the "no
  error ever carries the API key" invariant, and eight fixture tests that parse
  responses captured from a live instance.

The fixtures are the check a hand-written JSON literal cannot make: they catch an
instance-specific attribute, a differently spelled Formattable, or a
`{"href": null}` where a string was assumed. When one stops parsing, the serde
models have drifted from what a real server sends.

## Working on the boundary

The IPC contract lives in two files that must change together —
`src/bridge/types.ts` and `src-tauri/src/schemas/*.rs`. No compiler checks one
against the other. [docs/architecture.md](docs/architecture.md) says what that
means in practice; the short version is that adding an optional field is safe and
renaming anything is not.
