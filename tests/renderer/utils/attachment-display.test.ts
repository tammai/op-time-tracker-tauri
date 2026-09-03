import { describe, expect, it } from 'vitest'
import type { Attachment } from '@opentracker/preload'

import {
  EM_DASH,
  attachmentAuthorLabel,
  attachmentIcon,
  formatAttachmentTimestamp,
  formatFileSize,
  isImageAttachment
} from '@renderer/utils/attachment-display'

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 1,
    fileName: 'a.png',
    canDelete: false,
    proxyUrl: 'opattach://localhost/1',
    _links: {},
    ...overrides
  }
}

describe('formatFileSize', () => {
  it('picks the largest unit the value fits', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(24551)).toBe('24 KB')
    expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB')
    expect(formatFileSize(1024 ** 3 * 2)).toBe('2.0 GB')
  })

  it('shows a decimal only where it carries information', () => {
    // Bytes are never fractional, and a tenth of a kilobyte is noise past 10.
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(9.5 * 1024)).toBe('9.5 KB')
    expect(formatFileSize(99 * 1024)).toBe('99 KB')
  })

  it('does not run out of units', () => {
    expect(formatFileSize(1024 ** 6)).toContain('TB')
  })

  it('has a fallback for every value the server might not send', () => {
    expect(formatFileSize(undefined)).toBe(EM_DASH)
    expect(formatFileSize(null)).toBe(EM_DASH)
    expect(formatFileSize(-1)).toBe(EM_DASH)
    expect(formatFileSize(Number.NaN)).toBe(EM_DASH)
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe(EM_DASH)
  })
})

describe('formatAttachmentTimestamp', () => {
  it('shows the date and the time', () => {
    // Fixed locale so the assertion does not depend on the runner's.
    const formatted = formatAttachmentTimestamp('2024-05-21T08:51:20Z', 'en-GB')

    expect(formatted).toContain('2024')
    expect(formatted).toContain('May')
    // The time is what distinguishes two uploads of the same screenshot.
    expect(formatted).toMatch(/\d{2}:\d{2}/)
  })

  it('falls back rather than showing "Invalid Date"', () => {
    expect(formatAttachmentTimestamp(undefined)).toBe(EM_DASH)
    expect(formatAttachmentTimestamp(null)).toBe(EM_DASH)
    expect(formatAttachmentTimestamp('')).toBe(EM_DASH)
    expect(formatAttachmentTimestamp('not a date')).toBe(EM_DASH)
  })
})

describe('attachmentAuthorLabel', () => {
  it('reads the HAL link title', () => {
    expect(
      attachmentAuthorLabel(
        attachment({ _links: { author: { href: '/api/v3/users/1', title: 'Ada' } } })
      )
    ).toBe('Ada')
  })

  it('falls back for an unset link, in either of its two spellings', () => {
    expect(attachmentAuthorLabel(attachment({ _links: {} }))).toBe(EM_DASH)
    expect(
      attachmentAuthorLabel(attachment({ _links: { author: { href: null, title: null } } }))
    ).toBe(EM_DASH)
  })
})

describe('isImageAttachment', () => {
  it('reads the server-reported content type as a prefix', () => {
    for (const contentType of ['image/png', 'IMAGE/JPEG', ' image/webp', 'image/svg+xml']) {
      expect(isImageAttachment(attachment({ contentType })), contentType).toBe(true)
    }
  })

  it('is false for anything else, including a missing type', () => {
    for (const contentType of ['application/pdf', 'text/plain', 'notimage/png', '']) {
      expect(isImageAttachment(attachment({ contentType })), contentType).toBe(false)
    }
    expect(isImageAttachment(attachment())).toBe(false)
  })
})

describe('attachmentIcon', () => {
  it('picks an icon per family, with a generic fallback', () => {
    const cases: Array<[string | undefined, string]> = [
      ['image/png', 'i-lucide-image'],
      ['video/mp4', 'i-lucide-file-video'],
      ['audio/mpeg', 'i-lucide-file-audio'],
      ['application/pdf', 'i-lucide-file-text'],
      ['text/csv', 'i-lucide-file-text'],
      ['application/zip', 'i-lucide-file-archive'],
      [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'i-lucide-file-spreadsheet'
      ],
      ['application/octet-stream', 'i-lucide-file'],
      [undefined, 'i-lucide-file']
    ]
    for (const [contentType, icon] of cases) {
      expect(attachmentIcon(attachment({ contentType })), String(contentType)).toBe(icon)
    }
  })
})
