import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, effectScope, nextTick, type App, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'

import {
  STATUS_FILTER_ALL,
  STATUS_FILTER_OPEN,
  useWorkPackagesBrowser
} from '@renderer/composables/useWorkPackagesBrowser'

/**
 * Harness for the browse screen's state composable.
 *
 * Same shape as `useWorkPackagePicker.test.ts`: no component runner and no DOM,
 * so a bare app supplies the injection context (`app.runWithContext`) and an
 * `effectScope` carries the effects. That is all Pinia Colada needs.
 *
 * What it buys is the coverage no pure util can reach — which filters actually
 * reach the bridge, the statuses-failure fallback, and the invariant that the
 * selection outlives the list it was chosen from.
 */

/** A work package as the bridge returns it. */
function wp(id: number, subject: string, status = 'In Progress', lockVersion = 1) {
  return {
    id,
    _type: 'WorkPackage' as const,
    // Required since stage 2: every save is conditional on it.
    lockVersion,
    subject,
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: '/api/v3/statuses/1', title: status },
      // The schema defaults this to `{}`, so a parsed work package always has
      // the key — an unassigned one included. Present here so the fixture is
      // assignable to `WorkPackage` where `select()` takes one.
      assignee: {}
    }
  }
}

function collection(elements: ReturnType<typeof wp>[], total = elements.length) {
  return {
    _type: 'WorkPackageCollection',
    total,
    count: elements.length,
    _embedded: { elements }
  }
}

/** The instance's statuses. `In Progress` = 1, `To Do` = 2, `Closed` = 9. */
const STATUSES = {
  _type: 'Collection',
  total: 3,
  count: 3,
  _embedded: {
    elements: [
      { id: 1, _type: 'Status', name: 'In Progress', isClosed: false },
      { id: 2, _type: 'Status', name: 'To Do', isClosed: false },
      { id: 9, _type: 'Status', name: 'Closed', isClosed: true }
    ]
  }
}

const MINE = [
  wp(101, 'Auth: fix login redirect'),
  wp(102, 'Billing: invoice PDF export', 'To Do')
]

let app: App
let scope: EffectScope
let listWorkPackages: ReturnType<typeof vi.fn>
let listStatuses: ReturnType<typeof vi.fn>
let openWorkPackageInBrowser: ReturnType<typeof vi.fn>
let listProjects: ReturnType<typeof vi.fn>
let getWorkPackageCreateForm: ReturnType<typeof vi.fn>
let listAvailableAssignees: ReturnType<typeof vi.fn>
let createWorkPackage: ReturnType<typeof vi.fn>
let getWorkPackageForm: ReturnType<typeof vi.fn>

/** The create form for the one project the harness offers. */
const CREATE_FORM = {
  subject: { writable: true },
  description: { writable: true },
  startDate: { writable: true },
  dueDate: { writable: true },
  assignee: { writable: true },
  status: { writable: true, allowedValues: [{ id: 1, name: 'To Do' }] },
  type: { writable: true, allowedValues: [{ id: 1, name: 'Task' }] },
  priority: { writable: true, allowedValues: [{ id: 8, name: 'Normal' }] },
  defaults: { typeId: 1, statusId: 1, priorityId: 8 }
}

/** The `filters` object of every `listWorkPackages` call, in order. */
function listCalls(): Array<Record<string, unknown>> {
  return listWorkPackages.mock.calls.map(
    (c) =>
      (c[0] as { filters?: Record<string, unknown> } | undefined)?.filters ?? {}
  )
}

/** Every call that carried a search term. */
function searchCalls(): string[] {
  return listCalls()
    .map((f) => f.search)
    .filter((s): s is string => typeof s === 'string')
}

function mountBrowser(into: EffectScope = scope) {
  let browser!: ReturnType<typeof useWorkPackagesBrowser>
  app.runWithContext(() => {
    into.run(() => {
      browser = useWorkPackagesBrowser()
    })
  })
  return browser
}

