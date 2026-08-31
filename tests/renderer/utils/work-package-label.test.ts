import { describe, it, expect } from 'vitest'

import {
  formatWorkPackageLabel,
  workPackageSelectionLabel
} from '@renderer/utils/work-package-label'

describe('formatWorkPackageLabel', () => {
  it('leads with the id, which is what a user looks up in OpenProject', () => {
    expect(formatWorkPackageLabel(12345, 'Redesign the calendar grid')).toBe(
      '#12345 · Redesign the calendar grid'
    )
  })

  it('drops the separator when there is no subject to put after it', () => {
    for (const subject of [undefined, null, '']) {
      expect(formatWorkPackageLabel(12345, subject)).toBe('#12345')
    }
  })
})

describe('workPackageSelectionLabel', () => {
  const seen = new Map([
    [12345, 'Redesign the calendar grid'],
    [12346, 'Fix the day modal']
  ])

  it('labels a selection the list no longer holds from what was shown', () => {
    // The regression: selecting a search result resets the search term in the
    // same tick, so the chosen item is gone from the results before the trigger
    // renders. The banked subject is the only thing left that knows its name.
    expect(workPackageSelectionLabel(12345, seen)).toBe(
      '#12345 · Redesign the calendar grid'
    )
  })

  it('falls back to a known subject for an id that was never shown', () => {
    // Edit mode: the entry's work package is rarely among the suggestions, so
    // its subject comes off the entry itself.
    expect(
      workPackageSelectionLabel(99999, seen, { id: 99999, subject: 'Ship v1' })
    ).toBe('#99999 · Ship v1')
  })

  it('ignores a known subject belonging to a different id', () => {
    // Otherwise a stale draft would label whatever the user picked next with
    // the edited entry's name.
    expect(
      workPackageSelectionLabel(77777, seen, { id: 99999, subject: 'Ship v1' })
    ).toBe('#77777')
  })

  it('prefers what was shown over the known subject', () => {
    // Both describe the same id; the list's own copy is the fresher one.
    expect(
      workPackageSelectionLabel(12346, seen, { id: 12346, subject: 'Stale name' })
    ).toBe('#12346 · Fix the day modal')
  })

  it('returns the id alone when nothing knows the subject', () => {
    expect(workPackageSelectionLabel(54321, seen)).toBe('#54321')
    expect(workPackageSelectionLabel(54321, seen, null)).toBe('#54321')
    expect(
      workPackageSelectionLabel(54321, seen, { id: 54321, subject: '' })
    ).toBe('#54321')
  })
})
