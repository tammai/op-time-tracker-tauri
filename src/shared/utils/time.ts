/**
 * Pure time/duration helpers shared across the frontend.
 *
 * Lives under `src/shared/` so every frontend caller — the calendar's month
 * aggregation, the day totals, the entry rows — reads a duration through one
 * module. The backend keeps its own copy in `src-tauri/src/util/time.rs`, since
 * it is the side that builds requests; the two are deliberately parallel and
 * both are round-trip tested (`docs/architecture.md`).
 *
 * This module is **pure**: no Vue, no bridge, no fetch. Unit-testable in
 * isolation (see `tests/shared/utils/time.test.ts`).
 */

/**
 * Parse an ISO 8601 duration string (as returned by OpenProject's `hours`
 * field) into a decimal number of hours.
 *
 * OpenProject only emits the `PT…H…M…S` form (no date components, no
 * weeks/years), but we handle the full ISO 8601 duration grammar for
 * robustness. Returns the total hours as a number (e.g. `PT1H30M` → 1.5,
 * `PT45M` → 0.75, `PT2H` → 2, `PT0S` → 0).
 *
 * @throws {Error} if `input` is not a valid ISO 8601 duration. The Zod
 *   schema parse surfaces this as a validation error to the caller.
 */
export function parseHoursToDecimal(input: string): number {
  if (typeof input !== 'string') {
    throw new Error(
      `Invalid ISO 8601 duration: expected string, got ${typeof input}`
    )
  }
  // ISO 8601 duration: P[nY][nM][nW][nD]T[nH][nM][nS]
  // OpenProject only uses PT…H…M…S, but accept the full form.
  const match =
    /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      input
    )
  if (!match) {
    throw new Error(`Invalid ISO 8601 duration: "${input}"`)
  }
  // Reject the empty `P` / `PT` form (no components at all).
  const [, sign, years, months, weeks, days, hours, minutes, seconds] = match
  if (
    years === undefined &&
    months === undefined &&
    weeks === undefined &&
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    throw new Error(`Invalid ISO 8601 duration: "${input}" has no components`)
  }
  const totalHours =
    Number(years ?? 0) * 365 * 24 +
    Number(months ?? 0) * 30 * 24 +
    Number(weeks ?? 0) * 7 * 24 +
    Number(days ?? 0) * 24 +
    Number(hours ?? 0) +
    Number(minutes ?? 0) / 60 +
    Number(seconds ?? 0) / 3600
  const result = sign ? -totalHours : totalHours
  return Math.round(result * 1_000_000) / 1_000_000
}

/**
 * Format a decimal number of hours as an ISO 8601 duration string — the
 * inverse of `parseHoursToDecimal()`.
 *
 * The time-entry form collects decimal hours (`1.5`) but OpenProject's
 * `hours` field is an ISO 8601 duration (`PT1H30M`), so every write goes
 * through here.
 *
 * Rounds to whole seconds, then emits only the non-zero components
 * (`PT2H`, `PT45M`, `PT1H30M`, `PT1H0M30S` → `PT1H30S`). Zero formats as
 * `PT0S` rather than the invalid empty `PT`. Because rounding is to the
 * second, any value expressible in whole seconds round-trips exactly
 * through `parseHoursToDecimal()`.
 *
 * @throws {Error} if `hours` is not a finite, non-negative number.
 */
export function formatDecimalHoursToIso(hours: number): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    throw new Error(
      `Invalid decimal hours: expected a finite number, got ${String(hours)}`
    )
  }
  if (hours < 0) {
    throw new Error(`Invalid decimal hours: must not be negative, got ${hours}`)
  }

  const totalSeconds = Math.round(hours * 3600)
  if (totalSeconds === 0) return 'PT0S'

  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60

  let out = 'PT'
  if (h > 0) out += `${h}H`
  if (m > 0) out += `${m}M`
  if (s > 0) out += `${s}S`
  return out
}