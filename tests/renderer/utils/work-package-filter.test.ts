import { describe, it, expect } from 'vitest'

import type { WorkPackage } from '@opentracker/preload'

import {
  PRIMARY_STATUSES,
  PRIMARY_STATUSES_LOWER,
  decideWorkPackageSearch,
  filterWorkPackagesByTerm,
  isPriorityWorkPackage,
  matchesWorkPackageTerm,
  sortByStatusPriority,
  statusRank
} from '@renderer/utils/work-package-filter'

/**
 * Build a minimal `WorkPackage` fixture with only the fields these helpers
 * read (`id`, `subject`, and the `_links` titles). Every other field is
 * unused by the pure helpers, so the `as WorkPackage` cast only satisfies
 * the type check — mirroring how they're called in production with full
 * schema-validated objects.
 */
function makeWp(
  id: number,
  subject: string,
  status?: string,
  type = 'Task',
  project = 'Time Tracker'
): WorkPackage {
  return {
    id,
    _type: 'WorkPackage',
    subject,
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      type: { href: '/api/v3/types/1', title: type },
      ...(status === undefined
        ? {}
        : { status: { href: '/api/v3/statuses/1', title: status } }),
      project: { href: '/api/v3/projects/1', title: project }
    }
  } as unknown as WorkPackage
}

describe('PRIMARY_STATUSES', () => {
  it('is the In Progress / To Do pair, mirrored lowercased', () => {
    expect(PRIMARY_STATUSES).toEqual(['In Progress', 'To Do'])
    expect([...PRIMARY_STATUSES_LOWER].sort()).toEqual(['in progress', 'to do'])
  })
})

describe('statusRank', () => {
  it('ranks In Progress before To Do', () => {
    expect(statusRank('In Progress')).toBeLessThan(statusRank('To Do'))
  })
  it('matches case-insensitively', () => {
    expect(statusRank('in progress')).toBe(statusRank('In Progress'))
    expect(statusRank('IN PROGRESS')).toBe(statusRank('In Progress'))
  })
  it('ranks unknown and missing statuses last', () => {
    expect(statusRank('Closed')).toBeGreaterThan(statusRank('To Do'))
    expect(statusRank(undefined)).toBeGreaterThan(statusRank('To Do'))
    expect(statusRank('')).toBeGreaterThan(statusRank('To Do'))
  })
})

describe('isPriorityWorkPackage', () => {
  it('accepts the priority statuses, case-insensitively', () => {
    expect(isPriorityWorkPackage(makeWp(1, 'a', 'In Progress'))).toBe(true)
    expect(isPriorityWorkPackage(makeWp(2, 'b', 'to do'))).toBe(true)
  })
  it('rejects other and missing statuses', () => {
    expect(isPriorityWorkPackage(makeWp(3, 'c', 'Closed'))).toBe(false)
    expect(isPriorityWorkPackage(makeWp(4, 'd', undefined))).toBe(false)
  })
})

describe('sortByStatusPriority', () => {
  it('puts In Progress first, then To Do, then everything else', () => {
    const sorted = sortByStatusPriority([
      makeWp(1, 'closed', 'Closed'),
      makeWp(2, 'todo', 'To Do'),
      makeWp(3, 'wip', 'In Progress')
    ])
    expect(sorted.map((w) => w.id)).toEqual([3, 2, 1])
  })

  it('preserves the server order among equal ranks (stable)', () => {
    const sorted = sortByStatusPriority([
      makeWp(1, 'a', 'To Do'),
      makeWp(2, 'b', 'To Do'),
      makeWp(3, 'c', 'To Do')
    ])
    expect(sorted.map((w) => w.id)).toEqual([1, 2, 3])
  })

  it('returns a new array without mutating the cached input', () => {
    const input = [makeWp(1, 'todo', 'To Do'), makeWp(2, 'wip', 'In Progress')]
    const originalOrder = input.map((w) => w.id)
    const sorted = sortByStatusPriority(input)
    expect(sorted).not.toBe(input)
    expect(input.map((w) => w.id)).toEqual(originalOrder)
  })
})


describe('matchesWorkPackageTerm', () => {
  const wp = makeWp(12345, 'Auth: fix login redirect', 'In Progress')

  it('matches a substring of the subject, not just a prefix', () => {
    // Subjects usually lead with a component prefix, so prefix-only matching
    // would make the most natural search term useless.
    expect(matchesWorkPackageTerm(wp, 'login')).toBe(true)
    expect(matchesWorkPackageTerm(wp, 'redirect')).toBe(true)
    expect(matchesWorkPackageTerm(wp, 'Auth')).toBe(true)
    expect(matchesWorkPackageTerm(wp, 'fix login')).toBe(true)
  })

  it('is case-insensitive on both sides', () => {
    expect(matchesWorkPackageTerm(wp, 'LOGIN')).toBe(true)
    expect(matchesWorkPackageTerm(wp, 'aUtH')).toBe(true)
    expect(matchesWorkPackageTerm(makeWp(1, 'UPPER CASE'), 'upper')).toBe(true)
  })

  it('ignores whitespace around the term', () => {
    expect(matchesWorkPackageTerm(wp, '  login  ')).toBe(true)
  })

  it('matches the id exactly, mirroring the server-side subjectOrId filter', () => {
    expect(matchesWorkPackageTerm(wp, '12345')).toBe(true)
    // Not a prefix: `12` would otherwise pull in every id starting with those
    // digits and bury the subject matches.
    expect(matchesWorkPackageTerm(wp, '123')).toBe(false)
    expect(matchesWorkPackageTerm(wp, '2345')).toBe(false)
  })

  it('still matches digits that appear inside the subject', () => {
    expect(matchesWorkPackageTerm(makeWp(7, 'Bump to v2.5'), '2.5')).toBe(true)
  })

  it('returns false when the term appears nowhere', () => {
    expect(matchesWorkPackageTerm(wp, 'payment')).toBe(false)
  })

  it('treats an empty or whitespace-only term as matching everything', () => {
    // Clearing the box restores the full suggestion list.
    expect(matchesWorkPackageTerm(wp, '')).toBe(true)
    expect(matchesWorkPackageTerm(wp, '   ')).toBe(true)
  })
})

