import { computed, ref, watch, type Ref } from 'vue'
import { useQuery } from '@pinia/colada'
import type { Principal, WorkPackage } from '@opentracker/preload'

import { useStagedAttachments } from '@renderer/composables/useStagedAttachments'
import {
  useCreateWorkPackage,
  workPackageQueries
} from '@renderer/composables/queries/work-packages'
import { principalQueries } from '@renderer/composables/queries/principals'
import { projectQueries } from '@renderer/composables/queries/projects'
import type {
  EditableFieldState,
  WorkPackageFieldName
} from '@renderer/composables/useWorkPackageEditor'
import {
  emptyWorkPackageDraft,
  hasCreateDraftContent,
  resetProjectScopedFields,
  toAssigneeOptions,
  toCreateWorkPackageInput,
  toFieldOptions,
  toProjectOptions,
  workPackageCreateIssue,
  type AssigneeOption,
  type FieldOption,
  type WorkPackageDraft
} from '@renderer/utils/work-package-draft'

/**
 * Create state for the work-package detail pane.
 *
 * **Its own composable rather than a mode of `useWorkPackageEditor`**, and the
 * reason is that the editor's entire spine is absent here. That spine is a
 * snapshot plus a diff against it, a `lockVersion` that makes each save
 * conditional, a 409 path that discards edits and refetches, and a re-seed rule
 * keyed on row identity. A create has no prior revision to diff against, nothing
 * to conflict with, and no row to re-seed from — so folding the two together
 * would mean putting `if (mode === 'create')` through every one of those, in
 * exchange for sharing a `ref` or two.
 *
 * What the two genuinely share is already factored out and is reused verbatim:
 * the draft shape and its pure functions in `utils/work-package-draft.ts`, the
 * assignee query, and `WorkPackageFields.vue` itself — which is mounted here
 * against `emptyWorkPackageDraft()`, exactly as Stage 2 built it to be.
 *
 * **The project drives everything.** Type, status, priority and assignee are all
 * derived from the project, so changing it invalidates all four. That reset is
 * deliberately *not* a hand-written list of fields to clear: it goes through
 * `resetProjectScopedFields`, which names the fields to **keep** and rebuilds
 * the rest from empty. A field added to the draft later is therefore reset by
 * default rather than silently surviving — and a survivor is invisible, because
 * a live instance answers **200** to a form requested with a type the project
 * disallows, burying the objection in the response body (PLAN.md, "Verified API
 * shapes — Stage 3").
 *
 * It takes the selection **ref** and writes to it, like the editor: a successful
 * create has to become the selected work package, and the selection is the one
 * object the panel and the list row both read from.
 */

const NO_PROJECT_REASON = 'Choose a project first.'
const FORM_FAILED_REASON = 'The allowed values couldn’t be loaded.'
const NO_ALLOWED_VALUES_REASON = 'This project offers no value for this field.'
const NOT_WRITABLE_REASON = 'OpenProject doesn’t allow setting this field here.'
const ASSIGNEES_FAILED_REASON = 'The project’s members couldn’t be loaded.'
const NO_PROJECTS_REASON =
  'Your API key can’t create work packages in any project.'
const PROJECTS_FAILED_REASON = 'The list of projects couldn’t be loaded.'
const GENERIC_CREATE_ERROR = 'The work package couldn’t be created.'

