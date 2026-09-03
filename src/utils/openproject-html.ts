/**
 * The narrow set of HTML OpenProject stores inside a Markdown description.
 *
 * ## The problem this solves
 *
 * `utils/markdown.ts` renders every raw HTML token as escaped text, which is
 * the right default for content this app does not trust. But OpenProject's own
 * editor stores an inline image **as HTML**, because CommonMark has no figure or
 * caption node:
 *
 * ```html
 * <figure class="op-uc-figure">
 *   <img class="op-uc-image" src="/api/v3/attachments/12345/content">
 *   <figcaption class="op-uc-figure--description">A screenshot</figcaption>
 * </figure>
 * ```
 *
 * Escaped, the user reads the tags instead of seeing the screenshot. The blanket
 * rule cannot tell "OpenProject's own figure wrapper" apart from "an injected
 * `onerror` handler", so this module makes that distinction explicitly.
 *
 * ## What it will and will not render
 *
 * Only the constructs OpenProject actually emits, and each one is **rebuilt**
 * rather than passed through: the tag name comes from this file, and the only
 * attributes that survive are `src`, `alt` and `title`, re-escaped. Every event
 * handler, `style`, `class` and `data-*` attribute is dropped by construction,
 * not by a blocklist. An image source must satisfy `isSafeImageSrc`.
 *
 * Anything not listed here returns `null`, and the caller escapes it exactly as
 * before. That is the property worth preserving: **widening what renders is an
 * edit to this file, never a side effect of a change elsewhere.**
 *
 * Note the input is one of marked's HTML *tokens*, not the whole description.
 * That matters: a fenced code block showing `<img src=x>` is a different token
 * type and never reaches here, so a code sample about HTML is still displayed
 * as a code sample.
 */

import { decodeHtmlEntities, escapeHtml } from '@renderer/utils/html'
import { isSafeImageSrc } from '@shared/validation/url'

/**
 * Wrappers whose tags carry no meaning worth rendering, dropped rather than
 * escaped so their contents survive.
 *
 * Two different reasons land elements here:
 *
 * - OpenProject wraps tables and aligned blocks in a `<figure>`, and separates
 *   the tags from the content with blank lines — so marked emits the open and
 *   close tags as their own tokens with a correctly-rendered table between
 *   them. Escaping those two showed tags around the table.
 * - A `<mention>` is only ever a link to a user profile this app cannot open,
 *   and its text already reads as `@Ada`. Dropping the tags leaves exactly the
 *   name.
 */
const DROPPED_WRAPPERS = new Set([
  'div',
  'figure',
  'mention',
  'p',
  'section',
  'span'
])

const ATTRIBUTE =
  /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g

/** A complete figure, with everything between its tags. */
const FIGURE = /^<figure\b[^>]*>([\s\S]*?)<\/figure>$/i
/**
 * A lone open or close tag and nothing else.
 *
 * These are common, not exotic: marked only treats a fixed set of tag names as
 * *block* HTML. Everything else — `<mention>`, `<macro>` — is tokenised as an
 * inline open tag, its text, and an inline close tag, so a complete-element
 * pattern never sees it whole. The first capture says which of the two it is.
 */
const LONE_TAG = /^<(\/?)([a-zA-Z][\w-]*)\b[^>]*\/?>$/
/** A self-contained `<img>`, with or without a solidus. */
const IMAGE = /^<img\b([^>]*?)\/?>$/i
const LINE_BREAK = /^<br\b[^>]*\/?>$/i
/** OpenProject's embedded-content element: a table, a TOC, a child list. */
const MACRO = /^<macro\b([^>]*?)(?:\/>|>([\s\S]*?)<\/macro>)$/i
const MENTION = /^<mention\b[^>]*>([\s\S]*?)<\/mention>$/i
const FIGCAPTION = /^<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>$/i

/** The first `<img>` anywhere in a fragment, and its attributes. */
const NESTED_IMAGE = /<img\b([^>]*?)\/?>/i
const NESTED_FIGCAPTION = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i

/** Read one tag's attributes into a map, with entity references decoded. */
function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase()
    if (!name || found.has(name)) continue
    found.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return found
}

/**
 * Strip every tag out of a fragment, leaving its text.
 *
 * Used for the parts that have text worth keeping but no structure worth
 * rendering — a caption, a mention. The result is escaped by the caller.
 */
function textOf(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, '')).trim()
}

