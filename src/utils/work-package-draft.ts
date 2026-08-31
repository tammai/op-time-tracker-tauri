/**
 * The editable field set of a work package, as plain data.
 *
 * This module is the whole answer to "how does the editor hold dirty state,
 * and how does stage 3 reuse it". Three properties make that work:
 *
 * 1. **A draft is flat, serializable state** — no HAL, no refs, no work
 *    package. `toWorkPackageDraft()` produces one from a loaded work package;
 *    `emptyWorkPackageDraft()` produces the same shape from nothing, which is
 *    what stage 3's create form starts from. Neither the panel nor the editor
 *    composable has to branch on which it got.
 * 2. **The diff decides clear-vs-omit, once.** `diffWorkPackageDraft()` is the
 *    only place that turns "the user emptied this field" into the `null` a
 *    PATCH needs, and "the user didn't touch it" into an absent key. Getting
 *    that wrong wipes data, so it lives in a pure function with tests rather
 *    than being re-derived per field in a template.
 * 3. **Options are built here too**, so the panel binds `{ label, value }` and
 *    never learns that an allowed value arrived as `{ id, name }`, let alone as
 *    an href.
 *
 * Pure — no Vue, no bridge, no fetch — like `time-entry-draft.ts`, and for
 * the same reason: `docs/conventions-frontend.md` keeps logic out of
 * components, and `tests/renderer/` has no component runner.
 */

import type {
  AllowedValue,
  CreateWorkPackageInput,
  Principal,
  Project,
  UpdateWorkPackageInput,
  WorkPackage
} from '@opentracker/preload'

import { isCalendarDate } from '@shared/validation/calendar-date'
import {
  formattableRaw,
  parsePrincipalIdFromHref,
  parsePriorityIdFromHref,
  parseProjectIdFromHref,
  parseStatusIdFromHref,
  parseTypeIdFromHref
} from '@shared/utils/hal'

/**
 * Mirrors the backend's own bound (`WORK_PACKAGE_SUBJECT_MAX_LENGTH`).
 * Duplicated deliberately: this copy is a UI affordance that stops a doomed
 * request, the backend one is the boundary that actually enforces it.
 */
const SUBJECT_MAX_LENGTH = 255

/** Mirrors `WORK_PACKAGE_DESCRIPTION_MAX_LENGTH`, for the same reason. */
const DESCRIPTION_MAX_LENGTH = 30_000

/** What the assignee select calls "nobody". */
export const UNASSIGNED_OPTION_LABEL = 'Unassigned'

/**
 * The editable fields, as the form holds them.
 *
 * Dates are `''` when unset rather than `null`: a draft is what an input binds
 * to, and an empty input is an empty string. Keeping one representation here
 * means `null` shows up in exactly one place — the diff — where it carries its
 * real meaning of *clear this field*.
 */
export interface WorkPackageDraft {
  subject: string
  /**
   * The raw text of the description Formattable — never the `{format, raw,
   * html}` object. The backend pins the format and builds the object, so
   * the draft holds only what the user actually typed.
   */
  description: string
  startDate: string
  dueDate: string
  statusId: number | null
  typeId: number | null
  priorityId: number | null
  assigneeId: number | null
}

/**
 * The fields whose legal values do **not** depend on the project.
 *
 * The complement of this list is what `resetProjectScopedFields` clears, and
 * naming the *keepers* rather than the clearers is the point: a field added to
 * the draft later is treated as project-scoped until someone says otherwise, so
 * forgetting to update this costs a needless reset rather than a stale id the
 * server refuses. See `resetProjectScopedFields`.
 */
const PROJECT_INDEPENDENT_FIELDS = [
  'subject',
  'description',
  'startDate',
  'dueDate'
] as const

/** The changed half of an update — everything but the identity fields. */
export type WorkPackageChanges = Omit<UpdateWorkPackageInput, 'id' | 'lockVersion'>

/** A select option, in the shape `USelectMenu` binds with `value-key="value"`. */
export interface FieldOption {
  label: string
  value: number
}

