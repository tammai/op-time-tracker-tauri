/**
 * The typed contract for the Rust command surface.
 *
 * This is the IPC contract between the webview and the Tauri backend, and the
 * successor to the Electron app's `src/preload/types.ts`. The names, shapes and
 * error codes are deliberately unchanged, which is what let the Vue frontend
 * come across untouched.
 *
 * In the Electron app these types were *inferred* from the main process's Zod
 * schemas. Rust cannot export TypeScript, so here they are hand-written and the
 * serde models in `src-tauri/src/schemas/` are the other half of the same
 * contract. That makes this file load-bearing: **a change on one side must be
 * made on the other.** Adding a method or an optional field is fine; removing or
 * renaming one is a breaking change.
 *
 * Security note: there is intentionally NO `getCredentials()` here. The webview
 * must never receive the API key. It only learns *whether* credentials are
 * configured (`hasCredentials`) and can save or clear them. See
 * `docs/security.md`.
 */

// HAL primitives

/**
 * A HAL link. `href` is nullable because HAL — and OpenProject with it —
 * represents an unset resource link as `{ "href": null }` rather than by
 * omitting the key.
 */
export interface HalLink {
  href?: string | null
  title?: string | null
}

/**
 * OpenProject's Formattable, in the three spellings the backend accepts: the
 * `{ format, raw, html }` object a current instance sends, a bare string on
 * older ones, and `null` for an empty value. Read it with `formattableRaw()`
 * from `@shared/utils/hal`, never off `.raw` directly.
 */
export type Formattable =
  | { format?: string; raw?: string | null; html?: string | null }
  | string
  | null

/** The collection envelope every list arrives in. */
export interface Collection<T> {
  _type: string
  total: number
  count: number
  _embedded: { elements: T[] }
}

// Resources

export interface WorkPackageLinks {
  self: HalLink
  type?: HalLink
  status?: HalLink
  project?: HalLink
  priority?: HalLink
  /** Always present; `{}` or `{ href: null }` when unassigned. */
  assignee: HalLink
}

export interface WorkPackage {
  id: number
  _type: string
  /**
   * OpenProject's optimistic-locking counter. Required, and required to be sent
   * back on a save — a `PATCH` without it is an unconditional overwrite.
   */
  lockVersion: number
  subject: string
  description?: Formattable
  type?: string
  status?: string
  startDate?: string | null
  dueDate?: string | null
  spentHours?: number | string | null
  createdAt?: string
  updatedAt?: string
  _links: WorkPackageLinks
}

export type WorkPackageCollection = Collection<WorkPackage>

/** The links an attachment carries that the UI reads. */
export interface AttachmentLinks {
  author?: HalLink
  container?: HalLink
  /**
   * Present only when this key may delete the attachment — OpenProject
   * expresses the permission as the presence of the link. Read `canDelete`
   * rather than testing for it.
   */
  delete?: HalLink
}

/**
 * One attachment on a work package.
 *
 * `canDelete` and `proxyUrl` are **computed by the backend**, not sent by
 * OpenProject (`src-tauri/src/schemas/attachments.rs`). Both are marked
 * `skip_deserializing` there, so a hostile instance cannot assert either one.
 */
export interface Attachment {
  id: number
  fileName: string
  fileSize?: number
  contentType?: string
  createdAt?: string
  _links: AttachmentLinks
  /** Whether the stored key may delete this attachment. */
  canDelete: boolean
  /**
   * The `opattach:` URL that renders this attachment's bytes in an `<img>`.
   *
   * `/api/v3/attachments/{id}/content` needs an auth header an `<img>` cannot
   * send, so the backend serves the bytes on its own URI scheme instead — see
   * `src-tauri/src/attachment_protocol.rs`. Use it as-is; never build one here.
   */
  proxyUrl: string
}

export type AttachmentCollection = Collection<Attachment>

/**
 * A file chosen for a work package that does not exist yet.
 *
 * OpenProject attaches to a container, so a create has nothing to attach to
 * until it succeeds. The backend holds the chosen file and hands back this
 * handle plus enough metadata to draw a list — **never the path**
 * (`src-tauri/src/staged_attachments.rs`). `token` is opaque and
 * process-local; it is the only way to refer to the file again.
 */
export interface StagedAttachment {
  token: string
  fileName: string
  fileSize: number
  contentType: string
}