/**
 * Rebuild an `<img>` from its attributes.
 *
 * `null` when the source is missing or fails `isSafeImageSrc`, so the caller can
 * fall back to escaping the tag rather than emitting an image element that
 * points nowhere.
 */
function renderImage(rawAttributes: string): string | null {
  const attributeMap = attributes(rawAttributes)
  const source = attributeMap.get('src')?.trim() ?? ''
  if (!isSafeImageSrc(source)) return null

  const alt = attributeMap.get('alt') ?? ''
  const title = attributeMap.get('title')
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${titleAttribute}>`
}

/**
 * Render one of OpenProject's HTML constructs, or `null` to leave it escaped.
 *
 * Whitespace is trimmed first: a block-level token arrives with the newlines
 * that separated it from the surrounding Markdown.
 */
export function renderOpenProjectHtml(token: string): string | null {
  const source = token.trim()
  if (source.length === 0) return ''

  const figure = FIGURE.exec(source)
  if (figure) return renderFigure(figure[1] ?? '')

  const image = IMAGE.exec(source)
  if (image) return renderImage(image[1] ?? '')

  if (LINE_BREAK.test(source)) return '<br>'

  const macro = MACRO.exec(source)
  if (macro) return renderMacro(macro[1] ?? '')

  const mention = MENTION.exec(source)
  if (mention) {
    // A mention already reads as `@Name` in its own text; the element only
    // carried the link to the user's profile, which this app cannot open.
    return escapeHtml(textOf(mention[1] ?? ''))
  }

  const figcaption = FIGCAPTION.exec(source)
  if (figcaption) {
    return `<figcaption>${escapeHtml(textOf(figcaption[1] ?? ''))}</figcaption>`
  }

  const lone = LONE_TAG.exec(source)
  if (lone) {
    const isClosing = lone[1] === '/'
    const name = (lone[2] ?? '').toLowerCase()

    if (DROPPED_WRAPPERS.has(name)) return ''
    // A `<macro>` arrives split in two, because marked tokenises it inline.
    // The placeholder belongs on the *opening* tag; emitting it on both would
    // print it twice.
    if (name === 'macro') return isClosing ? '' : renderMacro(source)
  }

  return null
}

/**
 * Rebuild a figure around the image and caption it holds.
 *
 * A figure with no image is a wrapper around Markdown that marked already
 * rendered *outside* this token in the common case (OpenProject separates the
 * tags from the content with blank lines). Where it isn't — a table with no
 * surrounding blank line — the tags are dropped and the inner text is escaped,
 * which loses the table's formatting but never shows markup to the user.
 */
function renderFigure(inner: string): string {
  const image = NESTED_IMAGE.exec(inner)
  const caption = NESTED_FIGCAPTION.exec(inner)
  const captionText = caption ? escapeHtml(textOf(caption[1] ?? '')) : ''

  if (!image) {
    const text = textOf(inner)
    return text.length > 0 ? escapeHtml(text) : ''
  }

  const rendered = renderImage(image[1] ?? '')
  if (!rendered) {
    // The image points somewhere we will not load from. Its alt text — or
    // failing that, its caption — is the only thing left that carries meaning,
    // and an empty figure is better than a broken one.
    const alt = escapeHtml(attributes(image[1] ?? '').get('alt') ?? '')
    const fallback = alt || captionText
    return fallback ? `<p>${fallback}</p>` : ''
  }

  const captionElement = captionText ? `<figcaption>${captionText}</figcaption>` : ''
  return `<figure>${rendered}${captionElement}</figure>`
}

/**
 * A placeholder for an embedded macro.
 *
 * OpenProject renders these server-side from a query — an embedded work-package
 * table, a table of contents, a child list. There is nothing here to render them
 * from, and an empty gap would read as a description that lost a section, so the
 * placeholder says what is missing and where to see it.
 *
 * A `<span>`, not a `<p>`: marked tokenises `<macro>` inline, so the
 * placeholder lands inside a paragraph, and a `<p>` there would be invalid
 * nesting the browser silently rewrites.
 */
function renderMacro(rawAttributes: string): string {
  const kind = attributes(rawAttributes).get('class') ?? ''
  const label = kind.includes('toc')
    ? 'table of contents'
    : kind.includes('embedded-table')
      ? 'embedded work package table'
      : 'embedded content'
  return `<span class="op-uc-macro">${escapeHtml(
    `[${label} — open this work package in OpenProject to see it]`
  )}</span>`
}
