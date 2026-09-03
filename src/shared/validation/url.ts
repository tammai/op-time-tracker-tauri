import { z } from 'zod'

import {
  ATTACHMENT_PROXY_SCHEME,
  ATTACHMENT_PROXY_WINDOWS_HOST
} from '@shared/constants/openproject'

/**
 * Result of validating a user-supplied OpenProject base URL.
 * On success, `url` is a normalized `URL` (origin trailing slash, no
 * surprising port normalization — just `new URL(input)`).
 */
export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: string }

/**
 * Validate that `input` is a well-formed `http` or `https` URL.
 *
 * The OpenProject base URL is user-controlled and used to build request URLs
 * downstream, so it must be a strict http(s) URL — no `file:`, `javascript:`,
 * `data:`, etc. Trims leading/trailing whitespace before parsing.
 *
 * Result-style: never throws. Returns `{ ok, error }` on failure so callers
 * can surface the message in the UI without try/catch noise.
 */
export function validateOpenProjectBaseUrl(input: string): UrlValidationResult {
  const trimmed = (input ?? '').trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'Base URL is required.' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Base URL must be a well-formed http(s) URL.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `Base URL must use http or https (got "${parsed.protocol}").`
    }
  }

  // Reject URLs with no host (e.g. `http://`).
  if (!parsed.hostname) {
    return { ok: false, error: 'Base URL must include a host.' }
  }

  return { ok: true, url: parsed }
}

/**
 * Whether `input` is a link we are willing to put in a document.
 *
 * Narrower than it looks like it needs to be, and deliberately: a description is
 * rendered back as rich text with clickable anchors, so a `javascript:` href
 * typed into the link dialog would execute on click, and `file:` would reach the
 * user's disk. Only `http(s)` earns an anchor.
 *
 * Bare `example.com` is rejected rather than guessed at — silently prefixing
 * `https://` would turn a typo into a link to somewhere the user didn't name.
 * The dialog says so instead.
 */
export function isSafeLinkHref(input: string): boolean {
  const trimmed = (input ?? '').trim()
  if (trimmed.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return parsed.hostname.length > 0
}

/**
 * Whether `input` is a source we are willing to load an image from.
 *
 * Everything `isSafeLinkHref` allows, plus this app's own attachment proxy
 * scheme. Kept separate rather than widening that function: an `opattach:` URL
 * is a legitimate *image source* and a useless *anchor href*, and only images
 * should be able to reach the scheme.
 *
 * Both platform spellings are accepted whichever platform is running —
 * `opattach://localhost/12` on macOS and Linux, `http://opattach.localhost/12`
 * on Windows. The Windows form already satisfies the http(s) rule, so it is
 * matched explicitly only to document that it is intentional.
 *
 * Note what this does *not* do: it never builds a proxy URL, and it does not
 * check that the id exists. The backend rewrites descriptions to these URLs and
 * refuses any path that is not one positive integer.
 */
export function isSafeImageSrc(input: string): boolean {
  const trimmed = (input ?? '').trim()
  if (trimmed.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol === `${ATTACHMENT_PROXY_SCHEME}:`) return parsed.hostname.length > 0
  if (parsed.protocol === 'http:' && parsed.hostname === ATTACHMENT_PROXY_WINDOWS_HOST) return true
  return isSafeLinkHref(trimmed)
}

/**
 * Zod schema encoding the same http(s) rule as `validateOpenProjectBaseUrl`.
 *
 * Used by the onboarding form and the credential save path so that both
 * UI-side and backend validation share one source of truth.
 */
export const OpenProjectBaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'Base URL is required.')
  .url('Base URL must be a well-formed http(s) URL.')
  .refine(
    (value) => {
      try {
        const u = new URL(value)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Base URL must use http or https.' }
  )

/**
 * Extract a single human-readable error message from a Zod error, suitable
 * for surfacing in the UI. Kept here so the onboarding form and the
 * credential save path share the same message formatting.
 */
export function formatUrlZodError(error: z.ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'Invalid base URL.'
}