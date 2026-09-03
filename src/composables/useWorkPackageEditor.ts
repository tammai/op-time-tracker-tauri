import { computed, ref, watch, type Ref } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import type {
  Principal,
  UpdateWorkPackageInput,
  WorkPackage
} from '@opentracker/preload'

import {
  useUpdateWorkPackage,
  workPackageQueries
} from '@renderer/composables/queries/work-packages'
import { principalQueries } from '@renderer/composables/queries/principals'
import {
  diffWorkPackageDraft,
  emptyWorkPackageDraft,
  hasWorkPackageChanges,
  toAssigneeOptions,
  toFieldOptions,
  toWorkPackageDraft,
  workPackageDraftIssue,
  workPackageProjectId,
  type AssigneeOption,
  type FieldOption,
  type WorkPackageDraft
} from '@renderer/utils/work-package-draft'

/**
 * Editing state for the work-package detail panel.
 *
 * Takes the selection **ref**, and writes back to it. That two-way relationship
 * is deliberate: a successful save must update the panel, the list row, and the
 * lock version from the response OpenProject echoes back, and the selection is
 * the one object all three read from. Handing this composable a read-only value
 * would leave the caller to re-implement that, and getting it wrong means the
 * next save conflicts against the previous one.
 *
 * **How the dirty state is held** — the design point that outlives stage 2.
 * There are two drafts, not one: `snapshot` is what the work package looked
 * like when editing began, `draft` is what is on screen. Everything else is
 * derived from the pair by pure functions in `utils/work-package-draft.ts` —
 * what changed, whether anything did, whether it is valid. The composable owns
 * no per-field logic at all, which is what lets stage 3 build a create form
 * from `emptyWorkPackageDraft()` and the same diff without forking anything:
 * an empty work package is just a snapshot where every field is unset.
 *
 * The re-seed rule is the subtle part. The browse list refetches on its own,
 * and the browser adopts fresher copies into the selection — so re-seeding on
 * every change to `selected` would silently erase whatever the user was typing
 * the moment a background refetch landed. Re-seeding is therefore keyed on the
 * **row identity**, not on the object: a new work package re-seeds, a new
 * revision of the one being edited does not. A revision that matters shows up
 * as a 409 on save, which is the one place edits are discarded — deliberately,
 * loudly, and with the server's copy taking over.
 */

/** Whether a field can be edited, and — when it can't — why not. */
export interface EditableFieldState {
  disabled: boolean
  reason: string | null
}

/**
 * The fields the panel renders — shared with the create form, which mounts the
 * same component and therefore has to answer for the same set.
 *
 * `description` joined it in Stage 3 (the spec's "Deliberate scope widening"):
 * it was added to the shared component for the create form, which makes it
 * editable here too.
 */
export type WorkPackageFieldName =
  | 'subject'
  | 'description'
  | 'startDate'
  | 'dueDate'
  | 'status'
  | 'type'
  | 'priority'
  | 'assignee'

const NOT_WRITABLE_REASON =
  'OpenProject doesn’t allow changing this field on this work package.'
const NO_ALLOWED_VALUES_REASON =
  'OpenProject offers no other value for this field here.'
const FORM_FAILED_REASON = 'The allowed values couldn’t be loaded.'
const ASSIGNEES_FAILED_REASON = 'The project’s members couldn’t be loaded.'
const NO_PROJECT_REASON = 'This work package’s project couldn’t be identified.'
const GENERIC_SAVE_ERROR = 'The work package couldn’t be saved.'

