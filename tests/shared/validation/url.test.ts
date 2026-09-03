import { describe, it, expect } from 'vitest'
import {
  OpenProjectBaseUrlSchema,
  formatUrlZodError,
  isSafeImageSrc,
  isSafeLinkHref,
  validateOpenProjectBaseUrl
} from '@shared/validation/url'
import { z } from 'zod'

describe('validateOpenProjectBaseUrl', () => {
  describe('valid inputs', () => {
    it('accepts a plain https URL', () => {
      const result = validateOpenProjectBaseUrl('https://openproject.example.com')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.url.protocol).toBe('https:')
        expect(result.url.hostname).toBe('openproject.example.com')
      }
    })

    it('accepts an http URL', () => {
      const result = validateOpenProjectBaseUrl('http://localhost:3000')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.url.protocol).toBe('http:')
        expect(result.url.hostname).toBe('localhost')
        expect(result.url.port).toBe('3000')
      }
    })

    it('preserves a trailing slash on the origin', () => {
      const result = validateOpenProjectBaseUrl('https://openproject.example.com/')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.url.origin).toBe('https://openproject.example.com')
        expect(result.url.pathname).toBe('/')
      }
    })

    it('preserves a path component', () => {
      const result = validateOpenProjectBaseUrl(
        'https://openproject.example.com/op/'
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.url.pathname).toBe('/op/')
      }
    })

    it('preserves an explicit port', () => {
      const result = validateOpenProjectBaseUrl('https://host.example:8443')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.url.port).toBe('8443')
      }
    })

    it('trims surrounding whitespace before parsing', () => {
      const result = validateOpenProjectBaseUrl(
        '   https://openproject.example.com   '
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('rejects an empty string', () => {
      const result = validateOpenProjectBaseUrl('')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/required/i)
    })

    it('rejects whitespace-only input', () => {
      const result = validateOpenProjectBaseUrl('   \t\n  ')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/required/i)
    })

    it('rejects a javascript: URL', () => {
      const result = validateOpenProjectBaseUrl(
        'javascript:alert(1)'
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/http/i)
    })

    it('rejects a file: URL', () => {
      const result = validateOpenProjectBaseUrl('file:///etc/passwd')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/http/i)
    })

    it('rejects a data: URL', () => {
      const result = validateOpenProjectBaseUrl('data:text/plain,hello')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/http/i)
    })

    it('rejects malformed input', () => {
      const result = validateOpenProjectBaseUrl('not a url at all')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/well-formed|http/i)
    })

    it('rejects input missing the protocol', () => {
      const result = validateOpenProjectBaseUrl('openproject.example.com')
      expect(result.ok).toBe(false)
    })

    it('rejects a URL with no host', () => {
      // `new URL('https://')` throws, so this surfaces as the malformed
      // branch rather than the empty-host branch — but it's still rejected.
      const result = validateOpenProjectBaseUrl('https://')
      expect(result.ok).toBe(false)
    })

    // Carry-forward from task 3’s code review: document the validator’s
    // real behavior on userinfo URLs so task 5’s HTTP client has a defined
    // contract. The validator only checks `protocol` + `hostname` — it
    // does NOT strip userinfo (`user:pass@`). `new URL('https://u:p@host')`
    // succeeds with `username`/`password` populated, so the validator
    // **accepts** it. The stripping of userinfo happens downstream in the
    // backend (`src-tauri/src/openproject/url.rs`), which
    // builds request URLs from the validated `Credentials.baseUrl` and
    // discards any userinfo before sending. Layering: validator accepts →
    // client strips. This test documents the real contract, not an
    // aspirational one.
    it('accepts a URL with userinfo (stripping is the client’s job, not the validator’s)', () => {
      const result = validateOpenProjectBaseUrl(
        'https://user:pass@openproject.example.com'
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        // The validator does NOT strip userinfo — it passes through.
        expect(result.url.username).toBe('user')
        expect(result.url.password).toBe('pass')
        expect(result.url.hostname).toBe('openproject.example.com')
      }
    })
  })
})

