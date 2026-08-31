<script setup lang="ts">
import { computed, watch } from 'vue'
// Imported explicitly rather than relying on the generated `auto-imports.d.ts`
// globals: those satisfy the type checker but not eslint's `no-undef`, and the
// generated file is gitignored, so a fresh clone would fail lint.
import { useToast } from '@nuxt/ui/composables/useToast'

import { useWorkPackagesBrowser } from '@renderer/composables/useWorkPackagesBrowser'
import {
  NO_DUE_DATE_LABEL,
  formatWorkPackageDate,
  workPackageAssigneeLabel,
  workPackageStatusColorClass,
  workPackageStatusLabel
} from '@renderer/utils/work-package-display'
import WorkPackageDetailPanel from './WorkPackageDetailPanel.vue'
import WorkPackageCreatePanel from './WorkPackageCreatePanel.vue'

/**
 * The work-packages screen: a full-screen modal with a master-detail layout —
 * searchable list on the left, detail pane on the right, divided by a single
 * flush rule. The pane reads by default, edits on request, and is taken over by
 * the create form when New is pressed.
 *
 * A modal over the calendar rather than a second view, so the calendar stays
 * mounted underneath and `useMonthTimeEntries()` isn't torn down and refetched
 * every time this closes.
 *
 * This component owns **no** state. Everything — the query, the search term, the
 * filter, the selection, the editor and the creator — lives in
 * `useWorkPackagesBrowser()`, and each pane is its own component. That split is
 * what let edit and create land as a panel plus a mutation each: this file
 * gained one button and one `v-if` across both stages.
 *
 * Conventions: no direct `window.openproject.*` calls — the list comes from the
 * composable, and even the open-in-browser action routes through it
 * (`docs/conventions-frontend.md`).
 */

/** Two-way `v-model:open` so the parent owns visibility. */
const open = defineModel<boolean>('open', { required: true })

/**
 * What `UModal` binds to — a gate in front of the real model, not a second
 * source of truth.
 *
 * Every way out of the modal (the close button, Escape, a click outside) ends
 * in one `update:open` of `false`, so refusing it in one setter covers all
 * three with no flicker: `:open` is controlled, so declining to write leaves
 * the dialog exactly where it is while the confirm appears. Watching `open`
 * and re-opening after the fact would show the modal closing and snapping back.
 */
const modalOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (value) {
      open.value = true
      return
    }
    if (requestClose()) open.value = false
  }
})

/**
 * The user chose to lose the edits. Selecting the pending row is the
 * composable's job; finishing a close is this component's, since it owns the
 * visibility model.
 */
function onDiscardPending(): void {
  if (discardPendingAction() === 'close') open.value = false
}

const {
  workPackages,
  isStatusFilterDegraded,
  isInitialLoading,
  isTruncated,
  totalCount,
  shownCount,
  error,
  isFetching,
  refetch,
  searchTerm,
  isSearching,
  isTermTooShort,
  isShowingSearchResults,
  searchError,
  resetSearch,
  selectedWorkPackage,
  select,
  editor,
  creator,
  pendingAction,
  requestCreate,
  requestClose,
  discardPendingAction,
  keepEditing,
  openInBrowser,
  openingId,
} = useWorkPackagesBrowser()

const toast = useToast()

// A search the user walked away from shouldn't be waiting for them on their
// way back in, and neither should a half-started create — by the time the
// screen closes, either the draft was empty or the confirm above already asked
// about it. The status filter and the selection are deliberately kept: those
// read as settings, not as a transient query.
watch(open, (isOpen) => {
  if (!isOpen) {
    resetSearch()
    creator.cancelCreating()
  }
})

/**
 * Why the New action isn't available, shown as a line rather than as the
 * button's tooltip.
 *
 * Not a style preference: `UTooltip` puts its trigger on the button element
 * itself, and a disabled `<button>` fires neither `pointerenter` nor `focus`, so
 * a reason living in the tooltip would be unreachable exactly when it matters.
 * It earns its line on the same terms as the degraded-status notice beside it —
 * it reports a real fact about the instance that nothing else here surfaces.
 */
const createBlockedReason = computed(() => creator.startBlockedReason.value)

/**
 * Open a work package in the system browser.
 *
 * Failures toast rather than replacing the screen with an error: the list is
 * still valid and still on screen, and the modal deliberately stays open so the
 * user can simply try again or pick another row.
 */
async function onOpenInBrowser(workPackageId: number): Promise<void> {
  try {
    await openInBrowser(workPackageId)
  } catch (e) {
    const err = e as ({ code?: string; message?: string } & Error) | null
    toast.add({
      title: 'Couldn’t open in your browser',
      description:
        err?.message ??
        'An unexpected error occurred while opening the work package.',
      icon: 'i-lucide-alert-octagon',
      color: 'error'
    })
  }
}

