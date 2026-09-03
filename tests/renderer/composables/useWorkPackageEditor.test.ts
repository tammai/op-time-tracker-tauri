import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createApp,
  effectScope,
  nextTick,
  ref,
  type App,
  type EffectScope,
  type Ref
} from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import type { WorkPackage } from '@opentracker/preload'

import { useWorkPackageEditor } from '@renderer/composables/useWorkPackageEditor'

/**
 * Harness for the work-package editor.
 *
 * Same shape as `useWorkPackagesBrowser.test.ts`: no component runner and no
 * DOM, so a bare app supplies the injection context and an `effectScope`
 * carries the effects — all Pinia Colada needs.
 *
 * What it covers is what no pure function can: that dirty state survives a
 * background refetch, that a conflict discards edits rather than retrying, that
 * a save re-seeds the snapshot *and* the lock version so the next save doesn't
 * conflict against itself, and that a failed form leaves the read view intact.
 */

function wp(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 42,
    _type: 'WorkPackage',
    lockVersion: 4,
    subject: 'Fix login bug',
    startDate: '2026-01-15',
    dueDate: '2026-01-22',
    _links: {
      self: { href: '/api/v3/work_packages/42' },
      type: { href: '/api/v3/types/1', title: 'Task' },
      status: { href: '/api/v3/statuses/3', title: 'In Progress' },
      project: { href: '/api/v3/projects/7', title: 'Backend' },
      priority: { href: '/api/v3/priorities/8', title: 'Normal' },
      assignee: { href: '/api/v3/users/11', title: 'Alice' }
    },
    ...overrides
  } as WorkPackage
}

const FORM = {
  subject: { writable: true },
  description: { writable: true },
  startDate: { writable: true },
  dueDate: { writable: true },
  assignee: { writable: true },
  status: {
    writable: true,
    allowedValues: [
      { id: 3, name: 'In Progress' },
      { id: 9, name: 'Closed' }
    ]
  },
  type: { writable: true, allowedValues: [{ id: 1, name: 'Task' }] },
  priority: {
    writable: true,
    allowedValues: [
      { id: 8, name: 'Normal' },
      { id: 9, name: 'High' }
    ]
  }
}

const ASSIGNEES = {
  _type: 'Collection',
  total: 2,
  count: 2,
  _embedded: {
    elements: [
      { id: 11, _type: 'User', name: 'Alice' },
      { id: 12, _type: 'User', name: 'Bob' }
    ]
  }
}

/** An IPC error as the bridge rejects with it. */
function ipcError(code: string, message = 'boom'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

let app: App
let scope: EffectScope
let getWorkPackageForm: ReturnType<typeof vi.fn>
let listAvailableAssignees: ReturnType<typeof vi.fn>
let updateWorkPackage: ReturnType<typeof vi.fn>

function mountEditor(selected: Ref<WorkPackage | null>) {
  let editor!: ReturnType<typeof useWorkPackageEditor>
  app.runWithContext(() => {
    scope.run(() => {
      editor = useWorkPackageEditor(selected)
    })
  })
  return editor
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

beforeEach(() => {
  getWorkPackageForm = vi.fn(() => Promise.resolve(FORM))
  listAvailableAssignees = vi.fn(() => Promise.resolve(ASSIGNEES))
  updateWorkPackage = vi.fn((input: { id: number; lockVersion: number }) =>
    Promise.resolve(wp({ lockVersion: input.lockVersion + 1 }))
  )

  vi.stubGlobal('window', {
    openproject: { getWorkPackageForm, listAvailableAssignees, updateWorkPackage }
  })

  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp({ render: () => null })
  app.use(pinia)
  app.use(PiniaColada, {})
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

describe('useWorkPackageEditor — seeding and dirty tracking', () => {
  it('seeds the draft from the selected work package', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    expect(editor.draft.value).toEqual({
      subject: 'Fix login bug',
      description: '',
      startDate: '2026-01-15',
      dueDate: '2026-01-22',
      statusId: 3,
      typeId: 1,
      priorityId: 8,
      assigneeId: 11
    })
    expect(editor.isDirty.value).toBe(false)
  })

  it('reports dirty only once a field actually differs', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()

    editor.draft.value.subject = 'Fix login bug'
    expect(editor.isDirty.value).toBe(false)

    editor.draft.value.subject = 'Renamed'
    expect(editor.isDirty.value).toBe(true)

    editor.draft.value.subject = 'Fix login bug'
    expect(editor.isDirty.value).toBe(false)
  })

  it('re-seeds when a different row is selected', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()

    selected.value = wp({ id: 43, subject: 'Another one', lockVersion: 1 })
    await flush()
    expect(editor.draft.value.subject).toBe('Another one')
    expect(editor.isDirty.value).toBe(false)
  })

  /**
   * The invariant a naive `watch(selected)` would break. The browse list
   * refetches on its own — on a manual refresh, and after any mutation — and
   * the browser adopts the fresher copy into the selection. If that re-seeded
   * the draft, a background refetch would silently erase what the user was
   * typing. The row identity is what governs a re-seed; a new lock version on
   * the *same* row is left for the save to discover as a 409.
   */
  it('does not discard in-progress edits when the same row refetches', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Half-typed edit'

    // The list refetched and someone else had bumped the work package.
    selected.value = wp({ lockVersion: 9, subject: 'Changed elsewhere' })
    await flush()

    expect(editor.draft.value.subject).toBe('Half-typed edit')
    expect(editor.isDirty.value).toBe(true)
  })

  it('re-seeds a refetched row while the panel is only reading', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()

    selected.value = wp({ lockVersion: 9, subject: 'Changed elsewhere' })
    await flush()
    expect(editor.draft.value.subject).toBe('Changed elsewhere')
  })

  it('cancelling discards the edits and leaves edit mode', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'

    editor.cancelEditing()
    expect(editor.isEditing.value).toBe(false)
    expect(editor.isDirty.value).toBe(false)
    expect(editor.draft.value.subject).toBe('Fix login bug')
  })

  it('clears itself when the selection goes away', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    editor.startEditing()

    selected.value = null
    await flush()
    expect(editor.isEditing.value).toBe(false)
    expect(editor.isDirty.value).toBe(false)
  })
})

