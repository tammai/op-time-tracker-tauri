import { describe, it, expect } from 'vitest'
import {
  validateOpenProjectApiKey,
  OpenProjectApiKeySchema,
  formatApiKeyZodError
} from '@shared/validation/api-key'
import { z } from 'zod'

describe('validateOpenProjectApiKey', () => {
  describe('valid inputs', () => {
    it('accepts a non-empty alphanumeric key', () => {
      const result = validateOpenProjectApiKey('abc123XYZ')
      expect(result.ok).toBe(true)
    })

    it('accepts a key with dashes', () => {
      const result = validateOpenProjectApiKey('a1b2c3-d4e5f6-7890')
      expect(result.ok).toBe(true)
    })

    it('accepts a key with underscores', () => {
      const result = validateOpenProjectApiKey('op_api_key_12345')
      expect(result.ok).toBe(true)
    })

    it('accepts a long key with mixed charset', () => {
      const result = validateOpenProjectApiKey(
        'OP-abcDEF123_456-789_ghiJKLmnop901'
      )
      expect(result.ok).toBe(true)
    })

    it('accepts a key with surrounding whitespace (trim check)', () => {
      // The value is non-empty after trim, so it passes. Callers should
      // trim before storing, but validation only rejects whitespace-only.
      const result = validateOpenProjectApiKey('  abc123  ')
      expect(result.ok).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('rejects an empty string', () => {
      const result = validateOpenProjectApiKey('')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/required/i)
    })

    it('rejects a whitespace-only string', () => {
      const result = validateOpenProjectApiKey('   \t\n  ')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/required/i)
    })
  })
})

describe('OpenProjectApiKeySchema', () => {
  it('parses a non-empty key', () => {
    const parsed = OpenProjectApiKeySchema.safeParse('abc123')
    expect(parsed.success).toBe(true)
  })

  it('parses a key with dashes and underscores', () => {
    const parsed = OpenProjectApiKeySchema.safeParse('op-key_123')
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty string', () => {
    const parsed = OpenProjectApiKeySchema.safeParse('')
    expect(parsed.success).toBe(false)
  })

  it('rejects a whitespace-only string', () => {
    const parsed = OpenProjectApiKeySchema.safeParse('    ')
    expect(parsed.success).toBe(false)
  })

  it('formatApiKeyZodError returns the first issue message', () => {
    const parsed = OpenProjectApiKeySchema.safeParse('')
    if (!parsed.success) {
      const msg = formatApiKeyZodError(parsed.error)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
    } else {
      throw new Error('should have failed')
    }
  })

  it('formatApiKeyZodError falls back when issues are empty', () => {
    const emptyError = new z.ZodError([])
    expect(formatApiKeyZodError(emptyError)).toMatch(/invalid/i)
  })
})