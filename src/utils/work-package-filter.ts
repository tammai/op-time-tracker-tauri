/**
 * Pure work-package narrowing / ordering helpers for
 * `usePriorityWorkPackages()`, which feeds the time-entry form's
 * work-package select.
 *
 * The rules are small enough to live as pure functions — no Vue, no
 * bridge, no fetch — and are unit-tested directly (see
 * `tests/renderer/utils/work-package-filter.test.ts`). The text filter and
 * badge-colour helpers that lived here went with the work-packages drawer
 * when it was removed; these three are what the query composable still uses.
 *
 * The `WorkPackage` *type* is imported type-only (erased at compile time),
 * so this module stays free of runtime dependencies.
 */

import type { WorkPackage } from '@opentracker/preload'

import {
  isWorkPackageSearchTerm,
  normalizeWorkPackageSearchTerm
} from '@shared/validation/work-package-search'

/**
 * Status titles treated as "priority" — the only items offered for logging.
 * These match OpenProject's common default titles and are resolved to
 * status resource **IDs** before filtering server-side (the work-package
 * `status` filter's `=` operator requires IDs, not titles).
 */
export const PRIMARY_STATUSES = ['In Progress', 'To Do']

/** Lowercased set of {@link PRIMARY_STATUSES}, for case-insensitive matching. */
export const PRIMARY_STATUSES_LOWER = new Set(
  PRIMARY_STATUSES.map((s) => s.toLowerCase())
)

/**
 * Display priority — lower index sorts first. Anything unlisted sorts
 * after the known statuses, preserving the server's relative order among
 * those (the sort is stable).
 */
const STATUS_PRIORITY = ['in progress', 'to do']

/**
 * Sort rank for a status title; unknown/missing titles rank last. `null` is
 * accepted because HAL link titles are nullable (an unset link is
 * `{ href: null, title: null }`) — the falsy guard already covers it.
 */
export function statusRank(title: string | null | undefined): number {
  if (!title) return STATUS_PRIORITY.length
  const idx = STATUS_PRIORITY.indexOf(title.toLowerCase())
  return idx === -1 ? STATUS_PRIORITY.length : idx
}

/** True when the work package's status is one of the priority statuses. */
export function isPriorityWorkPackage(wp: WorkPackage): boolean {
  const title = wp._links.status?.title?.toLowerCase()
  return title !== undefined && PRIMARY_STATUSES_LOWER.has(title)
}

/**
 * Order a list by status priority. Returns a new array — never mutates the
 * input, which is a Colada-cached query result.
 */
export function sortByStatusPriority(list: WorkPackage[]): WorkPackage[] {
  return [...list].sort(
    (a, b) =>
      statusRank(a._links.status?.title) - statusRank(b._links.status?.title)
  )
}

/**
 * True when `term` occurs in the work package's subject, or is its id.
 *
 * Substring, not prefix: an OpenProject subject usually leads with a component
 * or ticket prefix, so "login" has to find "Auth: fix login redirect".
 * Case-insensitive on both sides.
 *
 * The id is matched too, and exactly — the same rule the server-side
 * `subjectOrId` `**` filter applies, so a local hit and a remote hit mean the
 * same thing. Exactly, rather than as a prefix, because `12` would otherwise
 * pull in every id starting with those digits and drown the subject matches.
 */
export function matchesWorkPackageTerm(wp: WorkPackage, term: string): boolean {
  const needle = normalizeWorkPackageSearchTerm(term).toLowerCase()
  if (needle === '') return true
  return wp.subject.toLowerCase().includes(needle) || String(wp.id) === needle
}

/**
 * Narrow a list to the work packages matching `term`.
 *
 * This is the picker's local pass: the preloaded priority list is filtered
 * here first, and only an empty result sends the term to the server. Returns a
 * new array — never mutates the input, which is a Colada-cached query result.
 * An empty term returns everything, so clearing the box restores the full list.
 */
export function filterWorkPackagesByTerm(
  list: WorkPackage[],
  term: string
): WorkPackage[] {
  return list.filter((wp) => matchesWorkPackageTerm(wp, term))
}

/** What the picker should do with a term, and the local matches for it. */
export interface WorkPackageSearchDecision {
  /**
   * `local` — show `matches` (possibly the whole list, for an empty term).
   * `server` — nothing local matched and the term is long enough to send.
   * `too-short` — nothing local matched but the term is below the minimum, so
   * no request will be made. Distinct from `server` because the UI must not
   * claim "no work package matches" for a search it never performed.
   */
  mode: 'local' | 'server' | 'too-short'
  matches: WorkPackage[]
}

/**
 * Decide, for one term, whether the local list answers it or the server must.
 *
 * Extracted from `useWorkPackagePicker` so the local-first rule — including
 * the invariant that a term with local hits *never* reaches the server — is
 * unit-testable without a Colada/Pinia harness, which `tests/renderer/` does
 * not have.
 *
 * `loaded` is the caller's "the priority list has actually arrived" flag. An
 * unloaded list is empty, and an empty list matches nothing, so without it
 * every term looks like a local miss and the first keystrokes after opening
 * the form fire a request the local pass was about to answer.
 */
export function decideWorkPackageSearch(
  list: WorkPackage[],
  term: string,
  loaded = true
): WorkPackageSearchDecision {
  const matches = filterWorkPackagesByTerm(list, term)
  if (!loaded || matches.length > 0) return { mode: 'local', matches }
  // An empty term can't reach here with a loaded list (it matches everything),
  // so a miss means the user typed something real.
  if (normalizeWorkPackageSearchTerm(term) === '') return { mode: 'local', matches }
  return {
    mode: isWorkPackageSearchTerm(term) ? 'server' : 'too-short',
    matches
  }
}
