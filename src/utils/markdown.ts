import { Marked, Renderer, type Tokens } from 'marked'

import { isSafeLinkHref } from '@shared/validation/url'

const HTML_CHARACTER = /[&<>"']/g
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(value: string): string {
  return value.replace(HTML_CHARACTER, (character) => HTML_ESCAPES[character] ?? character)
}

/**
 * Render OpenProject's raw Markdown without trusting either its stored HTML or
 * arbitrary HTML embedded in the Markdown itself.
 *
 * Marked's normal renderers already escape text and code. These overrides close
 * the two remaining injection paths: raw HTML is displayed as text, and only
 * absolute http(s) destinations become links or images. The same URL policy is
 * used by the editor's link dialog.
 */
const renderer = new Renderer()

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text)

renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
  const label = this.parser.parseInline(tokens)
  if (!isSafeLinkHref(href)) return label

  const safeTitle = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}"${safeTitle}>${label}</a>`
}

renderer.image = ({ href, title, text }: Tokens.Image): string => {
  if (!isSafeLinkHref(href)) return escapeHtml(text)

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
