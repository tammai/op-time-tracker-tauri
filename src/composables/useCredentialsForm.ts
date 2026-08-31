import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { z } from 'zod'

import { DEFAULT_OPENPROJECT_BASE_URL } from '@shared/constants/openproject'
import {
  OpenProjectBaseUrlSchema,
  formatUrlZodError
} from '@shared/validation/url'
import { OpenProjectApiKeySchema } from '@shared/validation/api-key'

/**
 * The base URL + API key form, shared by the onboarding screen and the
 * settings modal.
 *
 * Extracted so the two callers can't drift: this is a security-sensitive
 * form, and duplicating its validate → probe → save sequence would mean two
 * places to get the key handling right. The markup stays with each caller
 * (onboarding is a full-page card, settings is a modal section); only the
 * logic is shared.
 *
 * Prefill: `load()` reads the non-secret `getConnectionInfo()` — the stored
 * base URL (falling back to `DEFAULT_OPENPROJECT_BASE_URL`) plus whether a
 * key is stored. The key field stays blank in that case and only shows a
 * masked placeholder; leaving it blank on save keeps the stored key.
 *
 * Security (`docs/security.md`): the API key is user-entered and
 * lives only in this composable's reactive state until it is handed to the
 * backend via the typed `testConnection` / `saveCredentials` bridge.
 * It is never logged, never persisted here, and never read back — the bridge
 * has no getter for it, so the form can only overwrite the key, never
 * display it.
 */

/** Object schema so `UForm` can drive per-field validation + error display. */
export const credentialsFormSchema = z.object({
  baseUrl: OpenProjectBaseUrlSchema,
  apiKey: OpenProjectApiKeySchema
})

/**
 * Same schema with the key optional — used once a key is already stored, so
 * a blank field means "keep it" instead of failing validation.
 */
export const credentialsFormSchemaWithStoredKey = z.object({
  baseUrl: OpenProjectBaseUrlSchema,
  apiKey: z.string().optional()
})

export type CredentialsFormState = {
  baseUrl: string
  apiKey?: string
}

/** What the API key field shows when a key is already stored. */
export const STORED_API_KEY_PLACEHOLDER = '••••••••••••••••'

/**
 * How long a *successful* probe banner stays up. Success is transient
 * feedback — the enabled Save button carries the state from then on — so the
 * banner clears itself instead of lingering. Failures stay until the next
 * attempt, since they're the ones the user has to act on.
 */
export const TEST_SUCCESS_DISMISS_MS = 5_000

export interface UseCredentialsFormOptions {
  /** Called after credentials are saved successfully. */
  onSaved?: () => void
}