export interface TimeEntryLinks {
  self: HalLink
  workPackage?: HalLink
  project?: HalLink
  user?: HalLink
  activity?: HalLink
}

export interface TimeEntry {
  id: number
  _type: string
  /** The raw ISO 8601 duration (`"PT1H30M"`) — convert with `parseHoursToDecimal`. */
  hours: string
  spentOn: string
  createdAt?: string
  updatedAt?: string
  comment: Formattable
  _links: TimeEntryLinks
}

export type TimeEntryCollection = Collection<TimeEntry>

export interface TimeEntryActivity {
  id: number
  name: string
  position?: number
  default?: boolean
}

export type TimeEntryActivityCollection = Collection<TimeEntryActivity>

export interface Principal {
  id: number
  _type: string
  name: string
  _links?: { self?: HalLink }
}

export type PrincipalCollection = Collection<Principal>

export interface Project {
  id: number
  _type?: string
  name: string
  identifier?: string
  active?: boolean
  _links?: { self?: HalLink; createWorkPackage?: HalLink }
}

export type ProjectCollection = Collection<Project>

export interface Status {
  id: number
  name: string
  color?: string | null
  isDefault?: boolean | null
  isClosed?: boolean | null
}

export type StatusCollection = Collection<Status>

// Forms (flattened out of HAL by the backend)

/** One selectable value for an enumerated field. No hrefs reach the webview. */
export interface AllowedValue {
  id: number
  name: string
}

export interface WorkPackageFormField {
  writable: boolean
  allowedValues: AllowedValue[]
}

export interface WorkPackageFormPlainField {
  writable: boolean
}

export interface WorkPackageForm {
  subject: WorkPackageFormPlainField
  description: WorkPackageFormPlainField
  startDate: WorkPackageFormPlainField
  dueDate: WorkPackageFormPlainField
  assignee: WorkPackageFormPlainField
  status: WorkPackageFormField
  type: WorkPackageFormField
  priority: WorkPackageFormField
}

/**
 * OpenProject's own initial values for the three required links. `null` means
 * the form offered none — reported honestly so the UI can gate Create rather
 * than sending a type the project never allowed.
 */
export interface WorkPackageCreateDefaults {
  typeId: number | null
  statusId: number | null
  priorityId: number | null
}

export interface WorkPackageCreateForm extends WorkPackageForm {
  defaults: WorkPackageCreateDefaults
}

// Filters

export interface WorkPackageFilters {
  /** Only work packages assigned to the current user. */
  onlyMine?: boolean
  /** Only open work packages (status operator `o`). */
  onlyOpen?: boolean
  /**
   * Specific status resource **ids**, stringified. Takes precedence over
   * `onlyOpen`. OpenProject's `status` filter `=` operator requires ids, not
   * titles — resolve titles via `listStatuses()` first.
   */
  statuses?: string[]
  /** Title search (`subjectOrId` with the `**` operator). 2–100 characters. */
  search?: string
  /** Server-side ordering as `[[field, 'asc' | 'desc'], …]`. */
  sortBy?: Array<[string, 'asc' | 'desc']>
  pageSize?: number
  offset?: number
}

export interface TimeEntryFilters {
  /** Only entries belonging to the current user. */
  onlyMine?: boolean
  spentOn?: { between: [string, string] } | { on: string }
  workPackageId?: number
  pageSize?: number
  offset?: number
}

// Inputs

export interface SaveCredentialsInput {
  baseUrl: string
  /**
   * Omit (or pass empty) to keep the API key already in the keychain — the
   * webview can't echo back a key it never receives, so this is how a URL-only
   * change is expressed. Required when nothing is stored yet.
   */
  apiKey?: string
}

export interface TestConnectionInput {
  baseUrl: string
  /** Omit to probe with the stored key (resolved in the backend). */
  apiKey?: string
}

/**
 * The non-secret half of the stored credentials, for prefilling the settings
 * form. `hasApiKey` reports presence only — the key itself is never sent.
 */
export interface ConnectionInfo {
  baseUrl: string | null
  hasApiKey: boolean
}

/** Result of the connection probe. Never includes the key or the base URL. */
export type TestConnectionResult = { ok: true } | { ok: false; error: string }

export interface ListWorkPackagesInput {
  filters?: WorkPackageFilters
}

export interface ListTimeEntriesInput {
  filters?: TimeEntryFilters
}

/**
 * Optional scoping for `listTimeEntryActivities`. Passing the work package the
 * user is logging against limits the activities to the ones allowed in that
 * work package's project.
 */
