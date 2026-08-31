import { z } from 'zod'

/**
 * Result of validating a user-supplied OpenProject API key. The key is a
 * secret, so this module never logs the value — only returns ok/error.
 */
export type ApiKeyValidationResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Validate that `input` is a non-empty OpenProject API key.
 *
 * OpenProject API keys are typically alphanumeric tokens, but we intentionally
 * do not over-constrain charset or length (keys may include dashes/underscores
 * and vary in length across OpenProject versions). We only reject empty /
 * whitespace-only input — anything that could never authenticate.
 *
 * Result-style: never throws. Never logs the value.
 */
export function validateOpenProjectApiKey(input: string): ApiKeyValidationResult {
  const value = input ?? ''
  if (value.trim().length === 0) {
    return { ok: false, error: 'API key is required.' }
  }
  return { ok: true }
}

/**
 * Zod schema encoding the same rule as `validateOpenProjectApiKey`.
 *
 * Used by the credential save path so UI-side and backend validation
 * share one source of truth. Intentionally minimal — no charset/length caps
 * (don't lock out valid keys).
 */
export const OpenProjectApiKeySchema = z
  .string()
  .min(1, 'API key is required.')
  .refine((s) => s.trim().length > 0, {
    message: 'API key cannot be whitespace only.'
  })

/**
 * Extract a single human-readable error message from a Zod error.
 */
export function formatApiKeyZodError(error: z.ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'Invalid API key.'
}