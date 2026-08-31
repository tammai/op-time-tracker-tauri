/**
 * Pure calendar grid / month-range helpers for the Calendar tab (task 7).
 *
 * These helpers are intentionally **pure**: no Vue, no bridge, no fetch.
 * They take plain numbers/strings and return plain data, so they can be
 * unit-tested in isolation (see `tests/renderer/utils/`).
 *
 * Timezone choice: all date math is done in **UTC**. OpenProject's
 * `spentOn` is an ISO `YYYY-MM-DD` calendar date with no time component,
 * so building `Date` objects with `Date.UTC(year, month, day)` and
 * formatting with `toISOString().slice(0, 10)` keeps the grid stable
 * regardless of the user's local timezone — a day cell never shifts
 * across timezones, and the `between` filter range always matches the
 * same calendar days the grid is rendering.
 */

/** Format a UTC `Date` as `YYYY-MM-DD` (no time, no timezone). */
export function formatYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Return the inclusive `YYYY-MM-DD` range for the first and last day of
 * the given month. `month` is 0-indexed (JS `Date` convention: 0 = Jan).
 *
 * Used to build the `spentOn: { between: [start, end] }` filter for the
 * time-entries query.
 */
export function getMonthRange(
  year: number,
  month: number
): { start: string; end: string } {
  const start = formatYmd(new Date(Date.UTC(year, month, 1)))
  // Last day of month = day 0 of the next month.
  const end = formatYmd(new Date(Date.UTC(year, month + 1, 0)))
  return { start, end }
}

/**
 * The first day-of-week the grid uses. `0` = Sunday, `1` = Monday.
 * We render a **Sunday-first** grid (common in calendar UIs and matches
 * Nuxt UI's own date components). Change this constant to switch.
 */
export const CALENDAR_FIRST_DAY_OF_WEEK = 0 as const

/** A single cell in the calendar grid. */
export interface CalendarCell {
  /** UTC midnight `Date` for the cell. */
  date: Date
  /** `YYYY-MM-DD` for the cell (precomputed for map lookups). */
  ymd: string
  /** True when this cell belongs to the target month. */
  inMonth: boolean
  /** Day-of-month number (1–31). */
  dayNumber: number
}

/**
 * Build the 6-row × 7-column (42-cell) calendar grid for the given month,
 * including leading days from the previous month and trailing days from
 * the next month (marked `inMonth: false`).
 *
 * Always 42 cells (6 weeks) so the grid height stays stable across
 * months — a 5-row February would otherwise jump the layout.
 *
 * `month` is 0-indexed (JS `Date` convention: 0 = Jan).
 */
export function getCalendarGridDays(
  year: number,
  month: number
): CalendarCell[] {
  const firstOfMonth = new Date(Date.UTC(year, month, 1))
  // `getUTCDay()`: 0 = Sun … 6 = Sat.
  const firstDayOfWeek = firstOfMonth.getUTCDay()
  const leading = (firstDayOfWeek - CALENDAR_FIRST_DAY_OF_WEEK + 7) % 7

  // Start from the first cell's date (leading days before the 1st).
  const start = new Date(Date.UTC(year, month, 1 - leading))

  const cells: CalendarCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + i
      )
    )
    cells.push({
      date: d,
      ymd: formatYmd(d),
      inMonth: d.getUTCMonth() === month,
      dayNumber: d.getUTCDate()
    })
  }
  return cells
}