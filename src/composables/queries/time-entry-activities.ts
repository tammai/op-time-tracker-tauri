import { defineQueryOptions } from '@pinia/colada'

import type { TimeEntryActivityCollection } from '@opentracker/preload'

/**
 * Time Entry Activities domain query options.
 *
 * Per `docs/conventions-frontend.md` ("Server State: Pinia Colada"):
 * - One file per domain under `composables/queries/<domain>.ts`.
 * - Keys are defined once here (never hand-written inline in components).
 *   Format: `['<domain>', '<scope>', ...params]`.
 * - The query is the **only** place `window.openproject.*` is called —
 *   components consume this composable, never the bridge directly, so the
 *   Colada cache (and invalidation) stays wired.
 *
 * OpenProject requires an activity on every time entry, so the time-entry
 * form's Activity select is populated from here. The allowed set is
 * project-scoped, so the key includes the work package id being logged
 * against: switching work packages in the form fetches (and caches) that
 * project's activities separately. `undefined` — no work package chosen
 * yet — keys as `'all'` and fetches the unscoped list.
 *
 * `workPackageId` is a **plain** number — never a getter. Reactivity is the
 * caller's job: pass the whole factory call inside a getter,
 * `useQuery(() => timeEntryActivityQueries.list(id))`, the form
 * `defineQueryOptions` documents. Calling the factory eagerly freezes the key
 * at setup, so switching work packages would never refetch the activity set.
 */
export const timeEntryActivityQueries = {
  list: defineQueryOptions((workPackageId?: number) => ({
    key: ['time-entry-activities', 'list', workPackageId ?? 'all'],
    query: () => window.openproject.listTimeEntryActivities({ workPackageId })
  }))
}

export type TimeEntryActivityListQuery = typeof timeEntryActivityQueries.list
export type { TimeEntryActivityCollection }