export interface ListTimeEntryActivitiesInput {
  workPackageId?: number
}

export interface CreateTimeEntryInput {
  workPackageId: number
  activityId: number
  /** ISO `YYYY-MM-DD`, and a real calendar day. */
  spentOn: string
  /** Decimal hours, in `(0, 24]`. */
  hours: number
  comment?: string
}

/** Update is a **full replacement**: an omitted `comment` clears the stored one. */
export interface UpdateTimeEntryInput extends CreateTimeEntryInput {
  id: number
}

export interface DeleteTimeEntryInput {
  id: number
}

export interface WorkPackageFormInput {
  workPackageId: number
  /** Required — the form endpoint answers HTTP 409 without one. */
  lockVersion: number
}

export interface WorkPackageCreateFormInput {
  projectId: number
  /** Optional; matters on instances whose status workflows differ per type. */
  typeId?: number
}

/** A **project** id, not a work package id — see `docs/architecture.md`. */
export interface AvailableAssigneesInput {
  projectId: number
}

/**
 * Input for `createWorkPackage`. Deliberately not nullable anywhere: on a create
 * there is nothing to clear, so `null` would be a second spelling of "absent".
 */
export interface CreateWorkPackageInput {
  projectId: number
  typeId: number
  subject: string
  description?: string
  statusId?: number
  priorityId?: number
  assigneeId?: number
  startDate?: string
  dueDate?: string
}

/**
 * Input for `updateWorkPackage` — a **partial** update.
 *
 * The distinction that matters: an absent field is left alone by OpenProject,
 * while `null` on a date or on `assigneeId` explicitly *clears* it. The two are
 * not interchangeable, and passing every field would rewrite data the user never
 * edited.
 */
export interface UpdateWorkPackageInput {
  id: number
  /** Must be the value from the work package as loaded. */
  lockVersion: number
  subject?: string
  /** `''` clears the description. */
  description?: string
  startDate?: string | null
  dueDate?: string | null
  statusId?: number
  typeId?: number
  priorityId?: number
  assigneeId?: number | null
}

/**
 * Input for `openWorkPackageInBrowser`.
 *
 * A numeric id and nothing else — deliberately not a URL, an href, or a path.
 * The backend builds the URL itself from the stored base URL, so the webview has
 * no way to influence what is handed to the operating system.
 */
export interface OpenWorkPackageInBrowserInput {
  workPackageId: number
}

// The error every command rejects with

/**
 * What a failed command throws: an `Error` whose `code` is the stable
 * machine-readable half.
 *
 * The frontend reads `.message` for display and branches on `.code` — most
 * importantly `OPENPROJECT_CONFLICT`, which means refetch and discard rather
 * than retry.
 *
 * Codes: `CREDENTIAL_VALIDATION_FAILED`, `CREDENTIAL_READ_FAILED`,
 * `CREDENTIAL_NOT_CONFIGURED`, `OPENPROJECT_INVALID_INPUT`,
 * `OPENPROJECT_AUTH_FAILED`, `OPENPROJECT_NOT_FOUND`, `OPENPROJECT_HTTP_ERROR`,
 * `OPENPROJECT_SERVER_ERROR`, `OPENPROJECT_SCHEMA_FAILED`,
 * `OPENPROJECT_VALIDATION_FAILED`, `OPENPROJECT_CONFLICT`,
 * `OPENPROJECT_TIMEOUT`, `SHELL_INVALID_INPUT`, `SHELL_UNSAFE_TARGET`,
 * `SHELL_OPEN_FAILED`, `BRIDGE_UNKNOWN`.
 */
export interface BridgeErrorShape extends Error {
  code: string
}

// The bridge

/** Whose attachments to list, or upload to. */
export interface WorkPackageAttachmentsInput {
  workPackageId: number
}

/** One attachment, by id — delete and save both take this. */
export interface AttachmentIdInput {
  id: number
}

/**
 * Files to attach.
 *
 * Omit `paths` to have the **backend** open the native file picker, which is
 * the normal case: the chosen paths never cross IPC in either direction. Pass
 * `paths` only with the paths from a `tauri://drag-drop` event — the one case
 * where the webview legitimately knows a path the user picked, because the OS
 * handed it there.
 */
export interface UploadAttachmentFilesInput {
  workPackageId: number
  paths?: string[]
}

