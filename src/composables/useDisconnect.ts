import { ref } from 'vue'
import { useQueryCache } from '@pinia/colada'

/**
 * Clearing the stored OpenProject credentials.
 *
 * Lives here rather than in `SettingsModal.vue` for two reasons from
 * `docs/conventions-frontend.md`: components hold no business
 * logic, and query-cache work goes through `useQueryCache()` in the
 * composable/query layer, never in a component.
 *
 * Security (`docs/security.md`): the key itself never reaches the
 * webview, so there is nothing secret to scrub here — `clearCredentials()`
 * removes it from the keychain in the backend. What this composable does
 * own is the *derived* OpenProject data sitting in the Pinia Colada cache.
 */

export interface UseDisconnectOptions {
  /** Called once credentials are cleared and the cache is purged. */
  onDisconnected?: () => void
}

export function useDisconnect(options: UseDisconnectOptions = {}) {
  const queryCache = useQueryCache()

  const disconnecting = ref(false)
  const disconnectError = ref<string | null>(null)

  /**
   * Drop every cached query. The cache lives in Pinia, so it outlives the
   * calendar being unmounted — without this, reconnecting within Colada's gc
   * window (default ~5 min) repaints the *previous* account's time entries
   * while the refetch is still in flight. Cancel first so a request that
   * resolves after the purge can't write its result back in.
   *
   * This version of `@pinia/colada` has no `clear()`; `getEntries()` with no
   * filter returns every entry, which is the documented way to do it.
   */
  function purgeQueryCache(): void {
    queryCache.cancelQueries()
    for (const entry of queryCache.getEntries()) {
      queryCache.remove(entry)
    }
  }

  /**
   * Clear the stored credentials, purge cached OpenProject data, then hand
   * back to the caller (the shell returns to onboarding). The cache is only
   * purged after the clear succeeds — on failure the user stays connected, so
   * throwing their loaded data away would be wrong.
   */
  async function disconnect(): Promise<void> {
    disconnecting.value = true
    disconnectError.value = null
    try {
      await window.openproject.clearCredentials()
      purgeQueryCache()
      options.onDisconnected?.()
    } catch (e) {
      const maybeTyped = e as { message?: string }
      disconnectError.value =
        maybeTyped.message ?? 'Could not clear the stored credentials.'
    } finally {
      disconnecting.value = false
    }
  }

  return { disconnecting, disconnectError, disconnect }
}
