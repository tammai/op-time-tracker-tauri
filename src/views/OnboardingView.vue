<script setup lang="ts">
import { useCredentialsForm } from '@renderer/composables/useCredentialsForm'

/**
 * Onboarding screen — first-time setup of the OpenProject base URL + API key.
 *
 * The validate → probe → save sequence lives in `useCredentialsForm()`,
 * shared with the settings modal so this security-sensitive flow exists in
 * exactly one place. This component owns only its layout and emits
 * `configured` once credentials are saved, so the parent (`App.vue`) swaps
 * to the main shell.
 *
 * The base URL field is prefilled with `DEFAULT_OPENPROJECT_BASE_URL` (or the
 * stored URL, if the user got here by disconnecting) — see the composable.
 *
 * Security: the API key is user-entered and lives only in the composable's
 * reactive state until save, then goes to the backend via the typed
 * `testConnection` / `saveCredentials` bridge — never logged, never read
 * back. See `docs/security.md`.
 */

const emit = defineEmits<{
  /** Credentials saved successfully — parent should show the main shell. */
  configured: []
}>()

const {
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
  onTestConnection,
  onSave
} = useCredentialsForm({ onSaved: () => emit('configured') })
</script>

<template>
  <UApp>
    <div class="min-h-screen flex flex-col items-center justify-center p-4">
      <UContainer class="w-full max-w-lg">
        <div class="mb-6 flex items-center gap-2 justify-center">
          <UIcon name="i-lucide-clock" class="size-6 text-primary" />
          <h1 class="text-lg font-semibold text-highlighted">
            OpenProject Time Tracker
          </h1>
        </div>

        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-settings" class="size-5 text-primary" />
              <h2 class="text-sm font-semibold text-highlighted">
                Connect to OpenProject
              </h2>
            </div>
          </template>

          <UForm
            :schema="formSchema"
            :state="state"
            class="flex flex-col gap-4"
            @submit="onSave"
          >
            <UFormField
              label="OpenProject base URL"
              name="baseUrl"
              description="The URL of your OpenProject instance."
              required
            >
              <UInput
                v-model="state.baseUrl"
                type="url"
                placeholder="https://op.bigin.vn"
                icon="i-lucide-link"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>

            <UFormField
              label="API key"
              name="apiKey"
              :description="
                hasStoredApiKey
                  ? 'A key is already stored. Leave blank to keep it.'
                  : 'Found in your OpenProject account settings.'
              "
              :required="!hasStoredApiKey"
            >
              <UInput
                v-model="state.apiKey"
                :type="apiKeyVisible ? 'text' : 'password'"
                :placeholder="apiKeyPlaceholder"
                icon="i-lucide-key"
                autocomplete="off"
                class="w-full"
              >
                <!--
                  A key is pasted, not typed from memory, so a paste that lost a
                  character is otherwise only visible as "Authentication failed".
                  `tabindex="-1"` keeps the reveal out of the tab order between
                  the field and Test connection.
                -->
                <template #trailing>
                  <UButton
                    color="neutral"
                    variant="link"
                    size="sm"
                    tabindex="-1"
                    :icon="apiKeyVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="apiKeyVisible ? 'Hide API key' : 'Show API key'"
                    :aria-pressed="apiKeyVisible"
                    @click="toggleApiKeyVisibility"
                  />
                </template>
              </UInput>
            </UFormField>

            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <UButton
                  type="button"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-plug"
                  label="Test connection"
                  :loading="testing"
                  :disabled="testing || saving"
                  @click="onTestConnection"
                />
                <UButton
                  type="submit"
                  color="primary"
                  icon="i-lucide-check"
                  label="Save & continue"
                  :loading="saving"
                  :disabled="saving || testing"
                />
              </div>

              <!-- Success auto-dismisses after 5s (see `useCredentialsForm`);
                   the failure banner stays until the next attempt. -->
              <UAlert
                v-if="testResultVisible && testResult?.ok"
                color="success"
                variant="subtle"
                icon="i-lucide-check-circle"
                title="Connected successfully"
                :description="testResult.message"
              />
              <UAlert
                v-else-if="testResultVisible && testResult && !testResult.ok"
                color="error"
                variant="subtle"
                icon="i-lucide-alert-triangle"
                title="Connection failed"
                :description="testResult.message"
              />
              <UAlert
                v-if="saveError"
                color="error"
                variant="subtle"
                icon="i-lucide-alert-octagon"
                title="Could not save"
                :description="saveError"
              />
            </div>
          </UForm>

          <template #footer>
            <p class="text-muted text-xs">
              The API key is stored securely in your OS keychain. It never
              leaves this machine and is never sent anywhere except your
              OpenProject server.
            </p>
          </template>
        </UCard>
      </UContainer>
    </div>
  </UApp>
</template>