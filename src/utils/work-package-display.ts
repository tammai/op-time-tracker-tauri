/**
 * How a work package's fields are rendered in the browser's list and detail
 * panel.
 *
 * Pure — no Vue, no bridge, no fetch — so the display rules are unit-tested
 * directly (`tests/renderer/utils/work-package-display.test.ts`) rather than
 * inferred from a component. Same split as `work-package-label.ts`, and the
 * same reason: `docs/conventions-frontend.md` keeps logic out of
 * components, and `tests/renderer/` has no component runner.
 *
 * The `WorkPackage` *type* is imported type-only (erased at compile time), so
 * this module carries no runtime dependency on the preload bridge.
 */

import type { WorkPackage } from '@opentracker/preload'

import { isCalendarDate } from '@shared/validation/calendar-date'
import { parseHoursToDecimal } from '@shared/utils/time'

/**
 * The single marker for "we don't know this value".
 *
 * One constant rather than a literal per call site, so a reader can tell at a
 * glance that a dash in the panel always means the same thing — and so a test
 * asserting the fallback can't drift from what's rendered.
 */
export const EM_DASH = '—'

/** Shown when nothing is assigned — a fact, distinct from an unknown value. */
export const UNASSIGNED_LABEL = 'Unassigned'

/**
 * Fallbacks for the two date fields.
 *
 * A bare dash reads as "this field is broken"; these say the date simply
 * isn't set, which for a work package is ordinary rather than exceptional.
 * Passed explicitly at the call site so {@link formatWorkPackageDate} keeps
 * {@link EM_DASH} as its neutral default for any other date.
 */
export const NO_DUE_DATE_LABEL = 'No due date'
export const NO_START_DATE_LABEL = 'No start date'

/**
 * Format OpenProject's `spentHours` for display.
 *
 * The field is genuinely polymorphic: current OpenProject versions serialize it
 * as an ISO-8601 duration (`"PT3H30M"`), older ones as a decimal number, and
 * some instances omit it entirely until time is logged — which is why the Zod
 * schema accepts `number | string | null | undefined` and validates nothing
 * further. Nothing read the field before this browser, so this is the first
 * place the three forms have to be reconciled.
 *
 * A malformed value yields {@link EM_DASH} rather than throwing:
 * `parseHoursToDecimal` throws on anything outside the ISO grammar, and one
 * unreadable field must not take down the row (or the whole list) that
 * contains it.
 *
 * Zero is *not* unknown — `0.00h` says "nothing logged yet", which is exactly
 * what the user needs to know before logging against the item.
 */
export function formatSpentHours(
  value: number | string | null | undefined
): string {
  const hours = toDecimalHours(value)
  return hours === null ? EM_DASH : `${hours.toFixed(2)}h`
}

/**
 * `spentHours` reduced to a decimal number, or `null` when it can't be read.
 *
 * Three accepted forms, in the order they're likely to arrive:
 * - a number (older instances, and the only form the schema names first);
 * - an ISO-8601 duration string (`"PT3H30M"` — current instances);
 * - a plain numeric string (`"3.5"`), which `parseHoursToDecimal` rejects
 *   because it has no `P` prefix, but which is unambiguous and cheap to accept.
 */
function toDecimalHours(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  const trimmed = value.trim()
  if (trimmed === '') return null

  try {
    return parseHoursToDecimal(trimmed)
  } catch {
    // Not a duration. A bare numeric string is the one other form worth
    // accepting; anything else is unreadable.
    const asNumber = Number(trimmed)
    return Number.isFinite(asNumber) ? asNumber : null
  }
}

/**
 * Who the work package is assigned to.
 *
 * Three outcomes, because "nobody" and "we can't tell" are different claims:
 * - a link title → that name;
 * - no href *and* no title → {@link UNASSIGNED_LABEL}. An unassigned work
 *   package arrives as `assignee: {}` on some instances and
 *   `{ href: null, title: null }` on others; both mean nobody;
 * - an href with no title → {@link EM_DASH}. Someone is assigned and we don't
 *   know who, so saying "Unassigned" would be a false statement about the item.
 */