/** An assignee option; `null` is the "Unassigned" entry. */
export interface AssigneeOption {
  label: string
  value: number | null
}

/** The draft stage 3 starts a create form from. */
export function emptyWorkPackageDraft(): WorkPackageDraft {
  return {
    subject: '',
    description: '',
    startDate: '',
    dueDate: '',
    statusId: null,
    typeId: null,
    priorityId: null,
    assigneeId: null
  }
}

/**
 * The draft with every **project-scoped** field cleared, and only the fields
 * that mean the same thing in any project kept.
 *
 * This is how "changing the project resets type, status, assignee and priority"
 * is expressed, and the shape is deliberate. It could have been written as a
 * list of fields to clear — and then a field added later would silently survive
 * a project change, producing a select showing a type the new project never
 * allows and a create the server refuses. Written as a list of fields to *keep*,
 * the default for anything new is to be reset, which is the failure direction
 * worth having.
 *
 * A live instance confirmed why this cannot be left to the server: a form
 * requested with a type the project disallows answers **200** with a validation
 * error buried in the body, not an error status — so a stale type is invisible
 * until the create fails (PLAN.md, "Verified API shapes — Stage 3").
 */
export function resetProjectScopedFields(draft: WorkPackageDraft): WorkPackageDraft {
  const next = emptyWorkPackageDraft()
  for (const field of PROJECT_INDEPENDENT_FIELDS) next[field] = draft[field]
  return next
}

/**
 * The draft a loaded work package starts from — also the snapshot the diff
 * measures against, so re-deriving it after a save is what stops the *next*
 * save from reporting phantom changes.
 *
 * Every id comes from a HAL href, parsed and validated as a positive integer;
 * an href we can't read yields `null`, which the diff then never sends.
 */
export function toWorkPackageDraft(workPackage: WorkPackage): WorkPackageDraft {
  const links = workPackage._links
  return {
    subject: workPackage.subject,
    // A Formattable arrives as an object, a bare string, or null depending on
    // the instance; `formattableRaw` is the one place that is untangled.
    description: formattableRaw(workPackage.description),
    startDate: workPackage.startDate ?? '',
    dueDate: workPackage.dueDate ?? '',
    statusId: parseStatusIdFromHref(links.status?.href),
    typeId: parseTypeIdFromHref(links.type?.href),
    priorityId: parsePriorityIdFromHref(
      (links as { priority?: { href?: string | null } }).priority?.href
    ),
    // A principal may be a user, a group, or a placeholder user — all three
    // hrefs are read, because the *current* value has to render even when the
    // editor can only ever write a user back.
    assigneeId: parsePrincipalIdFromHref(links.assignee?.href)
  }
}

/**
 * The project a work package belongs to.
 *
 * Needed because the assignee options come from a **project** resource, not a
 * work-package one (PLAN.md, "Verified API shapes"). Reading it here — from the
 * work package the panel already has — is what lets the form request and the
 * assignee request go out in parallel, and what keeps one failing from
 * disabling the other.
 */
export function workPackageProjectId(workPackage: WorkPackage): number | null {
  return parseProjectIdFromHref(workPackage._links.project?.href)
}

/**
 * What changed between the loaded snapshot and what the user has on screen.
 *
 * The contract, and the reason this is a tested pure function rather than
 * inline template logic:
 * - a field that did not change is **absent** from the result, so it is absent
 *   from the PATCH body, so OpenProject leaves it alone;
 * - a *cleared* nullable field is present with the value `null`, which is how
 *   HAL says "empty this";
 * - the three required links can never be cleared, so a `null` there is read as
 *   "we couldn't determine the current value", not as an instruction.
 *
 * Collapsing the first two — sending every field, as `updateTimeEntry` does —
 * would rewrite data the user never opened.
 */
