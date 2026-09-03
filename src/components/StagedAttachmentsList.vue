<script setup lang="ts">
import { useTemplateRef } from 'vue'

import { DROP_PRIORITY, useFileDrop } from '@renderer/composables/useFileDrop'
import { formatFileSize } from '@renderer/utils/attachment-display'
import type { useStagedAttachments } from '@renderer/composables/useStagedAttachments'

/**
 * The attachments section of the **create** form.
 *
 * A sibling of `WorkPackageAttachments.vue` rather than a mode inside it, for
 * the same reason `WorkPackageCreatePanel` is a sibling of the detail panel:
 * the two lists answer different questions. That one shows what OpenProject
 * holds, with permissions, timestamps and an uploader; this one shows what is
 * *about to be* uploaded, and every row's only action is to take it back off
 * the list. Nothing here has an id, a thumbnail, or a delete permission,
 * because none of it exists on the server yet.
 *
 * The staging itself is passed in rather than created here, because the create
 * composable has to flush it after a successful create — the list and the
 * flush must be looking at the same set.
 */

const props = defineProps<{
  staging: ReturnType<typeof useStagedAttachments>
  /** Locked while the create is in flight. */
  disabled?: boolean
}>()

const root = useTemplateRef<HTMLElement>('root')

/**
 * A drop anywhere on this section stages the files.
 *
 * Registered at the panel priority, not the editor's: during a create the
 * description editor has no image affordances at all — there is no work package
 * for an inline image to point at — so there is no higher-priority zone to lose
 * to.
 */
const { isOver: isDropTarget } = useFileDrop({
  element: () => root.value,
  enabled: () => !props.disabled,
  onDrop: (paths) => void props.staging.add(paths),
  priority: DROP_PRIORITY.panel
})
</script>

<template>
  <div
    ref="root"
    class="flex min-w-0 flex-col gap-2 rounded-md p-1"
    :class="isDropTarget ? 'outline-2 -outline-offset-2 outline-primary' : ''"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="text-muted">
        Attachments
        <span v-if="props.staging.count.value > 0" class="tabular-nums">
          ({{ props.staging.count.value }})
        </span>
      </span>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-paperclip"
        label="Add files"
        :loading="props.staging.isStaging.value"
        :disabled="props.disabled || props.staging.isStaging.value"
        @click="props.staging.add()"
      />
    </div>

    <p
      v-if="props.staging.error.value"
      class="text-error text-xs"
      role="alert"
    >
      {{ props.staging.error.value }}
    </p>

    <!-- Says *when* they upload, which is the one thing about this list that
         differs from the edit flow and is not otherwise guessable. -->
    <p v-if="!props.staging.hasItems.value" class="text-muted text-xs">
      Files added here are uploaded once the work package is created. Use
      <span class="text-highlighted">Add files</span>, or drop them here.
    </p>

    <ul v-else class="flex flex-col divide-y divide-default rounded-md bg-elevated">
      <li
        v-for="item in props.staging.items.value"
        :key="item.token"
        class="flex min-w-0 items-center gap-2 p-2"
      >
        <UIcon name="i-lucide-file" class="text-muted size-4 shrink-0" />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm text-highlighted" :title="item.fileName">
            {{ item.fileName }}
          </span>
          <span class="text-muted text-xs tabular-nums">
            {{ formatFileSize(item.fileSize) }}
          </span>
        </div>
        <!-- Remove, not delete: nothing has been uploaded, so there is nothing
             to undo and no confirm to ask for. -->
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          :disabled="props.disabled"
          :aria-label="`Remove ${item.fileName}`"
          @click="props.staging.remove(item.token)"
        />
      </li>
    </ul>
  </div>
</template>