/**
 * An attachment whose bytes never had a path — a screenshot pasted into the
 * description editor.
 *
 * `data` is base64. It is not a byte array because Tauri serializes one as a
 * JSON array of numbers, costing roughly six bytes of IPC per byte of image.
 */
export interface UploadAttachmentDataInput {
  workPackageId: number
  fileName: string
  contentType?: string
  data: string
}

/** Which staged file to forget. */
export interface StagedTokenInput {
  token: string
}

/** The staged files to upload, and the work package that now exists for them. */
export interface UploadStagedAttachmentsInput {
  workPackageId: number
  tokens: string[]
}

export interface OpenProjectBridge {
  /**
   * Returns true if credentials are saved. Cheap — does not expose the API key.
   * Used by the onboarding gate to decide whether to show the form or the
   * calendar.
   */
  hasCredentials(): Promise<boolean>

  /**
   * Read back the non-secret connection info so the settings form can show the
   * configured base URL and indicate that a key is stored.
   */
  getConnectionInfo(): Promise<ConnectionInfo>

  /**
   * Validate and persist credentials. Rejects with `{ code, message }` on
   * validation failure. Never returns the saved values. Omit `apiKey` to keep
   * the stored one.
   */
  saveCredentials(input: SaveCredentialsInput): Promise<void>

  /** Remove stored credentials. Safe to call when none are stored. */
  clearCredentials(): Promise<void>

  /**
   * Probe the server with the unsaved form values to verify the pair
   * authenticates before saving. A failure is a **value**, not a rejection —
   * "your key is wrong" is the expected outcome of a test button.
   */
  testConnection(input: TestConnectionInput): Promise<TestConnectionResult>

  /** `GET /api/v3/work_packages`, filtered and parsed in the backend. */
  listWorkPackages(input?: ListWorkPackagesInput): Promise<WorkPackageCollection>

  /**
   * Time entries for a date range — **every** match, not just the first page.
   * The calendar asks a question about a month, so a partial answer would be a
   * wrong answer.
   */
  listTimeEntries(input?: ListTimeEntriesInput): Promise<TimeEntryCollection>

  /**
   * The instance-wide status set, used to resolve status titles to the resource
   * ids the work-package `status` filter requires.
   */
  listStatuses(): Promise<StatusCollection>

  /**
   * The activities that may be assigned to a time entry — required on every
   * entry. Pass `workPackageId` to scope the list to that work package's
   * project.
   */
  listTimeEntryActivities(
    input?: ListTimeEntryActivitiesInput
  ): Promise<TimeEntryActivityCollection>

  /**
   * Create a time entry. Rejects with `OPENPROJECT_INVALID_INPUT` when the
   * details fail validation, `OPENPROJECT_VALIDATION_FAILED` when OpenProject
   * itself refuses the entry (e.g. the activity isn't allowed for that project).
   */
  createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry>

  /**
   * Update an entry. **Full replacement, not a partial patch**: every field is
   * sent, so an omitted `comment` clears the stored one.
   */
  updateTimeEntry(input: UpdateTimeEntryInput): Promise<TimeEntry>

  /**
   * Delete an entry. Irreversible; there is no server-side undo. Rejects with
   * `OPENPROJECT_NOT_FOUND` when the entry is already gone or not visible.
   */
  deleteTimeEntry(input: DeleteTimeEntryInput): Promise<void>

  /**
   * The editable schema of one work package: which fields may be written, and —
   * for status, type and priority — which values that work package's workflow
   * actually allows. The only source that honours "only legal transitions";
   * `listStatuses()` cannot know which are reachable from where it is now.
   *
   * Rejects with `OPENPROJECT_CONFLICT` when the lock version is already stale.
   */
  getWorkPackageForm(input: WorkPackageFormInput): Promise<WorkPackageForm>

  /**
   * The schema for a *new* work package in one project, plus OpenProject's own
   * defaults. Project-scoped, which is the shape of the whole create flow:
   * until a project is chosen there are no legal types, statuses or assignees.
   */
  getWorkPackageCreateForm(
    input: WorkPackageCreateFormInput
  ): Promise<WorkPackageCreateForm>

  /**
   * The principals a work package may be assigned to — its **project's**
   * assignable members. Takes a `projectId`, not a work package id: the
   * work-package-scoped route does not exist (HTTP 404).
   */
  listAvailableAssignees(input: AvailableAssigneesInput): Promise<PrincipalCollection>

