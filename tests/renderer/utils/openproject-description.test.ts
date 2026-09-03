import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '@renderer/utils/markdown'

/**
 * End-to-end checks against the shapes OpenProject's own editor actually
 * serializes a description into, after the backend has pointed the attachment
 * URLs at the proxy scheme.
 *
 * These exist because unit-testing `renderOpenProjectHtml` on complete elements
 * was not enough: marked only treats a fixed set of tag names as *block* HTML,
 * so `<mention>` and `<macro>` arrive as a separate open tag, text, and close
 * tag. Both rendered as escaped markup until this file caught it. Anything added
 * to the recognised set belongs here as well as in the unit tests.
 */
describe('rendering a real OpenProject description', () => {
  it('renders a figure that sits between two paragraphs', () => {
    const html = renderMarkdown(
      [
        'Steps to reproduce:',
        '',
        '<figure class="op-uc-figure"><img class="op-uc-image" src="opattach://localhost/40023"></figure>',
        '',
        'Then it crashes.'
      ].join('\n')
    )

    expect(html).toContain('<p>Steps to reproduce:</p>')
    expect(html).toContain(
      '<figure><img src="opattach://localhost/40023" alt=""></figure>'
    )
    expect(html).toContain('<p>Then it crashes.</p>')
  })

  it('renders a figure whose tags and caption are on separate lines', () => {
    const html = renderMarkdown(
      [
        '<figure class="op-uc-figure op-uc-figure_align-center">',
        '<img class="op-uc-image" src="opattach://localhost/40024" alt="Error dialog">',
        '<figcaption class="op-uc-figure--description">The dialog we get</figcaption>',
        '</figure>'
      ].join('\n')
    )

    expect(html).toBe(
      '<figure><img src="opattach://localhost/40024" alt="Error dialog">' +
        '<figcaption>The dialog we get</figcaption></figure>'
    )
  })

  it('renders a table that OpenProject wrapped in a figure', () => {
    // The wrapper tags arrive as their own tokens with the Markdown table
    // between them, so dropping them is what lets the table render.
    const html = renderMarkdown(
      [
        '<figure class="op-uc-figure op-uc-figure_align-center">',
        '',
        '| Field | Value |',
        '|---|---|',
        '| a | b |',
        '',
        '</figure>'
      ].join('\n')
    )

    expect(html).toContain('<table>')
    expect(html).toContain('<th>Field</th>')
    expect(html).toContain('<td>b</td>')
    expect(html).not.toContain('figure')
  })

  it('renders an image inline in the middle of a sentence', () => {
    const html = renderMarkdown(
      'See the icon <img class="op-uc-image_inline" src="opattach://localhost/40025"> in the toolbar.'
    )

    expect(html).toBe(
      '<p>See the icon <img src="opattach://localhost/40025" alt=""> in the toolbar.</p>\n'
    )
  })

  it('reduces a mention to the name, though it arrives as three tokens', () => {
    const html = renderMarkdown(
      'Assigned to <mention class="mention" data-id="8" data-type="user" data-text="@Ada">@Ada</mention>.'
    )

    expect(html).toBe('<p>Assigned to @Ada.</p>\n')
  })

  it('replaces an embedded macro with a placeholder that says what it was', () => {
    const html = renderMarkdown(
      '<macro class="macro--embedded-table" data-query=\'{"c":["id"]}\'></macro>'
    )

    expect(html).toContain('embedded work package table')
    // Once, not twice: the opening tag carries the placeholder and the closing
    // tag carries nothing.
    expect(html.match(/op-uc-macro/g)).toHaveLength(1)
    // A span, so it nests legally inside the paragraph marked puts it in.
    expect(html).toContain('<span class="op-uc-macro">')
  })

  it('renders the Markdown image our own editor inserts', () => {
    expect(renderMarkdown('![shot](opattach://localhost/40026)')).toBe(
      '<p><img src="opattach://localhost/40026" alt="shot"></p>\n'
    )
  })

  it('leaves no escaped markup anywhere in any of these', () => {
    // The symptom that started this: a description showing its own tags.
    const sources = [
      '<figure class="op-uc-figure"><img src="opattach://localhost/1"></figure>',
      '<mention class="mention" data-id="8">@Ada</mention>',
      '<macro class="toc"></macro>',
      'text <img src="opattach://localhost/2"> more',
      '<br>'
    ]
    for (const source of sources) {
      expect(renderMarkdown(source), source).not.toMatch(
        /&lt;(br|figcaption|figure|img|macro|mention)/
      )
    }
  })
})
