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

import { useWorkPackageCreator } from '@renderer/composables/useWorkPackageCreator'

/**
 * Harness for the work-package creator — same shape as the editor's, since
 * neither has a component runner: a bare app supplies the injection context and
 * an `effectScope` carries the effects, which is all Pinia Colada needs.
 *
 * What it covers is the half no pure function can: that changing the project
 * actually resets the fields the new project re-derives *and* refetches both
 * lists, that the form's defaults are adopted without overwriting the user, that
 * a create selects what it made, and that a refused create keeps the draft.
 */

function wp(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 42,
    _type: 'WorkPackage',
    lockVersion: 4,
    subject: 'Fix login bug',
    startDate: null,
    dueDate: null,
    _links: {
      self: { href: '/api/v3/work_packages/42' },
      type: { href: '/api/v3/types/1', title: 'Task' },
      status: { href: '/api/v3/statuses/1', title: 'To Do' },
      project: { href: '/api/v3/projects/7', title: 'Backend' },
      priority: { href: '/api/v3/priorities/8', title: 'Normal' },
      assignee: { href: null }
    },
    ...overrides
  } as WorkPackage
}

const PROJECTS = {
  _type: 'Collection',
  total: 2,
  count: 2,
  _embedded: {
    elements: [
      { id: 7, _type: 'Project', name: 'Backend' },
      { id: 12, _type: 'Project', name: 'Design System' }
    ]
  }
}

const NO_PROJECTS = {
  _type: 'Collection',
  total: 0,
  count: 0,
  _embedded: { elements: [] }
}

/** The create form for project 7. */
const FORM_7 = {
  subject: { writable: true },
  description: { writable: true },
  startDate: { writable: true },
  dueDate: { writable: true },
  assignee: { writable: true },
  status: {
    writable: true,
    allowedValues: [
      { id: 1, name: 'To Do' },
      { id: 7, name: 'In progress' }
    ]
  },
  type: {
    writable: true,
    allowedValues: [
      { id: 1, name: 'Task' },
      { id: 5, name: 'Bug' }
    ]
  },
  priority: {
    writable: true,
    allowedValues: [
      { id: 8, name: 'Normal' },
      { id: 9, name: 'High' }
    ]
  },
  defaults: { typeId: 1, statusId: 1, priorityId: 8 }
}

/**
 * Project 12's form. Deliberately shares *no* type or status id with project
 * 7's — that is what makes a survived value visible rather than coincidentally
 * still valid.
 */
const FORM_12 = {
  ...FORM_7,
  status: { writable: true, allowedValues: [{ id: 30, name: 'Backlog' }] },
  type: { writable: true, allowedValues: [{ id: 20, name: 'Epic' }] },
  priority: { writable: true, allowedValues: [{ id: 40, name: 'Low' }] },
  defaults: { typeId: 20, statusId: 30, priorityId: 40 }
}