export function useWorkPackageEditor(selected: Ref<WorkPackage | null>) {
  /** The values the panel binds to. */
  const draft = ref<WorkPackageDraft>(emptyWorkPackageDraft())
  /** What the work package held when editing began — the diff's baseline. */
  const snapshot = ref<WorkPackageDraft>(emptyWorkPackageDraft())

  /**
   * The lock version the snapshot was taken from — **not** whatever the
   * selection currently holds.
   *
   * The distinction is the difference between a safe save and a silent
   * overwrite. The browse list refetches on its own and the browser adopts the
   * fresher copy into the selection, so by the time Save is pressed
   * `selected.lockVersion` may already be the revision *somebody else* wrote.
   * Sending that would make the conditional write succeed against a version the
   * user never saw, quietly discarding the other person's change. Pinning it to
   * the snapshot is what guarantees a genuine conflict comes back as a 409.
   */
  const snapshotLockVersion = ref(0)

  const isEditing = ref(false)
  const isSaving = ref(false)
  const saveError = ref<string | null>(null)
  const hasConflict = ref(false)

  const cache = useQueryCache()

  function seedFrom(workPackage: WorkPackage | null): void {
    const next =
      workPackage === null
        ? emptyWorkPackageDraft()
        : toWorkPackageDraft(workPackage)
    snapshot.value = next
    draft.value = { ...next }
    snapshotLockVersion.value = workPackage?.lockVersion ?? 0
  }

  // Re-seed on row identity, not on object identity. See the header comment:
  // a background refetch of the row under edit must not eat the user's typing.
  watch(
    selected,
    (workPackage, previous) => {
      if (workPackage === null) {
        isEditing.value = false
        saveError.value = null
        hasConflict.value = false
        seedFrom(null)
        return
      }
      if (isEditing.value && previous?.id === workPackage.id) return
      if (previous?.id !== workPackage.id) {
        isEditing.value = false
        saveError.value = null
        hasConflict.value = false
      }
      seedFrom(workPackage)
    },
    { immediate: true }
  )

  // Allowed values

  // Two independent requests, fired in parallel. Neither depends on the other,
  // which is exactly what makes "one failed, the read view survives, only the
  // affected select goes dark" fall out rather than being special-cased: the
  // form knows the legal transitions, the project knows its members.
  //
  // Keyed on the *snapshot's* lock version, matching the save. Keying it on the
  // selection's would rekey mid-edit whenever the list refetched, swapping the
  // option lists under the user and blanking a select whose chosen value had
  // left them. If the snapshot really is stale the form answers 409, the three
  // selects disable with a reason, and the save that follows says the same
  // thing — which is the honest report, not a glitch.
  const formParams = computed(() =>
    selected.value === null
      ? null
      : { workPackageId: selected.value.id, lockVersion: snapshotLockVersion.value }
  )

  const formQuery = useQuery(() => ({
    ...workPackageQueries.form(
      formParams.value ?? { workPackageId: 0, lockVersion: 0 }
    ),
    enabled: formParams.value !== null
  }))

  /** `null` when the work package's project link can't be read. */
  const projectId = computed(() =>
    selected.value === null ? null : workPackageProjectId(selected.value)
  )

  const assigneesQuery = useQuery(() => ({
    ...principalQueries.availableAssignees(projectId.value ?? 0),
    enabled: projectId.value !== null
  }))

  const form = computed(() => formQuery.data.value)
  const formError = computed(() =>
    formParams.value === null ? null : formQuery.error.value
  )
  const assigneesError = computed(() =>
    projectId.value === null ? null : assigneesQuery.error.value
  )

  /**
   * The revision under edit is no longer the server's.
   *
   * The form endpoint takes the same lock version the save will send, so it
   * answers 409 for a stale one — meaning the conflict is detectable *before*
   * the user types, not only when they press Save. Treating it as a conflict
   * here is what stops the panel from sitting there half-editable: the three
   * selects would otherwise merely disable with "allowed values couldn't be
   * loaded", while subject and the dates stayed live and every keystroke went
   * into a draft that could not be saved.
   */
  const isStaleRevision = computed(() => {
    const error = formError.value as { code?: string } | null
    return error?.code === 'OPENPROJECT_CONFLICT'
  })

  /**
   * Editing is blocked: either a save was refused as a conflict, or the form
   * already reported this revision stale. One flag so the panel has one thing
   * to render and one thing to disable on.
   */
  const isConflicted = computed(() => hasConflict.value || isStaleRevision.value)

  const isRefreshing = ref(false)

  /**
   * Take the server's version and unblock.
   *
   * The only honest way out of a conflict: there is nothing to merge onto a
   * work package that has since changed, so this drops the draft and reloads.
   * `isEditing` is cleared *before* the refetch lands, because the re-seed
   * watcher deliberately skips a row it believes is being edited — leaving it
   * set would refresh the cache and keep showing the stale draft.
   */
  async function refreshFromServer(): Promise<void> {
    isRefreshing.value = true
    isEditing.value = false
    hasConflict.value = false
    saveError.value = null
    try {
      await cache.invalidateQueries({ key: ['work-packages'] })
      // Re-seed explicitly as well: when the refetched row is value-identical
      // the selection object never changes, so the watcher wouldn't fire and
      // the lock version would stay stale.
      seedFrom(selected.value)
    } finally {
      isRefreshing.value = false
    }
  }

  const principals = computed<Principal[]>(
    () => assigneesQuery.data.value?._embedded.elements ?? []
  )

  const statusOptions = computed<FieldOption[]>(() =>
    toFieldOptions(form.value?.status.allowedValues ?? [])
  )
  const typeOptions = computed<FieldOption[]>(() =>
    toFieldOptions(form.value?.type.allowedValues ?? [])
  )
  const priorityOptions = computed<FieldOption[]>(() =>
    toFieldOptions(form.value?.priority.allowedValues ?? [])
  )

  const assigneeOptions = computed<AssigneeOption[]>(() => {
    const link = selected.value?._links.assignee
    // Pin the current assignee so a former member — or a group, which this
    // editor can read but not write — still renders instead of showing blank.
    const current =
      snapshot.value.assigneeId === null
        ? null
        : { id: snapshot.value.assigneeId, title: link?.title ?? null }
    return toAssigneeOptions(principals.value, current)
  })

  /**
   * Per-field editability.
   *
   * The three enumerated fields need the form: with no allowed values there is
   * nothing to offer, so they are disabled with a reason. The free-form fields
   * do not — they need no server-supplied values — so a failed form leaves them
   * editable and OpenProject gets to refuse the write itself, with a message
   * worth more than any guess made here.
   */
  const fields = computed<Record<WorkPackageFieldName, EditableFieldState>>(() => {
    const loaded = form.value
    const failed = formError.value !== null

    const plain = (
      name: 'subject' | 'description' | 'startDate' | 'dueDate'
    ): EditableFieldState => {
      if (loaded && !loaded[name].writable) {
        return { disabled: true, reason: NOT_WRITABLE_REASON }
      }
      return { disabled: false, reason: null }
    }

    const enumerated = (
      name: 'status' | 'type' | 'priority',
      options: FieldOption[]
    ): EditableFieldState => {
      if (failed) return { disabled: true, reason: FORM_FAILED_REASON }
      if (!loaded) return { disabled: true, reason: null }
      if (!loaded[name].writable) {
        return { disabled: true, reason: NOT_WRITABLE_REASON }
      }
      if (options.length === 0) {
        return { disabled: true, reason: NO_ALLOWED_VALUES_REASON }
      }
      return { disabled: false, reason: null }
    }

    const assignee = ((): EditableFieldState => {
      if (projectId.value === null) {
        return { disabled: true, reason: NO_PROJECT_REASON }
      }
      if (assigneesError.value !== null) {
        return { disabled: true, reason: ASSIGNEES_FAILED_REASON }
      }
      if (loaded && !loaded.assignee.writable) {
        return { disabled: true, reason: NOT_WRITABLE_REASON }
      }
      return { disabled: false, reason: null }
    })()

    return {
      subject: plain('subject'),
      description: plain('description'),
      startDate: plain('startDate'),
      dueDate: plain('dueDate'),
      status: enumerated('status', statusOptions.value),
      type: enumerated('type', typeOptions.value),
      priority: enumerated('priority', priorityOptions.value),
      assignee
    }
  })

  // Dirty state

  const changes = computed(() => diffWorkPackageDraft(snapshot.value, draft.value))
  const isDirty = computed(() => hasWorkPackageChanges(changes.value))
  const draftIssue = computed(() => workPackageDraftIssue(draft.value))
  const canSave = computed(
    () => isDirty.value && draftIssue.value === null && !isSaving.value
  )

  function startEditing(): void {
    if (selected.value === null) return
    // Resuming clears the last verdict: a conflict notice that outlives the
    // refetch it triggered would report a state that no longer exists.
    hasConflict.value = false
    saveError.value = null
    isEditing.value = true
  }

  function cancelEditing(): void {
    seedFrom(selected.value)
    isEditing.value = false
    saveError.value = null
    hasConflict.value = false
  }

  // Saving

  const { mutateAsync: updateWorkPackage } = useUpdateWorkPackage()

  /**
   * Persist a partial update against the revision shown in the panel.
   *
   * Three outcomes, deliberately different:
   * - **Success** — the echoed work package replaces the selection, which
   *   re-seeds the snapshot *and* the lock version. Skipping that would make the
   *   next save conflict against this one.
   * - **409** — somebody else got there first. The edits are discarded and the
   *   panel returns to reading, because there is no honest way to replay them
   *   onto a work package that has since changed. The mutation invalidates the
   *   `['work-packages']` cache on this path, so the refetched row arrives and
   *   re-seeds through the ordinary watcher.
   * - **Anything else** — the edits stay exactly where they are, with the
   *   message shown. A 422 in particular is actionable ("that transition isn't
   *   allowed"), and throwing away the user's work would be the wrong response
   *   to a problem they can fix.
   *
   * A regular edit and the read view's quick status selector both use this
   * path. That keeps lock-version handling, cache invalidation, and conflict
   * recovery identical instead of growing a second mutation workflow in the
   * component.
   */
  async function persistChanges(
    patch: Omit<UpdateWorkPackageInput, 'id' | 'lockVersion'>
  ): Promise<void> {
    const workPackage = selected.value
    if (workPackage === null) return

    isSaving.value = true
    saveError.value = null
    hasConflict.value = false
    try {
      const updated = await updateWorkPackage({
        id: workPackage.id,
        // The revision the user actually edited — see `snapshotLockVersion`.
        lockVersion: snapshotLockVersion.value,
        ...patch
      })
      selected.value = updated
      seedFrom(updated)
      isEditing.value = false
    } catch (e) {
      const error = e as { code?: string; message?: string } | null
      if (error?.code === 'OPENPROJECT_CONFLICT') {
        hasConflict.value = true
        isEditing.value = false
        seedFrom(selected.value)
        return
      }
      saveError.value = error?.message || GENERIC_SAVE_ERROR
    } finally {
      isSaving.value = false
    }
  }

  /** Save all fields changed in the explicit edit form. */
  async function save(): Promise<void> {
    if (draftIssue.value !== null) return
    if (!hasWorkPackageChanges(changes.value)) {
      isEditing.value = false
      return
    }
    await persistChanges(changes.value)
  }

  /**
   * Change only the status from the detail view, without entering edit mode.
   *
   * The guards mirror the selector's disabled state, but live here as well so
   * the invariant survives another caller: only an allowed transition can be
   * sent, and a quick write cannot overlap an edit, another write, or conflict
   * recovery. The draft is not changed optimistically, so a rejected update
   * leaves the status on screen truthful to the selected server revision.
   */
  async function quickUpdateStatus(statusId: number): Promise<void> {
    if (selected.value === null) return
    if (isEditing.value || isSaving.value || isConflicted.value) return
    if (fields.value.status.disabled) return
    if (!statusOptions.value.some((option) => option.value === statusId)) return
    if (snapshot.value.statusId === statusId) return

    await persistChanges({ statusId })
  }

  return {
    // Draft state
    draft,
    isEditing,
    isDirty,
    changes,
    draftIssue,
    canSave,
    startEditing,
    cancelEditing,

    // Allowed values
    statusOptions,
    typeOptions,
    priorityOptions,
    assigneeOptions,
    fields,
    isFormLoading: computed(() => formQuery.isLoading.value),
    formError,
    assigneesError,

    // Saving
    save,
    quickUpdateStatus,
    isSaving,
    saveError,
    hasConflict,

    // Conflict recovery
    isConflicted,
    isRefreshing,
    refreshFromServer
  }
}
