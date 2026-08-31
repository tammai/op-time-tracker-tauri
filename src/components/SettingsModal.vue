<script setup lang="ts">
import { watch } from 'vue'
// Explicit import, not the gitignored `auto-imports.d.ts` global — see the
// note in `TimeEntryForm.vue`.
import { useToast } from '@nuxt/ui/composables/useToast'

import { useCredentialsForm } from '@renderer/composables/useCredentialsForm'
import { useDisconnect } from '@renderer/composables/useDisconnect'
import {
  APP_AUTHOR,
  APP_AUTHOR_EMAIL,
  APP_NAME,
  APP_VERSION
} from '@renderer/utils/app-info'

/**
 * Settings modal — appearance and the OpenProject connection (including the
 * disconnect action, which sits in the connection form's button row).
 *
 * The credential form's validate → probe → save sequence is the same one
 * onboarding uses, via `useCredentialsForm()`, so this security-sensitive
 * flow exists in exactly one place.
 *
 * Security (`docs/security.md`): the API key field always starts
 * **empty** — the bridge has no getter for the stored key by design, so this
 * form can only overwrite it, never reveal it. When a key is stored the
 * field shows a masked placeholder and may be left blank to keep it. The
 * base URL is *not* secret, so it is read back and prefilled via
 * `getConnectionInfo()`.
 */

const emit = defineEmits<{
  /** Credentials were cleared — the shell should return to onboarding. */
  disconnected: []
}>()

/** Two-way `v-model:open` so the navbar action owns visibility. */
const open = defineModel<boolean>('open', { required: true })

const toast = useToast()

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
  load,
  onTestConnection,
  onSave,
  reset
} = useCredentialsForm({
  onSaved: () => {
    toast.add({
      title: 'Connection updated',
      description: 'Your OpenProject credentials were saved.',
      icon: 'i-lucide-check-circle',
      color: 'success'
    })
    reset()
    // Pick up the just-saved URL / key presence for the next open.
    void load()
    open.value = false
  }
})

// Never leave a typed key sitting in memory after the modal closes; on open,
// re-read the stored connection so the fields reflect what's configured now.
watch(open, (isOpen) => {
  if (isOpen) void load()
  else reset()
})

/**
 * Disconnect. The gate in `App.vue` flips on the emitted event, so no window
 * reload is needed; `useDisconnect` also purges the query cache so the next
 * connection can't show the previous account's data.
 */
const { disconnecting, disconnectError, disconnect } = useDisconnect({
  onDisconnected: () => {
    reset()
    open.value = false
    emit('disconnected')
  }
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="Settings"
    description="Appearance and your OpenProject connection."
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <!-- Appearance -->
        <section class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-sm font-semibold text-highlighted">Appearance</h3>
            <p class="text-muted text-xs">Switch between light and dark.</p>
          </div>
          <UColorModeButton />
        </section>

        <USeparator />

        <!-- Connection -->
        <section class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-sm font-semibold text-highlighted">
              OpenProject connection
            </h3>
            <p class="text-muted text-xs">
              For your security the stored API key is never shown. Leave it
              blank to keep the current key, or enter a new one to replace it.
            </p>
          </div>

          <UForm
            :schema="formSchema"
            :state="state"
            class="flex flex-col gap-4"
            @submit="onSave"
          >
            <UFormField label="OpenProject base URL" name="baseUrl" required>
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
              :required="!hasStoredApiKey"
              :help="
                hasStoredApiKey
                  ? 'A key is stored. Leave blank to keep it.'
                  : undefined
              "
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

            <div class="flex items-center gap-2">
              <!-- Removes the stored credentials from this machine's keychain
                   and hands back to onboarding. Kept apart from the test/save
                   pair so the destructive action isn't a mis-click away. -->
              <UButton
                type="button"
                color="error"
                variant="solid"
                icon="i-lucide-unlink"
                label="Disconnect"
                :loading="disconnecting"
                :disabled="disconnecting || testing || saving"
                @click="disconnect"
              />
              <div class="ms-auto flex items-center gap-2">
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
                  label="Save"
                  :loading="saving"
                  :disabled="saving || testing"
                />
              </div>
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
            <UAlert
              v-if="disconnectError"
              color="error"
              variant="subtle"
              icon="i-lucide-alert-octagon"
              title="Could not disconnect"
              :description="disconnectError"
            />
          </UForm>
        </section>
      </div>
    </template>

    <!-- Version + credits. Values come from `package.json` at build time via
         `app-info.ts`, so releasing a new version updates this on its own. -->
    <template #footer>
      <div
        class="text-muted flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs"
      >
        <span>
          <span class="text-default font-medium">{{ APP_NAME }}</span>
          <span class="ms-1.5">v{{ APP_VERSION }}</span>
        </span>
        <span>
          <template v-if="APP_AUTHOR">{{ APP_AUTHOR }}</template
          ><template v-if="APP_AUTHOR && APP_AUTHOR_EMAIL"> · </template
          >{{ APP_AUTHOR_EMAIL }}
        </span>
      </div>
    </template>
  </UModal>
</template>
