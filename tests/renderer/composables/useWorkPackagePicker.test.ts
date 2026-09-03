import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, effectScope, nextTick, type App, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'

import { useWorkPackagePicker } from '@renderer/composables/useWorkPackagePicker'

/**
 * Harness for the picker composable.
 *
 * `tests/renderer/` has no component runner and the project has no DOM
 * environment, so instead of mounting anything this creates a bare app purely
 * for its injection context (`app.runWithContext`) and runs the composable
 * inside an `effectScope`. That is enough for Pinia Colada: `useQuery` needs
 * an active pinia, the plugin's provides, and a scope to attach effects to —
 * none of which require a document.
 *
 * What it buys is the coverage the pure utils can't reach: the debounce
 * lifecycle, and the invariant that a term the local list answers never
 * produces a request.
 */

/** A work package as the bridge returns it. */
function wp(id: number, subject: string, status = 'In Progress') {
  return {
    id,
    _type: 'WorkPackage' as const,
    subject,
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: '/api/v3/statuses/1', title: status }
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

const STATUSES = {
  _type: 'Collection',
  total: 2,
  count: 2,
  _embedded: {
    elements: [
      { id: 1, _type: 'Status', name: 'In Progress', isClosed: false },
      { id: 2, _type: 'Status', name: 'To Do', isClosed: false }
    ]
  }
}

/** The user's own priority items — what the local pass searches. */
const PRIORITY = [
  wp(101, 'Auth: fix login redirect'),
  wp(102, 'Billing: invoice PDF export')
]

let app: App
let scope: EffectScope
let listWorkPackages: ReturnType<typeof vi.fn>

/** Every `listWorkPackages` call that carried a search term. */
function searchCalls(): string[] {
  return listWorkPackages.mock.calls
    .map((c) => (c[0] as { filters?: { search?: string } } | undefined)?.filters?.search)
    .filter((s): s is string => s !== undefined)
}

function mountPicker(
  selectedId: number | undefined = undefined,
  into: EffectScope = scope
) {
  let picker!: ReturnType<typeof useWorkPackagePicker>
  app.runWithContext(() => {
    into.run(() => {
      picker = useWorkPackagePicker({ selectedId: () => selectedId })
    })
  })
  return picker
}

/** Let queries resolve without advancing the debounce clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()

  listWorkPackages = vi.fn(
    (input?: { filters?: { search?: string } }) => {
      const search = input?.filters?.search
      if (search === undefined) return Promise.resolve(collection(PRIORITY))
      // Anything reaching the server is, by construction, not in PRIORITY.
      return Promise.resolve(collection([wp(900, `Server hit for ${search}`)], 12))
    }
  )

  vi.stubGlobal('window', {
    openproject: {
      listWorkPackages,
      listStatuses: vi.fn(() => Promise.resolve(STATUSES))
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
  // The app is never mounted — it exists only to carry the injection context —
  // so there is nothing to unmount, only the scope's effects to stop.
  scope.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useWorkPackagePicker — local-first', () => {
  it('answers a term the priority list matches without any request', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'login'
    await flush()
    // Well past the debounce: nothing should ever be sent.
    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    expect(searchCalls()).toEqual([])
    expect(picker.items.value.map((i) => i.value)).toEqual([101])
  })

  it('shows the whole priority list for an empty term', async () => {
    const picker = mountPicker()
    await flush()

    expect(picker.items.value.map((i) => i.value)).toEqual([101, 102])
    expect(searchCalls()).toEqual([])
  })

  it('sends a term nothing local matched, exactly once, after the debounce', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'payment gateway'
    await flush()
    expect(searchCalls()).toEqual([])

    await vi.advanceTimersByTimeAsync(300)
    await flush()

    expect(searchCalls()).toEqual(['payment gateway'])
    expect(picker.items.value.map((i) => i.value)).toEqual([900])
  })

  it('coalesces keystrokes into one request for the final term', async () => {
    const picker = mountPicker()
    await flush()

    for (const term of ['p', 'pa', 'pay', 'paym']) {
      picker.searchTerm.value = term
      await flush()
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(300)
    await flush()

    expect(searchCalls()).toEqual(['paym'])
  })

  it('never searches a term below the minimum, and says so', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'z'
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    expect(searchCalls()).toEqual([])
    expect(picker.isTermTooShort.value).toBe(true)
    // Not "no match anywhere" — nothing was asked.
    expect(picker.items.value).toEqual([])
  })

  it('resolves `#101` against the local list rather than the server', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = '#101'
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    expect(searchCalls()).toEqual([])
    expect(picker.items.value.map((i) => i.value)).toEqual([101])
  })
})

describe('useWorkPackagePicker — reopening the form', () => {
  it('shows the priority list on a remount, against an already-loaded query', async () => {
    // The modal unmounts its body on close, so reopening builds a *fresh*
    // picker over the app-wide `usePriorityWorkPackages`, which by then has
    // long since loaded. Nothing about the second picker changes, so anything
    // keyed on a load *transition* never runs for it — and the dropdown opens
    // empty until the user types. The picker has to settle at setup instead.
    const firstOpen = effectScope()
    mountPicker(undefined, firstOpen)
    await flush()
    firstOpen.stop()

    const reopened = mountPicker()
    await flush()

    expect(reopened.items.value.map((i) => i.value)).toEqual([101, 102])
  })

  it('shows a newly created item after the priority list refetches', async () => {
    const picker = mountPicker()
    await flush()

    expect(picker.items.value.map((i) => i.value)).toEqual([101, 102])

    listWorkPackages.mockResolvedValueOnce(
      collection([...PRIORITY, wp(103, 'Newly created work package')])
    )

    let invalidation!: Promise<unknown>
    app.runWithContext(() => {
      invalidation = useQueryCache().invalidateQueries({ key: ['work-packages'] })
    })
    await invalidation
    await flush()

    expect(picker.items.value.map((i) => i.value)).toEqual([101, 102, 103])
  })
})

describe('useWorkPackagePicker — the debounce', () => {
  it('reports isSearching through the debounce window, not just the request', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'payment gateway'
    await flush()
    // Still waiting on the timer — no request yet, but the user is waiting.
    expect(searchCalls()).toEqual([])
    expect(picker.isSearching.value).toBe(true)

    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(picker.isSearching.value).toBe(false)
  })

  it('skips the debounce for a term whose results are already cached', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'deploy'
    await flush()
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(picker.items.value.map((i) => i.value)).toEqual([900])

    // Let the dead end fully settle, so the latched term really does move off
    // "deploy" — otherwise backing out is trivially a no-op and proves nothing.
    picker.searchTerm.value = 'deployx'
    await flush()
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(searchCalls()).toEqual(['deploy', 'deployx'])

    // Now back out. The answer for "deploy" is cached, so it must come straight
    // back rather than blanking the dropdown for another debounce interval.
    picker.searchTerm.value = 'deploy'
    await flush()

    expect(picker.isSearching.value).toBe(false)
    expect(picker.items.value.map((i) => i.value)).toEqual([900])
    // And no second request for a term already answered.
    expect(searchCalls()).toEqual(['deploy', 'deployx'])
  })

  it('drops a pending timer when the scope is disposed', async () => {
    const picker = mountPicker()
    await flush()

    picker.searchTerm.value = 'payment gateway'
    await flush()
    scope.stop()

    await vi.advanceTimersByTimeAsync(2000)
    await flush()

    // The unmounted picker must not wake up and fire into a dead scope.
    expect(searchCalls()).toEqual([])
  })
})

describe('useWorkPackagePicker — the selected item', () => {
  it('keeps the selection listed with an empty box so the trigger can label it', async () => {
    const picker = mountPicker(555)
    await flush()

    expect(picker.items.value.map((i) => i.value)).toEqual([555, 101, 102])
  })

  it('drops the selection from the list once a term is being searched', async () => {
    // Otherwise a non-matching selected item is presented as the sole result,
    // and a non-empty list means the "no match" empty state never renders.
    const picker = mountPicker(555)
    await flush()

    picker.searchTerm.value = 'nothing matches this'
    await flush()

    expect(picker.items.value.map((i) => i.value)).not.toContain(555)
  })
})
