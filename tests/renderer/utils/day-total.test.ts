import { describe, it, expect } from 'vitest'

import {
  FULL_WORKDAY_HOURS,
  dayTotalColor
} from '@renderer/utils/day-total'

describe('dayTotalColor', () => {
  it('is success on exactly a full working day', () => {
    expect(dayTotalColor(FULL_WORKDAY_HOURS)).toBe('success')
  })

  it('is warning below a full day', () => {
    expect(dayTotalColor(0)).toBe('warning')
    expect(dayTotalColor(0.25)).toBe('warning')
    expect(dayTotalColor(7.75)).toBe('warning')
  })

  it('is error above a full day', () => {
    expect(dayTotalColor(8.25)).toBe('error')
    expect(dayTotalColor(12)).toBe('error')
  })

  it('reads float noise as a full day, not a short one', () => {
    // Six `PT1H20M` entries — eight hours logged, but the decimals don't sum
    // cleanly (7.999999999999999), and an amber day for a full one is wrong.
    const oneHourTwenty = 1 + 20 / 60
    const sixBlocks = [...Array(6)].reduce((sum) => sum + oneHourTwenty, 0)
    expect(sixBlocks).not.toBe(FULL_WORKDAY_HOURS)
    expect(dayTotalColor(sixBlocks)).toBe('success')
  })

  it('still treats a genuine near-miss as short', () => {
    // Displayed as `8.0h` in a calendar cell, but it isn't a full day.
    expect(dayTotalColor(7.96)).toBe('warning')
  })
})
