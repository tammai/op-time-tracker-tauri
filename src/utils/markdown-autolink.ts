import { isSafeLinkHref } from '@shared/validation/url'

export interface HttpUrlRange {
  end: number
  href: string
  start: number
}

const HTTP_URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/giu
const SIMPLE_TRAILING_PUNCTUATION = /[.,!?;:]$/u
const BRACKET_PAIRS = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}']
] as const

function count(text: string, character: string): number {
  return [...text].filter((value) => value === character).length
}

/**
 * Remove sentence punctuation without breaking balanced brackets that are
 * genuinely part of the URL path.
 */
function trimTrailingPunctuation(candidate: string): string {
  let href = candidate

  while (SIMPLE_TRAILING_PUNCTUATION.test(href)) {
    href = href.slice(0, -1)
  }

  for (const [opening, closing] of BRACKET_PAIRS) {
    while (href.endsWith(closing) && count(href, closing) > count(href, opening)) {
      href = href.slice(0, -1)
    }
  }

  return href
}

/** Find absolute HTTP(S) URLs in one unformatted text node. */
export function findHttpUrlRanges(text: string): HttpUrlRange[] {
  const ranges: HttpUrlRange[] = []

  for (const match of text.matchAll(HTTP_URL_CANDIDATE)) {
    const candidate = match[0]
    const href = trimTrailingPunctuation(candidate)
    const start = match.index

    if (!href || start === undefined || !isSafeLinkHref(href)) continue
    ranges.push({ start, end: start + href.length, href })
  }

  return ranges
}
