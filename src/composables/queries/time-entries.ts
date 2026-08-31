import {
  defineQuery,
  defineQueryOptions,
  useMutation,
  useQuery,
  useQueryCache
} from '@pinia/colada'
import { computed, ref } from 'vue'
import type {
  CreateTimeEntryInput,
  UpdateTimeEntryInput,
  DeleteTimeEntryInput,
  TimeEntry,
  TimeEntryCollection,
  TimeEntryFilters
} from '@opentracker/preload'

import { getMonthRange } from '@renderer/utils/calendar-dates'
import { aggregateTimeEntriesByDay } from '@renderer/utils/calendar-aggregation'

/**
 * Time Entries domain query options.
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
 * The Calendar tab (task 7) calls this with
 * `filters: { spentOn: { between: [monthStart, monthEnd] } }`. The key
 * includes the full `filters` object, so distinct month ranges cache
 * separately and navigating back to a previous month reuses the cached
 * entry list without refetching.
 *
 * `filters` is a **plain** object — never a `ref` or getter. Reactivity is the
 * caller's job: pass the whole factory call inside a getter,
 * `useQuery(() => timeEntryQueries.list({ … }))`, which is the form
 * `defineQueryOptions` documents. Calling the factory eagerly
 * (`useQuery(timeEntryQueries.list(…))`) freezes the key at setup, so a
 * parameter change never rekeys and the query never refetches.
 */
export const timeEntryQueries = {
  list: defineQueryOptions((filters?: TimeEntryFilters) => ({
    key: ['time-entries', 'list', filters ?? {}],
    query: () => window.openproject.listTimeEntries({ filters })
  }))
}

export type TimeEntryListQuery = typeof timeEntryQueries.list

/**
 * The displayed month's time entries, plus the month cursor itself.
 *
 * `defineQuery` (not a bare `useQuery`) because two components now read this
 * at once: the navbar renders the month title, the month total, and the
 * prev/today/next controls, while the calendar renders the grid. They must
 * agree on which month is displayed, so the cursor lives here with the query
 * it parameterises rather than being threaded through props — and the
 * aggregation runs once for both instead of once per component.
 *
 * Month state is client state, but it belongs here rather than in
 * `useUiStore` precisely because it *is* the query's parameter: keeping them
 * together means a month change and the refetch it triggers can't drift.
 *
 * All date maths is UTC, matching `calendar-dates.ts` and OpenProject's
 * `spentOn`, so a day never shifts across timezones.
 */
export const useMonthTimeEntries = defineQuery(() => {
  const now = new Date()
  const year = ref(now.getUTCFullYear())
  const month = ref(now.getUTCMonth())

  /** `YYYY-MM-DD` range for the displayed month. */
  const monthRange = computed(() => getMonthRange(year.value, month.value))

  // The whole options factory call sits inside the getter `useQuery` takes, so
  // it re-runs whenever `monthRange` changes: navigating months rekeys the
  // query (refetching, then caching, each visited month). Building the options
  // outside the getter would freeze the key on the month mounted first.
  const query = useQuery(() =>
    timeEntryQueries.list({
      onlyMine: true,
      spentOn: {
        between: [monthRange.value.start, monthRange.value.end] as [string, string]
      }
    })
  )

  /** Time entries for the displayed month. */
  const entries = computed(() => query.data.value?._embedded.elements ?? [])

  /** Per-day + month-wide aggregates (pure computed over the entries). */
  const aggregate = computed(() => aggregateTimeEntriesByDay(entries.value))

  /** True while the *first* load is in flight (no data yet). */
  const isInitialLoading = computed(
    () => query.status.value === 'pending' && query.data.value === undefined
  )

  /** "July" — month name from UTC components. */
  const monthName = computed(() =>
    new Date(Date.UTC(year.value, month.value, 15)).toLocaleDateString(undefined, {
      month: 'long',
      timeZone: 'UTC'
    })
  )

  /** "2026" — year from UTC components. */
  const yearLabel = computed(() =>
    new Date(Date.UTC(year.value, month.value, 15)).toLocaleDateString(undefined, {
      year: 'numeric',
      timeZone: 'UTC'
    })
  )

  /** Month total, formatted for the header badge (1 decimal). */
  const totalHoursLabel = computed(
    () => `${aggregate.value.totalHours.toFixed(1)}h`
  )

  function prevMonth(): void {
    if (month.value === 0) {
      month.value = 11
      year.value -= 1
    } else {
      month.value -= 1
    }
  }

  function nextMonth(): void {
    if (month.value === 11) {
      month.value = 0
      year.value += 1
    } else {
      month.value += 1
    }
  }

  /** Jump back to the month containing today. */
  function goToToday(): void {
    const today = new Date()
    year.value = today.getUTCFullYear()
    month.value = today.getUTCMonth()
  }

  return {
    ...query,
    year,
    month,
    monthRange,
    entries,
    aggregate,
    isInitialLoading,
    monthName,
    yearLabel,
    totalHoursLabel,
    prevMonth,
    nextMonth,
    goToToday
  }
})