/** Let queries resolve without advancing the debounce clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()

  listWorkPackages = vi.fn((input?: { filters?: { search?: string } }) => {
    const search = input?.filters?.search
    if (search === undefined) return Promise.resolve(collection(MINE))
    return Promise.resolve(collection([wp(900, `Server hit for ${search}`)], 12))
  })
  listStatuses = vi.fn(() => Promise.resolve(STATUSES))
  openWorkPackageInBrowser = vi.fn(() => Promise.resolve())
  listProjects = vi.fn(() =>
    Promise.resolve({
      _type: 'Collection',
      total: 1,
      count: 1,
      _embedded: { elements: [{ id: 7, _type: 'Project', name: 'Backend' }] }
    })
  )
  getWorkPackageCreateForm = vi.fn(() => Promise.resolve(CREATE_FORM))
  getWorkPackageForm = vi.fn(() => Promise.resolve(CREATE_FORM))
  listAvailableAssignees = vi.fn(() =>
    Promise.resolve({
      _type: 'Collection',
      total: 1,
      count: 1,
      _embedded: { elements: [{ id: 11, _type: 'User', name: 'Alice' }] }
    })
  )
  createWorkPackage = vi.fn(() => Promise.resolve(wp(500, 'Brand new')))

  vi.stubGlobal('window', {
    openproject: {
      listWorkPackages,
      listStatuses,
      openWorkPackageInBrowser,
      listProjects,
      getWorkPackageCreateForm,
      getWorkPackageForm,
      listAvailableAssignees,
      createWorkPackage
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
  vi.useRealTimers()
})

describe('useWorkPackagesBrowser — the default scope', () => {
  it('asks for the user’s own work packages, narrowed to the resolved open status IDs', async () => {
    const browser = mountBrowser()
    await flush()

    // The whole point of resolving titles first: OpenProject's `status` filter
    // `=` operator rejects titles with HTTP 400, so IDs are what get sent.
    const withIds = listCalls().filter((f) => f.statuses !== undefined)
    expect(withIds.length).toBeGreaterThan(0)
    expect(withIds.at(-1)).toMatchObject({
      onlyMine: true,
      statuses: ['1', '2']
    })
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101, 102])
  })

  it('never sends a status filter before the statuses have settled', async () => {
    mountBrowser()
    await flush()

    // A request fired before resolution would fetch the wrong slice and be
    // immediately superseded — so no call may carry an empty status list.
    for (const filters of listCalls()) {
      expect(filters.statuses).not.toEqual([])
    }
  })
})

describe('useWorkPackagesBrowser — the statuses query fails', () => {
  beforeEach(() => {
    listStatuses = vi.fn(() => Promise.reject(new Error('statuses unavailable')))
    vi.stubGlobal('window', {
      openproject: { listWorkPackages, listStatuses, openWorkPackageInBrowser }
    })
  })

  it('drops the server-side status filter and narrows client-side instead', async () => {
    const browser = mountBrowser()
    await flush()

    // No IDs resolved → the filter must be omitted entirely rather than sent
    // empty (or, worse, sent as titles).
    expect(listCalls().every((f) => f.statuses === undefined)).toBe(true)
    // The list still arrives, narrowed by `isPriorityWorkPackage`.
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101, 102])
    expect(browser.isStatusFilterDegraded.value).toBe(true)
  })

  it('still shows the list when the client-side narrowing matches nothing', async () => {
    // An instance that uses neither "In Progress" nor "To Do" resolves no IDs
    // *and* matches no titles. Showing an empty list there is indistinguishable
    // from "you have no work packages", which would be a lie.
    listWorkPackages.mockImplementation(() =>
      Promise.resolve(collection([wp(201, 'Ops: rotate certs', 'Scheduled')]))
    )

    const browser = mountBrowser()
    await flush()

    expect(browser.workPackages.value.map((w) => w.id)).toEqual([201])
    expect(browser.isStatusFilterDegraded.value).toBe(true)
  })
})

describe('useWorkPackagesBrowser — the status filter', () => {
  it('sends the chosen status id on its own', async () => {
    const browser = mountBrowser()
    await flush()

    browser.statusFilter.value = '9'
    await flush()

    expect(listCalls().at(-1)).toMatchObject({ onlyMine: true, statuses: ['9'] })
  })

  it('drops the status filter entirely for "all"', async () => {
    const browser = mountBrowser()
    await flush()

    browser.statusFilter.value = STATUS_FILTER_ALL
    await flush()

    const last = listCalls().at(-1)!
    expect(last.onlyMine).toBe(true)
    expect(last.statuses).toBeUndefined()
  })

  it('offers the instance’s statuses alongside the two sentinels', async () => {
    const browser = mountBrowser()
    await flush()

    const values = browser.statusFilterOptions.value.map((o) => o.value)
    expect(values.slice(0, 2)).toEqual([STATUS_FILTER_OPEN, STATUS_FILTER_ALL])
    expect(values).toContain('9')
    const closed = browser.statusFilterOptions.value.find((o) => o.value === '9')
    expect(closed?.label).toBe('Closed')
  })
})

describe('useWorkPackagesBrowser — search', () => {
  it('answers a term the loaded list matches without any request', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'login'
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    expect(searchCalls()).toEqual([])
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101])
  })

  it('escapes the mine/open narrowing for a term nothing local matched', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'payment gateway'
    await flush()
    expect(searchCalls()).toEqual([])

    await vi.advanceTimersByTimeAsync(300)
    await flush()

    expect(searchCalls()).toEqual(['payment gateway'])
    // The search deliberately carries no assignee/status narrowing — reaching
    // items outside the user's own open set is the entire point.
    const searchCall = listCalls().find((f) => f.search !== undefined)!
    expect(searchCall.onlyMine).toBeUndefined()
    expect(searchCall.statuses).toBeUndefined()
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([900])
  })

  it('says "keep typing" for a term below the minimum, and asks nothing', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'z'
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    expect(searchCalls()).toEqual([])
    // Distinct from "no work packages match": claiming that would be a
    // statement about the whole instance, for a search never performed.
    expect(browser.isTermTooShort.value).toBe(true)
    expect(browser.workPackages.value).toEqual([])
  })

  it('coalesces keystrokes into one request for the final term', async () => {
    const browser = mountBrowser()
    await flush()

    for (const term of ['p', 'pa', 'pay', 'paym']) {
      browser.searchTerm.value = term
      await flush()
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(300)
    await flush()

    expect(searchCalls()).toEqual(['paym'])
  })

  it('strips control characters from the box', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'pay ment\n'
    await flush()

    expect(browser.searchTerm.value).toBe('payment')
  })

  it('restores the full list when the term is cleared', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'login'
    await flush()
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101])

    browser.resetSearch()
    await flush()

    expect(browser.searchTerm.value).toBe('')
    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101, 102])
  })
})

describe('useWorkPackagesBrowser — truncation', () => {
  it('reports the server total when it exceeds the page that was loaded', async () => {
    listWorkPackages.mockImplementation(() =>
      Promise.resolve(collection(MINE, 250))
    )

    const browser = mountBrowser()
    await flush()

    expect(browser.isTruncated.value).toBe(true)
    expect(browser.totalCount.value).toBe(250)
    expect(browser.shownCount.value).toBe(2)
  })

  it('reports no truncation when the whole set fits', async () => {
    const browser = mountBrowser()
    await flush()

    expect(browser.isTruncated.value).toBe(false)
  })

  it('reports truncation of a search result too', async () => {
    const browser = mountBrowser()
    await flush()

    browser.searchTerm.value = 'payment gateway'
    await flush()
    await vi.advanceTimersByTimeAsync(300)
    await flush()

    // The stubbed search answers with 1 of 12.
    expect(browser.isTruncated.value).toBe(true)
    expect(browser.totalCount.value).toBe(12)
    expect(browser.shownCount.value).toBe(1)
  })
})

describe('useWorkPackagesBrowser — selection', () => {
  it('selects the first row so the detail panel is never blank on arrival', async () => {
    const browser = mountBrowser()
    await flush()

    expect(browser.selectedWorkPackage.value?.id).toBe(101)
  })

  it('keeps the selection when it leaves the visible list', async () => {
    // The panel holds the object, not an id looked up in the current list —
    // otherwise searching would blank the panel out from under the user.
    const browser = mountBrowser()
    await flush()

    browser.select(MINE[1])
    expect(browser.selectedWorkPackage.value?.id).toBe(102)

    browser.searchTerm.value = 'login'
    await flush()

    expect(browser.workPackages.value.map((w) => w.id)).toEqual([101])
    expect(browser.selectedWorkPackage.value?.id).toBe(102)
  })

  it('refreshes the held object when the same work package comes back changed', async () => {
    const browser = mountBrowser()
    await flush()
    expect(browser.selectedWorkPackage.value?.subject).toBe(
      'Auth: fix login redirect'
    )

    // A refetch returning an edited subject must update the panel — the
    // selection survives *and* stays current. Stage 2's PATCH depends on this.
    listWorkPackages.mockImplementation(() =>
      Promise.resolve(collection([wp(101, 'Auth: fix login redirect (v2)'), MINE[1]]))
    )
    await browser.refetch()
    await flush()

    expect(browser.selectedWorkPackage.value?.id).toBe(101)
    expect(browser.selectedWorkPackage.value?.subject).toBe(
      'Auth: fix login redirect (v2)'
    )
  })
})

describe('useWorkPackagesBrowser — unsaved edits', () => {
  /**
   * Put the editor into the one state the whole state machine exists for: the
   * user has typed something that is not on the server. Returns the browser so
   * the caller can drive it.
   */
  async function withUnsavedEdits(): Promise<
    ReturnType<typeof useWorkPackagesBrowser>
  > {
    const browser = mountBrowser()
    await flush()
    expect(browser.selectedWorkPackage.value?.id).toBe(101)

    browser.editor.startEditing()
    browser.editor.draft.value.subject = 'Auth: fix login redirect (edited)'
    await flush()
    expect(browser.editor.isDirty.value).toBe(true)
    return browser
  }

  it('refuses to switch rows while edits are unsaved, and remembers the row that was wanted', async () => {
    const browser = await withUnsavedEdits()

    browser.select(MINE[1])
    await flush()

    // Blocked — the panel must still show the row being edited, or the typing
    // is gone with no way back.
    expect(browser.selectedWorkPackage.value?.id).toBe(101)
    expect(browser.editor.draft.value.subject).toBe(
      'Auth: fix login redirect (edited)'
    )
    // And the request is *held*, not dropped: answering "discard" has to know
    // which row the user was heading for.
    expect(browser.pendingAction.value).toEqual({
      kind: 'select',
      workPackage: MINE[1]
    })
  })

  it('discarding really loses the edits and performs the held row switch', async () => {
    const browser = await withUnsavedEdits()
    browser.select(MINE[1])
    await flush()

    expect(browser.discardPendingAction()).toBe('select')
    await flush()

    // The pending action completed…
    expect(browser.selectedWorkPackage.value?.id).toBe(102)
    expect(browser.pendingAction.value).toBeNull()
    // …and the edits are actually gone, not merely hidden: the draft now holds
    // the newly selected row, and nothing is dirty.
    expect(browser.editor.draft.value.subject).toBe('Billing: invoice PDF export')
    expect(browser.editor.isDirty.value).toBe(false)
    expect(browser.editor.isEditing.value).toBe(false)
  })

  it('keeping the edits preserves the draft and abandons the switch', async () => {
    const browser = await withUnsavedEdits()
    browser.select(MINE[1])
    await flush()

    browser.keepEditing()
    await flush()

    expect(browser.pendingAction.value).toBeNull()
    // The whole point: the answer "no, keep editing" must cost nothing.
    expect(browser.selectedWorkPackage.value?.id).toBe(101)
    expect(browser.editor.draft.value.subject).toBe(
      'Auth: fix login redirect (edited)'
    )
    expect(browser.editor.isDirty.value).toBe(true)
    expect(browser.editor.isEditing.value).toBe(true)
  })

  it('switches rows immediately when the editor is clean', async () => {
    const browser = mountBrowser()
    await flush()

    browser.select(MINE[1])
    await flush()

    // No confirm for a switch that loses nothing — asking would be noise.
    expect(browser.pendingAction.value).toBeNull()
    expect(browser.selectedWorkPackage.value?.id).toBe(102)
  })

  it('does not prompt when the row already open is re-selected', async () => {
    const browser = await withUnsavedEdits()

    browser.select(MINE[0])
    await flush()

    // Clicking the open row is not a switch, so there is nothing to lose.
    expect(browser.pendingAction.value).toBeNull()
    expect(browser.selectedWorkPackage.value?.id).toBe(101)
    expect(browser.editor.isDirty.value).toBe(true)
  })

  it('lets the screen close when nothing is unsaved', async () => {
    const browser = mountBrowser()
    await flush()

    expect(browser.requestClose()).toBe(true)
    expect(browser.pendingAction.value).toBeNull()
  })

  it('withholds permission to close while edits are unsaved', async () => {
    const browser = await withUnsavedEdits()

    // `false` is what keeps the modal on screen — the same guard as the row
    // switch, because to the user it is the same question.
    expect(browser.requestClose()).toBe(false)
    expect(browser.pendingAction.value).toEqual({ kind: 'close' })
    expect(browser.editor.draft.value.subject).toBe(
      'Auth: fix login redirect (edited)'
    )
  })

  it('discarding a held close reports the kind so the caller can finish it', async () => {
    const browser = await withUnsavedEdits()
    expect(browser.requestClose()).toBe(false)

    // The composable cannot close the modal itself — it says which action was
    // released so the component can.
    expect(browser.discardPendingAction()).toBe('close')
    await flush()

    expect(browser.pendingAction.value).toBeNull()
    expect(browser.selectedWorkPackage.value?.id).toBe(101)
    expect(browser.editor.draft.value.subject).toBe('Auth: fix login redirect')
    expect(browser.editor.isDirty.value).toBe(false)
  })

  it('keeping the edits leaves a held close refusing again', async () => {
    const browser = await withUnsavedEdits()
    expect(browser.requestClose()).toBe(false)

    browser.keepEditing()
    expect(browser.pendingAction.value).toBeNull()
    expect(browser.editor.isDirty.value).toBe(true)
    // Still dirty → the next attempt must ask again rather than sail through.
    expect(browser.requestClose()).toBe(false)
  })

  it('discarding with nothing pending is a no-op', async () => {
    const browser = mountBrowser()
    await flush()

    expect(browser.discardPendingAction()).toBeNull()
    expect(browser.selectedWorkPackage.value?.id).toBe(101)
  })
})