const ASSIGNEES_7 = {
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

const ASSIGNEES_12 = {
  _type: 'Collection',
  total: 1,
  count: 1,
  _embedded: { elements: [{ id: 21, _type: 'User', name: 'Carol' }] }
}

/** An IPC error as the bridge rejects with it. */
function ipcError(code: string, message = 'boom'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

let app: App
let scope: EffectScope
let listProjects: ReturnType<typeof vi.fn>
let getWorkPackageCreateForm: ReturnType<typeof vi.fn>
let listAvailableAssignees: ReturnType<typeof vi.fn>
let createWorkPackage: ReturnType<typeof vi.fn>
let getCurrentUser: ReturnType<typeof vi.fn>
let stageAttachmentFiles: ReturnType<typeof vi.fn>
let discardStagedAttachment: ReturnType<typeof vi.fn>
let uploadStagedAttachments: ReturnType<typeof vi.fn>

function mountCreator(selected: Ref<WorkPackage | null> = ref(null)) {
  let creator!: ReturnType<typeof useWorkPackageCreator>
  app.runWithContext(() => {
    scope.run(() => {
      creator = useWorkPackageCreator(selected)
    })
  })
  return creator
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

beforeEach(() => {
  listProjects = vi.fn(() => Promise.resolve(PROJECTS))
  getWorkPackageCreateForm = vi.fn((input: { projectId: number }) =>
    Promise.resolve(input.projectId === 12 ? FORM_12 : FORM_7)
  )
  listAvailableAssignees = vi.fn((input: { projectId: number }) =>
    Promise.resolve(input.projectId === 12 ? ASSIGNEES_12 : ASSIGNEES_7)
  )
  createWorkPackage = vi.fn(() =>
    Promise.resolve(wp({ id: 99, subject: 'Brand new', lockVersion: 0 }))
  )
  // Alice is assignable in project 7 and *not* in project 12 — so the same
  // identity exercises both halves of the default without a second fixture.
  getCurrentUser = vi.fn(() => Promise.resolve({ id: 11, _type: 'User', name: 'Alice' }))
  stageAttachmentFiles = vi.fn(() =>
    Promise.resolve([
      { token: 'staged-1', fileName: 'shot.png', fileSize: 2048, contentType: 'image/png' }
    ])
  )
  discardStagedAttachment = vi.fn(() => Promise.resolve())
  uploadStagedAttachments = vi.fn(() => Promise.resolve([]))

  vi.stubGlobal('window', {
    openproject: {
      listProjects,
      getWorkPackageCreateForm,
      listAvailableAssignees,
      createWorkPackage,
      getCurrentUser,
      stageAttachmentFiles,
      discardStagedAttachment,
      uploadStagedAttachments
    }
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

describe('useWorkPackageCreator — entering and leaving create mode', () => {
  it('is off until asked, and starts from an empty draft', async () => {
    const creator = mountCreator()
    await flush()
    expect(creator.isCreating.value).toBe(false)

    creator.startCreating()
    await flush()
    expect(creator.isCreating.value).toBe(true)
    expect(creator.draft.value.subject).toBe('')
    expect(creator.draft.value.description).toBe('')
  })

  /**
   * A new work package starts on a blank project — the form leads with
   * "Choose a project" — whether or not a row is selected, and regardless of
   * that row's project. The two create surfaces agree on this (the calendar
   * drawer resets the project too), and choosing the project is the one
   * decision everything else hangs off, so making it explicit each time beats
   * guessing it from context.
   */
  it('starts with no project selected, even when a work package is selected', async () => {
    const creator = mountCreator(ref(wp()))
    await flush()
    creator.startCreating()
    await flush()
    expect(creator.projectId.value).toBeNull()
  })

  it('starts with no project when the selection is in a non-creatable project', async () => {
    // No project is ever seeded from the selection now, so a selection whose
    // project isn't creatable is no longer a special case — but the assertion
    // stays to pin the edge.
    const creator = mountCreator(
      ref(wp({ _links: { ...wp()._links, project: { href: '/api/v3/projects/99' } } }))
    )
    await flush()
    creator.startCreating()
    await flush()
    expect(creator.projectId.value).toBeNull()
  })

  it('resets the project to blank on re-enter, carrying nothing over', async () => {
    const selected = ref<WorkPackage | null>(wp())
    const creator = mountCreator(selected)
    await flush()
    creator.startCreating()
    await flush()

    creator.projectId.value = 12
    await flush()
    creator.cancelCreating()
    creator.startCreating()
    await flush()
    expect(creator.projectId.value).toBeNull()
  })

  it('throws the draft away on cancel', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.draft.value.subject = 'Half-typed'
    creator.cancelCreating()
    await flush()

    expect(creator.isCreating.value).toBe(false)
    expect(creator.draft.value.subject).toBe('')
    expect(creator.isDirty.value).toBe(false)
  })
})

/**
 * The structural point of this stage. Every allowed-value list is
 * project-scoped, so a type, status, priority or assignee that survived a
 * project change is one the new project never offered — and the form endpoint
 * answers **200** for a type the project disallows, burying the objection in the
 * body, so nothing downstream catches it either.
 */
describe('useWorkPackageCreator — changing the project', () => {
  async function creatorInProject7() {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    return creator
  }

  it('resets type, status, priority and assignee', async () => {
    const creator = await creatorInProject7()
    creator.draft.value.typeId = 5
    creator.draft.value.statusId = 7
    creator.draft.value.priorityId = 9
    creator.draft.value.assigneeId = 11

    creator.projectId.value = 12
    // Synchronously, before any request can come back: a stale id must never be
    // reachable, not even for the moment the new form is in flight.
    await nextTick()
    expect(creator.draft.value.typeId).not.toBe(5)
    expect(creator.draft.value.statusId).not.toBe(7)
    expect(creator.draft.value.priorityId).not.toBe(9)
    expect(creator.draft.value.assigneeId).toBeNull()
  })

  it('keeps what the user typed — it means the same in any project', async () => {
    const creator = await creatorInProject7()
    creator.draft.value.subject = 'Still mine'
    creator.draft.value.description = 'And this'
    creator.draft.value.startDate = '2026-03-01'
    creator.draft.value.dueDate = '2026-03-14'

    creator.projectId.value = 12
    await flush()

    expect(creator.draft.value.subject).toBe('Still mine')
    expect(creator.draft.value.description).toBe('And this')
    expect(creator.draft.value.startDate).toBe('2026-03-01')
    expect(creator.draft.value.dueDate).toBe('2026-03-14')
  })

  it('refetches both the form and the project’s assignees', async () => {
    const creator = await creatorInProject7()
    expect(getWorkPackageCreateForm).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 7 })
    )
    expect(listAvailableAssignees).toHaveBeenCalledWith({ projectId: 7 })

    creator.projectId.value = 12
    await flush()

    expect(getWorkPackageCreateForm).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 12 })
    )
    expect(listAvailableAssignees).toHaveBeenCalledWith({ projectId: 12 })
  })

  it('offers only the new project’s values once the form lands', async () => {
    const creator = await creatorInProject7()
    expect(creator.typeOptions.value.map((o) => o.value)).toEqual([1, 5])
    expect(creator.assigneeOptions.value.map((o) => o.value)).toEqual([null, 11, 12])

    creator.projectId.value = 12
    await flush()

    expect(creator.typeOptions.value.map((o) => o.value)).toEqual([20])
    expect(creator.statusOptions.value.map((o) => o.value)).toEqual([30])
    expect(creator.assigneeOptions.value.map((o) => o.value)).toEqual([null, 21])
  })

  it('adopts the new project’s defaults, never the old project’s ids', async () => {
    const creator = await creatorInProject7()
    expect(creator.draft.value.typeId).toBe(1)

    creator.projectId.value = 12
    await flush()

    expect(creator.draft.value.typeId).toBe(20)
    expect(creator.draft.value.statusId).toBe(30)
    expect(creator.draft.value.priorityId).toBe(40)
  })
})