export function workPackageAssigneeLabel(wp: WorkPackage): string {
  const assignee = wp._links.assignee
  if (assignee?.title) return assignee.title
  return assignee?.href ? EM_DASH : UNASSIGNED_LABEL
}

/**
 * Format an OpenProject date field (`startDate` / `dueDate`) for display.
 *
 * Gated on {@link isCalendarDate} rather than handed straight to `Date`:
 * `new Date('not-a-dateT00:00:00Z')` is an Invalid Date, and
 * `toLocaleDateString` renders that as the literal string "Invalid Date" — a
 * worse answer than the em dash, and one the user can't act on. The same guard
 * rejects an impossible day like `2026-02-31`.
 *
 * Rendered at UTC for the same reason the calendar does all its date maths
 * there: a local-midnight parse shows `2026-01-01` as 31 December in any
 * negative-offset timezone.
 *
 * `locales` exists so tests can pin a locale; production passes nothing and
 * the OS locale wins, matching the day modal's date heading.
 *
 * `fallback` lets a caller name what the absence means — the panel passes
 * {@link NO_DUE_DATE_LABEL} / {@link NO_START_DATE_LABEL}, since an unset date
 * is a normal state for a work package rather than an unreadable field. It
 * covers the malformed case too: a value we can't parse is, as far as the user
 * is concerned, a date we don't have.
 */
export function formatWorkPackageDate(
  value: string | null | undefined,
  locales?: Intl.LocalesArgument,
  fallback: string = EM_DASH
): string {
  if (!value || !isCalendarDate(value)) return fallback
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(locales, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

/**
 * Display titles for the three HAL links the panel shows.
 *
 * The canonical display value is the link title, not the (usually absent)
 * top-level `type`/`status` string — see `src-tauri/src/schemas/work_packages.rs`.
 * An unset link is `{ href: null, title: null }`, so a falsy title is the
 * fallback condition rather than a missing key.
 */
export function workPackageTypeLabel(wp: WorkPackage): string {
  return wp._links.type?.title || EM_DASH
}

export function workPackageStatusLabel(wp: WorkPackage): string {
  return wp._links.status?.title || EM_DASH
}

/**
 * Text colour for a status, by title.
 *
 * Keyed on the title rather than the status resource's `isClosed` flag because
 * a work package's `_links.status` carries only `{ href, title }` — the flag
 * lives on the status *resource*, which the list doesn't fetch per row.
 *
 * Deliberately a short map, not an exhaustive one. OpenProject instances define
 * arbitrary statuses, so anything unrecognized falls back to
 * {@link STATUS_COLOR_DEFAULT} rather than being guessed at — a wrong colour
 * asserts something about a workflow we know nothing about. The entries here
 * are the common defaults plus the two the app already treats as primary
 * (`PRIMARY_STATUSES` in `work-package-filter.ts`).
 *
 * Returned as whole Tailwind class strings, and written as literals so
 * Tailwind's source scan can see them — a composed string like
 * `` `text-${name}` `` would produce a class that never gets generated.
 */
export const STATUS_COLOR_DEFAULT = 'text-muted'

const STATUS_COLORS = new Map<string, string>([
  // Active work — the same status the app sorts to the top.
  ['in progress', 'text-primary'],
  ['in development', 'text-primary'],
  // Queued, not started.
  ['to do', 'text-info'],
  ['new', 'text-info'],
  ['scheduled', 'text-info'],
  // Stalled: not failed, but not moving either.
  ['on hold', 'text-warning'],
  // Terminal, unsuccessful.
  ['rejected', 'text-error'],
  // Terminal, successful.
  ['closed', 'text-success'],
  ['done', 'text-success']
])

export function workPackageStatusColorClass(wp: WorkPackage): string {
  const title = wp._links.status?.title
  if (!title) return STATUS_COLOR_DEFAULT
  return STATUS_COLORS.get(title.toLowerCase()) ?? STATUS_COLOR_DEFAULT
}

export function workPackagePriorityLabel(wp: WorkPackage): string {
  return wp._links.priority?.title || EM_DASH
}

export function workPackageProjectLabel(wp: WorkPackage): string {
  return wp._links.project?.title || EM_DASH
}