export function diffWorkPackageDraft(
  base: WorkPackageDraft,
  draft: WorkPackageDraft
): WorkPackageChanges {
  const changes: WorkPackageChanges = {}

  const subject = draft.subject.trim()
  if (subject !== base.subject.trim()) changes.subject = subject

  // Not trimmed, unlike the subject: trailing spaces end a line in markdown, so
  // trimming here would silently rewrite the user's formatting. An emptied
  // description is a real instruction — the backend sends it as an empty
  // `raw`, which is how a Formattable is cleared.
  if (draft.description !== base.description) changes.description = draft.description

  if (draft.startDate !== base.startDate) {
    changes.startDate = draft.startDate === '' ? null : draft.startDate
  }
  if (draft.dueDate !== base.dueDate) {
    changes.dueDate = draft.dueDate === '' ? null : draft.dueDate
  }

  // Required links: only ever *set*, never cleared.
  if (draft.statusId !== null && draft.statusId !== base.statusId) {
    changes.statusId = draft.statusId
  }
  if (draft.typeId !== null && draft.typeId !== base.typeId) {
    changes.typeId = draft.typeId
  }
  if (draft.priorityId !== null && draft.priorityId !== base.priorityId) {
    changes.priorityId = draft.priorityId
  }

  // The one link that *can* be cleared, so `null` passes straight through.
  if (draft.assigneeId !== base.assigneeId) changes.assigneeId = draft.assigneeId

  return changes
}

/** Whether a diff is worth sending. */
export function hasWorkPackageChanges(changes: WorkPackageChanges): boolean {
  return Object.keys(changes).length > 0
}

/**
 * The first thing wrong with a draft, or `null`.
 *
 * A UI affordance, not a boundary: the backend re-checks all of this
 * (`UpdateWorkPackageInputSchema`). Its job is to turn a request that would
 * come back as `OPENPROJECT_INVALID_INPUT` into a disabled Save and an inline
 * message, which is a far better answer than a failed round trip.
 *
 * The date ordering rule is the one check that has no backend twin:
 * OpenProject enforces it itself and answers 422, so this only saves a round
 * trip — but "due before start" is the mistake a date pair invites.
 */
export function workPackageDraftIssue(draft: WorkPackageDraft): string | null {
  const subject = draft.subject.trim()
  if (subject === '') return 'A subject is required.'
  if (subject.length > SUBJECT_MAX_LENGTH) {
    return `The subject cannot be longer than ${SUBJECT_MAX_LENGTH} characters.`
  }
  if (draft.description.length > DESCRIPTION_MAX_LENGTH) {
    return `The description cannot be longer than ${DESCRIPTION_MAX_LENGTH} characters.`
  }
  if (draft.startDate !== '' && !isCalendarDate(draft.startDate)) {
    return 'The start date is not a real date.'
  }
  if (draft.dueDate !== '' && !isCalendarDate(draft.dueDate)) {
    return 'The due date is not a real date.'
  }
  if (
    draft.startDate !== '' &&
    draft.dueDate !== '' &&
    draft.dueDate < draft.startDate
  ) {
    return 'The due date cannot be before the start date.'
  }
  return null
}

/**
 * Allowed values → select options.
 *
 * Server order is preserved: OpenProject returns statuses and types in their
 * configured workflow order, which is more meaningful than anything we could
 * sort them by.
 */
export function toFieldOptions(values: AllowedValue[]): FieldOption[] {
  return values.map((value) => ({ label: value.name, value: value.id }))
}

/**
 * Assignee options: "Unassigned", then the project's assignable **users**.
 *
 * Users only. The PATCH builds `/api/v3/users/{id}` from a bare number and has
 * no way to express a group href, so offering a group would produce a write the
 * server refuses. The schema still accepts groups, because one in the response
 * must not fail the parse and empty the whole select.
 *
 * `current` is the work package's existing assignee, pinned to the top when the
 * fetched list doesn't contain them — a former member, or a group. Without it
 * the select would render blank for a work package that is plainly assigned,
 * and the user would have no way to tell "nobody" from "somebody we couldn't
 * list". Selecting it back is a no-op, since it equals the snapshot.
 */