describe('useWorkPackageCreator — the form’s defaults', () => {
  it('prefills type, status and priority from what OpenProject would pick', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBe(1)
    expect(creator.draft.value.statusId).toBe(1)
    expect(creator.draft.value.priorityId).toBe(8)
  })

  it('never overwrites a choice the user already made', async () => {
    let landForm!: (form: unknown) => void
    getWorkPackageCreateForm.mockImplementation(
      () => new Promise((resolve) => (landForm = resolve))
    )
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    // Let the project change's own reset land first, then choose a type while
    // the form is still in flight — the window the user actually types in.
    await nextTick()
    creator.draft.value.typeId = 5
    landForm(FORM_7)
    await flush()

    expect(creator.draft.value.typeId).toBe(5)
    // The untouched fields still take their default.
    expect(creator.draft.value.statusId).toBe(1)
  })

  it('leaves a field unset when the form offers no default for it', async () => {
    getWorkPackageCreateForm.mockResolvedValue({
      ...FORM_7,
      defaults: { typeId: null, statusId: null, priorityId: null }
    })
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBeNull()
    expect(creator.createIssue.value).toMatch(/type/i)
  })

  /**
   * A default the allowed values don't contain is not a default we can use —
   * the select would render blank against an id it has no option for, and the
   * create would be refused.
   */
  it('ignores a default the form does not also allow', async () => {
    getWorkPackageCreateForm.mockResolvedValue({
      ...FORM_7,
      defaults: { typeId: 999, statusId: 1, priorityId: 8 }
    })
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBeNull()
    expect(creator.draft.value.statusId).toBe(1)
  })
})