/**
 * Bridge errors cross IPC as `{ code, message }` (see
 * `src-tauri/src/error.rs` → `AppError`); read them defensively and
 * never reach into secret-bearing detail. Same treatment as `DayEntriesModal`.
 *
 * The search error takes precedence when search results are what's on screen —
 * otherwise a failed search would be reported with the list query's error.
 */
const activeError = computed(
  () => (isShowingSearchResults.value ? searchError.value : null) ?? error.value
)

const errorCode = computed(() => {
  const e = activeError.value as ({ code?: string } & Error) | null
  return e?.code ?? 'OPENPROJECT_UNKNOWN'
})

const errorMessage = computed(() => {
  const e = activeError.value as ({ message?: string } & Error) | null
  return e?.message ?? 'An unexpected error occurred while loading work packages.'
})

/** The "showing the first N" notice — there is no pagination to reach the rest. */
const truncationNotice = computed(
  () => `Showing the first ${shownCount.value} of ${totalCount.value} matches.`
)
</script>

<template>
  <UModal
    v-model:open="modalOpen"
    fullscreen
    title="Work packages"
    description="Browse, create and edit your work packages."
    :ui="{ body: 'flex min-h-0 gap-0 overflow-hidden p-0 sm:p-0' }"
  >
    <!-- The body slot's own theme classes are `flex-1 p-4 sm:p-6` plus
         `overflow-y-auto` (from the default `scrollable: false` variant). The
         override above makes it the flex row itself and hands the single scroll
         to the list inside: `flex-1` survives the merge, while `overflow-hidden`
         beats `overflow-y-auto` and `p-0` beats the padding. Laying the panes
         out in a child with `h-full` instead would stake the whole layout on a
         percentage height resolving inside a scroll container.

         The padding is dropped here and re-applied *inside* each pane so the
         divider rule runs edge to edge with no gutter beside it — a gap either
         side would read as two separate cards rather than one split view. -->
    <template #body>
      <!-- ------------------------------------------------------------- -->
      <!-- Master: search + list                                          -->
      <!-- ------------------------------------------------------------- -->
      <div
        class="flex min-h-0 w-full max-w-sm shrink-0 flex-col border-r border-default"
      >
        <!-- The search section: input, refresh, and whatever has to be said
             about what the list below is currently showing. The notices live
             *inside* this block rather than floating above the list, because
             they describe the search — and the rule under the whole section
             keeps it visually fixed while the list scrolls past beneath it,
             lining up with the divider between the two panes. -->
        <div class="flex shrink-0 flex-col gap-2 border-b border-default p-4">
          <div class="flex items-center gap-2">
            <UInput
              v-model="searchTerm"
              class="min-w-0 flex-1"
              icon="i-lucide-search"
              placeholder="Search all work packages…"
              :loading="isSearching"
              aria-label="Search work packages"
            />
            <UButton
              color="neutral"
              variant="subtle"
              size="md"
              icon="i-lucide-refresh-cw"
              aria-label="Refresh work packages"
              :loading="isFetching"
              @click="() => refetch()"
            />
            <!-- New sits with the list, not with the detail pane: it creates a
                 row here, and the pane it opens into is where the fields live.
                 The default (solid) variant, like Save and Edit — this is the
                 one action on this screen that makes something, and the refresh
                 button beside it is deliberately quieter.

                 `requestCreate`, never `creator.startCreating()`: entering the
                 create form with an unsaved edit open ends in that edit being
                 discarded without anything having asked (a completed create
                 reassigns the selection, which re-seeds the editor). The browser
                 owns that question because it owns both halves. -->
            <UTooltip text="New work package">
              <UButton
                color="primary"
                size="md"
                icon="i-lucide-plus"
                aria-label="New work package"
                :disabled="!creator.canStartCreating.value"
                @click="requestCreate()"
              />
            </UTooltip>
          </div>

          <!-- Only the degraded-status case is worth a line here. That the
               search reaches beyond your own work packages is already said by
               the input's own placeholder; this one reports a real fault on the
               instance, which nothing else surfaces. -->
          <p v-if="isStatusFilterDegraded" class="text-muted text-xs">
            Status names couldn't be resolved on this instance, so this list
            isn't narrowed by status.
          </p>

          <!-- Why New is greyed out. See `createBlockedReason` — it cannot live
               in the button's tooltip, because a disabled button never fires
               the events that would open one. -->
          <p v-if="createBlockedReason" class="text-muted text-xs">
            {{ createBlockedReason }}
          </p>
        </div>

        <!-- Error. Shown in place of the list, with the IPC code, matching
             `DayEntriesModal`'s treatment of the same class of failure. -->
        <UAlert
          v-if="activeError"
          class="mx-4 mb-4"
          color="error"
          variant="subtle"
          icon="i-lucide-alert-triangle"
          title="Couldn't load work packages"
          :description="errorMessage"
        >
          <template #actions>
            <span class="text-muted text-xs">{{ errorCode }}</span>
          </template>
        </UAlert>

        <!-- First load -->
        <div v-else-if="isInitialLoading" class="flex flex-col gap-2 px-4 pb-4">
          <USkeleton v-for="i in 6" :key="i" class="h-12 w-full" />
        </div>

        <!-- Below the search minimum. Deliberately NOT "no work packages
             match": that would be a claim about the whole instance, for a
             search that was never sent. -->
        <UEmpty
          v-else-if="isTermTooShort"
          class="px-4"
          icon="i-lucide-keyboard"
          title="Keep typing"
          description="Enter at least two characters to search all work packages."
          variant="naked"
        />

        <UEmpty
          v-else-if="isSearching && workPackages.length === 0"
          class="px-4"
          icon="i-lucide-loader-circle"
          title="Searching…"
          description="Looking beyond your own work packages."
          variant="naked"
        />

        <UEmpty
          v-else-if="workPackages.length === 0"
          class="px-4"
          icon="i-lucide-inbox"
          :title="isShowingSearchResults ? 'No matches' : 'Nothing here'"
          :description="
            isShowingSearchResults
              ? 'No work package matches that search.'
              : 'No work packages are assigned to you in this status.'
          "
          variant="naked"
        />

        <template v-else>
          <!-- `divide-y` rather than per-row borders or a gap: one rule between
               rows, none above the first or below the last, so the list reads as
               a single surface against the pane's own edges. -->
          <ul class="min-h-0 flex-1 divide-y divide-default overflow-y-auto">
            <li v-for="wp in workPackages" :key="wp.id">
              <!-- The whole row is the selector — there is no nested action to
                   compete with it, so the entire hit area selects. -->
              <button
                type="button"
                class="flex w-full cursor-pointer flex-col gap-1 px-4 py-3 text-left"
                :class="
                  selectedWorkPackage?.id === wp.id
                    ? 'bg-elevated'
                    : 'hover:bg-elevated/50'
                "
                :aria-current="selectedWorkPackage?.id === wp.id"
                @click="select(wp)"
              >
                <!-- Meta first: id, status, assignee, due date on one line,
                     dot-separated. `flex-wrap` so a long assignee name wraps
                     the line instead of pushing the due date out of the pane.
                     The dots are `aria-hidden` — they're a visual separator,
                     and a screen reader announcing "middle dot" between every
                     field is noise. -->
                <span
                  class="text-muted flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
                >
                  <span class="tabular-nums">#{{ wp.id }}</span>
                  <span aria-hidden="true">·</span>
                  <span :class="workPackageStatusColorClass(wp)" class="font-medium">
                    {{ workPackageStatusLabel(wp) }}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{{ workPackageAssigneeLabel(wp) }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="tabular-nums">
                    {{ formatWorkPackageDate(wp.dueDate, undefined, NO_DUE_DATE_LABEL) }}
                  </span>
                </span>

                <!-- The subject wraps rather than truncating: it is the one
                     field a user scans for, and a clipped title makes two
                     similarly-prefixed work packages indistinguishable. -->
                <span class="text-sm font-medium text-highlighted break-words">
                  {{ wp.subject }}
                </span>
              </button>
            </li>
          </ul>

          <!-- There is no pagination, so a truncated list has to say so —
               otherwise a missing item looks like a missing work package. -->
          <p v-if="isTruncated" class="text-muted shrink-0 px-4 py-2 text-xs">
            {{ truncationNotice }}
          </p>
        </template>
      </div>

      <!-- ------------------------------------------------------------- -->
      <!-- Detail                                                         -->
      <!-- ------------------------------------------------------------- -->
      <!-- Nothing selected renders an empty pane, deliberately: the list beside
           it already tells the user what to do, and a placeholder here competes
           with it for attention every time the modal opens. The `v-if` also
           means the panel never has to cope with a null work package — which is
           what lets stage 2 bind a form straight to a non-null prop. -->
      <!-- The unsaved-changes confirm is the panel's own actions bar, not a
           second strip beneath it: switching rows and closing the screen are
           the same question to the user, and it is answered in the one place
           the panel's other decisions are. An inline bar rather than a nested
           dialog, matching how the day modal confirms a delete — a modal on top
           of a modal buries the thing it is asking about. -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- Create takes the pane over rather than sitting beside the detail
             view: it is the same pane answering a different question, and the
             selection underneath is untouched — cancelling returns to it with
             any edit in progress still intact. -->
        <WorkPackageCreatePanel
          v-if="creator.isCreating.value"
          :creator="creator"
          :pending-action="pendingAction"
          @keep-editing="keepEditing()"
          @discard-pending="onDiscardPending()"
        />
        <WorkPackageDetailPanel
          v-else-if="selectedWorkPackage"
          :work-package="selectedWorkPackage"
          :opening="openingId === selectedWorkPackage.id"
          :editor="editor"
          :pending-action="pendingAction"
          @open-in-browser="onOpenInBrowser"
          @keep-editing="keepEditing()"
          @discard-pending="onDiscardPending()"
        />
      </div>
    </template>
  </UModal>
</template>