describe('OpenProjectBaseUrlSchema', () => {
  it('parses a valid https URL', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse(
      'https://openproject.example.com'
    )
    expect(parsed.success).toBe(true)
  })

  it('parses a valid http URL with port', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse('http://localhost:3000')
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty string', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse('')
    expect(parsed.success).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse('file:///etc/passwd')
    expect(parsed.success).toBe(false)
  })

  it('rejects a malformed URL', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse('not a url')
    expect(parsed.success).toBe(false)
  })

  it('formatUrlZodError returns the first issue message', () => {
    const parsed = OpenProjectBaseUrlSchema.safeParse('javascript:alert(1)')
    if (!parsed.success) {
      const msg = formatUrlZodError(parsed.error)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
    } else {
      throw new Error('should have failed')
    }
  })

  it('formatUrlZodError falls back when issues are empty', () => {
    // Construct an empty-error ZodError to exercise the fallback branch.
    const emptyError = new z.ZodError([])
    expect(formatUrlZodError(emptyError)).toMatch(/invalid/i)
  })
})
describe('isSafeLinkHref', () => {
  it('accepts http and https links', () => {
    expect(isSafeLinkHref('https://example.com')).toBe(true)
    expect(isSafeLinkHref('http://example.com/path?a=1#b')).toBe(true)
    expect(isSafeLinkHref('  https://example.com  ')).toBe(true)
  })

  it('rejects schemes that would execute or read the disk', () => {
    // A description is rendered back with clickable anchors, so these are the
    // cases that matter — not merely malformed input.
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false)
    expect(isSafeLinkHref('JavaScript:alert(1)')).toBe(false)
    expect(isSafeLinkHref('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeLinkHref('file:///etc/passwd')).toBe(false)
    expect(isSafeLinkHref('vbscript:msgbox(1)')).toBe(false)
  })

  it('rejects anything it cannot parse, and never guesses a scheme', () => {
    // Prefixing https:// would turn a typo into a link somewhere unnamed.
    expect(isSafeLinkHref('example.com')).toBe(false)
    expect(isSafeLinkHref('not a url')).toBe(false)
    expect(isSafeLinkHref('')).toBe(false)
    expect(isSafeLinkHref('   ')).toBe(false)
    expect(isSafeLinkHref('http://')).toBe(false)
  })
})

describe('isSafeImageSrc', () => {
  it('accepts the attachment proxy URL, in both platform spellings', () => {
    // The macOS/Linux form and the Windows one. Both are accepted whichever
    // platform is running: a description written on one OS is edited on the
    // other, and the backend produces whichever its own build targets.
    expect(isSafeImageSrc('opattach://localhost/12345')).toBe(true)
    expect(isSafeImageSrc('http://opattach.localhost/12345')).toBe(true)
  })

  it('accepts everything an anchor href may be', () => {
    expect(isSafeImageSrc('https://example.com/a.png')).toBe(true)
    expect(isSafeImageSrc('http://example.com/a.png')).toBe(true)
  })

  it('rejects the schemes the link rule rejects', () => {
    for (const source of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'example.com/a.png',
      '',
      '   '
    ]) {
      expect(isSafeImageSrc(source), source).toBe(false)
    }
  })

  it('rejects a proxy URL with no host', () => {
    expect(isSafeImageSrc('opattach:///12345')).toBe(false)
  })

  it('is a superset of isSafeLinkHref and nothing more', () => {
    // Anything an anchor may point at, an image may load. The reverse does not
    // hold, which is the whole reason there are two functions.
    for (const source of ['https://example.com/a', 'http://example.com/a']) {
      expect(isSafeImageSrc(source), source).toBe(isSafeLinkHref(source))
    }
    expect(isSafeLinkHref('opattach://localhost/1')).toBe(false)
    expect(isSafeImageSrc('opattach://localhost/1')).toBe(true)
  })
})