describe('filterWorkPackagesByTerm', () => {
  const list = [
    makeWp(101, 'Auth: fix login redirect', 'In Progress'),
    makeWp(102, 'Billing: invoice PDF export', 'To Do'),
    makeWp(103, 'Auth: add login rate limit', 'To Do')
  ]

  it('keeps every match, in the input order', () => {
    expect(filterWorkPackagesByTerm(list, 'login').map((w) => w.id)).toEqual([
      101, 103
    ])
  })

  it('returns [] when nothing matches — the signal to search the server', () => {
    // An empty local result is precisely what triggers the API call, so this
    // must be an empty array rather than the unfiltered list.
    expect(filterWorkPackagesByTerm(list, 'payment gateway')).toEqual([])
  })

  it('returns everything for an empty term', () => {
    expect(filterWorkPackagesByTerm(list, '').map((w) => w.id)).toEqual([
      101, 102, 103
    ])
  })

  it('finds an item by its exact id', () => {
    expect(filterWorkPackagesByTerm(list, '102').map((w) => w.id)).toEqual([102])
  })

  it('returns a new array and never mutates the Colada-cached input', () => {
    const originalOrder = list.map((w) => w.id)
    const out = filterWorkPackagesByTerm(list, 'auth')
    expect(out).not.toBe(list)
    expect(list.map((w) => w.id)).toEqual(originalOrder)
  })
})

describe('matchesWorkPackageTerm — the `#id` form', () => {
  const wp = makeWp(12345, 'Auth: fix login redirect', 'In Progress')

  it('matches `#12345`, the exact label the picker renders', () => {
    // Regression: the free-text sanitizer stopped stripping `#`, which left
    // the app's own display format matching nothing at all.
    expect(matchesWorkPackageTerm(wp, '#12345')).toBe(true)
    expect(matchesWorkPackageTerm(wp, ' #12345 ')).toBe(true)
  })

  it('does not turn `#` into a wildcard for the wrong id', () => {
    expect(matchesWorkPackageTerm(wp, '#123')).toBe(false)
    expect(matchesWorkPackageTerm(wp, '#99999')).toBe(false)
  })

  it('still treats a non-id `#` term as subject text', () => {
    expect(matchesWorkPackageTerm(makeWp(1, 'Ship #hashtag support'), '#hashtag')).toBe(
      true
    )
    expect(matchesWorkPackageTerm(wp, '#hashtag')).toBe(false)
  })
})

describe('decideWorkPackageSearch', () => {
  const list = [
    makeWp(101, 'Auth: fix login redirect', 'In Progress'),
    makeWp(102, 'Billing: invoice PDF export', 'To Do')
  ]

  it('answers locally when the priority list matches — never reaching the server', () => {
    // The invariant the knowledge doc asserts: a term with local hits must
    // never produce a request.
    const d = decideWorkPackageSearch(list, 'login')
    expect(d.mode).toBe('local')
    expect(d.matches.map((w) => w.id)).toEqual([101])
  })

  it('answers locally for an empty term, showing the whole list', () => {
    const d = decideWorkPackageSearch(list, '')
    expect(d.mode).toBe('local')
    expect(d.matches).toHaveLength(2)
  })

  it('escalates to the server only on a local miss', () => {
    const d = decideWorkPackageSearch(list, 'payment gateway')
    expect(d.mode).toBe('server')
    expect(d.matches).toEqual([])
  })

  it('reports too-short instead of server for a sub-minimum term', () => {
    // The distinction the UI needs: nothing was sent, so "no work package
    // matches" would be a claim about the instance that was never checked.
    expect(decideWorkPackageSearch(list, 'z').mode).toBe('too-short')
  })

  it('treats `#7` as long enough, since it resolves to an id lookup', () => {
    expect(decideWorkPackageSearch(list, '#7').mode).toBe('server')
  })

  it('never escalates while the priority list is still loading', () => {
    // An unloaded list is empty, so every term would look like a local miss
    // and fire a request the local pass was about to answer.
    const d = decideWorkPackageSearch([], 'login', false)
    expect(d.mode).toBe('local')
    expect(d.matches).toEqual([])
  })

  it('does escalate once loaded and genuinely empty', () => {
    expect(decideWorkPackageSearch([], 'login', true).mode).toBe('server')
  })

  it('does not mutate the Colada-cached input', () => {
    const originalOrder = list.map((w) => w.id)
    decideWorkPackageSearch(list, 'auth')
    expect(list.map((w) => w.id)).toEqual(originalOrder)
  })
})