describe('useWorkPackagesBrowser — open in browser', () => {
  it('sends only the numeric id across the bridge', async () => {
    const browser = mountBrowser()
    await flush()

    await browser.openInBrowser(101)

    expect(openWorkPackageInBrowser).toHaveBeenCalledTimes(1)
    // Never an href, a path, or a URL — the backend builds the target.
    expect(openWorkPackageInBrowser).toHaveBeenCalledWith({ workPackageId: 101 })
  })

  it('rethrows so the caller can toast, and clears the pending id', async () => {
    openWorkPackageInBrowser.mockRejectedValueOnce(
      Object.assign(new Error('Could not open the work package in your browser.'), {
        code: 'SHELL_OPEN_FAILED'
      })
    )

    const browser = mountBrowser()
    await flush()

    await expect(browser.openInBrowser(101)).rejects.toMatchObject({
      code: 'SHELL_OPEN_FAILED'
    })
    // The row must not be left spinning after the failure.
    expect(browser.openingId.value).toBeNull()
  })
})

describe('useWorkPackagesBrowser — errors', () => {
  it('surfaces the list error for the modal’s error state', async () => {
    listWorkPackages.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('Authentication failed. Check your API key.'), {
          code: 'OPENPROJECT_AUTH_FAILED'
        })
      )
    )

    const browser = mountBrowser()
    await flush()

    expect(browser.error.value).toBeTruthy()
    expect((browser.error.value as { code?: string } | null)?.code).toBe(
      'OPENPROJECT_AUTH_FAILED'
    )
  })
})

