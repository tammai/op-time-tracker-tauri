import type { Attachment } from '@opentracker/preload'

/**
 * Display helpers for the attachments list.
 *
 * Pure functions here rather than expressions in the template, for the same
 * reason `utils/work-package-display.ts` exists: the fallback cases — no size,
 * an unparseable timestamp, an attachment whose uploader OpenProject did not
 * name — are the ones worth a test, and they are unreachable from inside a
 * `.vue` file.
 */

/** What every helper here shows in place of a value the server did not send. */
export const EM_DASH = '—'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * A byte count as a human-readable size.
 *
 * Powers of 1024 with the decimal-ish unit names, which is what OpenProject's
 * own UI shows — matching it matters more here than being pedantic about KiB,
 * because the two numbers sit side by side when somebody checks why an upload
 * was refused.
 *
 * One decimal place below 10 and none above it: "1.4 MB" is worth the digit,
 * "847.3 KB" is not.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return EM_DASH
  if (bytes === 0) return '0 B'

  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit += 1
  }

  // Bytes are never fractional, so the smallest unit shows no decimal at all.
  const decimals = unit === 0 || size >= 10 ? 0 : 1
  return `${size.toFixed(decimals)} ${UNITS[unit]}`
}

/**
 * An attachment's upload time, in the viewer's locale.
 *
 * Takes a full ISO timestamp, unlike `formatWorkPackageDate`, which takes a
 * calendar date — `createdAt` carries a time, and "yesterday at 14:02" is what
 * distinguishes two uploads of the same screenshot.
 */
export function formatAttachmentTimestamp(
  value: string | null | undefined,
  locales?: Intl.LocalesArgument
): string {
  if (!value) return EM_DASH
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return EM_DASH

  return parsed.toLocaleString(locales, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Who uploaded it.
 *
 * The HAL link title, which is the canonical display value — an unset link is
 * `{ href: null, title: null }`, so a falsy title is the fallback condition
 * rather than a missing key.
 */
export function attachmentAuthorLabel(attachment: Attachment): string {
  return attachment._links.author?.title || EM_DASH
}

/**
 * Whether the UI should offer an inline preview rather than a save.
 *
 * Reads the server-reported content type, hence the prefix test:
 * `image/png`, `image/svg+xml` and `image/jpeg; charset=binary` have all been
 * seen. The backend applies the same rule in `schemas::attachments`; this copy
 * exists because the *list* decides which row gets a thumbnail, and that is a
 * rendering decision.
 *
 * SVG is included here and neutralised by the proxy, which is not a
 * contradiction: the proxy relabels an SVG as `application/octet-stream` so it
 * cannot be rendered as a document, and an `<img>` will still not run script in
 * one. A broken thumbnail is the worst outcome.
 */
export function isImageAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? ''
  return contentType.startsWith('image/')
}

/** A Lucide icon name for a non-image attachment, from its content type. */
export function attachmentIcon(attachment: Attachment): string {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? ''
  if (contentType.startsWith('image/')) return 'i-lucide-image'
  if (contentType.startsWith('video/')) return 'i-lucide-file-video'
  if (contentType.startsWith('audio/')) return 'i-lucide-file-audio'
  if (contentType === 'application/pdf') return 'i-lucide-file-text'
  if (contentType.startsWith('text/')) return 'i-lucide-file-text'
  if (contentType.includes('zip') || contentType.includes('compressed')) {
    return 'i-lucide-file-archive'
  }
  if (contentType.includes('spreadsheet') || contentType.includes('excel')) {
    return 'i-lucide-file-spreadsheet'
  }
  return 'i-lucide-file'
}