describe('useWorkPackageCreator — what gates Create', () => {
  async function ready() {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    creator.draft.value.subject = 'Brand new'
    return creator
  }

  it('is blocked until a project, a type and a subject are all present', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    await flush()

    expect(creator.canCreate.value).toBe(false)
    expect(creator.createIssue.value).toMatch(/project/i)

    creator.projectId.value = 7
    await flush()
    expect(creator.canCreate.value).toBe(false)
    expect(creator.createIssue.value).toMatch(/subject/i)

    creator.draft.value.subject = 'Brand new'
    expect(creator.createIssue.value).toBeNull()
    expect(creator.canCreate.value).toBe(true)
  })

  it('reports the reason a bad draft cannot be sent', async () => {
    const creator = await ready()
    creator.draft.value.startDate = '2026-03-14'
    creator.draft.value.dueDate = '2026-03-01'
    expect(creator.createIssue.value).toMatch(/before the start date/i)
    expect(creator.canCreate.value).toBe(false)
  })

  it('refuses to send a draft it has already reported as invalid', async () => {
    const creator = await ready()
    creator.draft.value.subject = '   '
    await creator.create()
    expect(createWorkPackage).not.toHaveBeenCalled()
  })
})

describe('useWorkPackageCreator — creating', () => {
  async function ready(selected = ref<WorkPackage | null>(null)) {
    const creator = mountCreator(selected)
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    creator.draft.value.subject = 'Brand new'
    return { creator, selected }
  }

  it('sends the draft as ids, with no nulls', async () => {
    const { creator } = await ready()
    creator.draft.value.description = 'Body **text**'
    creator.draft.value.assigneeId = 11
    await creator.create()

    expect(createWorkPackage).toHaveBeenCalledWith({
      projectId: 7,
      typeId: 1,
      subject: 'Brand new',
      description: 'Body **text**',
      statusId: 1,
      priorityId: 8,
      assigneeId: 11
    })
  })

  it('selects the new work package and leaves create mode', async () => {
    const { creator, selected } = await ready()
    await creator.create()

    expect(selected.value?.id).toBe(99)
    expect(creator.isCreating.value).toBe(false)
    expect(creator.draft.value.subject).toBe('')
    expect(creator.isDirty.value).toBe(false)
  })

  /**
   * The 422 case. OpenProject refuses for a reason the create form could not
   * predict — a required custom field, a type the project stopped allowing —
   * and the user can act on it, so the draft is the last thing to throw away.
   */
  it('keeps the draft and shows OpenProject’s message when the create is refused', async () => {
    const { creator, selected } = await ready()
    creator.draft.value.description = 'Worth keeping'
    createWorkPackage.mockRejectedValueOnce(
      ipcError('OPENPROJECT_VALIDATION_FAILED', 'Team can’t be blank.')
    )

    await creator.create()

    expect(creator.createError.value).toBe('Team can’t be blank.')
    expect(creator.isCreating.value).toBe(true)
    expect(creator.draft.value.subject).toBe('Brand new')
    expect(creator.draft.value.description).toBe('Worth keeping')
    expect(selected.value).toBeNull()
  })

  it('falls back to a generic message when the failure carries none', async () => {
    const { creator } = await ready()
    createWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_UNKNOWN', ''))
    await creator.create()
    expect(creator.createError.value).toBeTruthy()
    expect(creator.isCreating.value).toBe(true)
  })

  it('clears a previous failure when the next attempt succeeds', async () => {
    const { creator } = await ready()
    createWorkPackage.mockRejectedValueOnce(ipcError('OPENPROJECT_VALIDATION_FAILED', 'no'))
    await creator.create()
    expect(creator.createError.value).toBe('no')

    await creator.create()
    expect(creator.createError.value).toBeNull()
  })
})

/**
 * What the browse screen consults before it lets the user walk away.
 */