describe('useWorkPackageEditor — allowed values', () => {
  it('asks for the form with the selected row’s id and lock version', async () => {
    mountEditor(ref(wp()))
    await flush()
    expect(getWorkPackageForm).toHaveBeenCalledWith({
      workPackageId: 42,
      lockVersion: 4
    })
  })

  it('scopes the assignee list to the work package’s project', async () => {
    mountEditor(ref(wp()))
    await flush()
    expect(listAvailableAssignees).toHaveBeenCalledWith({ projectId: 7 })
  })

  it('offers the three selects as plain label/value options', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    expect(editor.statusOptions.value).toEqual([
      { label: 'In Progress', value: 3 },
      { label: 'Closed', value: 9 }
    ])
    expect(editor.typeOptions.value).toEqual([{ label: 'Task', value: 1 }])
    expect(editor.assigneeOptions.value).toEqual([
      { label: 'Unassigned', value: null },
      { label: 'Alice', value: 11 },
      { label: 'Bob', value: 12 }
    ])
  })

  /**
   * The edge case the spec names: a failed form must not take the read view
   * with it. The panel still shows the work package; only the fields whose
   * values came from the form go dark, and they say why.
   */
  it('disables only the enumerated fields when the form request fails', async () => {
    getWorkPackageForm.mockRejectedValue(ipcError('OPENPROJECT_SERVER_ERROR'))
    const editor = mountEditor(ref(wp()))
    await flush()

    for (const field of ['status', 'type', 'priority'] as const) {
      expect(editor.fields.value[field].disabled).toBe(true)
      expect(editor.fields.value[field].reason).toBeTruthy()
    }
    // Nothing about these depends on the form's allowed values.
    for (const field of ['subject', 'startDate', 'dueDate'] as const) {
      expect(editor.fields.value[field].disabled).toBe(false)
    }
    // The read view is intact.
    expect(editor.draft.value.subject).toBe('Fix login bug')
  })

  it('disables only the assignee select when the assignee request fails', async () => {
    listAvailableAssignees.mockRejectedValue(ipcError('OPENPROJECT_SERVER_ERROR'))
    const editor = mountEditor(ref(wp()))
    await flush()

    expect(editor.fields.value.assignee.disabled).toBe(true)
    expect(editor.fields.value.assignee.reason).toBeTruthy()
    expect(editor.fields.value.status.disabled).toBe(false)
  })

  it('disables a field OpenProject reports as not writable, and says so', async () => {
    getWorkPackageForm.mockResolvedValue({
      ...FORM,
      startDate: { writable: false },
      dueDate: { writable: false }
    })
    const editor = mountEditor(ref(wp()))
    await flush()
    expect(editor.fields.value.startDate.disabled).toBe(true)
    expect(editor.fields.value.startDate.reason).toBeTruthy()
    expect(editor.fields.value.subject.disabled).toBe(false)
  })

  it('does not ask for assignees when the project link is unreadable', async () => {
    const noProject = wp({
      _links: { self: { href: '/api/v3/work_packages/42' }, assignee: {} }
    } as Partial<WorkPackage>)
    const editor = mountEditor(ref(noProject))
    await flush()
    expect(listAvailableAssignees).not.toHaveBeenCalled()
    expect(editor.fields.value.assignee.disabled).toBe(true)
  })
})

