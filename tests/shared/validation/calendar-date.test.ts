import { describe, it, expect } from 'vitest'

import { isCalendarDate } from '@shared/validation/calendar-date'

describe('isCalendarDate', () => {
  it('accepts a real ISO calendar date', () => {
    expect(isCalendarDate('2026-07-25')).toBe(true)
    expect(isCalendarDate('2024-02-29')).toBe(true) // leap year
  })

  it('rejects a day that does not exist', () => {
    // The reason for the round-trip check: `new Date()` alone rolls these
    // forward into the next month instead of failing.
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2025-02-29')).toBe(false)
    expect(isCalendarDate('2026-04-31')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('2026-00-10')).toBe(false)
  })

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    for (const value of [
      '',
      '2026-7-25',
      '25-07-2026',
      '2026/07/25',
      '2026-07-25T10:00:00Z',
      ' 2026-07-25',
      'not-a-date'
    ]) {
      expect(isCalendarDate(value)).toBe(false)
    }
  })

  it('reads the date at UTC, so it never shifts by a day', () => {
    // The calendar and OpenProject's `spentOn` are both UTC calendar days;
    // parsing at local midnight would make the first of a month fail west of
    // Greenwich.
    expect(isCalendarDate('2026-01-01')).toBe(true)
    expect(isCalendarDate('2026-12-31')).toBe(true)
  })
})
