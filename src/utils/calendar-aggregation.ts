/**
 * Pure time-entry aggregation for the Calendar tab (task 7).
 *
 * Groups a flat list of `TimeEntry` objects by their `spentOn` date and
 * sums the hours per day, plus month-wide totals. The result drives the
 * calendar grid's per-day hours + entry counts.
 *
 * This module is **pure**: no Vue, no bridge, no fetch. It imports only
 * the shared `parseHoursToDecimal` (a pure string → number parser from
 * `src/shared/utils/time.ts`) and the `TimeEntry` *type* (type-only,
 * erased at compile time). Task 8 unit-tests it directly.
 */

import type { TimeEntry } from '@opentracker/preload'

import { parseHoursToDecimal } from '@shared/utils/time'

/**
 * Parse an entry's `hours` ISO 8601 duration, returning 0 on failure
 * instead of throwing. The schema layer has already validated real
 * OpenProject responses, so this only guards the pure aggregator against
 * caller-supplied junk — it must never throw on bad input.
 */
function safeParseHours(input: string): number {
  try {
    return parseHoursToDecimal(input)
  } catch {
    return 0
  }
}

/**
 * Aggregated totals for a single calendar day.
 */
export interface DayAggregate {
  /** `YYYY-MM-DD` — matches the entry's `spentOn`. */
  date: string
  /** Sum of hours for that day, as a decimal (e.g. `1.5`). */
  hours: number
  /** How many time entries fall on that day. */
  entryCount: number
  /** The raw entries (for hover/tooltip detail later). */
  entries: TimeEntry[]
}

/**
 * Aggregated totals for an entire month (or any flat entry list).
 */
export interface MonthAggregate {
  /** Per-day aggregates, keyed by `YYYY-MM-DD`. */
  days: Map<string, DayAggregate>
  /** Sum of hours across all entries. */
  totalHours: number
  /** Total number of entries. */
  totalEntries: number
}

/**
 * Group `entries` by `spentOn` and sum hours per day.
 *
 * - Empty input → empty `days` map, 0 totals (not an error).
 * - Entries with a null/empty/missing `spentOn` are **skipped**
 *   defensively — OpenProject always populates it, but a malformed entry
 *   must never break the whole grid.
 * - `hours` is parsed via `parseHoursToDecimal` (the single shared
 *   parser). An unparseable `hours` string contributes 0 to that day's
 *   total rather than throwing — the schema layer has already validated
 *   real responses, so this only guards against caller-supplied junk.
 * - The `entries` array on each `DayAggregate` preserves the original
 *   entry object references (rendered later as tooltips).
 */
export function aggregateTimeEntriesByDay(
  entries: TimeEntry[]
): MonthAggregate {
  const days = new Map<string, DayAggregate>()
  let totalHours = 0
  let totalEntries = 0

  for (const entry of entries) {
    const date = entry?.spentOn
    if (typeof date !== 'string' || date.length === 0) continue

    // `hours` is schema-validated upstream; guard defensively so a
    // malformed entry contributes 0 rather than throwing the whole
    // aggregation (and so the pure helper never throws on bad input).
    const hours = safeParseHours(entry.hours)

    const existing = days.get(date)
    if (existing) {
      existing.hours += hours
      existing.entryCount += 1
      existing.entries.push(entry)
    } else {
      days.set(date, {
        date,
        hours,
        entryCount: 1,
        entries: [entry]
      })
    }

    totalHours += hours
    totalEntries += 1
  }

  return { days, totalHours, totalEntries }
}