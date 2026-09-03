import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '@renderer/utils/markdown'

describe('renderMarkdown', () => {
  it('renders the formatting used by work package descriptions', () => {
    const html = renderMarkdown('# Heading\n\n**Bold** and _italic_.\n\n- One\n- Two')

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>One</li>')
  })

  it('escapes raw HTML instead of trusting OpenProject content', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')

    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('escapes the HTML that is not on the OpenProject list', () => {
    for (const source of [
      '<script>alert(1)</script>',
      '<iframe src="https://example.com"></iframe>',
      '<svg onload="alert(1)"></svg>'
    ]) {
      const html = renderMarkdown(source)
      expect(html, source).not.toContain(source)
      expect(html, source).toContain('&lt;')
    }
  })

  it('renders the figure OpenProject stores an inline image as', () => {
    // The whole point of `utils/openproject-html.ts`: escaped wholesale, this
    // showed the user the tags instead of the screenshot.
    const html = renderMarkdown(
      'Before\n\n<figure class="op-uc-figure">' +
        '<img class="op-uc-image" src="opattach://localhost/12345" alt="Shot">' +
        '<figcaption>Step 1</figcaption></figure>\n\nAfter'
    )

    expect(html).toContain('<img src="opattach://localhost/12345" alt="Shot">')
    expect(html).toContain('<figcaption>Step 1</figcaption>')
    expect(html).not.toContain('&lt;figure')
    expect(html).not.toContain('op-uc-figure')
    // The surrounding Markdown still renders as Markdown.
    expect(html).toContain('<p>Before</p>')
    expect(html).toContain('<p>After</p>')
  })

  it('renders an inline attachment written as a Markdown image', () => {
    expect(renderMarkdown('![Shot](opattach://localhost/12345)')).toContain(
      '<img src="opattach://localhost/12345" alt="Shot">'
    )
  })

  it('never makes an attachment URL a clickable link', () => {
    // `isSafeImageSrc` widens what an image may load; anchors stay http(s) only.
    expect(renderMarkdown('[Shot](opattach://localhost/12345)')).not.toContain('<a ')
  })

  it('leaves HTML inside a code block as a code sample', () => {
    // A fenced block is a different token type, so it never reaches the HTML
    // renderer — a description documenting `<figure>` still shows the markup.
    const html = renderMarkdown('```html\n<figure><img src="x"></figure>\n```')

    expect(html).toContain('<code')
    expect(html).toContain('&lt;figure&gt;')
    expect(html).not.toContain('<figure>')
  })

  it('renders only absolute http or https links', () => {
    expect(renderMarkdown('[Safe](https://example.com/path)')).toContain(
      '<a href="https://example.com/path">Safe</a>'
    )
    expect(renderMarkdown('[Unsafe](javascript:alert(1))')).not.toContain('<a ')
    expect(renderMarkdown('[Local](file:///etc/passwd)')).not.toContain('<a ')
  })

  it('does not create images for unsafe sources', () => {
    expect(renderMarkdown('![Alt](https://example.com/image.png)')).toContain(
      '<img src="https://example.com/image.png" alt="Alt">'
    )
    expect(renderMarkdown('![Alt](data:text/html,unsafe)')).not.toContain('<img ')
  })

  it('renders every GFM task as a checkbox item', () => {
    const html = renderMarkdown('- [x] First\n- [ ] Second\n- [ ] Third')

    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
    expect(html.match(/<li>/g)).toHaveLength(3)
    expect(html).toContain('<input checked="" disabled="" type="checkbox"> First')
  })
})
