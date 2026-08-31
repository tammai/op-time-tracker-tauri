import { describe, it, expect } from 'vitest'

import type { WorkPackage } from '@opentracker/preload'

import {
  EM_DASH,
  formatSpentHours,
  NO_DUE_DATE_LABEL,
  NO_START_DATE_LABEL,
  STATUS_COLOR_DEFAULT,
  formatWorkPackageDate,
  workPackageAssigneeLabel,
  workPackagePriorityLabel,
  workPackageProjectLabel,
  workPackageStatusColorClass,
  workPackageStatusLabel,
  workPackageTypeLabel
} from '@renderer/utils/work-package-display'

/**
 * Build a `WorkPackage` carrying only the fields these display helpers read.
 * The `as unknown as WorkPackage` cast mirrors the sibling
 * `work-package-filter` / `work-package-label` tests: in production these are
 * called with full schema-validated objects, and the cast only satisfies the
 * type check for the subset under test.
 */
function makeWp(links: Record<string, unknown> = {}): WorkPackage {
  return {
    id: 42,
    _type: 'WorkPackage',
    subject: 'Fix login bug',
    _links: {
      self: { href: '/api/v3/work_packages/42' },
      ...links
    }
  } as unknown as WorkPackage
}

describe('formatSpentHours', () => {
  it('formats a decimal number to two places with an h suffix', () => {
    expect(formatSpentHours(3.5)).toBe('3.50h')
    expect(formatSpentHours(1)).toBe('1.00h')
    // Rounds rather than truncating, so a third-of-an-hour reads sensibly.
    expect(formatSpentHours(0.333333)).toBe('0.33h')
  })

  it('parses the ISO-8601 duration form OpenProject actually serializes', () => {
    // This is the whole reason the helper exists: current OpenProject versions
    // return `spentHours` as a duration, not a number.
    expect(formatSpentHours('PT3H30M')).toBe('3.50h')
    expect(formatSpentHours('PT45M')).toBe('0.75h')
    expect(formatSpentHours('PT2H')).toBe('2.00h')
  })

  it('renders zero as a real figure, not as unknown', () => {
    // "no time logged" is a fact; the em dash is reserved for "we don't know".
    expect(formatSpentHours(0)).toBe('0.00h')
    expect(formatSpentHours('PT0S')).toBe('0.00h')
  })

  it('renders null and undefined as an em dash', () => {
    expect(formatSpentHours(null)).toBe(EM_DASH)
    expect(formatSpentHours(undefined)).toBe(EM_DASH)
  })

  it('renders a malformed string as an em dash rather than throwing', () => {
    // `parseHoursToDecimal` throws on all of these; a single unparseable field
    // must not take down the row that contains it.
    for (const value of ['', '   ', 'PT', 'P', 'three hours', 'PT3X', '3h']) {
      expect(formatSpentHours(value)).toBe(EM_DASH)
    }
  })

  it('accepts a plain numeric string, which some instances emit', () => {
    expect(formatSpentHours('3.5')).toBe('3.50h')
    expect(formatSpentHours('0')).toBe('0.00h')
  })

  it('renders a non-finite number as an em dash', () => {
    expect(formatSpentHours(Number.NaN)).toBe(EM_DASH)
    expect(formatSpentHours(Number.POSITIVE_INFINITY)).toBe(EM_DASH)
  })
})

describe('workPackageAssigneeLabel', () => {
  it('uses the HAL link title when there is one', () => {
    expect(
      workPackageAssigneeLabel(
        makeWp({ assignee: { href: '/api/v3/users/7', title: 'Ada Lovelace' } })
      )
    ).toBe('Ada Lovelace')
  })

  it('says Unassigned for both shapes an unassigned work package arrives in', () => {
    // Observed on real instances: an absent link is either `{}` or an explicit
    // `{ href: null, title: null }`. Both mean nobody is assigned.
    expect(workPackageAssigneeLabel(makeWp({ assignee: {} }))).toBe('Unassigned')
    expect(
      workPackageAssigneeLabel(makeWp({ assignee: { href: null, title: null } }))
    ).toBe('Unassigned')
    // And the key missing altogether, which the schema's `.default({})` covers.
    expect(workPackageAssigneeLabel(makeWp())).toBe('Unassigned')
  })

  it('says "unknown" rather than "Unassigned" when a link exists with no title', () => {
    // Someone *is* assigned — claiming otherwise would be a false statement
    // about the work package, so this degrades to the unknown marker instead.
    expect(
      workPackageAssigneeLabel(makeWp({ assignee: { href: '/api/v3/users/7' } }))
    ).toBe(EM_DASH)
  })
})

