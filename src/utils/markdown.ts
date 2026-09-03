import { Marked, Renderer, type Tokens } from 'marked'

import { escapeHtml } from '@renderer/utils/html'
import { renderOpenProjectHtml } from '@renderer/utils/openproject-html'
import { isSafeImageSrc, isSafeLinkHref } from '@shared/validation/url'

/**
 * Render OpenProject's raw Markdown without trusting either its stored HTML or
 * arbitrary HTML embedded in the Markdown itself.
 *
 * Marked's normal renderers already escape text and code. These overrides close
 * the remaining injection paths: only absolute http(s) destinations become
 * links, only those and this app's attachment proxy become images, and raw HTML
 * is displayed as text — *except* for the narrow set of constructs OpenProject's
 * own editor stores inside a description, which `renderOpenProjectHtml` rebuilds
 * from scratch. See that module for what is on the list and why the blanket
 * escape was not enough on its own.
 */
const renderer = new Renderer()

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string =>
  renderOpenProjectHtml(text) ?? escapeHtml(text)

renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
  const label = this.parser.parseInline(tokens)
  if (!isSafeLinkHref(href)) return label

  const safeTitle = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}"${safeTitle}>${label}</a>`
}

/**
 * `isSafeImageSrc`, not `isSafeLinkHref`: an inline attachment arrives as an
 * `opattach:` URL, which is a legitimate image source and a useless anchor
 * href. Everything else the two accept is identical.
 */
renderer.image = ({ href, title, text }: Tokens.Image): string => {
  if (!isSafeImageSrc(href)) return escapeHtml(text)

  const safeTitle = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${safeTitle}>`
}

const markdown = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer
})

export function renderMarkdown(source: string): string {
  const rendered = markdown.parse(source)
  return typeof rendered === 'string' ? rendered : ''
}
