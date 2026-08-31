import { describe, it, expect } from 'vitest'

import type { TimeEntry } from '@opentracker/preload'

import {
  canChangeDate,
  timeEntryCommentText,
  timeEntryHours,
  timeEntryWorkPackageNumber,
  toDateChangeInput,
  toTimeEntryDraft,
  type TimeEntryDraft
} from '@renderer/utils/time-entry-draft'

/**
 * Build a `TimeEntry` fixture, overriding only what a scenario cares about.
 * `as TimeEntry` mirrors `calendar-aggregation.test.ts`: the helpers under
 * test read a handful of fields, and in production they receive full
 * schema-validated objects.
 */
function makeEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 100,
    _type: 'TimeEntry',
    hours: 'PT1H30M',
    spentOn: '2026-07-25',
    createdAt: '2026-07-25T10:00:00Z',
    updatedAt: '2026-07-25T10:00:00Z',
    comment: { format: 'plain', raw: 'Reviewed the redesign spec' },
    _links: {
      self: { href: '/api/v3/time_entries/100' },
      workPackage: {
        href: '/api/v3/work_packages/42',
        title: 'Redesign the calendar grid'
      },
      project: { href: '/api/v3/projects/1' },
      user: { href: '/api/v3/users/1' },
      activity: { href: '/api/v3/time_entries/activities/3' }
    },
    ...overrides
  } as TimeEntry
}

describe('timeEntryCommentText', () => {
  it('reads the raw text of a Formattable comment', () => {
    expect(timeEntryCommentText(makeEntry())).toBe('Reviewed the redesign spec')
  })

  it('accepts a bare string comment', () => {
    expect(timeEntryCommentText(makeEntry({ comment: 'plain text' }))).toBe(
      'plain text'
    )
  })

  it('returns an empty string for a null or absent comment', () => {
    expect(timeEntryCommentText(makeEntry({ comment: null }))).toBe('')
    expect(timeEntryCommentText(makeEntry({ comment: undefined }))).toBe('')
  })
})

describe('timeEntryWorkPackageNumber', () => {
  it('formats the work package id from the HAL href', () => {
    expect(timeEntryWorkPackageNumber(makeEntry())).toBe('#42')
  })

  it('returns null when the href yields no id, so no bare "#" is shown', () => {
    for (const workPackage of [
      undefined,
      { href: null },
      { href: '/api/v3/work_packages/abc' }
    ]) {
      const entry = makeEntry({
        _links: { ...makeEntry()._links, workPackage }
      } as Partial<TimeEntry>)
      expect(timeEntryWorkPackageNumber(entry)).toBeNull()
    }
  })
})

describe('timeEntryHours', () => {
  it('converts the ISO duration to decimal hours', () => {
    expect(timeEntryHours(makeEntry({ hours: 'PT2H15M' }))).toBe(2.25)
  })

  it('counts an unreadable duration as 0 rather than throwing', () => {
    // Display-only: the day list shows `0.00h` instead of dropping the row.
    expect(timeEntryHours(makeEntry({ hours: 'not-a-duration' }))).toBe(0)
  })
})

