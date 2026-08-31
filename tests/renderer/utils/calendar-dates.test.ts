import { describe, it, expect } from 'vitest'

import {
  getMonthRange,
  getCalendarGridDays,
  formatYmd,
  CALENDAR_FIRST_DAY_OF_WEEK
} from '@renderer/utils/calendar-dates'

describe('getMonthRange', () => {
  it('July 2026 (month=6) → 2026-07-01 .. 2026-07-31', () => {
    expect(getMonthRange(2026, 6)).toEqual({
      start: '2026-07-01',
      end: '2026-07-31'
    })
  })

  it('February 2026 (non-leap) → ends on the 28th', () => {
    expect(getMonthRange(2026, 1)).toEqual({
      start: '2026-02-01',
      end: '2026-02-28'
    })
  })

  it('February 2024 (leap) → ends on the 29th', () => {
    expect(getMonthRange(2024, 1)).toEqual({
      start: '2024-02-01',
      end: '2024-02-29'
    })
  })

  it('January (month=0) → 31 days', () => {
    expect(getMonthRange(2026, 0).end).toBe('2026-01-31')
  })

  it('December (month=11) → 31 days', () => {
    expect(getMonthRange(2026, 11).end).toBe('2026-12-31')
  })
})

describe('getCalendarGridDays', () => {
  it('always returns exactly 42 cells (6×7 grid)', () => {
    // Sample across months with different weekday starts + leap years.
    for (const [y, m] of [
      [2026, 6],
      [2026, 1],
      [2024, 1],
      [2026, 0],
      [2026, 11],
      [2026, 4]
    ] as const) {
      expect(getCalendarGridDays(y, m)).toHaveLength(42)
    }
  })

  it('first cell of a month that starts on the grid’s first weekday is the 1st, inMonth', () => {
    // February 2026 starts on a Sunday (getUTCDay() === 0), and the grid is
    // Sunday-first (CALENDAR_FIRST_DAY_OF_WEEK === 0), so no leading days.
    expect(CALENDAR_FIRST_DAY_OF_WEEK).toBe(0)
    const cells = getCalendarGridDays(2026, 1)
    expect(cells[0].ymd).toBe('2026-02-01')
    expect(cells[0].inMonth).toBe(true)
    expect(cells[0].dayNumber).toBe(1)
  })

  it('leading cells (before the 1st) belong to the previous month, inMonth=false', () => {
    // July 2026 starts on a Wednesday (getUTCDay() === 3), Sunday-first grid
    // → 3 leading days from June 2026 (Sun/Mon/Tue = Jun 28/29/30).
    const cells = getCalendarGridDays(2026, 6)
    expect(cells[0].ymd).toBe('2026-06-28')
    expect(cells[0].inMonth).toBe(false)
    expect(cells[1].ymd).toBe('2026-06-29')
    expect(cells[1].inMonth).toBe(false)
    expect(cells[2].ymd).toBe('2026-06-30')
    expect(cells[2].inMonth).toBe(false)
    // The 4th cell is July 1st.
    expect(cells[3].ymd).toBe('2026-07-01')
    expect(cells[3].inMonth).toBe(true)
  })

  it('trailing cells (after the last day) belong to the next month, inMonth=false', () => {
    // July 2026 has 31 days; with 3 leading days, the in-month cells occupy
    // indices 3..33, and trailing cells start at index 34 = Aug 1.
    const cells = getCalendarGridDays(2026, 6)
    expect(cells[33].ymd).toBe('2026-07-31')
    expect(cells[33].inMonth).toBe(true)
    expect(cells[34].ymd).toBe('2026-08-01')
    expect(cells[34].inMonth).toBe(false)
    expect(cells[41].ymd).toBe('2026-08-08')
    expect(cells[41].inMonth).toBe(false)
  })

  it('all days of the target month appear with inMonth=true (28-day February)', () => {
    const cells = getCalendarGridDays(2026, 1)
    const inMonth = cells.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(28)
    expect(inMonth[0].ymd).toBe('2026-02-01')
    expect(inMonth[27].ymd).toBe('2026-02-28')
  })

  it('all days of the target month appear with inMonth=true (29-day leap February)', () => {
    const cells = getCalendarGridDays(2024, 1)
    const inMonth = cells.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(29)
    expect(inMonth[0].ymd).toBe('2024-02-01')
    expect(inMonth[28].ymd).toBe('2024-02-29')
  })

  it('all days of the target month appear with inMonth=true (31-day month)', () => {
    const cells = getCalendarGridDays(2026, 6) // July
    const inMonth = cells.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0].ymd).toBe('2026-07-01')
    expect(inMonth[30].ymd).toBe('2026-07-31')
  })

  it('dayNumber matches the cell’s day-of-month', () => {
    const cells = getCalendarGridDays(2026, 6)
    // First in-month cell is July 1.
    expect(cells[3].dayNumber).toBe(1)
    // Last in-month cell is July 31.
    expect(cells[33].dayNumber).toBe(31)
  })

  it('grid is Sunday-first (CALENDAR_FIRST_DAY_OF_WEEK === 0)', () => {
    // Documented convention: the leading-cell count equals the 1st’s
    // getUTCDay(), since first weekday is Sunday (0).
    const firstOfJuly = new Date(Date.UTC(2026, 6, 1)).getUTCDay()
    const cells = getCalendarGridDays(2026, 6)
    const leading = cells.filter((c) => !c.inMonth && c.date < new Date(Date.UTC(2026, 6, 1))).length
    expect(leading).toBe(firstOfJuly)
  })
})

describe('formatYmd', () => {
  it('formats a UTC Date as YYYY-MM-DD', () => {
    expect(formatYmd(new Date(Date.UTC(2026, 6, 15)))).toBe('2026-07-15')
  })

  it('is timezone-stable — pads single-digit month/day', () => {
    expect(formatYmd(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05')
  })

  it('handles year boundaries', () => {
    expect(formatYmd(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31')
    expect(formatYmd(new Date(Date.UTC(2027, 0, 1)))).toBe('2027-01-01')
  })
})