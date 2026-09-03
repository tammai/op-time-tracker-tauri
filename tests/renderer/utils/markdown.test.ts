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
