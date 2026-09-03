import { describe, expect, it } from 'vitest'

import { decodeHtmlEntities, escapeHtml } from '@renderer/utils/html'

describe('escapeHtml', () => {
  it('escapes every character that could open a tag or close an attribute', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml(`" onerror='x'`)).toBe('&quot; onerror=&#39;x&#39;')
  })

  it('leaves text with nothing to escape untouched', () => {
    expect(escapeHtml('plain text')).toBe('plain text')
    expect(escapeHtml('')).toBe('')
  })
})

describe('decodeHtmlEntities', () => {
  it('decodes the references OpenProject emits in an attribute', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry')
    expect(decodeHtmlEntities('&lt;b&gt;')).toBe('<b>')
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"')
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's")
  })

  it('decodes numeric references in both bases', () => {
    expect(decodeHtmlEntities('&#65;&#66;')).toBe('AB')
    expect(decodeHtmlEntities('&#x41;&#X42;')).toBe('AB')
    expect(decodeHtmlEntities('&#128512;')).toBe('😀')
  })

  it('leaves a malformed or unknown reference as the text it was written as', () => {
    // Anything not decoded is escaped again by the caller, so it renders as the
    // literal characters — which is what it looks like on screen anyway.
    expect(decodeHtmlEntities('&notareal;')).toBe('&notareal;')
    expect(decodeHtmlEntities('&amp')).toBe('&amp')
    expect(decodeHtmlEntities('100% & rising')).toBe('100% & rising')
    // A lone surrogate and an out-of-range code point are both invalid.
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeHtmlEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeHtmlEntities('&#0;')).toBe('&#0;')
  })

  it('does no work on text with no ampersand', () => {
    expect(decodeHtmlEntities('plain')).toBe('plain')
  })

  it('cannot be used to smuggle a tag past the escape that follows it', () => {
    // The pair is only ever used decode-then-escape, so a decoded `<` must come
    // back out escaped.
    expect(escapeHtml(decodeHtmlEntities('&lt;img src=x onerror=y&gt;'))).toBe(
      '&lt;img src=x onerror=y&gt;'
    )
  })
})
