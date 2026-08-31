<script setup lang="ts">
import { computed } from 'vue'

import {
  pendingActionPrompt,
  type PendingAction
} from '@renderer/composables/useWorkPackagesBrowser'
import type { useWorkPackageCreator } from '@renderer/composables/useWorkPackageCreator'
import WorkPackageFields from './WorkPackageFields.vue'

/**
 * The detail pane in create mode — the right-hand half of the browse screen
 * while a new work package is being written.
 *
 * A sibling of `WorkPackageDetailPanel` rather than a mode inside it, because
 * the two have genuinely different chrome: there is no id to show, no
 * open-in-OpenProject action, no read view to return to, and the bar offers
 * Create rather than Edit/Save. What they must *not* differ in is the field
 * layout, and they don't: both mount `WorkPackageFields`, which is the whole
 * reason the three-stage split exists.
 *
 * The creator is passed in as one object rather than a dozen props and a
 * matching set of events, exactly as the editor is. It is owned by
 * `useWorkPackagesBrowser()` because the *list* has to consult it too — leaving
 * an unsaved create draft is the browser's decision to guard, not this
 * component's.
 */

type WorkPackageCreator = ReturnType<typeof useWorkPackageCreator>

const props = defineProps<{
  creator: WorkPackageCreator
  /**
   * An action the user asked for that the unsaved draft is holding up. Owned by
   * `useWorkPackagesBrowser()`, and rendered here for the same reason the edit
   * panel renders it: the actions bar is where the decision belongs.
   */
  pendingAction?: PendingAction | null
}>()

const emit = defineEmits<{
  /** Answers to the pending action above — the browser owns what they mean. */
  keepEditing: []
  discardPending: []
}>()

/**
 * The one line of status the actions bar shows, in priority order.
 *
 * A pending action outranks everything: it is a direct question, and the two
 * buttons beside it are its only answers. A failed create comes next — the
 * server's objection is more specific than any local one, and it is what the
 * user has to act on. The draft issue is last, and it is the reason Create is
 * greyed out, which is otherwise unguessable.
 */
const statusMessage = computed<string | null>(() => {
  // Wording lives with the type, so both panels ask the same question in the
  // same words whichever one is on screen when it is raised.
  if (props.pendingAction) return pendingActionPrompt(props.pendingAction)
  if (props.creator.createError.value) return props.creator.createError.value
  return props.creator.createIssue.value
})

/**
 * Only a refusal that already happened is an error. A pending question and a
 * still-unfilled required field are both things the user can act on right now,
 * so they share the warning colour — muted made "A subject is required" read as
 * incidental when it is the whole reason Create is off.
 */
const statusClass = computed(() =>
  props.creator.createError.value ? 'text-error' : 'text-warning'
)
</script>

<template>
  <!-- `flex-1`, not `h-full` — same reasoning as the detail panel: the pane is a
       flex column and a percentage height would claim it regardless of what else
       sits in it. -->
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Header. No id line, because there is no id yet — and nothing stands in
         for one: a placeholder where the work-package number goes would be read
         as a number. -->
    <div class="flex min-w-0 flex-col gap-1 p-4">
      <h2 class="text-base font-semibold text-highlighted">New work package</h2>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <!-- The same fields the edit panel mounts, against an empty draft. The
           project is a select here only because `project-options` is passed —
           see `WorkPackageFields`. -->
      <WorkPackageFields
        v-model:draft="props.creator.draft.value"
        v-model:project-id="props.creator.projectId.value"
        :fields="props.creator.fields.value"
        :status-options="props.creator.statusOptions.value"
        :type-options="props.creator.typeOptions.value"
        :priority-options="props.creator.priorityOptions.value"
        :assignee-options="props.creator.assigneeOptions.value"
        :project-options="props.creator.projectOptions.value"
        :busy="props.creator.isSaving.value"
      />
    </div>

    <!-- Actions, pinned to the bottom of the pane — the same bar, in the same
         place, as the edit panel's. Status on the left, buttons on the right;
         `min-w-0` plus `truncate` so a long server message can't shove the
         buttons off the edge. -->
    <div
      class="flex shrink-0 items-center justify-between gap-3 border-t border-default p-4"
    >
      <p v-if="statusMessage" class="min-w-0 truncate text-xs" :class="statusClass">
        {{ statusMessage }}
      </p>
      <span v-else />

      <div class="flex shrink-0 items-center gap-2">
        <!-- A pending action replaces the bar's usual buttons rather than
             joining them: while "discard your changes?" is on screen, Cancel and
             Create are two more answers to it that mean something else. -->
        <template v-if="props.pendingAction">
          <UButton
            color="neutral"
            variant="ghost"
            label="Keep editing"
            @click="emit('keepEditing')"
          />
          <UButton color="warning" label="Discard" @click="emit('discardPending')" />
        </template>
        <template v-else>
          <UButton
            color="neutral"
            variant="ghost"
            label="Cancel"
            :disabled="props.creator.isSaving.value"
            @click="props.creator.cancelCreating()"
          />
          <UButton
            color="primary"
            icon="i-lucide-plus"
            label="Create"
            :loading="props.creator.isSaving.value"
            :disabled="!props.creator.canCreate.value"
            @click="props.creator.create()"
          />
        </template>
      </div>
    </div>
  </div>
</template>
