import type { TimeEntry, UpdateTimeEntryInput } from '@opentracker/preload'

import { parseHoursToDecimal } from '@shared/utils/time'
import { isCalendarDate } from '@shared/validation/calendar-date'
import {
  parseActivityIdFromHref,
  parseWorkPackageIdFromHref
} from '@shared/utils/hal'

/**
 * Turning a server `TimeEntry` back into something the form can edit.
 *
 * The two representations don't line up: an entry carries its work package and
 * activity as HAL hrefs and its duration as an ISO 8601 string, while the form
 * (and `UpdateTimeEntryInput`) works in numeric ids and decimal hours. This
 * module is that translation, kept pure and out of the components so it can be
 * unit-tested — see `docs/conventions-frontend.md` (no business
 * logic in components).
 */

/** The form's edit-mode state, derived from an existing entry. */
export interface TimeEntryDraft {
  /** The entry being edited — becomes `UpdateTimeEntryInput.id`. */
  id: number
  workPackageId: number
  /**
   * The work package's subject, read off the entry's HAL link `title`. Empty
   * when the link carries none.
   *
   * Labels the form's work-package select while editing: the entry's item is
   * usually *not* among the loaded suggestions, and the select can only render
   * a label for an option it holds — so without this the trigger shows a bare
   * `#12345`. The subject is already in the entry, so carrying it costs no
   * extra request.
   */
  workPackageSubject: string
  /**
   * `undefined` when the entry's activity href yields no id. The form then
   * falls back to the project's default activity, the same as a new entry —
   * losing the original activity is better than blocking the edit.
   */
  activityId: number | undefined
  /**
   * The day the entry is logged against, `YYYY-MM-DD`. Prefills the row's date
   * action. Empty when the stored value isn't a real calendar date — the
   * picker then starts blank instead of on a day the entry isn't actually on.
   */
  spentOn: string
  hours: number
  comment: string
}

/**
 * The comment as plain text.
 *
 * OpenProject's `comment` is a Formattable object, but the schema also
 * tolerates a bare string or null (older and custom setups) — read all three
 * shapes rather than assuming one.
 */
export function timeEntryCommentText(entry: TimeEntry): string {
  const comment = entry.comment
  if (comment === null || comment === undefined) return ''
  if (typeof comment === 'string') return comment
  return comment.raw ?? ''
}

/**
 * The entry's work package as `#12345`, or `null` when the href yields no id.
 *
 * The list shows this next to the work package title: two entries against
 * similarly-named items are otherwise indistinguishable, and the number is what
 * a user looks up in OpenProject itself. `null` (an unreadable or missing href)
 * means the title stands alone rather than showing a `#` with nothing after it.
 */
export function timeEntryWorkPackageNumber(entry: TimeEntry): string | null {
  const id = parseWorkPackageIdFromHref(entry._links.workPackage?.href)
  return id === null ? null : `#${id}`
}

/**
 * Decimal hours for an entry; an unparseable duration counts as 0.
 *
 * Display-only: the day list shows `0.00h` for a duration it can't read rather
 * than dropping the row. `toTimeEntryDraft` deliberately does *not* use this —
 * a 0 there would silently rewrite the entry's hours on save.
 */
export function timeEntryHours(entry: TimeEntry): number {
  try {
    return parseHoursToDecimal(entry.hours)
  } catch {
    return 0
  }
}

/**
 * Build the form's edit state from an entry, or `null` when the entry can't be
 * edited safely.
 *
 * `null` means "no pencil on this row". That happens when the work package
 * href yields no positive integer id, or the duration doesn't parse — in
 * either case the form would have to invent a value, and saving would either
 * be rejected by the server or quietly overwrite the entry with the invented
 * one. Deleting such a row still works; it needs nothing but the id.
 */
export function toTimeEntryDraft(entry: TimeEntry): TimeEntryDraft | null {
  const workPackageId = parseWorkPackageIdFromHref(
    entry._links.workPackage?.href
  )
  if (workPackageId === null) return null

  let hours: number
  try {
    hours = parseHoursToDecimal(entry.hours)
  } catch {
    return null
  }
  if (!(hours > 0)) return null

  return {
    id: entry.id,
    workPackageId,
    // Absent title → empty, and the picker falls back to `#id`. A missing
    // subject is a labelling gap, never a reason to block the edit.
    workPackageSubject: entry._links.workPackage?.title ?? '',
    activityId: parseActivityIdFromHref(entry._links.activity?.href) ?? undefined,
    // Unlike the work package and the duration, an unreadable date doesn't
    // block the row: the picker just starts blank and the user chooses a day.
    spentOn: isCalendarDate(entry.spentOn) ? entry.spentOn : '',
    hours,
    comment: timeEntryCommentText(entry)
  }
}

/**
 * Whether the row's date action can be offered for `draft`.
 *
 * The update endpoint is a **full replacement**, so moving an entry means
 * resending every other field unchanged — including an activity id. A draft
 * without one can't express the move: the edit form fills that gap from the
 * project's activity list, but the row action has no such picker, and sending
 * no activity would be rejected. Those entries keep the pencil (where the gap
 * *can* be filled) and lose only the date button.
 */
export function canChangeDate(draft: TimeEntryDraft | null | undefined): boolean {
  return draft != null && draft.activityId !== undefined
}

/**
 * The update payload that moves `draft`'s entry to `spentOn`, or `null` when
 * the move isn't expressible.
 *
 * Every non-date field is carried over from the draft precisely because the
 * update replaces the whole entry — omitting the hours would zero them, and
 * omitting a non-empty comment would clear it. An empty comment is left off,
 * which is how "no comment" is written; the entry didn't have one either.
 *
 * `null` for a date that isn't a real calendar day (`2026-02-31`), so a
 * hand-typed value in the picker can't reach the server as-is. The main
 * process applies the same rule (`isCalendarDate`) and stays authoritative.
 */
export function toDateChangeInput(
  draft: TimeEntryDraft,
  spentOn: string
): UpdateTimeEntryInput | null {
  if (!canChangeDate(draft) || draft.activityId === undefined) return null
  if (!isCalendarDate(spentOn)) return null

  return {
    id: draft.id,
    workPackageId: draft.workPackageId,
    activityId: draft.activityId,
    spentOn,
    hours: draft.hours,
    ...(draft.comment !== '' ? { comment: draft.comment } : {})
  }
}