describe('toTimeEntryDraft', () => {
  it('derives the form state from an entry', () => {
    expect(toTimeEntryDraft(makeEntry())).toEqual({
      id: 100,
      workPackageId: 42,
      workPackageSubject: 'Redesign the calendar grid',
      activityId: 3,
      spentOn: '2026-07-25',
      hours: 1.5,
      comment: 'Reviewed the redesign spec'
    })
  })

  it('carries the work package subject, so the select can label the item', () => {
    // The edited entry's work package is usually outside the loaded
    // suggestions; without the subject the select shows a bare `#42`.
    expect(toTimeEntryDraft(makeEntry())?.workPackageSubject).toBe(
      'Redesign the calendar grid'
    )
  })

  it('leaves the subject empty when the link carries no title', () => {
    // A labelling gap, not a reason to block the edit — the picker falls back
    // to `#42`.
    for (const title of [undefined, null]) {
      const entry = makeEntry({
        _links: {
          ...makeEntry()._links,
          workPackage: { href: '/api/v3/work_packages/42', title }
        }
      } as Partial<TimeEntry>)
      expect(toTimeEntryDraft(entry)?.workPackageSubject).toBe('')
    }
  })

  it('carries the entry’s date, so the row’s picker opens on it', () => {
    expect(toTimeEntryDraft(makeEntry({ spentOn: '2026-01-15' }))?.spentOn).toBe(
      '2026-01-15'
    )
  })

  it('leaves spentOn empty when the stored date is unusable', () => {
    // Not a null draft: the row keeps its actions, the picker just starts
    // blank instead of on a day the entry isn't actually on.
    for (const spentOn of ['', 'not-a-date', '2026-02-31']) {
      const draft = toTimeEntryDraft(makeEntry({ spentOn }))
      expect(draft).not.toBeNull()
      expect(draft?.spentOn).toBe('')
    }
  })

  it('leaves activityId undefined when the activity link is missing or unreadable', () => {
    // The form then falls back to the project's default activity — losing the
    // original is better than blocking the edit.
    for (const activity of [
      undefined,
      { href: null },
      { href: '/api/v3/time_entries/activities/abc' }
    ]) {
      const entry = makeEntry({
        _links: { ...makeEntry()._links, activity }
      } as Partial<TimeEntry>)
      expect(toTimeEntryDraft(entry)?.activityId).toBeUndefined()
    }
  })

  it('returns null when the work package href yields no id', () => {
    // No numeric id means the form would have to invent one, and saving would
    // rewrite the entry with it — so the row gets no pencil.
    for (const workPackage of [
      undefined,
      { href: null },
      { href: '/api/v3/work_packages/abc' },
      { href: '/api/v3/work_packages/-1' }
    ]) {
      const entry = makeEntry({
        _links: { ...makeEntry()._links, workPackage }
      } as Partial<TimeEntry>)
      expect(toTimeEntryDraft(entry)).toBeNull()
    }
  })

  it('returns null when the duration is unreadable or zero', () => {
    // Unlike the display path, a 0 here would silently rewrite the entry's
    // hours on save — and the form rejects a non-positive value anyway.
    expect(toTimeEntryDraft(makeEntry({ hours: 'not-a-duration' }))).toBeNull()
    expect(toTimeEntryDraft(makeEntry({ hours: 'PT0S' }))).toBeNull()
  })

  it('carries an empty comment through, so clearing one is expressible', () => {
    expect(toTimeEntryDraft(makeEntry({ comment: null }))?.comment).toBe('')
  })
})

/** The draft a readable entry produces — the starting point for a move. */
function makeDraft(overrides: Partial<TimeEntryDraft> = {}): TimeEntryDraft {
  return {
    id: 100,
    workPackageId: 42,
    workPackageSubject: 'Redesign the calendar grid',
    activityId: 3,
    spentOn: '2026-07-25',
    hours: 1.5,
    comment: 'Reviewed the redesign spec',
    ...overrides
  }
}

describe('canChangeDate', () => {
  it('allows a draft that carries an activity', () => {
    expect(canChangeDate(makeDraft())).toBe(true)
  })

  it('refuses a draft with no activity, and a missing draft', () => {
    // A move resends the whole entry and the row action has no activity
    // picker to fill the gap — unlike the edit form, which does.
    expect(canChangeDate(makeDraft({ activityId: undefined }))).toBe(false)
    expect(canChangeDate(null)).toBe(false)
    expect(canChangeDate(undefined)).toBe(false)
  })
})

describe('toDateChangeInput', () => {
  it('resends every other field unchanged, with the new date', () => {
    // Full replacement: dropping hours would zero them, dropping the comment
    // would clear it.
    expect(toDateChangeInput(makeDraft(), '2026-07-20')).toEqual({
      id: 100,
      workPackageId: 42,
      activityId: 3,
      spentOn: '2026-07-20',
      hours: 1.5,
      comment: 'Reviewed the redesign spec'
    })
  })

  it('omits an empty comment rather than sending an empty string', () => {
    const input = toDateChangeInput(makeDraft({ comment: '' }), '2026-07-20')
    expect(input).not.toBeNull()
    expect(input).not.toHaveProperty('comment')
  })

  it('refuses a date that is empty, malformed, or not a real day', () => {
    for (const date of ['', '20-07-2026', '2026-02-31']) {
      expect(toDateChangeInput(makeDraft(), date)).toBeNull()
    }
  })

  it('refuses a draft the move cannot be expressed for', () => {
    expect(
      toDateChangeInput(makeDraft({ activityId: undefined }), '2026-07-20')
    ).toBeNull()
  })
})
