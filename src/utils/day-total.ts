/**
 * How a day's logged total is coloured.
 *
 * Applies to **day totals only** — the calendar cell and the day modal's
 * "Xh logged" badge. An individual time entry stays neutral primary: 2h on one
 * entry isn't short of anything, it's the day it belongs to that is.
 *
 * Pure and unit-tested (see `tests/renderer/utils/day-total.test.ts`) so the
 * threshold lives in one place rather than in two templates.
 */

/** A full working day. Under it is short, over it is too much. */
export const FULL_WORKDAY_HOURS = 8

/**
 * Tolerance for float noise in the comparison against a full day.
 *
 * Durations arrive as ISO strings and become decimals, so a day of three
 * `PT2H40M` entries sums to `8.000000000000002` — exactly eight hours as far
 * as the user is concerned. Without this it would read as an overrun.
 */
const EPSILON = 1e-6

/** The three states a day's total can be in. */
export type DayTotalColor = 'warning' | 'success' | 'error'

/**
 * `success` on a full day, `warning` when short of one, `error` when over.
 *
 * Note this compares the *unrounded* total, while the badge shows a rounded
 * one — 7.96h displays as `8.0h` in a calendar cell but is still short, so it
 * stays `warning`. Colouring by the rounded figure instead would call a day
 * complete that isn't.
 */
export function dayTotalColor(hours: number): DayTotalColor {
  if (Math.abs(hours - FULL_WORKDAY_HOURS) < EPSILON) return 'success'
  return hours < FULL_WORKDAY_HOURS ? 'warning' : 'error'
}