/**
 * Create a time entry.
 *
 * Per `docs/conventions-frontend.md`, mutations colocate with
 * their domain as `use<Action><Domain>()` and invalidate the cache **here**,
 * never in a component. Invalidating the whole `['time-entries']` prefix
 * covers every cached month range plus the single-day list the day modal
 * renders — after a successful save the calendar cell, the month total, and
 * the modal's entry list all refetch without any component coordinating it.
 *
 * Invalidation is on success only: a rejected write changed nothing on the
 * server, so there is nothing stale to refetch.
 *
 * The input carries plain numeric ids. The backend re-validates it
 * (`CreateTimeEntryInputSchema`) and builds the request hrefs itself — see
 * `docs/security.md`.
 */
export function useCreateTimeEntry() {
  const cache = useQueryCache()
  return useMutation<TimeEntry, CreateTimeEntryInput>({
    mutation: (input: CreateTimeEntryInput) =>
      window.openproject.createTimeEntry(input),
    onSuccess: () => {
      cache.invalidateQueries({ key: ['time-entries'] })
    }
  })
}

/**
 * Update an existing time entry.
 *
 * Invalidates on the same `['time-entries']` prefix as the create mutation,
 * and for the same reason: an edit can change the hours, so the day list, the
 * calendar cell, and the month total are all potentially stale — and an edit
 * that moved nothing still needs the list to show the new comment.
 *
 * The update is a **full replacement** (see the bridge contract): the caller
 * must send every field, not just the changed ones, so an omitted comment
 * clears it rather than leaving the old text in place.
 */
export function useUpdateTimeEntry() {
  const cache = useQueryCache()
  return useMutation<TimeEntry, UpdateTimeEntryInput>({
    mutation: (input: UpdateTimeEntryInput) =>
      window.openproject.updateTimeEntry(input),
    onSuccess: () => {
      cache.invalidateQueries({ key: ['time-entries'] })
    }
  })
}

/**
 * Delete a time entry.
 *
 * Same prefix invalidation. No optimistic removal: the row disappearing before
 * the server confirms would have to be put back on failure, and a delete that
 * silently un-deletes itself is worse than a brief spinner on the row.
 */
export function useDeleteTimeEntry() {
  const cache = useQueryCache()
  return useMutation<void, DeleteTimeEntryInput>({
    mutation: (input: DeleteTimeEntryInput) =>
      window.openproject.deleteTimeEntry(input),
    onSuccess: () => {
      cache.invalidateQueries({ key: ['time-entries'] })
    }
  })
}

export type {
  CreateTimeEntryInput,
  UpdateTimeEntryInput,
  DeleteTimeEntryInput,
  TimeEntry,
  TimeEntryCollection,
  TimeEntryFilters
}