<script setup lang="ts">
import { computed, ref, watch } from 'vue'
// Explicit import, not the gitignored `auto-imports.d.ts` global — see the
// note in `SettingsModal.vue`.
import { useToast } from '@nuxt/ui/composables/useToast'
import type { WorkPackage } from '@opentracker/preload'

import { useWorkPackageCreator } from '@renderer/composables/useWorkPackageCreator'
import WorkPackageFields from './WorkPackageFields.vue'

/**
 * The work-package create drawer — opened from the calendar's floating
 * button, so a work package can be created without first opening the browse
 * screen.
 *
 * It is a leaner chrome around the same two units the browse screen's create
 * pane uses — `useWorkPackageCreator` and `WorkPackageFields` — with the one
 * difference the narrower width calls for: `WorkPackageFields` is asked for two
 * columns instead of four. The creator's behaviour is unchanged; in particular
 * the project → fields cascade, the assignee default, and the create mutation
 * are exactly the browse screen's, so a work package created here is
 * indistinguishable from one created there.
 *
 * What it deliberately does **not** reuse is the browse pane's chrome. There is
 * no `pendingAction` here — the drawer has no list to switch rows in and no
 * selection to reassign, so the only unsaved-work question is "close and
 * discard?", asked through the close gate below rather than the browser's
 * three-way pending action. A completed create selects what it made into a
 * throwaway local ref (there is no detail panel to show it in) and toasts +
 * closes; the calendar doesn't surface work packages, so the new row lands in
 * the browse screen's cache, not on the grid.
 */

const open = defineModel<boolean>('open', { required: true })

const toast = useToast()

/**
 * The sink for a completed create.
 *
 * The creator writes its result to the selection ref so the browse screen's
 * detail panel picks it up; the drawer has no such panel, so this ref is here
 * only to receive that write and let us read the new id for the toast. It is
 * never read for display.
 */
const created = ref<WorkPackage | null>(null)
const creator = useWorkPackageCreator(created)

/**
 * Enter create mode when the drawer opens.
 *
 * `immediate` is load-bearing: the drawer first mounts with `open` already
 * `true` (`openCreateDrawer()` sets both store flags in one tick), so a plain
 * change-only watcher would never fire on that first mount and the form would
 * never appear. `startCreating()` itself refuses until the projects query has
 * settled (`canStartCreating` is false while it's pending), so a second watcher
 * starts it the moment that becomes possible. That split is invisible to the
 * user: while the request is in flight the body shows a loading state, and the
 * form appears the instant the project list is known — whether it was already
 * cached (browse screen opened earlier) or fetched fresh on this open.
 */
watch(
  open,
  (isOpen) => {
    if (isOpen) creator.startCreating()
    else resetCreateState()
  },
  { immediate: true }
)

watch(
  () => creator.canStartCreating.value,
  (can) => {
    if (open.value && can && !creator.isCreating.value) creator.startCreating()
  }
)

// Close gate — refuse to close over an unsaved draft, ask first

const isDiscardOpen = ref(false)

/**
 * Reset the creator to a fully default form — draft, chosen project, and the
 * create-result sink.
 *
 * `cancelCreating()` clears the draft but leaves `projectId` (and `created`)
 * in place, which is what the browse screen wants: a second work package
 * usually belongs beside the first, so it carries the project over. The drawer
 * is a quick, one-off create — cancelling it should return to the empty form
 * the user expects, so every close path resets the project too. Clearing
 * `created` matters as well: `startCreating()` seeds the project from the
 * selection when one exists, so a leftover created work package would pre-fill
 * the project on the next open.
 */
function resetCreateState(): void {
  creator.cancelCreating()
  creator.projectId.value = null
  created.value = null
}

/**
 * The two-way `open` gate, mirroring `WorkPackagesModal`'s `modalOpen`: every
 * way out (the close button, Escape, a click on the overlay) ends in one
 * `update:open` of `false`, so refusing it here covers all three with no
 * flicker. A dirty draft opens the discard confirm instead of closing; the
 * confirm is what eventually writes `false`.
 */
const drawerOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (value) {
      open.value = true
      return
    }
    if (creator.isDirty.value) {
      isDiscardOpen.value = true
      return
    }
    open.value = false
  }
})

/** Discard confirmed — close; the `open` watcher resets the form. */
function confirmDiscard(): void {
  isDiscardOpen.value = false
  open.value = false
}

// Status + actions

/**
 * The one line the footer shows, in priority order: a failed create (the
 * server's objection) over a still-unfilled required field (the reason Create
 * is greyed out). Same wording and colour logic as the browse create pane.
 */
const statusMessage = computed<string | null>(
  () => creator.createError.value ?? creator.createIssue.value
)
const statusClass = computed(() =>
  creator.createError.value ? 'text-error' : 'text-warning'
)

/**
 * Create the work package, then close + toast on success.
 *
 * The creator keeps the draft and shows the message on failure (a 422 is
 * actionable in one field), so the drawer stays open exactly when something
 * went wrong. On success `created` holds the echoed work package, which is the
 * id the toast announces.
 */
async function onCreate(): Promise<void> {
  await creator.create()
  if (creator.createError.value) return
  const id = created.value?.id
  toast.add({
    title: id ? `Created #${id}` : 'Work package created',
    icon: 'i-lucide-check-circle',
    color: 'success'
  })
  open.value = false
}
</script>

<template>
  <USlideover
    v-model:open="drawerOpen"
    title="New work package"
    description="Create a work package quickly."
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <!-- Creating: the form, scrollable in the slideover's own body. -->
      <div v-if="creator.isCreating.value">
        <WorkPackageFields
          v-model:draft="creator.draft.value"
          v-model:project-id="creator.projectId.value"
          :fields="creator.fields.value"
          :status-options="creator.statusOptions.value"
          :type-options="creator.typeOptions.value"
          :priority-options="creator.priorityOptions.value"
          :assignee-options="creator.assigneeOptions.value"
          :project-options="creator.projectOptions.value"
          :busy="creator.isSaving.value"
        />
      </div>

      <!-- Not yet creating: the projects list is still loading, or this key can
           create nowhere. The form would render all-disabled with no project,
           which reads as a broken drawer rather than a loading state; a centred
           notice says what's actually happening. -->
      <div
        v-else
        class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <template v-if="creator.startBlockedReason.value">
          <UIcon name="i-lucide-ban" class="text-muted size-8" />
          <p class="text-muted text-sm">
            {{ creator.startBlockedReason.value }}
          </p>
        </template>
        <template v-else>
          <UIcon
            name="i-lucide-loader-circle"
            class="text-muted size-8 animate-spin"
          />
          <p class="text-muted text-sm">Loading…</p>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-3">
        <p
          v-if="statusMessage"
          class="text-muted min-w-0 truncate text-xs"
          :class="statusClass"
        >
          {{ statusMessage }}
        </p>
        <span v-else />

        <div class="flex shrink-0 items-center gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Cancel"
            :disabled="creator.isSaving.value"
            @click="open = false"
          />
          <UButton
            color="primary"
            icon="i-lucide-plus"
            label="Create"
            :loading="creator.isSaving.value"
            :disabled="!creator.canCreate.value"
            @click="onCreate"
          />
        </div>
      </div>
    </template>
  </USlideover>

  <!-- The discard confirm. A modal on top of the slideover is fine here — the
       question is about the draft the slideover is still showing, not a second
       surface competing with it. -->
  <UModal
    v-model:open="isDiscardOpen"
    title="Discard the new work package?"
    description="Closing discards the fields you've filled in."
  >
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="Keep editing"
          @click="isDiscardOpen = false"
        />
        <UButton color="warning" label="Discard" @click="confirmDiscard" />
      </div>
    </template>
  </UModal>
</template>