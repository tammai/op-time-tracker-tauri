import { defineQueryOptions, useQuery } from '@pinia/colada'
import { computed } from 'vue'

import type { Status, StatusCollection } from '@opentracker/preload'

/**
 * Statuses domain query options.
 *
 * Per `docs/conventions-frontend.md` ("Server State: Pinia Colada"):
 * - One file per domain under `composables/queries/<domain>.ts`.
 * - Keys are defined once here (never hand-written inline in components).
 *   Format: `['<domain>', '<scope>', ...params]`.
 * - The query is the **only** place `window.openproject.*` is called —
 *   components consume this composable, never the bridge directly, so the
 *   Colada cache (and invalidation) stays wired.
 * - No Pinia store wrapping `useQuery` — Colada's cache already lives in
 *   Pinia; wrapping it duplicates state and breaks lifecycle tracking.
 *
 * Types come from the bridge contract (`@opentracker/preload`), which
 * re-exports the Zod schemas in `src-tauri/src/schemas/` — the single source of
 * truth. The frontend never sees raw server shapes.
 *
 * The statuses list takes no filters (the status set is small and
 * instance-wide), so a single stable key `['statuses', 'list']` is all
 * that's needed — Colada caches it for the session.
 */
export const statusQueries = {
  list: defineQueryOptions(() => ({
    key: ['statuses', 'list'],
    query: () => window.openproject.listStatuses()
  }))
}

export type StatusListQuery = typeof statusQueries.list

/**
 * The statuses list, plus the title→ID resolution every work-package status
 * filter needs.
 *
 * OpenProject's work-package `status` filter `=` operator requires status
 * resource **IDs**; passing titles yields HTTP 400. So any caller that wants
 * "the open ones" has to resolve its titles against this endpoint first. That
 * resolution used to live inside `usePriorityWorkPackages`; it lives here now
 * because the work-packages browser needs the identical mapping *and* the full
 * status list for its filter dropdown, and two copies of a rule whose failure
 * mode is a silent HTTP 400 is one copy too many.
 *
 * Safe to call from several places at once — `useQuery` shares by key, so the
 * statuses are fetched once per session regardless of how many callers ask.
 */
export function useStatusResolution() {
  const { data, status, error } = useQuery(statusQueries.list())

  /** Every status the instance defines, for a filter's options. */
  const statuses = computed<Status[]>(
    () => data.value?._embedded.elements ?? []
  )

  /** Lowercased status `name` → status resource `id`. */
  const statusTitleToId = computed(() => {
    const map = new Map<string, number>()
    for (const s of statuses.value) {
      map.set(s.name.toLowerCase(), s.id)
    }
    return map
  })

  /**
   * `titles` resolved to stringified status IDs, case-insensitively. Titles
   * this instance doesn't define are **dropped**, not preserved — an
   * unresolved title in the filter is the HTTP 400 this whole indirection
   * exists to avoid. Callers must therefore treat an empty result as "don't
   * send a status filter at all" and narrow client-side instead.
   */
  function resolveStatusIds(titles: readonly string[]): string[] {
    return titles
      .map((title) => statusTitleToId.value.get(title.toLowerCase()))
      .filter((id): id is number => id !== undefined)
      .map((id) => String(id))
  }

  /**
   * True once the statuses query has settled — successfully *or* not.
   *
   * Callers gate their own list query on this so the first request isn't sent
   * with the wrong filters and immediately superseded. It deliberately doesn't
   * distinguish success from failure: a failed statuses query resolves no IDs,
   * which is the same situation as an instance that doesn't use those titles,
   * and both take the same client-side fallback.
   */
  const isSettled = computed(() => status.value !== 'pending')

  return { statuses, statusTitleToId, resolveStatusIds, isSettled, error }
}

export type { Status, StatusCollection }