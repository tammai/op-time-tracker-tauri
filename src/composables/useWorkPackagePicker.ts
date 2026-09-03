import { computed, onScopeDispose, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'

import {
  normalizeWorkPackageSearchTerm,
  sanitizeWorkPackageSearchInput
} from '@shared/validation/work-package-search'
import {
  usePriorityWorkPackages,
  workPackageQueries
} from '@renderer/composables/queries/work-packages'
import type { WorkPackageCollection } from '@renderer/composables/queries/work-packages'
import {
  decideWorkPackageSearch,
  filterWorkPackagesByTerm,
  type WorkPackageSearchDecision
} from '@renderer/utils/work-package-filter'
import {
  formatWorkPackageLabel,
  workPackageSelectionLabel,
  type KnownWorkPackageSubject
} from '@renderer/utils/work-package-label'

/**
 * Options for the time-entry form's work-package select.
 *
 * Searches by **title**, local before remote:
 * - **Priority items** — the user's own open work packages, loaded once per
 *   app by `usePriorityWorkPackages()`. Shown unfiltered with an empty box,
 *   and narrowed by subject as the user types. A hit here answers the search
 *   outright: no request is made.
 * - **Server search** — only when the local pass matches *nothing*. The term
 *   goes to the server without the `onlyMine`/status filters, so items outside
 *   the priority list become reachable, debounced so a word costs one request
 *   rather than one per keystroke.
 *
 * The consequence of local-first is deliberate: a term that matches one of
 * your own items will not surface the instance-wide matches behind it. Typing
 * a more specific title is how you get past your own list.
 *
 * All filtering happens here, so the select is told to skip its built-in
 * filter — otherwise server results would be filtered a second time against a
 * term they already matched server-side (subject substring, not the select's
 * fuzzy rules), silently dropping rows.
 *
 * Lives in a composable, not the component, per
 * `docs/conventions-frontend.md` (no business logic in
 * components; server state via Colada query composables).
 */

/**
 * How long the box must be idle before a term is sent to the server.
 *
 * Only ever reached when the local pass came up empty, so it paces genuine
 * misses. Long enough to swallow a fast typist's inter-keystroke gap, short
 * enough not to read as lag once they stop.
 */
const SEARCH_DEBOUNCE_MS = 300

/** One `USelectMenu` option. `value` feeds the form's `workPackageId`. */
export interface WorkPackageItem {
  label: string
  value: number
}

type WorkPackage = WorkPackageCollection['_embedded']['elements'][number]

function toItem(wp: WorkPackage): WorkPackageItem {
  return { label: formatWorkPackageLabel(wp.id, wp.subject), value: wp.id }
}

export interface UseWorkPackagePickerOptions {
  /** The form's current selection, so it stays labelled as the list swaps. */
  selectedId: () => number | undefined
  /**
   * A subject the caller already knows for a specific work package — the
   * edited entry's item, read off its HAL link. Used to label the selection
   * when neither source holds it, which is the normal case in edit mode: the
   * entry's item is rarely among the user's priority suggestions, and without a
   * subject the select can only render `#12345`.
   *
   * Carries the id it belongs to so a subject can never label a *different*
   * selection.
   */
  knownSubject?: () => KnownWorkPackageSubject | null
}

export function useWorkPackagePicker(options: UseWorkPackagePickerOptions) {
  const {
    items: priorityItems,
    isInitialLoading: priorityLoading,
    error: priorityError
  } = usePriorityWorkPackages()

  // The search box

  /** Bound to `USelectMenu`'s `v-model:search-term`. */
  const searchTerm = ref('')

  /**
   * The decision, frozen at the moment the debounce fired.
   *
   * Latched rather than recomputed, because `priorityItems` is a shared
   * `defineQuery` that refetches on its own schedule. Re-deriving "does this
   * term match locally?" from the live list means a background refetch that
   * happens to add a matching item can yank rendered server results out from
   * under the user mid-scroll. What the term resolved to when it was sent is
   * what stays on screen until the term itself changes.
   */
  const latched = ref<{ term: string; decision: WorkPackageSearchDecision }>({
    term: '',
    decision: { mode: 'local', matches: [] }
  })
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const queryCache = useQueryCache()

  /** Whether a term's results are already sitting in the Colada cache. */
  function isCached(term: string): boolean {
    return (
      queryCache.getQueryData(workPackageQueries.search(term).key) !== undefined
    )
  }

  function settle(term: string): void {
    latched.value = {
      term,
      decision: decideWorkPackageSearch(
        priorityItems.value,
        term,
        !priorityLoading.value
      )
    }
  }

  // Strip control characters and cap the length on every keystroke, then start
  // the debounce clock. Writing the sanitized value back to the same ref is
  // what actually rejects a disallowed character — the box can never hold one,
  // so nothing downstream has to cope with it. A write-back re-runs this
  // watcher, which is harmless: the second pass is a no-op and just restarts a
  // timer that hasn't fired.
  watch(searchTerm, (value) => {
    const clean = sanitizeWorkPackageSearchInput(value)
    if (clean !== value) {
      searchTerm.value = clean
      return
    }
    clearTimeout(debounceTimer)
    // Nothing to wait for when the answer is already in hand: a term the local
    // pass can settle, or one whose results are cached from earlier in this
    // session. Debouncing those would blank the list for 300ms while backing
    // out of a typo — the case where the user is most obviously retreating to
    // something they just saw.
    const decision = decideWorkPackageSearch(
      priorityItems.value,
      clean,
      !priorityLoading.value
    )
    if (decision.mode !== 'server' || isCached(clean)) {
      settle(clean)
      return
    }
    debounceTimer = setTimeout(() => settle(clean), SEARCH_DEBOUNCE_MS)
  })

  // Re-settle when the priority list arrives: a term typed against an unloaded
  // list latched `local` with nothing in it, and would otherwise sit there
  // showing an empty dropdown until the next keystroke.
  //
  // `immediate` because the list is shared app-wide (`defineQuery`) and only
  // ever loads once, while this picker is rebuilt every time the form is
  // remounted. Waiting on the flag to *change* means the second and every
  // later mount finds it already `false`, never settles, and shows the empty
  // seed until the user types. Settling at setup against a still-loading list
  // is a no-op — `decideWorkPackageSearch` returns the same empty `local`
  // decision the seed already holds.
  watch(
    priorityLoading,
    (loading) => {
      if (!loading) settle(searchTerm.value)
    },
    { immediate: true }
  )

  // The form outlives no timer: a picker unmounted mid-debounce would
  // otherwise wake up to write into a discarded scope.
  onScopeDispose(() => clearTimeout(debounceTimer))

  // Local pass, then server

  /**
   * The priority list narrowed by the *live* term. Recomputed per keystroke
   * with no latency, which is the point: the common case never waits.
   */
  const localMatches = computed(() =>
    filterWorkPackagesByTerm(priorityItems.value, searchTerm.value)
  )

  /** True once the latched decision has caught up with what's in the box. */
  const isSettled = computed(() => latched.value.term === searchTerm.value)

  /** The live decision, used for the *pending* UI during the debounce window. */
  const liveMode = computed(
    () =>
      decideWorkPackageSearch(
        priorityItems.value,
        searchTerm.value,
        !priorityLoading.value
      ).mode
  )

  /** The term to actually query, or `''` when no request should be made. */
  const serverTerm = computed(() =>
    latched.value.decision.mode === 'server'
      ? normalizeWorkPackageSearchTerm(latched.value.term)
      : ''
  )

  const searchQuery = useQuery(() => ({
    ...workPackageQueries.search(serverTerm.value),
    // Anything the local pass already answered, and anything below the minimum
    // length, must not fire — Colada would otherwise cache a request keyed on a
    // term we never meant to send.
    enabled: serverTerm.value !== ''
  }))

  /**
   * Results for the latched term, in the order the server returned them —
   * `updatedAt desc`, requested explicitly by `workPackageQueries.search`.
   */
  const searchResults = computed(
    () => searchQuery.data.value?._embedded.elements ?? []
  )

  /** True when the server had more matches than the one page we asked for. */
  const isSearchTruncated = computed(
    () =>
      serverTerm.value !== '' &&
      (searchQuery.data.value?.total ?? 0) > searchResults.value.length
  )

  /** How many matches the server reported, for the truncation notice. */
  const searchTotal = computed(() => searchQuery.data.value?.total ?? 0)

  /**
   * True while a term is on its way to results — covering both the debounce
   * window and the request itself, since to the user those are one wait.
   */
  const isSearching = computed(() => {
    if (!isSettled.value) return liveMode.value === 'server'
    return serverTerm.value !== '' && searchQuery.status.value === 'pending'
  })

  /**
   * True when nothing matched locally and the term is too short to search.
   *
   * The UI needs this separately from "no results": claiming no work package
   * matches would be a statement about the whole instance, for a search that
   * was deliberately never sent.
   */
  const isTermTooShort = computed(() =>
    isSettled.value
      ? latched.value.decision.mode === 'too-short'
      : liveMode.value === 'too-short'
  )

  /** True when the search request itself failed, as opposed to finding nothing. */
  const hasSearchFailed = computed(
    () => serverTerm.value !== '' && searchQuery.status.value === 'error'
  )

  // The options list

  /**
   * Every subject this picker has *shown*, by id.
   *
   * Both sources are transient — a search's results are dropped the moment the
   * term changes, and `USelectMenu` resets the term as part of selecting
   * (`resetSearchTermOnSelect`, on by default) — so a subject has to be banked
   * as items pass through. Capturing it when the selection changes instead is a
   * tick too late: the chosen item has already left `searchResults`, leaving
   * the trigger to render a bare `#12345`.
   *
   * Bounded by what the user has actually seen: one priority page plus one item
   * per completed search.
   */
  const seenSubjects = ref(new Map<number, string>())

  watch(
    [priorityItems, searchResults],
    ([priority, results]) => {
      for (const wp of [...priority, ...results]) {
        seenSubjects.value.set(wp.id, wp.subject)
      }
    },
    { immediate: true }
  )

  /**
   * The work packages the dropdown should show, from whichever pass owns the
   * current term.
   *
   * An empty term is the live, preloaded priority list. It must not use the
   * latched matches: creating or editing a work package invalidates that query,
   * and the refetched list needs to appear without requiring a keystroke to
   * settle the picker again. Typed searches stay latched so a background
   * refetch cannot replace server results while the user is reading them.
   *
   * While the debounce is still running, an empty list rather than the previous
   * term's results — those belong to a term the user has already moved past,
   * and `isSearching` is what fills the gap.
   */
  const shownWorkPackages = computed(() => {
    if (normalizeWorkPackageSearchTerm(searchTerm.value) === '') {
      return localMatches.value
    }
    // Mid-debounce: blank rather than the previous term's results, which
    // belong to a term the user has already moved past.
    if (!isSettled.value) return liveMode.value === 'local' ? localMatches.value : []
    return latched.value.decision.mode === 'server'
      ? searchResults.value
      : latched.value.decision.matches
  })

  const items = computed<WorkPackageItem[]>(() => {
    const list = shownWorkPackages.value.map(toItem)

    // Keep the selection present so the trigger can label it — but only with
    // an empty box. While a term is being searched the selection is not a
    // result, and pinning it to the top both hides the "no match" empty state
    // (a non-empty list never renders it) and offers an unrelated item as
    // though it matched. The select's own filter used to drop it; now that
    // this composable owns filtering, dropping it is this composable's job.
    const id = options.selectedId()
    if (
      id !== undefined &&
      searchTerm.value.trim() === '' &&
      !list.some((item) => item.value === id)
    ) {
      list.unshift({
        label: workPackageSelectionLabel(
          id,
          seenSubjects.value,
          options.knownSubject?.()
        ),
        value: id
      })
    }
    return list
  })

  return {
    items,
    searchTerm,
    isLoading: computed(() => priorityLoading.value || isSearching.value),
    /**
     * True while the term is still resolving. The component uses it to say
     * "Searching…" instead of "no match", which would otherwise be wrong for
     * the whole debounce-plus-request window.
     */
    isSearching,
    /** Nothing matched locally and the term is below the search minimum. */
    isTermTooShort,
    /** The search request failed — distinct from it finding nothing. */
    hasSearchFailed,
    /** More matches exist than the single page the picker asked for. */
    isSearchTruncated,
    /** Total matches the server reported, for the truncation notice. */
    searchTotal,
    error: priorityError,
    searchError: searchQuery.error
  }
}