export function toAssigneeOptions(
  principals: Principal[],
  current: { id: number; title?: string | null } | null
): AssigneeOption[] {
  const users = principals
    .filter((principal) => principal._type === 'User')
    .map((principal) => ({ label: principal.name, value: principal.id }))

  const options: AssigneeOption[] = [
    { label: UNASSIGNED_OPTION_LABEL, value: null }
  ]
  if (current !== null && !users.some((user) => user.value === current.id)) {
    options.push({ label: current.title || `#${current.id}`, value: current.id })
  }
  return [...options, ...users]
}

// Creating (stage 3)

/**
 * The first thing stopping a create, or `null`.
 *
 * Three fields gate it, and only three: OpenProject requires a project, a type
 * and a subject, and everything else either has a default the create form
 * reports or is genuinely optional. Same role as `workPackageDraftIssue` — a UI
 * affordance that turns a doomed round trip into a disabled button with a
 * reason, not a boundary; `CreateWorkPackageInputSchema` re-checks all of it.
 *
 * The project comes in separately because it is not a draft field: it *drives*
 * the draft (see `resetProjectScopedFields`) rather than sitting in it.
 */
export function workPackageCreateIssue(
  projectId: number | null,
  draft: WorkPackageDraft
): string | null {
  if (projectId === null) return 'Choose a project.'
  if (draft.typeId === null) return 'Choose a type.'
  return workPackageDraftIssue(draft)
}

/**
 * Whether a create draft holds anything worth confirming before it is discarded.
 *
 * Only the fields the user types or picks for themselves count. Type, status and
 * priority are **prefilled from the create form** the moment a project is
 * chosen, so counting them would raise the unsaved-changes confirm with no user
 * input at all — a question nobody asked and nobody can answer meaningfully.
 * The project itself is one click to re-pick and holds no content.
 *
 * The assignee is the awkward one, because it is *both*: prefilled with the
 * current user, and a field people deliberately change. So it is compared
 * against `defaultedAssigneeId` — the value actually filled in for this project,
 * or `null` when none was — rather than against "unset". Choosing someone else,
 * **and clearing it**, are both real input and both count; being handed the
 * default does not. Passing `null` for a draft that was never defaulted gives
 * the plain "anything at all is content" reading.
 */
export function hasCreateDraftContent(
  draft: WorkPackageDraft,
  defaultedAssigneeId: number | null = null
): boolean {
  return (
    draft.subject.trim() !== '' ||
    draft.description.trim() !== '' ||
    draft.startDate !== '' ||
    draft.dueDate !== '' ||
    draft.assigneeId !== defaultedAssigneeId
  )
}

/**
 * The draft as a create request.
 *
 * Absence is the only way to say "not set" here — unlike the update path, where
 * `null` means *clear this*. On something that does not exist yet there is
 * nothing to clear, so an unset field is simply omitted and OpenProject applies
 * its own default (verified: a payload without `status` or `priority` validated
 * clean, and the server filled both in).
 *
 * `projectId` and `typeId` are passed in already known-present, because
 * `workPackageCreateIssue` is what establishes that and gating twice in two
 * places is how the two drift apart.
 */
export function toCreateWorkPackageInput(
  projectId: number,
  typeId: number,
  draft: WorkPackageDraft
): CreateWorkPackageInput {
  // Whether to send it is decided on the trimmed text — an all-whitespace
  // description is nothing — but what is sent is what the user typed, since
  // markdown reads trailing spaces as line breaks.
  const hasDescription = draft.description.trim() !== ''

  return {
    projectId,
    typeId,
    subject: draft.subject.trim(),
    ...(hasDescription ? { description: draft.description } : {}),
    ...(draft.statusId !== null ? { statusId: draft.statusId } : {}),
    ...(draft.priorityId !== null ? { priorityId: draft.priorityId } : {}),
    ...(draft.assigneeId !== null ? { assigneeId: draft.assigneeId } : {}),
    ...(draft.startDate !== '' ? { startDate: draft.startDate } : {}),
    ...(draft.dueDate !== '' ? { dueDate: draft.dueDate } : {})
  }
}

/** Projects → select options, in the order the server returned them. */
export function toProjectOptions(projects: Project[]): FieldOption[] {
  return projects.map((project) => ({ label: project.name, value: project.id }))
}
