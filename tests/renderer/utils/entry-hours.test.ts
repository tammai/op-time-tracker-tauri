import { describe, it, expect } from 'vitest'

import {
  HOURS_MIN,
  clampEntryHours
} from '@renderer/utils/entry-hours'

/**
 * The regression this covers: a value above the form's cap reached the server.
 * The hours control is a slider bounded by `min`/`max` now, so the cap can't be
 * exceeded from the UI — this stays as the last gate before the write, which is
 * where the original escape was caught.
 */

describe('clampEntryHours', () => {
  it('caps a value above the maximum', () => {
    expect(clampEntryHours(20, 8)).toBe(8)
    expect(clampEntryHours(8.25, 8)).toBe(8)
  })

  it('raises a value below the minimum', () => {
    expect(clampEntryHours(0, 8)).toBe(HOURS_MIN)
    expect(clampEntryHours(0.1, 8)).toBe(HOURS_MIN)
  })

  it('leaves a value inside the range alone', () => {
    // Including one off the quarter-hour grid: snapping is the input's job, and
    // doing it here too would give two different answers for one edit.
    expect(clampEntryHours(1.3, 8)).toBe(1.3)
    expect(clampEntryHours(8, 8)).toBe(8)
    expect(clampEntryHours(HOURS_MIN, 8)).toBe(HOURS_MIN)
  })

  it('honours whichever maximum it is handed', () => {
    // The form passes one cap (a working day) in both modes, but the helper
    // stays parameterised — the backend's own limit is looser, and the two
    // shouldn't be welded together here.
    expect(clampEntryHours(20, 24)).toBe(20)
    expect(clampEntryHours(30, 24)).toBe(24)
  })
})