/**
 * The unsaved-work guard, extended in stage 3 to cover the create draft.
 *
 * The question is the same whichever half of the pane is holding content —
 * "you'll lose this, carry on?" — so it has one answer, and the browser asks it
 * of the editor and the creator together. Reading them separately is how one of
 * them ends up forgotten when a third caller appears.
 */
describe('useWorkPackagesBrowser — an unsaved create draft', () => {
  async function inCreateMode() {
    const browser = mountBrowser()
    await flush()
    browser.creator.startCreating()
    await flush()
    return browser
  }

  it('lets the screen close and rows switch while the draft is empty', async () => {
    const browser = await inCreateMode()

    expect(browser.requestClose()).toBe(true)
    expect(browser.pendingAction.value).toBeNull()

    browser.select(wp(102, 'Billing: invoice PDF export'))
    expect(browser.pendingAction.value).toBeNull()
    expect(browser.selectedWorkPackage.value?.id).toBe(102)
  })

  it('leaves create mode when a row is picked and nothing would be lost', async () => {
    const browser = await inCreateMode()
    browser.select(wp(102, 'Billing: invoice PDF export'))
    expect(browser.creator.isCreating.value).toBe(false)
  })

  it('blocks a close once the draft holds something', async () => {
    const browser = await inCreateMode()
    browser.creator.draft.value.subject = 'Half-typed'

    expect(browser.requestClose()).toBe(false)
    expect(browser.pendingAction.value).toEqual({ kind: 'close' })
  })

  it('blocks a row switch once the draft holds something', async () => {
    const browser = await inCreateMode()
    browser.creator.draft.value.subject = 'Half-typed'

    const target = wp(102, 'Billing: invoice PDF export')
    browser.select(target)

    expect(browser.pendingAction.value).toMatchObject({ kind: 'select' })
    // Held, not performed — the panel is still showing what it was.
    expect(browser.selectedWorkPackage.value?.id).not.toBe(102)
    expect(browser.creator.draft.value.subject).toBe('Half-typed')
  })

  it('keeps the draft when the user says so', async () => {
    const browser = await inCreateMode()
    browser.creator.draft.value.subject = 'Half-typed'
    browser.select(wp(102, 'Billing: invoice PDF export'))

    browser.keepEditing()
    expect(browser.pendingAction.value).toBeNull()
    expect(browser.creator.isCreating.value).toBe(true)
    expect(browser.creator.draft.value.subject).toBe('Half-typed')
  })

  it('discards the draft and performs the switch when the user says so', async () => {
    const browser = await inCreateMode()
    browser.creator.draft.value.subject = 'Half-typed'
    browser.select(wp(102, 'Billing: invoice PDF export'))

    expect(browser.discardPendingAction()).toBe('select')
    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.creator.draft.value.subject).toBe('')
    expect(browser.selectedWorkPackage.value?.id).toBe(102)
  })

  it('reports a close so the modal can finish it, and clears the draft', async () => {
    const browser = await inCreateMode()
    browser.creator.draft.value.subject = 'Half-typed'
    expect(browser.requestClose()).toBe(false)

    expect(browser.discardPendingAction()).toBe('close')
    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.creator.draft.value.subject).toBe('')
  })

  /**
   * Re-selecting the open row is normally a no-op. While the create panel is
   * covering it, though, clicking it is a request to go back to reading it —
   * otherwise the row the user just clicked appears to do nothing.
   */
  it('treats picking the already-selected row as a way back out of create mode', async () => {
    const browser = mountBrowser()
    await flush()
    const open = browser.selectedWorkPackage.value
    expect(open).not.toBeNull()

    browser.creator.startCreating()
    await flush()
    browser.select(open!)

    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.pendingAction.value).toBeNull()
  })

  it('surfaces one unsaved-work verdict for both halves of the pane', async () => {
    const browser = await inCreateMode()
    expect(browser.hasUnsavedWork.value).toBe(false)
    browser.creator.draft.value.description = 'Worth keeping'
    expect(browser.hasUnsavedWork.value).toBe(true)
  })
})

