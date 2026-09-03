import { describe, expect, it } from 'vitest'

import { renderOpenProjectHtml } from '@renderer/utils/openproject-html'

/**
 * The proxy URL an inline attachment arrives as. Written out rather than built
 * from the constant so the test would fail if the scheme silently changed —
 * that string is half of a contract with the Rust side.
 */
const PROXY = 'opattach://localhost/12345'

describe('renderOpenProjectHtml', () => {
  it('renders the figure OpenProject stores an inline image as', () => {
    const html = renderOpenProjectHtml(
      `<figure class="op-uc-figure"><img class="op-uc-image" src="${PROXY}"></figure>`
    )

    expect(html).toBe(`<figure><img src="${PROXY}" alt=""></figure>`)
  })

  it('keeps the caption and drops everything else the figure carried', () => {
    const html = renderOpenProjectHtml(
      `<figure class="op-uc-figure op-uc-figure_align-center" style="width:40%">
         <img class="op-uc-image" src="${PROXY}" alt="Login screen" width="600">
         <figcaption class="op-uc-figure--description">Step 1</figcaption>
       </figure>`
    )

    expect(html).toBe(
      `<figure><img src="${PROXY}" alt="Login screen"><figcaption>Step 1</figcaption></figure>`
    )
    // Rebuilt, not filtered: nothing OpenProject sent but `src`/`alt`/`title`
    // can appear, whatever it was called.
    expect(html).not.toContain('class')
    expect(html).not.toContain('style')
    expect(html).not.toContain('width')
  })

  it('renders a standalone image tag', () => {
    expect(renderOpenProjectHtml(`<img src="${PROXY}" alt="Shot">`)).toBe(
      `<img src="${PROXY}" alt="Shot">`
    )
    // With a solidus, unquoted attributes, and odd spacing.
    expect(renderOpenProjectHtml(`<img  src='${PROXY}'  alt=Shot />`)).toBe(
      `<img src="${PROXY}" alt="Shot">`
    )
  })

  it('renders an https image, which a description may legitimately hold', () => {
    expect(renderOpenProjectHtml('<img src="https://example.com/a.png">')).toBe(
      '<img src="https://example.com/a.png" alt="">'
    )
  })

  it('refuses to build an image element for an unsafe source', () => {
    // `null` means "leave it escaped" — the caller's blanket rule still applies.
    for (const tag of [
      '<img src="javascript:alert(1)">',
      '<img src="data:text/html,<script>alert(1)</script>">',
      '<img src="file:///etc/passwd">',
      '<img src="/api/v3/attachments/1/content">',
      '<img alt="no source">',
      '<img src="">'
    ]) {
      expect(renderOpenProjectHtml(tag), tag).toBeNull()
    }
  })

  it('never re-emits an event handler, however it was written', () => {
    for (const tag of [
      `<img src="${PROXY}" onerror="alert(1)">`,
      `<img src="${PROXY}" ONLOAD='alert(1)'>`,
      `<img src="${PROXY}" onerror=alert(1)>`
    ]) {
      const html = renderOpenProjectHtml(tag)
      expect(html, tag).toBe(`<img src="${PROXY}" alt="">`)
      expect(html).not.toMatch(/on[a-z]+=/i)
      expect(html).not.toContain('alert')
    }
  })

  it('cannot be made to break out of the src or alt attribute', () => {
    const html = renderOpenProjectHtml(
      `<img src="${PROXY}" alt='" onerror="alert(1)'>`
    )

    expect(html).toBe(`<img src="${PROXY}" alt="&quot; onerror=&quot;alert(1)">`)
    expect(html).not.toMatch(/onerror="/)
  })

  it('decodes entities in an attribute exactly once', () => {
    // Decoded on the way in and escaped on the way out, so the user reads the
    // text rather than the escaping.
    expect(renderOpenProjectHtml(`<img src="${PROXY}" alt="Tom &amp; Jerry">`)).toBe(
      `<img src="${PROXY}" alt="Tom &amp; Jerry">`
    )
    expect(renderOpenProjectHtml(`<img src="${PROXY}" alt="&#65;&#x42;">`)).toBe(
      `<img src="${PROXY}" alt="AB">`
    )
  })

  it('drops the wrapper tags OpenProject puts around a rendered block', () => {
    // Its serializer emits these as their own tokens, with the Markdown table
    // or aligned block between them.
    for (const tag of [
      '<figure class="op-uc-figure">',
      '</figure>',
      '<div class="op-uc-container">',
      '</div>',
      '<p>',
      '</p>',
      '<span class="op-uc-span">',
      '</span>'
    ]) {
      expect(renderOpenProjectHtml(tag), tag).toBe('')
    }
  })

  it('drops the halves of a mention that marked split into separate tokens', () => {
    // marked treats only a fixed set of tag names as *block* HTML, so a
    // `<mention>` arrives as an open tag, its text, and a close tag — never as
    // one element. Dropping both tags leaves exactly the name.
    expect(
      renderOpenProjectHtml('<mention class="mention" data-id="8" data-text="@Ada">')
    ).toBe('')
    expect(renderOpenProjectHtml('</mention>')).toBe('')
  })

  it('puts the macro placeholder on the opening tag and nothing on the closing one', () => {
    // Same splitting as the mention above. Emitting on both would print the
    // placeholder twice.
    expect(renderOpenProjectHtml('<macro class="macro--embedded-table">')).toContain(
      'embedded work package table'
    )
    expect(renderOpenProjectHtml('</macro>')).toBe('')
  })

  it('renders a line break', () => {
    for (const tag of ['<br>', '<br/>', '<br />']) {
      expect(renderOpenProjectHtml(tag), tag).toBe('<br>')
    }
  })

  it('reduces a mention to the name it already reads as', () => {
    const html = renderOpenProjectHtml(
      '<mention class="mention" data-id="8" data-type="user" data-text="@Ada">@Ada</mention>'
    )

    expect(html).toBe('@Ada')
    expect(html).not.toContain('data-id')
  })

  it('says what an embedded macro was instead of leaving a gap', () => {
    expect(
      renderOpenProjectHtml('<macro class="macro--embedded-table" data-query="{}"></macro>')
    ).toContain('embedded work package table')
    expect(renderOpenProjectHtml('<macro class="toc"></macro>')).toContain(
      'table of contents'
    )
    expect(renderOpenProjectHtml('<macro class="something-new"/>')).toContain(
      'embedded content'
    )
    // The placeholder is text, not markup that a query could have supplied.
    expect(renderOpenProjectHtml('<macro class="toc">x</macro>')).not.toContain('<macro')
    // A span, so it nests legally inside the paragraph marked puts it in.
    expect(renderOpenProjectHtml('<macro class="toc"></macro>')).toContain(
      '<span class="op-uc-macro">'
    )
  })

  it('falls back to the alt text when a figure holds an unloadable image', () => {
    const html = renderOpenProjectHtml(
      '<figure class="op-uc-figure"><img src="javascript:alert(1)" alt="Diagram"></figure>'
    )

    expect(html).toBe('<p>Diagram</p>')
    expect(html).not.toContain('javascript')
  })

  it('strips a figure that holds no image down to its text', () => {
    // Rare: OpenProject normally separates the tags from the content with blank
    // lines, which makes them their own tokens instead. Losing the formatting
    // beats showing the tags.
    expect(renderOpenProjectHtml('<figure><table><tr><td>a</td></tr></table></figure>')).toBe(
      'a'
    )
    expect(renderOpenProjectHtml('<figure></figure>')).toBe('')
  })

  it('hands everything else back for the caller to escape', () => {
    for (const token of [
      '<script>alert(1)</script>',
      '<iframe src="https://example.com"></iframe>',
      '<svg onload="alert(1)"></svg>',
      '<style>body{display:none}</style>',
      '<a href="javascript:alert(1)">x</a>',
      '<object data="x"></object>',
      '<table><tr><td>a</td></tr></table>',
      '<h1>heading</h1>'
    ]) {
      expect(renderOpenProjectHtml(token), token).toBeNull()
    }
  })

  it('treats an empty or whitespace-only token as nothing', () => {
    expect(renderOpenProjectHtml('')).toBe('')
    expect(renderOpenProjectHtml('\n\n  ')).toBe('')
  })
})