describe('useWorkPackageCreator — unsaved content', () => {
  it('is not dirty merely because the form filled its own defaults in', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBe(1)
    expect(creator.isDirty.value).toBe(false)
  })

  it('is dirty once the user has entered something', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.draft.value.subject = 'Typed'
    expect(creator.isDirty.value).toBe(true)
  })

  it('is never dirty while create mode is off', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.draft.value.subject = 'Typed'
    creator.cancelCreating()
    expect(creator.isDirty.value).toBe(false)
  })
})

describe('useWorkPackageCreator — a key that may create nowhere', () => {
  it('refuses to start, with a reason', async () => {
    listProjects.mockResolvedValue(NO_PROJECTS)
    const creator = mountCreator()
    await flush()

    expect(creator.canStartCreating.value).toBe(false)
    expect(creator.startBlockedReason.value).toMatch(/project/i)

    creator.startCreating()
    expect(creator.isCreating.value).toBe(false)
  })

  it('refuses to start when the projects request failed, and says so', async () => {
    listProjects.mockRejectedValue(ipcError('OPENPROJECT_SERVER_ERROR', 'down'))
    const creator = mountCreator()
    await flush()

    expect(creator.canStartCreating.value).toBe(false)
    expect(creator.startBlockedReason.value).toBeTruthy()
  })

  it('allows it once at least one project comes back', async () => {
    const creator = mountCreator()
    await flush()
    expect(creator.canStartCreating.value).toBe(true)
    expect(creator.startBlockedReason.value).toBeNull()
    expect(creator.projectOptions.value).toEqual([
      { label: 'Backend', value: 7 },
      { label: 'Design System', value: 12 }
    ])
  })
})

describe('useWorkPackageCreator — per-field state', () => {
  it('disables every field until a project is chosen, and says why once', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    await flush()

    for (const name of ['subject', 'type', 'status', 'assignee'] as const) {
      expect(creator.fields.value[name].disabled).toBe(true)
    }
    // One reason, on the field that leads the form — not the same sentence
    // repeated under all seven controls.
    expect(creator.fields.value.type.reason).toMatch(/project/i)
    expect(creator.fields.value.subject.reason).toBeNull()
  })

  it('opens the fields the form reports writable', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    for (const name of [
      'subject',
      'description',
      'startDate',
      'dueDate',
      'type',
      'status',
      'priority',
      'assignee'
    ] as const) {
      expect(creator.fields.value[name].disabled).toBe(false)
    }
  })

  /**
   * A failed form takes the three selects down with it — there is nothing legal
   * to offer — while the free-text fields stay live, exactly as in edit mode.
   */
  it('disables the enumerated fields with a reason when the form fails', async () => {
    getWorkPackageCreateForm.mockRejectedValue(ipcError('OPENPROJECT_SERVER_ERROR'))
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.fields.value.type.disabled).toBe(true)
    expect(creator.fields.value.type.reason).toBeTruthy()
    expect(creator.fields.value.subject.disabled).toBe(false)
  })

  it('disables only the assignee when its own request fails', async () => {
    listAvailableAssignees.mockRejectedValue(ipcError('OPENPROJECT_SERVER_ERROR'))
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.fields.value.assignee.disabled).toBe(true)
    expect(creator.fields.value.assignee.reason).toBeTruthy()
    expect(creator.fields.value.type.disabled).toBe(false)
  })
})

