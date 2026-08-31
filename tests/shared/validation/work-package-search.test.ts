import { describe, it, expect } from 'vitest'

import {
  WORK_PACKAGE_SEARCH_MAX_CHARS,
  WORK_PACKAGE_SEARCH_MIN_CHARS,
  WorkPackageSearchTermSchema,
  normalizeWorkPackageSearchTerm,
  isWorkPackageSearchTerm,
  sanitizeWorkPackageSearchInput
} from '@shared/validation/work-package-search'

describe('sanitizeWorkPackageSearchInput', () => {
  it('leaves ordinary subject text untouched', () => {
    for (const term of ['', 'a', 'bug', 'Fix login bug', 'Émile’s task — 50%']) {
      expect(sanitizeWorkPackageSearchInput(term)).toBe(term)
    }
  })

  it('keeps the characters an id search used to strip', () => {
    // The whole point of the change: letters, spaces, and punctuation are
    // subject text now, not noise to be filtered down to digits.
    expect(sanitizeWorkPackageSearchInput('#1234 report')).toBe('#1234 report')
    expect(sanitizeWorkPackageSearchInput('0012')).toBe('0012')
  })

  it('preserves surrounding whitespace so a term can be typed word by word', () => {
    // Trimming here would delete the space the moment you typed it, making
    // multi-word searches impossible. The schema trims at point of use instead.
    expect(sanitizeWorkPackageSearchInput('login ')).toBe('login ')
    expect(sanitizeWorkPackageSearchInput('  padded  ')).toBe('  padded  ')
  })

  it('drops control characters, including a newline carried by a paste', () => {
    // Escapes, never literals — an invisible character in a test file is a
    // future mystery, and a stray tab gets reformatted away by lint.
    expect(sanitizeWorkPackageSearchInput('login\nbug')).toBe('loginbug')
    expect(sanitizeWorkPackageSearchInput('tab\there')).toBe('tabhere')
    expect(sanitizeWorkPackageSearchInput('nul\u0000byte')).toBe('nulbyte')
    // U+200B ZERO WIDTH SPACE is a format character (Cf), not whitespace, so
    // trimming would never catch it — it would ride into the query invisibly.
    expect(sanitizeWorkPackageSearchInput('zero\u200Bwidth')).toBe('zerowidth')
    // A plain space is not a control character and must survive.
    expect(sanitizeWorkPackageSearchInput('two words')).toBe('two words')
  })

  it(`truncates to ${WORK_PACKAGE_SEARCH_MAX_CHARS} characters`, () => {
    const long = 'x'.repeat(WORK_PACKAGE_SEARCH_MAX_CHARS + 50)
    expect(sanitizeWorkPackageSearchInput(long)).toHaveLength(
      WORK_PACKAGE_SEARCH_MAX_CHARS
    )
    // Stripping runs before truncation, so control characters don't eat into
    // the budget of real characters.
    const padded = '\n'.repeat(20) + 'y'.repeat(WORK_PACKAGE_SEARCH_MAX_CHARS)
    expect(sanitizeWorkPackageSearchInput(padded)).toBe(
      'y'.repeat(WORK_PACKAGE_SEARCH_MAX_CHARS)
    )
  })

  it('treats a nullish input as empty', () => {
    expect(
      sanitizeWorkPackageSearchInput(undefined as unknown as string)
    ).toBe('')
  })

  it('is idempotent — sanitizing its own output changes nothing', () => {
    for (const raw of ['login\nbug', '#99', '  spaced  ', ' ', 'x'.repeat(200)]) {
      const once = sanitizeWorkPackageSearchInput(raw)
      expect(sanitizeWorkPackageSearchInput(once)).toBe(once)
    }
  })
})