  /**
   * The user the stored API key authenticates as. Takes no input, deliberately:
   * the identity is the key's, so there is nothing for the webview to name.
   */
  getCurrentUser(): Promise<Principal>

  /**
   * Update a work package — **a partial update**. Send only what changed; `null`
   * on a date or on `assigneeId` explicitly clears it.
   *
   * Rejects with `OPENPROJECT_CONFLICT` when someone else changed the work
   * package first (refetch and discard rather than retrying),
   * `OPENPROJECT_VALIDATION_FAILED` carrying OpenProject's own message when it
   * refuses the change.
   */
  updateWorkPackage(input: UpdateWorkPackageInput): Promise<WorkPackage>

  /**
   * The projects a work package may be **created** in — not every project the
   * key can see, which would include ones it cannot write to. An empty
   * collection is a real answer, not an error.
   */
  listProjects(): Promise<ProjectCollection>

  /**
   * Create a work package. Rejects with `OPENPROJECT_VALIDATION_FAILED` carrying
   * OpenProject's own message when it refuses (a required custom field, a type
   * the project no longer allows) — the caller keeps the draft and shows it.
   */
  createWorkPackage(input: CreateWorkPackageInput): Promise<WorkPackage>

  /**
   * Every attachment on one work package.
   *
   * Each element carries a `proxyUrl` for rendering it and a `canDelete` the
   * delete button gates on. Not paginated — OpenProject returns the whole set.
   */
  listWorkPackageAttachments(
    input: WorkPackageAttachmentsInput
  ): Promise<AttachmentCollection>

  /**
   * Attach one or more files, returning what landed.
   *
   * With `paths` omitted the backend opens the native file picker; an empty
   * array back means the user cancelled it, which is not an error.
   *
   * Uploads run sequentially and **stop at the first failure**, so a rejection
   * may still have attached earlier files — OpenProject has no batch endpoint to
   * make this atomic. Refetch the list either way.
   */
  uploadWorkPackageAttachments(
    input: UploadAttachmentFilesInput
  ): Promise<Attachment[]>

  /** Attach base64 bytes — a pasted screenshot, which has no path on disk. */
  uploadWorkPackageAttachmentData(
    input: UploadAttachmentDataInput
  ): Promise<Attachment>

  /**
   * Delete an attachment. Irreversible, and it can break a description: an
   * inline image whose attachment is gone renders broken. Confirm first.
   */
  deleteAttachment(input: AttachmentIdInput): Promise<void>

  /**
   * Save an attachment to a location the user picks.
   *
   * The backend opens the save dialog and takes the suggested file name from
   * **OpenProject**, not from here, so no frontend string becomes a path it
   * writes to. Resolves to the file name written, or `null` when the user
   * cancelled.
   */
  saveAttachment(input: AttachmentIdInput): Promise<string | null>

  /**
   * Choose files for a work package that does not exist yet.
   *
   * Nothing is uploaded: the backend takes custody of the files and returns a
   * handle for each. Each one is validated now, so an oversized or unreadable
   * file is reported while the form is still being filled in rather than after
   * the create.
   *
   * Same `paths` split as `uploadWorkPackageAttachments` — omit it for the
   * native picker, pass it only with drag-and-drop paths. An empty array back
   * means the user cancelled the picker.
   */
  stageAttachmentFiles(
    input: UploadAttachmentFilesInput
  ): Promise<StagedAttachment[]>

  /** Drop one staged file — the user removed it, or the draft was cancelled. */
  discardStagedAttachment(input: StagedTokenInput): Promise<void>

  /**
   * Upload every staged file to the work package that was just created.
   *
   * A token is released only once its file has landed, so a failure part-way
   * through leaves the rest staged rather than losing them. Like the other
   * upload path it stops at the first refusal, so a rejection may still have
   * attached earlier files — refetch the list either way.
   */
  uploadStagedAttachments(
    input: UploadStagedAttachmentsInput
  ): Promise<Attachment[]>

  /**
   * Open a work package in the user's default browser.
   *
   * The only value crossing is the numeric id. The backend validates it and
   * builds `<baseUrl>/work_packages/<id>` from the **stored** base URL; it never
   * builds the URL from a server-supplied href, and it re-asserts http(s) before
   * handing anything to the OS.
   */
  openWorkPackageInBrowser(input: OpenWorkPackageInBrowserInput): Promise<void>
}

declare global {
  interface Window {
    openproject: OpenProjectBridge
  }
}
