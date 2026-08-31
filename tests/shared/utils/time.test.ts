import { describe, it, expect } from 'vitest'

import {
  parseHoursToDecimal,
  formatDecimalHoursToIso
} from '@shared/utils/time'

describe('parseHoursToDecimal', () => {
  it('PT1H30M → 1.5', () => {
    expect(parseHoursToDecimal('PT1H30M')).toBe(1.5)
  })
  it('PT45M → 0.75', () => {
    expect(parseHoursToDecimal('PT45M')).toBe(0.75)
  })
  it('PT2H → 2', () => {
    expect(parseHoursToDecimal('PT2H')).toBe(2)
  })
  it('PT0S → 0', () => {
    expect(parseHoursToDecimal('PT0S')).toBe(0)
  })
  it('PT1H → 1', () => {
    expect(parseHoursToDecimal('PT1H')).toBe(1)
  })
  it('PT1H30M45S → 1.5125 (45s = 0.0125h)', () => {
    expect(parseHoursToDecimal('PT1H30M45S')).toBeCloseTo(1.5125, 4)
  })
  it('PT30M → 0.5', () => {
    expect(parseHoursToDecimal('PT30M')).toBe(0.5)
  })
  it('PT90M → 1.5 (minutes overflow not normalized by server)', () => {
    expect(parseHoursToDecimal('PT90M')).toBe(1.5)
  })

  it('throws on malformed input (not ISO 8601)', () => {
    expect(() => parseHoursToDecimal('1.5h')).toThrow()
    expect(() => parseHoursToDecimal('garbage')).toThrow()
    expect(() => parseHoursToDecimal('')).toThrow()
  })
  it('throws on empty P / PT (no components)', () => {
    expect(() => parseHoursToDecimal('P')).toThrow()
    expect(() => parseHoursToDecimal('PT')).toThrow()
  })
  it('throws on non-string input', () => {
    // The schema catches this, but the helper guards too.
    expect(() => parseHoursToDecimal(123 as unknown as string)).toThrow()
  })
})

describe('formatDecimalHoursToIso', () => {
  it('1.5 → PT1H30M', () => {
    expect(formatDecimalHoursToIso(1.5)).toBe('PT1H30M')
  })
  it('0.75 → PT45M', () => {
    expect(formatDecimalHoursToIso(0.75)).toBe('PT45M')
  })
  it('2 → PT2H', () => {
    expect(formatDecimalHoursToIso(2)).toBe('PT2H')
  })
  it('0 → PT0S (never the invalid empty PT)', () => {
    expect(formatDecimalHoursToIso(0)).toBe('PT0S')
  })
  it('0.25 → PT15M (the form step)', () => {
    expect(formatDecimalHoursToIso(0.25)).toBe('PT15M')
  })
  it('omits zero components: 1.5125 → PT1H30M45S', () => {
    expect(formatDecimalHoursToIso(1.5125)).toBe('PT1H30M45S')
  })
  it('skips a zero minute component: 1 + 30s → PT1H30S', () => {
    expect(formatDecimalHoursToIso(1 + 30 / 3600)).toBe('PT1H30S')
  })
  it('rounds to whole seconds', () => {
    // 1/3 h = 1200.0000…s exactly; 0.00001 h = 0.036s rounds away.
    expect(formatDecimalHoursToIso(1 / 3)).toBe('PT20M')
    expect(formatDecimalHoursToIso(1 + 0.00001)).toBe('PT1H')
  })
  it('handles a full working day (8h)', () => {
    expect(formatDecimalHoursToIso(8)).toBe('PT8H')
  })

  it('throws on negative hours', () => {
    expect(() => formatDecimalHoursToIso(-1)).toThrow()
  })
  it('throws on non-finite / non-number input', () => {
    expect(() => formatDecimalHoursToIso(Number.NaN)).toThrow()
    expect(() => formatDecimalHoursToIso(Number.POSITIVE_INFINITY)).toThrow()
    expect(() =>
      formatDecimalHoursToIso('1.5' as unknown as number)
    ).toThrow()
  })

  it('round-trips through parseHoursToDecimal for minute-aligned values', () => {
    for (const h of [0.25, 0.5, 0.75, 1, 1.5, 2.25, 7.75, 8, 12, 24]) {
      expect(parseHoursToDecimal(formatDecimalHoursToIso(h))).toBe(h)
    }
  })
})