describe('isWorkPackageSearchTerm', () => {
  it('accepts free text at or above the minimum length', () => {
    expect(isWorkPackageSearchTerm('ab')).toBe(true)
    expect(isWorkPackageSearchTerm('login bug')).toBe(true)
    expect(isWorkPackageSearchTerm('12345')).toBe(true)
    expect(isWorkPackageSearchTerm('x'.repeat(WORK_PACKAGE_SEARCH_MAX_CHARS))).toBe(
      true
    )
  })

  it('rejects terms below the minimum length', () => {
    for (const term of ['', 'a', '1']) {
      expect(isWorkPackageSearchTerm(term)).toBe(false)
    }
  })

  it('measures length after trimming', () => {
    // ' a ' is 3 raw characters but a 1-character term — searching it would
    // cost a round trip to match a large slice of the instance.
    expect(isWorkPackageSearchTerm(' a ')).toBe(false)
    expect(isWorkPackageSearchTerm('   ')).toBe(false)
    expect(isWorkPackageSearchTerm(' ab ')).toBe(true)
  })

  it('rejects terms over the maximum length', () => {
    expect(
      isWorkPackageSearchTerm('x'.repeat(WORK_PACKAGE_SEARCH_MAX_CHARS + 1))
    ).toBe(false)
  })
})

describe('WorkPackageSearchTermSchema', () => {
  it('returns the trimmed term, so a filter value never carries whitespace', () => {
    expect(WorkPackageSearchTermSchema.parse('  login bug  ')).toBe('login bug')
  })

  it('accepts exactly what sanitize produces, once it is long enough', () => {
    // The two have to agree, or the picker would either never fire a search or
    // fire one the backend then rejects.
    for (const raw of ['login\nbug', '  report  ', '#1234', 'x'.repeat(200)]) {
      const clean = sanitizeWorkPackageSearchInput(raw)
      if (clean.trim().length >= WORK_PACKAGE_SEARCH_MIN_CHARS) {
        expect(isWorkPackageSearchTerm(clean)).toBe(true)
      }
    }
  })
})

describe('normalizeWorkPackageSearchTerm', () => {
  it('strips the `#` off an all-digits id, the form the picker itself renders', () => {
    // Options read `#12345 · Fix login bug`, and OpenProject's own UI writes
    // ids the same way — so `#12345` is the likeliest thing to be pasted.
    expect(normalizeWorkPackageSearchTerm('#12345')).toBe('12345')
    expect(normalizeWorkPackageSearchTerm('  #7  ')).toBe('7')
  })

  it('leaves a `#` that is not an id prefix alone', () => {
    // Otherwise a subject search for a tag or a release name would be mangled.
    expect(normalizeWorkPackageSearchTerm('#hashtag')).toBe('#hashtag')
    expect(normalizeWorkPackageSearchTerm('#12ab')).toBe('#12ab')
    expect(normalizeWorkPackageSearchTerm('a #123')).toBe('a #123')
    expect(normalizeWorkPackageSearchTerm('##12')).toBe('##12')
  })

  it('trims without otherwise touching ordinary text', () => {
    expect(normalizeWorkPackageSearchTerm('  login bug  ')).toBe('login bug')
    expect(normalizeWorkPackageSearchTerm('')).toBe('')
    expect(normalizeWorkPackageSearchTerm('   ')).toBe('')
  })

  it('is idempotent', () => {
    for (const raw of ['#12345', '#hashtag', '  spaced  ', '##12']) {
      const once = normalizeWorkPackageSearchTerm(raw)
      expect(normalizeWorkPackageSearchTerm(once)).toBe(once)
    }
  })
})

describe('WorkPackageSearchTermSchema — `#id` handling', () => {
  it('accepts `#7` and resolves it to the one-character id lookup', () => {
    // Length is checked before normalizing, so the `#` buys the second
    // character that gets a single-digit id past the minimum.
    expect(WorkPackageSearchTermSchema.parse('#7')).toBe('7')
    expect(isWorkPackageSearchTerm('#7')).toBe(true)
  })

  it('accepts `#12345` and resolves it to the bare id', () => {
    expect(WorkPackageSearchTermSchema.parse('#12345')).toBe('12345')
  })

  it('still rejects a bare single character', () => {
    expect(isWorkPackageSearchTerm('7')).toBe(false)
  })
})
