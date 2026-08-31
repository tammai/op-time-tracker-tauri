import { describe, it, expect } from 'vitest'

import type { TimeEntry } from '@opentracker/preload'

import { aggregateTimeEntriesByDay } from '@renderer/utils/calendar-aggregation'

/**
 * Build a minimal `TimeEntry` fixture with only the fields the aggregator
 * reads (`spentOn`, `hours`) plus a stable id. The aggregator ignores every
 * other field, so we keep fixtures small and focused — one scenario per
 * fixture. `as TimeEntry` is safe here because `TimeEntry`'s required
 * `_links`/`createdAt`/etc. are unused by the pure helper; the cast only
 * satisfies the type check, mirroring how the helper is called in
 * production with full schema-validated objects.
 */
function makeEntry(id: number, spentOn: string | null, hours: string): TimeEntry {
  return {
    id,
    _type: 'TimeEntry',
    hours,
    spentOn: spentOn ?? '',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
    comment: null,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: '/api/v3/work_packages/1' },
      project: { href: '/api/v3/projects/1' },
      user: { href: '/api/v3/users/1' }
    }
  } as TimeEntry
}

describe('aggregateTimeEntriesByDay', () => {
  it('empty input → empty days map, zero totals', () => {
    const result = aggregateTimeEntriesByDay([])
    expect(result.days.size).toBe(0)
    expect(result.totalHours).toBe(0)
    expect(result.totalEntries).toBe(0)
  })

  it('single entry on one day → that day aggregates the entry; month totals match', () => {
    const entry = makeEntry(1, '2026-07-15', 'PT2H')
    const result = aggregateTimeEntriesByDay([entry])
    expect(result.days.size).toBe(1)
    expect(result.totalEntries).toBe(1)
    expect(result.totalHours).toBe(2)

    const day = result.days.get('2026-07-15')
    expect(day).toBeDefined()
    expect(day?.date).toBe('2026-07-15')
    expect(day?.hours).toBe(2)
    expect(day?.entryCount).toBe(1)
    expect(day?.entries).toEqual([entry])
  })

  it('multiple entries on the same day → hours summed, entryCount correct, all entries preserved', () => {
    const a = makeEntry(1, '2026-07-15', 'PT1H')
    const b = makeEntry(2, '2026-07-15', 'PT30M')
    const c = makeEntry(3, '2026-07-15', 'PT2H')
    const result = aggregateTimeEntriesByDay([a, b, c])
    expect(result.days.size).toBe(1)
    expect(result.totalEntries).toBe(3)
    expect(result.totalHours).toBe(3.5)

    const day = result.days.get('2026-07-15')
    expect(day?.hours).toBe(3.5)
    expect(day?.entryCount).toBe(3)
    expect(day?.entries).toEqual([a, b, c])
  })

  it('entries across multiple days → each day aggregates independently; month totals sum all', () => {
    const a = makeEntry(1, '2026-07-15', 'PT1H')
    const b = makeEntry(2, '2026-07-16', 'PT2H')
    const c = makeEntry(3, '2026-07-16', 'PT1H30M')
    const result = aggregateTimeEntriesByDay([a, b, c])
    expect(result.days.size).toBe(2)
    expect(result.totalEntries).toBe(3)
    expect(result.totalHours).toBe(4.5)

    expect(result.days.get('2026-07-15')?.hours).toBe(1)
    expect(result.days.get('2026-07-16')?.hours).toBe(3.5)
    expect(result.days.get('2026-07-16')?.entryCount).toBe(2)
  })

  it('entries with the same spentOn date → grouped into one day (not duplicated)', () => {
    const a = makeEntry(1, '2026-07-15', 'PT1H')
    const b = makeEntry(2, '2026-07-15', 'PT1H')
    const result = aggregateTimeEntriesByDay([a, b])
    expect(result.days.size).toBe(1)
    expect(result.days.get('2026-07-15')?.entryCount).toBe(2)
  })

  it('entry with null spentOn → skipped (not thrown)', () => {
    const valid = makeEntry(1, '2026-07-15', 'PT1H')
    const nullSpentOn = makeEntry(2, null, 'PT1H')
    const result = aggregateTimeEntriesByDay([valid, nullSpentOn])
    expect(result.days.size).toBe(1)
    expect(result.totalEntries).toBe(1)
    expect(result.totalHours).toBe(1)
    expect(result.days.has('2026-07-15')).toBe(true)
  })

  it('entry with empty-string spentOn → skipped', () => {
    const emptySpentOn = { ...makeEntry(1, '2026-07-15', 'PT1H'), spentOn: '' }
    const result = aggregateTimeEntriesByDay([emptySpentOn])
    expect(result.days.size).toBe(0)
    expect(result.totalEntries).toBe(0)
    expect(result.totalHours).toBe(0)
  })

  it('parses various ISO 8601 durations and sums them correctly', () => {
    const entries = [
      makeEntry(1, '2026-07-15', 'PT1H30M'), // 1.5
      makeEntry(2, '2026-07-15', 'PT45M'), // 0.75
      makeEntry(3, '2026-07-15', 'PT2H'), // 2
      makeEntry(4, '2026-07-15', 'PT0S') // 0
    ]
    const result = aggregateTimeEntriesByDay(entries)
    expect(result.totalHours).toBe(4.25)
    expect(result.days.get('2026-07-15')?.hours).toBe(4.25)
    expect(result.days.get('2026-07-15')?.entryCount).toBe(4)
  })

  it('PT1H + PT30M on the same day → exactly 1.5 (no float drift)', () => {
    const entries = [
      makeEntry(1, '2026-07-15', 'PT1H'),
      makeEntry(2, '2026-07-15', 'PT30M')
    ]
    const result = aggregateTimeEntriesByDay(entries)
    expect(result.days.get('2026-07-15')?.hours).toBe(1.5)
    expect(result.totalHours).toBe(1.5)
  })

  it('malformed hours string → contributes 0 rather than throwing', () => {
    const valid = makeEntry(1, '2026-07-15', 'PT1H')
    const junk = makeEntry(2, '2026-07-15', 'not-a-duration')
    const result = aggregateTimeEntriesByDay([valid, junk])
    expect(result.days.size).toBe(1)
    expect(result.totalEntries).toBe(2)
    expect(result.totalHours).toBe(1)
    expect(result.days.get('2026-07-15')?.hours).toBe(1)
    expect(result.days.get('2026-07-15')?.entryCount).toBe(2)
  })
})