export function useWorkPackageCreator(selected: Ref<WorkPackage | null>) {
  /** The values the panel binds to. Empty until something is typed. */
  const draft = ref<WorkPackageDraft>(emptyWorkPackageDraft())

  /**
   * The project the whole form hangs off — deliberately *not* a draft field.
   *
   * It is the input the other four are derived from, not one of them, and
   * keeping it out of the draft is what lets `resetProjectScopedFields` be a
   * total function over the draft without having to exempt anything.
   */
  const projectId = ref<number | null>(null)

  const isCreating = ref(false)
  const isSaving = ref(false)
  const createError = ref<string | null>(null)

  /**
   * Files picked before the work package exists.
   *
   * Owned here rather than by the panel because `create()` has to flush them:
   * OpenProject attaches to a container, so the upload can only happen once the
   * create has returned an id. Both create surfaces — the browse panel and the
   * calendar drawer — get it for free by mounting `StagedAttachmentsList`
   * against this.
   */
  const staging = useStagedAttachments()

  // Projects

  // Always live, not gated on create mode: the "New" action has to know whether
  // it can be offered at all before the user presses it.
  const projectsQuery = useQuery(projectQueries.list())

  const projectOptions = computed<FieldOption[]>(() =>
    toProjectOptions(projectsQuery.data.value?._embedded.elements ?? [])
  )

  /** True once the projects request has settled, either way. */
  const projectsSettled = computed(() => projectsQuery.status.value !== 'pending')

  /**
   * Why create can't be offered, or `null`.
   *
   * Two distinct facts, kept distinct: the request failed, or it succeeded and
   * this key may genuinely create nowhere. Collapsing them into one disabled
   * button with no explanation is what makes an instance-permission problem look
   * like a broken app.
   */
  const startBlockedReason = computed<string | null>(() => {
    if (!projectsSettled.value) return null
    if (projectsQuery.error.value !== null) return PROJECTS_FAILED_REASON
    if (projectOptions.value.length === 0) return NO_PROJECTS_REASON
    return null
  })

  const canStartCreating = computed(
    () => projectsSettled.value && startBlockedReason.value === null
  )

  // Allowed values for the chosen project

  // Two independent requests again, in parallel: the form knows which types and
  // statuses the project allows, the project knows its members. Either failing
  // leaves the other's select working.
  //
  // The form is keyed on the project alone. `typeId` exists on the query and on
  // the IPC method, for an instance whose status workflows differ per type — but
  // sending the form's *own* default type back to it would rekey the query that
  // produced it, blanking every select for a second round trip. See PLAN.md.
  const createFormQuery = useQuery(() => ({
    ...workPackageQueries.createForm({ projectId: projectId.value ?? 0 }),
    enabled: projectId.value !== null
  }))

  const assigneesQuery = useQuery(() => ({
    ...principalQueries.availableAssignees(projectId.value ?? 0),
    enabled: projectId.value !== null
  }))

  // Who the key belongs to, for the assignee default. Session-cached on one
  // stable key, so this costs a single request no matter how many creates.
  const currentUserQuery = useQuery(principalQueries.currentUser())
  const currentUser = computed(() => currentUserQuery.data.value)

  const form = computed(() => createFormQuery.data.value)
  const formError = computed(() =>
    projectId.value === null ? null : createFormQuery.error.value
  )
  const assigneesError = computed(() =>
    projectId.value === null ? null : assigneesQuery.error.value
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

  const principals = computed<Principal[]>(
    () => assigneesQuery.data.value?._embedded.elements ?? []
  )

  // No "current assignee" to pin, unlike the editor: nothing is assigned yet, so
  // the list is exactly "Unassigned" plus the project's assignable users.
  const assigneeOptions = computed<AssigneeOption[]>(() =>
    toAssigneeOptions(principals.value, null)
  )

  // The project → fields cascade

  /**
   * Changing the project invalidates every value derived from it — **now**, not
   * when the new form arrives.
   *
   * Synchronous on purpose. The form request for the new project is in flight
   * for a while, and a stale type left reachable in that window is one the user
   * can submit; the create then fails against a value the select was still
   * showing. Clearing first means the worst case is an empty select, which is
   * the truth while the answer is unknown.
   */
  watch(projectId, () => {
    draft.value = resetProjectScopedFields(draft.value)
    // A new project means a new assignee list, so the default is owed again.
    hasDefaultedAssignee.value = false
    defaultedAssigneeId.value = null
  })

  /**
   * Whether the assignee default has already been offered for the current
   * project.
   *
   * Needed because "unassigned" is a real choice, not an empty one. Without
   * this, a user who deliberately cleared the assignee would have themselves
   * put back the next time the options list settled — the one case where
   * re-applying a default is actively wrong rather than merely redundant.
   */
  const hasDefaultedAssignee = ref(false)

  /**
   * The assignee id this project actually defaulted in, or `null` if none was.
   *
   * Read by `hasCreateDraftContent` so being handed the default doesn't count
   * as unsaved content, while changing or clearing it does.
   */
  const defaultedAssigneeId = ref<number | null>(null)

  /**
   * Default the assignee to the current user, once the project's assignable
   * list says they are on it.
   *
   * Matched against `assigneeOptions` rather than trusted on its own: the key's
   * owner is not necessarily a member of every project they can create in, and
   * an id with no matching option renders a blank select the create would then
   * be refused for. Not being assignable is ordinary, so the fallback is
   * unassigned and silent.
   */
  watch(
    [assigneeOptions, currentUser, isCreating],
    ([options, me, creating]) => {
      if (!creating || hasDefaultedAssignee.value) return
      if (me === undefined || projectId.value === null) return
      if (options.length === 0) return
      hasDefaultedAssignee.value = true
      if (draft.value.assigneeId !== null) return
      if (!options.some((option) => option.value === me.id)) return
      draft.value.assigneeId = me.id
      defaultedAssigneeId.value = me.id
    },
    { immediate: true }
  )

  /**
   * Adopt OpenProject's own defaults for the required links, once the form says
   * what they are.
   *
   * Only into a field the user has not set — a default that overwrote a choice
   * would be a race the user loses by typing fast. And only when the form also
   * *allows* the value: a default missing from the allowed values would render
   * the select blank against an id it has no option for, and the create would be
   * refused for it.
   */
  watch(
    [() => form.value, isCreating],
    ([loaded, creating]) => {
      if (!creating || loaded === undefined || projectId.value === null) return
      const adopt = (
        key: 'typeId' | 'statusId' | 'priorityId',
        options: FieldOption[]
      ): void => {
        const value = loaded.defaults[key]
        if (value === null) return
        if (draft.value[key] !== null) return
        if (!options.some((option) => option.value === value)) return
        draft.value[key] = value
      }
      adopt('typeId', typeOptions.value)
      adopt('statusId', statusOptions.value)
      adopt('priorityId', priorityOptions.value)
    },
    { immediate: true }
  )

  // Per-field state

  /**
   * Per-field editability, in the shape `WorkPackageFields` takes.
   *
   * With no project chosen everything is disabled, but the reason is shown once,
   * on the type select — the field the form actually leads with. Repeating the
   * same sentence under all seven controls says nothing seven times.
   */
  const fields = computed<Record<WorkPackageFieldName, EditableFieldState>>(() => {
    const loaded = form.value
    const noProject = projectId.value === null
    const failed = formError.value !== null

    const plain = (
      name: 'subject' | 'description' | 'startDate' | 'dueDate'
    ): EditableFieldState => {
      if (noProject) return { disabled: true, reason: null }
      if (loaded && !loaded[name].writable) {
        return { disabled: true, reason: NOT_WRITABLE_REASON }
      }
      return { disabled: false, reason: null }
    }

    const enumerated = (
      name: 'status' | 'type' | 'priority',
      options: FieldOption[]
    ): EditableFieldState => {
      if (noProject) {
        return { disabled: true, reason: name === 'type' ? NO_PROJECT_REASON : null }
      }
      if (failed) return { disabled: true, reason: FORM_FAILED_REASON }
      if (!loaded) return { disabled: true, reason: null }
      if (!loaded[name].writable) return { disabled: true, reason: NOT_WRITABLE_REASON }
      if (options.length === 0) {
        return { disabled: true, reason: NO_ALLOWED_VALUES_REASON }
      }
      return { disabled: false, reason: null }
    }

    const assignee = ((): EditableFieldState => {
      if (noProject) return { disabled: true, reason: null }
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

  // Draft state

  const createIssue = computed(() =>
    workPackageCreateIssue(projectId.value, draft.value)
  )

  /**
   * Whether leaving would lose something.
   *
   * Named to match the editor's `isDirty`, because the browse screen consults
   * both through the same guard and a second name for one question is how the
   * two answers drift. `false` outside create mode: a cancelled draft is gone,
   * not merely hidden.
   */
  const isDirty = computed(
    () =>
      isCreating.value &&
      (hasCreateDraftContent(draft.value, defaultedAssigneeId.value) ||
        // Staged files are unsaved work too: leaving would discard them, and
        // the browse screen's guard is the only thing that asks first.
        staging.hasItems.value)
  )

  const canCreate = computed(
    () => createIssue.value === null && !isSaving.value
  )

  /**
   * Enter create mode.
   *
   * **Not the entry point for the UI.** This composable can see its own draft
   * but not the editor's, so it cannot know whether entering would eventually
   * cost the user unsaved edits — a completed create reassigns the selection,
   * which re-seeds the editor and takes its draft with it. That question belongs
   * to `useWorkPackagesBrowser`, which owns both halves; the New action goes
   * through its `requestCreate()`, and this is what that calls once the answer
   * is yes.
   *
   * Refuses when there is nowhere to create — the action is disabled in the UI
   * for the same reason, but a composable that only enforces its precondition in
   * a template is one refactor away from not enforcing it at all.
   *
   * Each create starts from a blank project — the form leads with "Choose a
   * project" rather than inheriting the selected row's project or the previous
   * create's. The two create surfaces (the browse screen's panel and the
   * calendar's drawer) then agree on what "new" means, and choosing the
   * project is the one decision everything else hangs off, so making it
   * explicit each time beats guessing it from context.
   */
  function startCreating(): void {
    if (!canStartCreating.value) return
    draft.value = emptyWorkPackageDraft()
    createError.value = null
    // A fresh draft is owed the assignee default again. Both default watchers
    // also key on `isCreating`, which is what makes them re-run against an
    // already-loaded form instead of waiting for data that won't change.
    hasDefaultedAssignee.value = false
    defaultedAssigneeId.value = null
    // Reset the project too: a create never inherits the project from the
    // selection or the previous create. Setting it before `isCreating` flips
    // means the `projectId` watcher's cascade runs against the empty draft.
    projectId.value = null
    // A fresh create starts with nothing staged; anything left from an
    // abandoned draft is released rather than silently attached to this one.
    void staging.clear()
    isCreating.value = true
  }

  /** Leave create mode, discarding the draft. */
  function cancelCreating(): void {
    isCreating.value = false
    draft.value = emptyWorkPackageDraft()
    createError.value = null
    // Releases the backend's hold on every staged path.
    void staging.clear()
  }

  // Creating

  const { mutateAsync: createWorkPackage } = useCreateWorkPackage()

  /**
   * Create the work package.
   *
   * Two outcomes, deliberately different:
   * - **Success** — the echoed work package becomes the selection, which is what
   *   puts it in the panel; the mutation invalidates the list so the row appears
   *   beside it. Create mode ends and the draft is cleared, because it has been
   *   turned into something real.
   * - **Failure** — the draft stays exactly where it is, with the message shown.
   *   A 422 in particular is actionable ("Team can't be blank"), and throwing
   *   away everything the user typed is the wrong answer to a problem they can
   *   fix in one field. Nothing was created, so there is nothing to reconcile.
   */
  async function create(): Promise<void> {
    const project = projectId.value
    const typeId = draft.value.typeId
    // Re-checked rather than trusted from `canCreate`: this is callable directly.
    if (project === null || typeId === null) return
    if (createIssue.value !== null) return

    isSaving.value = true
    createError.value = null
    try {
      const created = await createWorkPackage(
        toCreateWorkPackageInput(project, typeId, draft.value)
      )

      // Only now can the staged files be uploaded: OpenProject attaches to a
      // container, and this is the first moment there is one.
      //
      // A refused attachment does **not** unwind the create — the work package
      // exists, and dropping the selection to report a file problem would be
      // the wrong trade. Create mode ends either way and the message is shown
      // beside the new work package, whose attachments panel is now the honest
      // account of what landed.
      const attachmentError = await staging.uploadTo(created.id)

      selected.value = created
      isCreating.value = false
      draft.value = emptyWorkPackageDraft()
      createError.value = attachmentError
    } catch (e) {
      const error = e as { message?: string } | null
      createError.value = error?.message || GENERIC_CREATE_ERROR
    } finally {
      isSaving.value = false
    }
  }

  return {
    // Mode
    isCreating,
    canStartCreating,
    startBlockedReason,
    startCreating,
    cancelCreating,

    // Draft
    draft,
    projectId,
    isDirty,
    createIssue,
    canCreate,

    // Options
    projectOptions,
    statusOptions,
    typeOptions,
    priorityOptions,
    assigneeOptions,
    fields,
    isFormLoading: computed(() => createFormQuery.isLoading.value),
    formError,
    assigneesError,

    // Creating
    create,
    isSaving,
    createError,

    // Attachments staged for the work package this will create
    staging
  }
}