describe('useWorkPackageCreator — defaulting the assignee to the current user', () => {
  it('assigns the current user once the project says they are assignable', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.assigneeId).toBe(11)
  })

  it('leaves it unassigned when the current user is not on that project', async () => {
    // Project 12's assignable list is Carol alone. Not being a member is
    // ordinary, so the fallback is silent rather than an error.
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 12
    await flush()

    expect(creator.draft.value.assigneeId).toBeNull()
  })

  it('never overwrites an assignee the user picked', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    creator.draft.value.assigneeId = 12
    await flush()

    expect(creator.draft.value.assigneeId).toBe(12)
  })

  it('counts changing the assignee as unsaved content, but not being handed it', async () => {
    // The default arrives without the user doing anything, so it must not raise
    // the unsaved-changes confirm; picking someone else is real input and must.
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    expect(creator.draft.value.assigneeId).toBe(11)
    expect(creator.isDirty.value).toBe(false)

    creator.draft.value.assigneeId = 12
    await flush()
    expect(creator.isDirty.value).toBe(true)
  })

  it('counts clearing the defaulted assignee as unsaved content', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    creator.draft.value.assigneeId = null
    await flush()
    expect(creator.isDirty.value).toBe(true)
  })

  it('does not put itself back after the user clears it', async () => {
    // "Unassigned" is a real choice, not an empty one — re-applying the default
    // over it is the one case where a default is actively wrong.
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    expect(creator.draft.value.assigneeId).toBe(11)

    creator.draft.value.assigneeId = null
    await flush()

    expect(creator.draft.value.assigneeId).toBeNull()
  })

  it('offers the default again after the project changes', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 12
    await flush()
    expect(creator.draft.value.assigneeId).toBeNull()

    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.assigneeId).toBe(11)
  })

  it('asks who the user is exactly once, however many projects are visited', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    creator.projectId.value = 12
    await flush()
    creator.projectId.value = 7
    await flush()

    expect(getCurrentUser).toHaveBeenCalledTimes(1)
  })

  it('creates without an assignee when the identity request fails', async () => {
    getCurrentUser.mockRejectedValueOnce(ipcError('OPENPROJECT_AUTH_FAILED'))
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    // A failed identity lookup must not block creating — it only costs the
    // convenience of the default.
    expect(creator.draft.value.assigneeId).toBeNull()
    expect(creator.createError.value).toBeNull()
  })
})

describe('useWorkPackageCreator — defaults on entering create mode', () => {
  /**
   * The regression this guards: both defaults used to key only on their data
   * changing. Entering create against a project whose form was already loaded
   * produced no change, so a fresh draft got nothing — the defaults appeared
   * only once the user changed project, which is the opposite of a default.
   */
  it('fills the defaults on a second create in the same project', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    expect(creator.draft.value.typeId).toBe(1)
    expect(creator.draft.value.assigneeId).toBe(11)

    // Leave and come back. The project resets to blank on re-enter, so it is
    // picked again — the form query for project 7 is cached, so `form.value`
    // never changes, which is exactly what makes the
    // defaults-only-on-data-change regression reappear without the `isCreating`
    // keying.
    creator.cancelCreating()
    await flush()
    expect(creator.draft.value.typeId).toBeNull()

    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBe(1)
    expect(creator.draft.value.statusId).toBe(1)
    expect(creator.draft.value.priorityId).toBe(8)
    expect(creator.draft.value.assigneeId).toBe(11)
  })

  it('fills the defaults once a project is chosen, seeding nothing from the selected row', async () => {
    const creator = mountCreator(ref(wp()))
    await flush()

    creator.startCreating()
    await flush()
    // No project is seeded from the selected work package any more.
    expect(creator.projectId.value).toBeNull()

    creator.projectId.value = 7
    await flush()

    expect(creator.draft.value.typeId).toBe(1)
    expect(creator.draft.value.assigneeId).toBe(11)
  })

  it('does not fill anything while create mode is closed', async () => {
    // The watchers are gated on `isCreating`, so a form loaded for some other
    // reason can't quietly seed a draft nobody is editing.
    const creator = mountCreator()
    await flush()
    creator.projectId.value = 7
    await flush()

    expect(creator.isCreating.value).toBe(false)
    expect(creator.draft.value.typeId).toBeNull()
    expect(creator.draft.value.assigneeId).toBeNull()
  })
})

