/**
 * An ISO `YYYY-MM-DD` calendar date — OpenProject's `spentOn`.
 *
 * Lives in `src/shared/` because both trees need the identical rule: the
 * frontend applies it to the date field so a bad day is caught inline, and the
 * backend re-applies it (`util::validation::validate_calendar_date`) before
 * building a request — webview input is never trusted
 * (`docs/security.md`).
 */

/** Shape only: four digits, two, two. Says nothing about the day existing. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether `value` is a well-formed ISO date **and** a day that exists.
 *
 * The round-trip through `Date` is what rejects `2026-02-31`: JS rolls an
 * overflowing day into the next month, so the re-formatted string differs from
 * the input. Parsed at UTC midnight so the check never shifts a day by timezone
 * — the same reason the calendar does all its date maths in UTC.
 */
export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
