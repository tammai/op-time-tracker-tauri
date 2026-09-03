import { describe, expect, it } from 'vitest'

import { findHttpUrlRanges } from '@renderer/utils/markdown-autolink'

describe('findHttpUrlRanges', () => {
  it('finds absolute HTTP and HTTPS URLs', () => {
    expect(findHttpUrlRanges('See https://example.com and http://localhost:3000/path')).toEqual([
      { start: 4, end: 23, href: 'https://example.com' },
      { start: 28, end: 54, href: 'http://localhost:3000/path' }
    ])
  })

  it('leaves sentence punctuation outside the link', () => {
    expect(findHttpUrlRanges('Open (https://example.com/docs).')).toEqual([
      { start: 6, end: 30, href: 'https://example.com/docs' }
    ])
  })

  it('keeps balanced parentheses in a URL path', () => {
    expect(findHttpUrlRanges('https://example.com/function(foo)')).toEqual([
      { start: 0, end: 33, href: 'https://example.com/function(foo)' }
    ])
  })

  it('ignores non-http schemes and incomplete URLs', () => {
    expect(findHttpUrlRanges('example.com javascript:alert(1) https://')).toEqual([])
  })
})