export function useCredentialsForm(options: UseCredentialsFormOptions = {}) {
  const state = reactive({
    baseUrl: DEFAULT_OPENPROJECT_BASE_URL,
    apiKey: ''
  })

  /** The base URL currently persisted, if any — what `reset()` returns to. */
  const storedBaseUrl = ref<string | null>(null)
  /** True when a key is in the keychain: the field may then be left blank. */
  const hasStoredApiKey = ref(false)

  const testing = ref(false)
  const saving = ref(false)
  const testResult = ref<{ ok: boolean; message: string } | null>(null)
  const saveError = ref<string | null>(null)

  /**
   * Whether the banner for the current `testResult` is still on screen. Kept
   * separate from `testResult` so auto-dismissing the success banner doesn't
   * also drop the "these values were probed" state.
   */
  const testResultVisible = ref(false)
  let dismissTimer: ReturnType<typeof setTimeout> | null = null

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  /** Single writer for `testResult`, so the dismiss timer can't leak. */
  function setTestResult(result: { ok: boolean; message: string } | null): void {
    clearDismissTimer()
    testResult.value = result
    testResultVisible.value = result !== null
    if (result?.ok) {
      dismissTimer = setTimeout(() => {
        testResultVisible.value = false
        dismissTimer = null
      }, TEST_SUCCESS_DISMISS_MS)
    }
  }

  onUnmounted(clearDismissTimer)

  /**
   * The exact values the last successful probe covered. Compared against the
   * live form so editing the URL (or the key) invalidates that success
   * instead of letting it vouch for values the server never saw.
   */
  const probedValues = ref<string | null>(null)

  /** NUL-joined: it can't appear in either field, so the pair is unambiguous. */
  function currentValues(): string {
    return `${state.baseUrl}\u0000${state.apiKey.trim()}`
  }

  /** True only while the form still holds the values that probed clean. */
  const testSucceeded = computed(
    () => testResult.value?.ok === true && probedValues.value === currentValues()
  )

  /** Blank means "keep the stored key" — only then is the field optional. */
  const formSchema = computed(() =>
    hasStoredApiKey.value
      ? credentialsFormSchemaWithStoredKey
      : credentialsFormSchema
  )

  /** Masked hint that a key is stored; never the key itself. */
  const apiKeyPlaceholder = computed(() =>
    hasStoredApiKey.value ? STORED_API_KEY_PLACEHOLDER : 'API key'
  )

  /**
   * Prefill from the stored (non-secret) connection info. Falls back to the
   * default instance URL when nothing is stored or the read fails — the form
   * must stay usable either way.
   */
  async function load(): Promise<void> {
    try {
      const info = await window.openproject.getConnectionInfo()
      storedBaseUrl.value = info.baseUrl
      hasStoredApiKey.value = info.hasApiKey
      state.baseUrl = info.baseUrl ?? DEFAULT_OPENPROJECT_BASE_URL
    } catch {
      storedBaseUrl.value = null
      hasStoredApiKey.value = false
      state.baseUrl = DEFAULT_OPENPROJECT_BASE_URL
    }
  }

  onMounted(() => {
    void load()
  })

  /**
   * Probe the OpenProject server with the unsaved form values, and record
   * which values passed. The key is used once in the backend for this
   * probe and never logged. Returns whether the probe succeeded, so `onSave`
   * can gate persistence on it.
   */
  async function runProbe(): Promise<boolean> {
    // A new attempt supersedes the last one — drop the previous verdict before
    // anything can return early, so a stale success can't vouch for these
    // values.
    probedValues.value = null

    // Validate client-side first so we surface a clear message without a
    // round-trip. (The backend re-validates too.)
    const baseUrlResult = OpenProjectBaseUrlSchema.safeParse(state.baseUrl)
    if (!baseUrlResult.success) {
      setTestResult({
        ok: false,
        message: formatUrlZodError(baseUrlResult.error)
      })
      return false
    }
    // A blank field with a key already stored is valid — the backend
    // probes with the stored key. Otherwise the key must pass validation.
    const keyIsBlank = state.apiKey.trim().length === 0
    if (!(keyIsBlank && hasStoredApiKey.value)) {
      const apiKeyResult = OpenProjectApiKeySchema.safeParse(state.apiKey)
      if (!apiKeyResult.success) {
        setTestResult({
          ok: false,
          message: apiKeyResult.error.issues[0]?.message ?? 'Invalid API key.'
        })
        return false
      }
    }

    // Snapshot before the await: the user can keep typing during the probe,
    // and the verdict belongs to the values actually sent.
    const probed = currentValues()
    testing.value = true
    setTestResult(null)
    try {
      const result = await window.openproject.testConnection({
        baseUrl: state.baseUrl,
        // Omit rather than send an empty string, so main resolves the
        // stored key instead of failing validation.
        ...(keyIsBlank ? {} : { apiKey: state.apiKey })
      })
      if (result.ok) {
        probedValues.value = probed
        // Not a repeat of the banner's "Connected successfully" title — say
        // what actually passed.
        setTestResult({
          ok: true,
          message: 'This URL and API key authenticated against OpenProject.'
        })
        return true
      }
      setTestResult({ ok: false, message: result.error })
      return false
    } catch (e) {
      setTestResult({
        ok: false,
        message: `Unexpected error: ${(e as Error).message}`
      })
      return false
    } finally {
      testing.value = false
    }
  }

  /** The Test connection button — probe and report, nothing else. */
  async function onTestConnection(): Promise<void> {
    await runProbe()
  }

  /**
   * Save credentials, then notify the caller. Surfaces typed
   * `saveCredentials` rejection messages.
   *
   * Save stays enabled whenever the fields are valid — requiring a manual
   * Test connection first left the button dead after every URL edit. The
   * verification isn't dropped, just moved: values that haven't already
   * probed clean are probed here, and a failing probe aborts the save rather
   * than persisting credentials that would leave the app unable to connect.
   */
  async function onSave(event: { data: CredentialsFormState }): Promise<void> {
    saving.value = true
    saveError.value = null
    const apiKey = event.data.apiKey?.trim()
    try {
      if (!testSucceeded.value) {
        const ok = await runProbe()
        if (!ok) return
      }
      await window.openproject.saveCredentials({
        baseUrl: event.data.baseUrl,
        // Blank → keep the stored key (resolved in the backend).
        ...(apiKey ? { apiKey } : {})
      })
      options.onSaved?.()
    } catch (e) {
      // The credential IPC handler rejects with a typed `{ code, message }`
      // error. Branch on the known shape.
      const maybeTyped = e as { code?: string; message?: string }
      saveError.value =
        maybeTyped.message ??
        `Could not save credentials: ${(e as Error).message}`
    } finally {
      saving.value = false
    }
  }

  /**
   * Whether the API key field is currently shown as plain text.
   *
   * A key is pasted, not remembered, and a paste that silently lost a character
   * is indistinguishable from a revoked key when the field is masked — the
   * failure reads as "Authentication failed", which sends the user hunting for
   * the wrong problem. Off by default; reset by `reset()` so the field is never
   * left revealed for the next opening of the settings modal.
   */
  const apiKeyVisible = ref(false)

  function toggleApiKeyVisibility(): void {
    apiKeyVisible.value = !apiKeyVisible.value
  }

  /**
   * Drop any typed key and result/error state, and return the URL field to
   * what's stored (or the default). Used when the settings modal closes, so
   * no entered key lingers in memory.
   */
  function reset(): void {
    state.baseUrl = storedBaseUrl.value ?? DEFAULT_OPENPROJECT_BASE_URL
    state.apiKey = ''
    apiKeyVisible.value = false
    setTestResult(null)
    probedValues.value = null
    saveError.value = null
  }

  return {
    state,
    formSchema,
    apiKeyPlaceholder,
    apiKeyVisible,
    toggleApiKeyVisibility,
    hasStoredApiKey,
    testing,
    saving,
    testResult,
    testResultVisible,
    saveError,
    testSucceeded,
    load,
    onTestConnection,
    onSave,
    reset
  }
}