describe('useWorkPackageCreator — files staged before the work package exists', () => {
  /** Get a creator in create mode on project 7, with one file staged. */
  async function withStagedFile() {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    await creator.staging.add()
    await flush()
    return creator
  }

  it('stages a file without uploading anything', async () => {
    const creator = await withStagedFile()

    expect(creator.staging.items.value).toHaveLength(1)
    expect(creator.staging.items.value[0]?.fileName).toBe('shot.png')
    // Nothing is uploaded until there is a work package to attach to.
    expect(uploadStagedAttachments).not.toHaveBeenCalled()
    expect(createWorkPackage).not.toHaveBeenCalled()
  })

  it('counts staged files as unsaved work', async () => {
    const creator = await withStagedFile()

    // The subject is still empty, so the *only* reason this is dirty is the
    // staged file — and the browse screen's guard is what asks before losing it.
    expect(creator.draft.value.subject).toBe('')
    expect(creator.isDirty.value).toBe(true)
  })

  it('uploads the staged files once the work package exists', async () => {
    const creator = await withStagedFile()
    creator.draft.value.subject = 'Brand new'
    await flush()

    await creator.create()
    await flush()

    expect(createWorkPackage).toHaveBeenCalledTimes(1)
    // Against the id the create returned, not anything the form held.
    expect(uploadStagedAttachments).toHaveBeenCalledWith({
      workPackageId: 99,
      tokens: ['staged-1']
    })
    expect(creator.staging.items.value).toHaveLength(0)
    expect(creator.createError.value).toBeNull()
  })

  it('keeps the created work package when its files are refused', async () => {
    uploadStagedAttachments = vi.fn(() =>
      Promise.reject(ipcError('OPENPROJECT_VALIDATION_FAILED', 'File is too large'))
    )
    window.openproject.uploadStagedAttachments = uploadStagedAttachments

    const creator = await withStagedFile()
    creator.draft.value.subject = 'Brand new'
    await flush()

    await creator.create()
    await flush()

    // The work package exists — unwinding the selection to report a file
    // problem would be the wrong trade.
    expect(creator.isCreating.value).toBe(false)
    expect(creator.createError.value).toContain('File is too large')
    // The staged list is dropped either way: the new work package's own
    // attachments panel is now the honest account of what landed.
    expect(creator.staging.items.value).toHaveLength(0)
  })

  it('does not upload anything when nothing was staged', async () => {
    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    creator.draft.value.subject = 'No files'
    await flush()

    await creator.create()
    await flush()

    expect(createWorkPackage).toHaveBeenCalledTimes(1)
    expect(uploadStagedAttachments).not.toHaveBeenCalled()
  })

  it('releases staged files when the draft is cancelled', async () => {
    const creator = await withStagedFile()

    creator.cancelCreating()
    await flush()

    expect(creator.staging.items.value).toHaveLength(0)
    // The backend is told, so it stops holding the path for the session.
    expect(discardStagedAttachment).toHaveBeenCalledWith({ token: 'staged-1' })
  })

  it('removes one staged file on request', async () => {
    const creator = await withStagedFile()

    await creator.staging.remove('staged-1')
    await flush()

    expect(creator.staging.items.value).toHaveLength(0)
    expect(discardStagedAttachment).toHaveBeenCalledWith({ token: 'staged-1' })
  })

  it('reports a refused pick without unwinding the draft', async () => {
    stageAttachmentFiles = vi.fn(() =>
      Promise.reject(ipcError('OPENPROJECT_INVALID_INPUT', '“huge.iso” is larger than the 64 MB'))
    )
    window.openproject.stageAttachmentFiles = stageAttachmentFiles

    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()
    creator.draft.value.subject = 'Keep me'

    await creator.staging.add()
    await flush()

    expect(creator.staging.error.value).toContain('64 MB')
    expect(creator.staging.items.value).toHaveLength(0)
    // A rejected file pick is not a reason to lose what was typed.
    expect(creator.draft.value.subject).toBe('Keep me')
    expect(creator.isCreating.value).toBe(true)
  })

  it('treats a cancelled picker as nothing, not as an error', async () => {
    stageAttachmentFiles = vi.fn(() => Promise.resolve([]))
    window.openproject.stageAttachmentFiles = stageAttachmentFiles

    const creator = mountCreator()
    await flush()
    creator.startCreating()
    creator.projectId.value = 7
    await flush()

    await creator.staging.add()
    await flush()

    expect(creator.staging.items.value).toHaveLength(0)
    expect(creator.staging.error.value).toBeNull()
  })
})