/**
 * Entering create mode is the third way unsaved work can be lost, and the
 * least visible one.
 *
 * Opening the create form does not itself destroy an edit draft — the editor
 * keeps its state and Cancel comes straight back to it. *Finishing* the create
 * does: `creator.create()` assigns the new work package to the selection, the
 * editor's watcher sees a different row id, and it re-seeds. By then the edits
 * are gone with nothing having asked, so the entrance is what gets guarded.
 */
describe('useWorkPackagesBrowser — starting a create with unsaved edits', () => {
  /** A browser whose editor is open on the first row with an unsaved change. */
  async function midEdit() {
    const browser = mountBrowser()
    await flush()
    browser.editor.startEditing()
    browser.editor.draft.value.subject = 'Half-typed edit'
    await flush()
    expect(browser.editor.isDirty.value).toBe(true)
    return browser
  }

  it('intercepts New rather than entering create mode', async () => {
    const browser = await midEdit()

    browser.requestCreate()

    expect(browser.pendingAction.value).toEqual({ kind: 'create' })
    // Held, not performed: the edit panel is still what's on screen.
    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.editor.isEditing.value).toBe(true)
    expect(browser.editor.draft.value.subject).toBe('Half-typed edit')
  })

  it('keeps the edit draft and stays out of create mode on keep-editing', async () => {
    const browser = await midEdit()
    browser.requestCreate()

    browser.keepEditing()

    expect(browser.pendingAction.value).toBeNull()
    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.editor.isEditing.value).toBe(true)
    expect(browser.editor.isDirty.value).toBe(true)
    expect(browser.editor.draft.value.subject).toBe('Half-typed edit')
  })

  it('enters create mode and drops the edit on discard', async () => {
    const browser = await midEdit()
    browser.requestCreate()

    expect(browser.discardPendingAction()).toBe('create')

    expect(browser.creator.isCreating.value).toBe(true)
    expect(browser.editor.isEditing.value).toBe(false)
    expect(browser.editor.isDirty.value).toBe(false)
    expect(browser.editor.draft.value.subject).not.toBe('Half-typed edit')
    // The create form starts empty — discarding must not carry anything over.
    expect(browser.creator.draft.value.subject).toBe('')
  })

  it('does not intercept New when the editor is clean', async () => {
    const browser = mountBrowser()
    await flush()

    browser.requestCreate()

    expect(browser.pendingAction.value).toBeNull()
    expect(browser.creator.isCreating.value).toBe(true)
  })

  it('does not intercept New when an edit is open but unchanged', async () => {
    const browser = mountBrowser()
    await flush()
    browser.editor.startEditing()
    await flush()

    browser.requestCreate()

    expect(browser.pendingAction.value).toBeNull()
    expect(browser.creator.isCreating.value).toBe(true)
  })

  /**
   * The loss this guard exists to prevent, end to end: without it, New →
   * complete the create → the selection is reassigned → the editor re-seeds on
   * the new row id and the draft is gone, unasked.
   */
  it('never lets a completed create silently discard an unguarded edit', async () => {
    const browser = await midEdit()

    browser.requestCreate()
    // The only way past the question is to answer it.
    expect(browser.creator.isCreating.value).toBe(false)
    expect(browser.pendingAction.value).not.toBeNull()

    browser.keepEditing()
    expect(browser.editor.draft.value.subject).toBe('Half-typed edit')
  })

  it('asks before restarting a create that already holds content', async () => {
    const browser = mountBrowser()
    await flush()
    browser.requestCreate()
    await flush()
    browser.creator.draft.value.subject = 'Half-typed create'

    browser.requestCreate()
    expect(browser.pendingAction.value).toEqual({ kind: 'create' })

    expect(browser.discardPendingAction()).toBe('create')
    expect(browser.creator.isCreating.value).toBe(true)
    expect(browser.creator.draft.value.subject).toBe('')
  })
})