describe('useWorkPackageEditor — saving', () => {
  it('quick-updates only the status without entering edit mode', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    updateWorkPackage.mockResolvedValueOnce(
      wp({
        lockVersion: 5,
        _links: {
          ...wp()._links,
          status: { href: '/api/v3/statuses/9', title: 'Closed' }
        }
      })
    )

    await editor.quickUpdateStatus(9)
    await flush()

    expect(updateWorkPackage).toHaveBeenCalledWith({
      id: 42,
      lockVersion: 4,
      statusId: 9
    })
    expect(selected.value?._links.status?.title).toBe('Closed')
    expect(editor.draft.value.statusId).toBe(9)
    expect(editor.isEditing.value).toBe(false)
  })

  it('does not quick-update to a status the current workflow disallows', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()

    await editor.quickUpdateStatus(999)

    expect(updateWorkPackage).not.toHaveBeenCalled()
    expect(editor.draft.value.statusId).toBe(3)
  })

  it('sends only the changed fields, with the loaded lock version', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    editor.draft.value.dueDate = ''

    await editor.save()

    expect(updateWorkPackage).toHaveBeenCalledWith({
      id: 42,
      lockVersion: 4,
      subject: 'Renamed',
      dueDate: null
    })
  })

  /**
   * The silent-overwrite guard. The list refetches on its own, and the browser
   * adopts the fresher copy into the selection — so by the time Save is pressed
   * the selection may already carry the lock version *someone else's* write
   * produced. Sending that would make the conditional write succeed against a
   * revision the user never saw, quietly dropping the other person's change.
   * The lock version must therefore be the one the snapshot came from.
   */
  it('saves against the revision that was edited, not one a refetch delivered', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'

    // Somebody else wrote to the work package; the list refetched.
    selected.value = wp({ lockVersion: 9, subject: 'Their edit' })
    await flush()

    await editor.save()
    expect(updateWorkPackage).toHaveBeenCalledWith({
      id: 42,
      lockVersion: 4,
      subject: 'Renamed'
    })
  })

  it('does not call the bridge at all when nothing changed', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()

    await editor.save()
    expect(updateWorkPackage).not.toHaveBeenCalled()
    expect(editor.isEditing.value).toBe(false)
  })

  /**
   * Without this the *second* save conflicts against the first: the server
   * bumped the lock version, and a snapshot still holding the old one is
   * guaranteed to be refused.
   */
  it('re-seeds the selection, the snapshot and the lock version from the response', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockResolvedValueOnce(
      wp({ lockVersion: 5, subject: 'Renamed' })
    )

    await editor.save()
    await flush()

    expect(selected.value?.lockVersion).toBe(5)
    expect(selected.value?.subject).toBe('Renamed')
    expect(editor.isDirty.value).toBe(false)
    expect(editor.isEditing.value).toBe(false)

    // A second save now carries the *new* lock version.
    editor.startEditing()
    editor.draft.value.subject = 'Renamed again'
    await editor.save()
    expect(updateWorkPackage).toHaveBeenLastCalledWith({
      id: 42,
      lockVersion: 5,
      subject: 'Renamed again'
    })
  })

  it('refuses to save a draft the backend would reject', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = '   '

    expect(editor.canSave.value).toBe(false)
    await editor.save()
    expect(updateWorkPackage).not.toHaveBeenCalled()
    expect(editor.draftIssue.value).toBeTruthy()
  })

  it('on a conflict, discards the edits, leaves edit mode, and says so', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_CONFLICT'))

    await editor.save()

    expect(editor.hasConflict.value).toBe(true)
    expect(editor.isEditing.value).toBe(false)
    expect(editor.isDirty.value).toBe(false)
    expect(editor.draft.value.subject).toBe('Fix login bug')
    expect(editor.saveError.value).toBeNull()
  })

  it('adopts the server’s copy after a conflict once the refetch lands', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const editor = mountEditor(selected)
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_CONFLICT'))
    await editor.save()

    // The list refetch delivers what the other writer left behind.
    selected.value = wp({ lockVersion: 7, subject: 'Their edit' })
    await flush()
    expect(editor.draft.value.subject).toBe('Their edit')
    expect(editor.isDirty.value).toBe(false)
  })

  it('clears the conflict notice as soon as editing resumes', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_CONFLICT'))
    await editor.save()
    expect(editor.hasConflict.value).toBe(true)

    editor.startEditing()
    expect(editor.hasConflict.value).toBe(false)
  })

  it('surfaces OpenProject’s own message on a 422 and keeps the edits', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.statusId = 9
    updateWorkPackage.mockRejectedValueOnce(
      ipcError(
        'OPENPROJECT_VALIDATION_FAILED',
        'Status is not set to one of the allowed values.'
      )
    )

    await editor.save()

    expect(editor.saveError.value).toBe(
      'Status is not set to one of the allowed values.'
    )
    // The user's work survives a rejection they can act on.
    expect(editor.isEditing.value).toBe(true)
    expect(editor.draft.value.statusId).toBe(9)
  })

  it('falls back to a generic message when an error carries none', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockRejectedValueOnce({})

    await editor.save()
    expect(editor.saveError.value).toBeTruthy()
    expect(editor.isEditing.value).toBe(true)
  })

  it('clears a previous save error when the next save succeeds', async () => {
    const editor = mountEditor(ref(wp()))
    await flush()
    editor.startEditing()
    editor.draft.value.subject = 'Renamed'
    updateWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_SERVER_ERROR'))
    await editor.save()
    expect(editor.saveError.value).toBeTruthy()

    await editor.save()
    expect(editor.saveError.value).toBeNull()
  })
})