describe('formatWorkPackageDate', () => {
  // An explicit locale keeps the assertion deterministic; production passes
  // `undefined` so the OS locale wins.
  const LOCALE = 'en-GB'

  it('formats a valid ISO calendar date', () => {
    expect(formatWorkPackageDate('2026-08-08', LOCALE)).toBe('8 Aug 2026')
  })

  it('renders the date at UTC, so it never shifts a day by timezone', () => {
    // The calendar does all its date maths in UTC; a local-midnight parse would
    // render 2026-01-01 as 31 Dec in any negative-offset zone.
    expect(formatWorkPackageDate('2026-01-01', LOCALE)).toBe('1 Jan 2026')
  })

  it('renders null, undefined, and empty as an em dash', () => {
    expect(formatWorkPackageDate(null, LOCALE)).toBe(EM_DASH)
    expect(formatWorkPackageDate(undefined, LOCALE)).toBe(EM_DASH)
    expect(formatWorkPackageDate('', LOCALE)).toBe(EM_DASH)
  })

  it('renders an unparseable or impossible date as an em dash, never "Invalid Date"', () => {
    for (const value of ['not-a-date', '2026-02-31', '2026-8-8', '20260808']) {
      expect(formatWorkPackageDate(value, LOCALE)).toBe(EM_DASH)
    }
  })

  it('uses a caller-supplied fallback for every absent-value form', () => {
    // The panel and the list say "No due date" rather than showing a dash: an
    // unset date is ordinary for a work package, and a bare dash reads as a
    // broken field.
    for (const value of [null, undefined, '']) {
      expect(formatWorkPackageDate(value, LOCALE, NO_DUE_DATE_LABEL)).toBe(
        NO_DUE_DATE_LABEL
      )
    }
    expect(formatWorkPackageDate(null, LOCALE, NO_START_DATE_LABEL)).toBe(
      NO_START_DATE_LABEL
    )
  })

  it('uses the fallback for an unreadable date too', () => {
    // A date we can't parse is, to the user, a date we don't have — surfacing
    // the field's own wording beats leaking a parse failure as a dash.
    expect(formatWorkPackageDate('not-a-date', LOCALE, NO_DUE_DATE_LABEL)).toBe(
      NO_DUE_DATE_LABEL
    )
  })

  it('still defaults to the em dash when no fallback is given', () => {
    expect(formatWorkPackageDate(null, LOCALE)).toBe(EM_DASH)
  })
})

describe('workPackageStatusColorClass', () => {
  const withStatus = (title: string | null): WorkPackage =>
    makeWp({ status: { href: '/api/v3/statuses/1', title } })

  it('colours the statuses it knows, case-insensitively', () => {
    expect(workPackageStatusColorClass(withStatus('In progress'))).toBe('text-primary')
    expect(workPackageStatusColorClass(withStatus('IN PROGRESS'))).toBe('text-primary')
    expect(workPackageStatusColorClass(withStatus('To do'))).toBe('text-info')
    expect(workPackageStatusColorClass(withStatus('On hold'))).toBe('text-warning')
    expect(workPackageStatusColorClass(withStatus('Rejected'))).toBe('text-error')
    expect(workPackageStatusColorClass(withStatus('Closed'))).toBe('text-success')
  })

  it('falls back for a status it does not know, rather than guessing', () => {
    // Instances define arbitrary statuses; asserting a colour for one we've
    // never seen would claim something about a workflow we know nothing about.
    expect(workPackageStatusColorClass(withStatus('Awaiting legal review'))).toBe(
      STATUS_COLOR_DEFAULT
    )
  })

  it('falls back when the status link carries no title', () => {
    expect(workPackageStatusColorClass(withStatus(null))).toBe(STATUS_COLOR_DEFAULT)
  })
})

describe('type / status / project labels', () => {
  it('read the HAL link titles', () => {
    const wp = makeWp({
      type: { href: '/api/v3/types/1', title: 'Task' },
      status: { href: '/api/v3/statuses/7', title: 'In Progress' },
      project: { href: '/api/v3/projects/3', title: 'Time Tracker' }
    })
    expect(workPackageTypeLabel(wp)).toBe('Task')
    expect(workPackageStatusLabel(wp)).toBe('In Progress')
    expect(workPackageProjectLabel(wp)).toBe('Time Tracker')
  })

  it('read the priority link title', () => {
    const wp = makeWp({ priority: { href: '/api/v3/priorities/8', title: 'High' } })
    expect(workPackagePriorityLabel(wp)).toBe('High')
  })

  it('fall back to an em dash when the link or its title is absent', () => {
    // `href: null` is how HAL — and the `HalLinkSchema` that models it —
    // represents an unset link; `project` is omitted entirely here.
    const wp = makeWp({
      type: { href: null, title: null },
      status: { href: null }
    })
    expect(workPackageTypeLabel(wp)).toBe(EM_DASH)
    expect(workPackageStatusLabel(wp)).toBe(EM_DASH)
    expect(workPackageProjectLabel(wp)).toBe(EM_DASH)
    expect(workPackagePriorityLabel(wp)).toBe(EM_DASH)
  })
})
