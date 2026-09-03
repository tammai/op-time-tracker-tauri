/**
 * HTML escaping, shared by the two modules that produce markup by hand.
 *
 * `utils/markdown.ts` escapes whatever it will not render; `utils/openproject-html.ts`
 * escapes every attribute value and text run it re-emits. One implementation so
 * the two can never disagree about which characters matter.
 */

const HTML_CHARACTER = /[&<>"']/g
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(value: string): string {
  return value.replace(HTML_CHARACTER, (character) => HTML_ESCAPES[character] ?? character)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6})|([a-zA-Z]{2,8}));/g

/**
 * Decode the entity references that can appear inside an HTML attribute.
 *
 * Needed because attribute values are decoded on the way *in* and escaped again
 * on the way out — without the decode, an `alt="a &amp; b"` round-trips to
 * `a &amp;amp; b` and the user reads the escaping rather than the text.
 *
 * Deliberately not a full entity table: only the references OpenProject's own
 * serializer emits, plus numeric ones. Anything else is left as literal text,
 * which is what it looks like on screen anyway.
 */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value

  return value.replace(ENTITY, (match, decimal, hex, name) => {
    if (decimal) return codePointToString(Number.parseInt(decimal, 10)) ?? match
    if (hex) return codePointToString(Number.parseInt(hex, 16)) ?? match
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match
  })
}

function codePointToString(codePoint: number): string | null {
  // Surrogates and out-of-range values throw from `fromCodePoint`; a reference
  // to one is malformed, so it stays as the literal text it was written as.
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null
  return String.fromCodePoint(codePoint)
}
