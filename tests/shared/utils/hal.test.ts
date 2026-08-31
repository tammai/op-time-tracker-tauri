import { describe, it, expect } from 'vitest'

import {
  formattableRaw,
  parseActivityIdFromHref,
  parseWorkPackageIdFromHref
} from '@shared/utils/hal'

// The frontend's own href parsers: it needs them to prefill the edit form from
// an existing entry. The backend's copy (`src-tauri/src/util/hal.rs`) is tested
// separately, and is the one that guards request paths.

describe('parseActivityIdFromHref', () => {
  it('parses the id from a canonical activity href', () => {
    expect(parseActivityIdFromHref('/api/v3/time_entries/activities/5')).toBe(5)
  })
  it('tolerates a trailing slash', () => {
    expect(parseActivityIdFromHref('/api/v3/time_entries/activities/12/')).toBe(12)
  })
  it('parses an absolute href', () => {
    expect(
      parseActivityIdFromHref(
        'https://openproject.example.com/api/v3/time_entries/activities/7'
      )
    ).toBe(7)
  })
  it('returns null for a non-numeric or negative segment', () => {
    expect(parseActivityIdFromHref('/api/v3/time_entries/activities/abc')).toBeNull()
    expect(parseActivityIdFromHref('/api/v3/time_entries/activities/-3')).toBeNull()
    expect(parseActivityIdFromHref('/api/v3/time_entries/activities/')).toBeNull()
  })
  it('returns null for an unrelated href', () => {
    expect(parseActivityIdFromHref('/api/v3/statuses/1')).toBeNull()
    expect(parseActivityIdFromHref('')).toBeNull()
  })
})

describe('parseWorkPackageIdFromHref', () => {
  it('parses the id from a canonical work package href', () => {
    expect(parseWorkPackageIdFromHref('/api/v3/work_packages/12345')).toBe(12345)
  })
  it('tolerates a trailing slash', () => {
    expect(parseWorkPackageIdFromHref('/api/v3/work_packages/42/')).toBe(42)
  })
  it('parses an absolute href', () => {
    expect(
      parseWorkPackageIdFromHref(
        'https://openproject.example.com/api/v3/work_packages/7'
      )
    ).toBe(7)
  })
  it('returns null for a non-numeric or negative segment', () => {
    expect(parseWorkPackageIdFromHref('/api/v3/work_packages/abc')).toBeNull()
    expect(parseWorkPackageIdFromHref('/api/v3/work_packages/-3')).toBeNull()
    expect(parseWorkPackageIdFromHref('/api/v3/work_packages/')).toBeNull()
  })
  it('returns null for a sub-resource rather than reading the wrong id', () => {
    // The id must be the last segment — `/12345/activities` is a different
    // resource, and returning 12345 for it would address the wrong thing.
    expect(
      parseWorkPackageIdFromHref('/api/v3/work_packages/12345/activities')
    ).toBeNull()
  })
  it('returns null for an unrelated href', () => {
    expect(parseWorkPackageIdFromHref('/api/v3/time_entries/9')).toBeNull()
    expect(parseWorkPackageIdFromHref('/api/v3/statuses/1')).toBeNull()
    expect(parseWorkPackageIdFromHref('')).toBeNull()
  })
  it('returns null for a non-string href', () => {
    // OpenProject sends an unset link as `{ "href": null }`, so the parsers
    // are handed `null`/`undefined` in practice, not just strings.
    expect(parseWorkPackageIdFromHref(null)).toBeNull()
    expect(parseWorkPackageIdFromHref(undefined)).toBeNull()
    expect(parseWorkPackageIdFromHref(12345)).toBeNull()
  })
  it('does not confuse the two collections', () => {
    // `/api/v3/time_entries/activities/5` ends in a numeric segment too.
    expect(
      parseWorkPackageIdFromHref('/api/v3/time_entries/activities/5')
    ).toBeNull()
    expect(parseActivityIdFromHref('/api/v3/work_packages/5')).toBeNull()
  })
})

/**
 * A Formattable arrives in three spellings depending on the instance, and both
 * trees read it — the detail panel to display a description, the draft to seed
 * the field that edits it. Untangling it in one place is what keeps those two
 * from disagreeing about what "empty" means.
 */
describe('formattableRaw', () => {
  it('reads the raw text out of the object form', () => {
    expect(
      formattableRaw({ format: 'markdown', raw: 'Body', html: '<p>Body</p>' })
    ).toBe('Body')
  })

  it('accepts the bare-string form older instances send', () => {
    expect(formattableRaw('Plain text')).toBe('Plain text')
  })

  it('reads an absent value as empty, however it is absent', () => {
    expect(formattableRaw(null)).toBe('')
    expect(formattableRaw(undefined)).toBe('')
    expect(formattableRaw({})).toBe('')
    expect(formattableRaw({ format: 'markdown', raw: null })).toBe('')
  })

  it('never returns the server’s rendered html', () => {
    // `html` is the server's rendering of `raw`; the editor writes `raw`, and
    // handing rendered markup to a field that edits source would be wrong twice.
    expect(formattableRaw({ raw: '**bold**', html: '<strong>bold</strong>' })).toBe(
      '**bold**'
    )
  })

  it('preserves whitespace — markdown reads trailing spaces as a line break', () => {
    expect(formattableRaw({ raw: 'line one  \nline two\n' })).toBe(
      'line one  \nline two\n'
    )
  })
})
