import { z } from 'zod'

/**
 * The work-package picker's search term.
 *
 * The dropdown searches by work-package **title**, so the term is free text.
 * Below `WORK_PACKAGE_SEARCH_MIN_CHARS` the picker only filters its
 * already-loaded items; at or above it, a term that matched nothing locally is
 * sent to the server so items outside the priority list become reachable.
 *
 * Lives in `src/shared/` because both trees need the identical rule: the
 * frontend applies it to keystrokes, and the backend re-applies it
 * before building a request — webview input is never trusted
 * (`docs/security.md`).
 */

/**
 * Hard cap on the term's length.
 *
 * Nothing on the OpenProject side requires it; it bounds what a keystroke can
 * push into a query string, and no useful subject search is this long.
 */
export const WORK_PACKAGE_SEARCH_MAX_CHARS = 100

/**
 * Shortest term that triggers a server search.
 *
 * A single character matches an appreciable fraction of any instance, so the
 * request would cost a round trip to return a list nobody can scan. Two is the
 * point where a subject substring starts to discriminate.
 */
export const WORK_PACKAGE_SEARCH_MIN_CHARS = 2

/**
 * Reduce a term to what should actually be matched against: trimmed, and with
 * the `#` stripped off an all-digits `#12345`.
 *
 * The `#` form is not an edge case — it is how this app labels every option
 * (`#12345 · Fix login bug`) and how OpenProject's own UI writes ids, so it is
 * the most likely thing a user pastes. Left alone it matches nothing: it isn't
 * the id (`'#12345' !== '12345'`) and `subjectOrId`'s `**` operator compares
 * ids exactly, so the server rejects it too.
 *
 * Only stripped when digits are all that follow, so a subject search for
 * `#hashtag` — or for a literal `#12345` inside a subject — is untouched.
 * Stripping is strictly more permissive anyway: `12345` still matches a
 * subject containing `#12345`.
 */
export function normalizeWorkPackageSearchTerm(raw: string): string {
  const trimmed = (raw ?? '').trim()
  return /^#\d+$/.test(trimmed) ? trimmed.slice(1) : trimmed
}

/**
 * A complete, server-searchable term: between
 * {@link WORK_PACKAGE_SEARCH_MIN_CHARS} and
 * {@link WORK_PACKAGE_SEARCH_MAX_CHARS} characters once trimmed. Anything
 * shorter is either still being typed or not a term at all.
 *
 * Trimming and `#`-stripping are part of the schema, so the parsed output —
 * not the raw input — is what callers send onward. The length bounds are
 * checked *before* normalizing, so `#7` is a valid two-character term that
 * resolves to the one-character id lookup `7`.
 */
export const WorkPackageSearchTermSchema = z
  .string()
  .trim()
  .min(
    WORK_PACKAGE_SEARCH_MIN_CHARS,
    `Search must be at least ${WORK_PACKAGE_SEARCH_MIN_CHARS} characters.`
  )
  .max(
    WORK_PACKAGE_SEARCH_MAX_CHARS,
    `Search must be at most ${WORK_PACKAGE_SEARCH_MAX_CHARS} characters.`
  )
  .transform(normalizeWorkPackageSearchTerm)

/**
 * Coerce raw keystrokes into the allowed shape — control characters dropped,
 * truncated to the cap. Applied on every input event, so it has to accept
 * partial terms (`''`, `'a'`) rather than reject them.
 *
 * Deliberately does *not* trim: a trailing space is how you type two words, so
 * stripping it mid-sentence would fight the user. {@link WorkPackageSearchTermSchema}
 * trims at the point the term is actually used.
 *
 * Control characters (including the newline a paste can carry) are the only
 * class removed — everything else is legitimate subject text, and the term is
 * percent-encoded into a query value rather than interpolated anywhere.
 */
export function sanitizeWorkPackageSearchInput(raw: string): string {
  return (raw ?? '')
    .replace(/\p{Cc}|\p{Cf}/gu, '')
    .slice(0, WORK_PACKAGE_SEARCH_MAX_CHARS)
}

/** Whether `value` is long enough and well-formed to query the server with. */
export function isWorkPackageSearchTerm(value: string): boolean {
  return WorkPackageSearchTermSchema.safeParse(value).success
}
