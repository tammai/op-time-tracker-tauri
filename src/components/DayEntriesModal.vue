<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
// Imported explicitly rather than relying on the generated `auto-imports.d.ts`
// globals: those satisfy the type checker but not eslint's `no-undef`, and the
// generated file is gitignored, so a fresh clone would fail lint.
import { useToast } from '@nuxt/ui/composables/useToast'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { parseDate, type DateValue } from '@internationalized/date'
import type { TimeEntry } from '@opentracker/preload'

import { isCalendarDate } from '@shared/validation/calendar-date'
import { dayTotalColor } from '@renderer/utils/day-total'

import {
  timeEntryQueries,
  useDeleteTimeEntry,
  useUpdateTimeEntry
} from '@renderer/composables/queries/time-entries'
import {
  canChangeDate,
  timeEntryCommentText,
  timeEntryHours,
  timeEntryWorkPackageNumber,
  toDateChangeInput,
  toTimeEntryDraft,
  type TimeEntryDraft
} from '@renderer/utils/time-entry-draft'
import TimeEntryForm from './TimeEntryForm.vue'

/**
 * The day modal: log time against a day (top section) and review, edit, or
 * delete what's already logged on it (footer).
 *
 * The entry list is its own single-day query rather than a slice of the
 * calendar's month query — every mutation invalidates the whole
 * `['time-entries']` prefix, so both refresh together after a write, and a
 * dedicated query keeps this modal correct even for a day outside the
 * currently displayed month.
 *
 * Editing reuses the same `TimeEntryForm` in the top section rather than
 * opening a second modal: it's the same fields with the same validation, and
 * a nested modal would put the entry list out of view while editing it.
 *
 * Moving an entry to another day is its own row action instead of a field in
 * that form — it's the one edit whose result is that the entry leaves this
 * list, and it needs nothing but a date, so it confirms inline on the row the
 * same way a delete does.
 *
 * Conventions: no direct `window.openproject.*` calls — data comes from the
 * query composable (`docs/conventions-frontend.md`).
 */

const props = defineProps<{
  /** The day, `YYYY-MM-DD`. */
  date: string
}>()

/** Two-way `v-model:open` so the parent owns visibility. */
const open = defineModel<boolean>('open', { required: true })

const {
  data,
  error,
  isLoading,
  refresh
} = useQuery(() =>
  timeEntryQueries.list({
    onlyMine: true,
    spentOn: { on: props.date }
  })
)

const entries = computed<TimeEntry[]>(
  () => data.value?._embedded.elements ?? []
)

/** "Saturday, 25 July 2026" — UTC, matching the grid and `spentOn`. */
const dateLabel = computed(() =>
  new Date(`${props.date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
)

const totalHours = computed(() =>
  entries.value.reduce((sum, e) => sum + timeEntryHours(e), 0)
)

// Just the figure — it sits under the "Logged entries" heading, which already
// says what it's a total of.
const totalLabel = computed(() => `${totalHours.value.toFixed(2)}h`)

/** Work package label from the HAL link title, with an id fallback. */
function workPackageLabel(entry: TimeEntry): string {
  return entry._links.workPackage?.title ?? 'Work package'
}

const toast = useToast()

// Row state — which entry is being edited, and which is confirming a delete.
// Declared together because each action clears the other: opening an edit
// dismisses a pending confirm, and deleting the edited entry ends the edit.

/**
 * The entry currently loaded into the form, or `null` in add mode.
 *
 * A snapshot taken when the pencil is clicked, not a lookup into the live
 * list: a background refetch mid-edit would otherwise overwrite whatever the
 * user has typed. The `id` it carries is what the save is applied to, so a
 * stale snapshot updates the right entry regardless.
 */
const editingDraft = ref<TimeEntryDraft | null>(null)

/** The row showing its inline "Delete this entry?" confirm, if any. */
const confirmingDeleteId = ref<number | null>(null)

/** The row whose delete is in flight — only ever one at a time. */
const deletingId = ref<number | null>(null)

/** The row showing its inline date picker, if any. */
const changingDateId = ref<number | null>(null)

/** The day picked in that row's picker, `YYYY-MM-DD` (`''` once cleared). */
const pickedDate = ref('')

/** The row whose move is in flight. */
const movingId = ref<number | null>(null)

/** True while this form's own save is in flight (reported by the form). */
const formSaving = ref(false)

/**
 * Any write in the modal — the form's save, a delete, or a move — is in
 * flight. Every control that could start a second write, or change what the
 * in-flight one applies to, is disabled while this is true: two concurrent
 * writes would race each other's cache invalidation, and the refetch that
 * follows would settle on whichever landed last.
 */
const isBusy = computed(
  () => formSaving.value || deletingId.value !== null || movingId.value !== null
)

// Edit

/**
 * Entries whose work package href or duration can't be read back into form
 * values (see `toTimeEntryDraft`) have no pencil — the form would have to
 * invent a value and the save would overwrite the entry with it. Deleting
 * them still works; that needs nothing but the id.
 */
const draftsByEntryId = computed(
  () => new Map(entries.value.map((entry) => [entry.id, toTimeEntryDraft(entry)]))
)

function startEditing(entry: TimeEntry): void {
  const draft = draftsByEntryId.value.get(entry.id)
  if (!draft) return
  confirmingDeleteId.value = null
  changingDateId.value = null
  editingDraft.value = draft
}

function stopEditing(): void {
  editingDraft.value = null
}

/**
 * The row whose entry is loaded in the form is locked: its actions menu is
 * disabled while the edit is open.
 *
 * The form above *is* the way to act on that entry — a second Edit would
 * reload the draft and discard what's been typed, and a move or delete would
 * leave the form editing something that has changed underneath it. The warning
 * background and the dimmed content say which row it is; the disabled menu
 * says to finish or cancel the edit first.
 */
function isUnderEdit(entry: TimeEntry): boolean {
  return editingDraft.value?.id === entry.id
}

/** The edited entry was gone by the time the save landed. */
function onEditTargetMissing(): void {
  stopEditing()
  toast.add({
    title: 'Entry no longer exists',
    description: 'It was removed elsewhere. The list has been refreshed.',
    icon: 'i-lucide-alert-triangle',
    color: 'warning'
  })
  void refresh()
}

// Reopening the modal — on another day, or the same one — must not resume an
// edit the user walked away from.
watch(open, (isOpen) => {
  if (!isOpen) {
    stopEditing()
    confirmingDeleteId.value = null
    changingDateId.value = null
  }
})

// Change date — move an entry to another day

const { mutateAsync: updateTimeEntry } = useUpdateTimeEntry()

/**
 * Rows the date action is offered on: the same drafts the pencil needs, minus
 * those with no readable activity. See `canChangeDate` — a move resends the
 * whole entry, and this action has no activity picker to fill that gap with.
 */
function canMove(entry: TimeEntry): boolean {
  return canChangeDate(draftsByEntryId.value.get(entry.id))
}

function startDateChange(entry: TimeEntry): void {
  const draft = draftsByEntryId.value.get(entry.id)
  if (!canChangeDate(draft)) return
  confirmingDeleteId.value = null
  // Start on the day the entry is already on, so the picker opens in the right
  // month and a mis-click can't move it somewhere unrelated.
  pickedDate.value = draft?.spentOn ?? ''
  changingDateId.value = entry.id
}

function cancelDateChange(): void {
  changingDateId.value = null
  pickedDate.value = ''
}

/**
 * `UCalendar` speaks `@internationalized/date` values; everything else here —
 * `spentOn`, the query filters, the update payload — speaks `YYYY-MM-DD`
 * strings. Converting in this one computed keeps the string form as the source
 * of truth, so the pure helpers and their tests stay free of calendar objects.
 *
 * `parseDate` throws on a malformed string, hence the guard: an entry whose
 * stored date is unusable opens the picker on no selection rather than
 * crashing the row.
 */
const pickedCalendarDate = computed<DateValue | undefined>({
  get: () =>
    isCalendarDate(pickedDate.value) ? parseDate(pickedDate.value) : undefined,
  set: (value) => {
    pickedDate.value = value?.toString() ?? ''
  }
})

/**
 * A picked day that would actually change something. Same day → nothing to
 * send; an empty or impossible day → `toDateChangeInput` would refuse it
 * anyway, and a disabled button says so before the click.
 */
function canSaveDate(entry: TimeEntry): boolean {
  const draft = draftsByEntryId.value.get(entry.id)
  if (!draft) return false
  if (pickedDate.value === draft.spentOn) return false
  return toDateChangeInput(draft, pickedDate.value) !== null
}

/**
 * Move the entry, then let the list refetch: the entry is on another day now,
 * so it leaves this modal on its own via the mutation's `['time-entries']`
 * invalidation. Failures toast rather than alert inline, matching delete — the
 * row is on its way out either way.
 */
async function confirmDateChange(entry: TimeEntry): Promise<void> {
  const draft = draftsByEntryId.value.get(entry.id)
  const input = draft ? toDateChangeInput(draft, pickedDate.value) : null
  if (!input) return

  const movedTo = input.spentOn
  movingId.value = entry.id
  try {
    await updateTimeEntry(input)
    // Unreachable while `isUnderEdit` disables this row's move, but kept as the
    // invariant it protects: the form must never hold a snapshot of an entry
    // that has left this day, or saving it would write the entry back here.
    if (isUnderEdit(entry)) stopEditing()
    cancelDateChange()
    toast.add({
      title: 'Entry moved',
      description: `${timeEntryHours(entry).toFixed(2)}h moved to ${movedTo}.`,
      icon: 'i-lucide-calendar-check',
      color: 'success'
    })
  } catch (e) {
    const err = e as ({ code?: string; message?: string } & Error) | null
    toast.add({
      title: 'Couldn’t move entry',
      description:
        err?.message ?? 'An unexpected error occurred while moving the entry.',
      icon: 'i-lucide-alert-octagon',
      color: 'error'
    })
    // A vanished entry can't be moved, and the stale row is still on screen.
    if (err?.code === 'OPENPROJECT_NOT_FOUND') {
      cancelDateChange()
      void refresh()
    }
  } finally {
    movingId.value = null
  }
}

// Delete

const { mutateAsync: deleteTimeEntry } = useDeleteTimeEntry()

function askDelete(entry: TimeEntry): void {
  changingDateId.value = null
  confirmingDeleteId.value = entry.id
}

function cancelDelete(): void {
  confirmingDeleteId.value = null
}

/**
 * Delete is irreversible and there is no server-side undo, hence the inline
 * confirm above. Failures surface as a toast rather than an inline alert: the
 * row they belong to is gone from the confirm state by then, and on a 404 the
 * row itself is about to disappear from the refreshed list.
 */
async function confirmDelete(entry: TimeEntry): Promise<void> {
  deletingId.value = entry.id
  try {
    await deleteTimeEntry({ id: entry.id })
    // Same invariant as a move: the form must never be left editing an entry
    // that no longer exists. Unreachable while this row's delete is disabled
    // under edit, but the guard is what makes that safe to change.
    if (isUnderEdit(entry)) stopEditing()
    if (changingDateId.value === entry.id) cancelDateChange()
    confirmingDeleteId.value = null
    toast.add({
      title: 'Entry deleted',
      description: `${timeEntryHours(entry).toFixed(2)}h on ${props.date}.`,
      icon: 'i-lucide-trash-2',
      color: 'success'
    })
  } catch (e) {
    const err = e as ({ code?: string; message?: string } & Error) | null
    toast.add({
      title: 'Couldn’t delete entry',
      description:
        err?.message ?? 'An unexpected error occurred while deleting the entry.',
      icon: 'i-lucide-alert-octagon',
      color: 'error'
    })
  } finally {
    deletingId.value = null
  }
}

// Row actions menu

/**
 * The row's actions, as menu items behind one ellipsis button rather than a row
 * of icon buttons: three ghost icons crowded the hours badge, and a menu's
 * labels say what each action does without needing a tooltip.
 *
 * Per-item `disabled` covers only what that action itself can't do — an entry
 * with no readable draft can't be edited (`draftsByEntryId`), one with no
 * readable activity can't be moved (`canMove`). Whether the row may act at all
 * — a write in flight, or the entry being edited above — is on the trigger,
 * which disables the whole menu.
 *
 * Rebuilt per render rather than memoised: the items close over row state that
 * changes on every write, and there are at most a day's worth of rows in view.
 */
function entryActions(entry: TimeEntry): DropdownMenuItem[] {
  return [
    {
      label: 'Edit',
      icon: 'i-lucide-pencil',
      disabled: !draftsByEntryId.value.get(entry.id),
      onSelect: () => startEditing(entry)
    },
    {
      label: 'Change date',
      icon: 'i-lucide-calendar',
      disabled: !canMove(entry),
      onSelect: () => startDateChange(entry)
    },
    { type: 'separator' },
    {
      label: 'Delete',
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => askDelete(entry)
    }
  ]
}

/**
 * Bridge errors cross IPC as `{ code, message }` (see
 * `src-tauri/src/error.rs` → `AppError`); read them defensively and
 * never reach into secret-bearing detail.
 */
const errorCode = computed(() => {
  const e = error.value as ({ code?: string } & Error) | null
  return e?.code ?? 'OPENPROJECT_UNKNOWN'
})

const errorMessage = computed(() => {
  const e = error.value as ({ message?: string } & Error) | null
  return (
    e?.message ??
    'An unexpected error occurred while loading this day’s entries.'
  )
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="dateLabel"
    description="Log time against this day and review what's already recorded."
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <TimeEntryForm
        :date="props.date"
        :draft="editingDraft"
        :busy="deletingId !== null || movingId !== null"
        @cancel-edit="stopEditing"
        @missing="onEditTargetMissing"
        @saved="stopEditing"
        @update:saving="(value) => (formSaving = value)"
      />
    </template>

    <template #footer>
      <div class="flex w-full flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-highlighted">
            Logged entries
          </h3>
          <div class="flex items-center gap-2">
            <UBadge
              v-if="entries.length > 0"
              :color="dayTotalColor(totalHours)"
              variant="soft"
              size="lg"
              class="tabular-nums"
              :label="totalLabel"
            />
            <UButton
              color="neutral"
              variant="subtle"
              size="sm"
              icon="i-lucide-refresh-cw"
              aria-label="Refresh entries"
              :loading="isLoading"
              :disabled="isBusy"
              @click="() => refresh()"
            />
          </div>
        </div>

        <!-- Error -->
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-alert-triangle"
          title="Couldn't load this day's entries"
          :description="errorMessage"
        >
          <template #actions>
            <span class="text-muted text-xs">{{ errorCode }}</span>
          </template>
        </UAlert>

        <!-- First load -->
        <div v-else-if="isLoading && entries.length === 0" class="flex flex-col gap-2">
          <USkeleton v-for="i in 2" :key="i" class="h-12 w-full" />
        </div>

        <!-- Empty -->
        <UEmpty
          v-else-if="entries.length === 0"
          icon="i-lucide-clock"
          title="Nothing logged yet"
          description="Time you log for this day will appear here."
          variant="naked"
        />

        <!-- List. Each row carries its actions in an ellipsis menu; delete and
             move confirm in place rather than in a nested modal, so the entry
             stays visible while the user decides. -->
        <ul v-else class="flex max-h-56 flex-col gap-2 overflow-y-auto">
          <li
            v-for="entry in entries"
            :key="entry.id"
            class="flex flex-col gap-2 rounded-md px-3 py-2"
            :class="
              isUnderEdit(entry) ? 'bg-warning/10' : 'bg-elevated/50'
            "
          >
            <!-- Dimmed under edit: the row is inert while the form above owns
                 that entry, and the background alone read as "highlighted"
                 rather than "not the thing to act on". The `li`'s warning
                 background stays at full strength — only its content fades. -->
            <div
              class="flex items-center justify-between gap-3"
              :class="{ 'opacity-50': isUnderEdit(entry) }"
            >
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-sm font-medium text-highlighted">
                  <!-- The number ahead of the title: two entries against
                       similarly-named items look identical without it, and the
                       number is what gets looked up in OpenProject. -->
                  <span
                    v-if="timeEntryWorkPackageNumber(entry)"
                    class="text-muted font-normal tabular-nums"
                  >
                    {{ timeEntryWorkPackageNumber(entry) }}
                  </span>
                  {{ workPackageLabel(entry) }}
                </span>
                <span
                  v-if="timeEntryCommentText(entry)"
                  class="truncate text-xs text-muted"
                >
                  {{ timeEntryCommentText(entry) }}
                </span>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <UBadge
                  color="primary"
                  variant="soft"
                  size="lg"
                  class="mr-1 tabular-nums"
                  :label="`${timeEntryHours(entry).toFixed(2)}h`"
                />
                <!-- One menu rather than a row of icon buttons. The content is
                     portaled, so it isn't clipped by the list's own
                     `overflow-y-auto`; `align: 'end'` keeps it at the right
                     edge of the row, and `side: 'top'` opens it upwards, clear
                     of the confirm strips that appear below the row. Reka still
                     flips it back down on its own when there's no room above. -->
                <UDropdownMenu
                  :items="entryActions(entry)"
                  :content="{ align: 'end', side: 'top' }"
                  :disabled="isBusy || isUnderEdit(entry)"
                >
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-ellipsis-vertical"
                    :aria-label="`Actions for entry #${entry.id}`"
                    :loading="deletingId === entry.id || movingId === entry.id"
                    :disabled="isBusy || isUnderEdit(entry)"
                  />
                </UDropdownMenu>
              </div>
            </div>

            <!-- Inline date picker, same footprint as the delete confirm so
                 the entry stays visible while it's being moved. -->
            <div
              v-if="changingDateId === entry.id"
              class="flex items-center justify-between gap-2 border-t border-default pt-2"
            >
              <div class="flex items-center gap-2">
                <span class="text-xs text-muted">Move to</span>
                <!-- The list scrolls inside `max-h-56`, so the calendar goes in
                     a popover rather than inline — an inline month grid would
                     be clipped by that overflow. -->
                <UPopover :disabled="isBusy">
                  <UButton
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    icon="i-lucide-calendar"
                    class="tabular-nums"
                    :label="pickedDate || 'Pick a day'"
                    :disabled="isBusy"
                    :aria-label="`New date for entry #${entry.id}`"
                  />
                  <template #content>
                    <UCalendar v-model="pickedCalendarDate" class="p-2" />
                  </template>
                </UPopover>
              </div>
              <div class="flex items-center gap-1">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  label="Cancel"
                  :disabled="isBusy"
                  @click="cancelDateChange()"
                />
                <UButton
                  color="primary"
                  variant="solid"
                  size="xs"
                  label="Move"
                  :loading="movingId === entry.id"
                  :disabled="isBusy || !canSaveDate(entry)"
                  @click="confirmDateChange(entry)"
                />
              </div>
            </div>

            <div
              v-if="confirmingDeleteId === entry.id"
              class="flex items-center justify-between gap-2 border-t border-default pt-2"
            >
              <span class="text-xs text-muted">
                Delete this entry? This can't be undone.
              </span>
              <div class="flex items-center gap-1">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  label="Cancel"
                  :disabled="isBusy"
                  @click="cancelDelete()"
                />
                <UButton
                  color="error"
                  variant="solid"
                  size="xs"
                  label="Delete"
                  :loading="deletingId === entry.id"
                  :disabled="isBusy"
                  @click="confirmDelete(entry)"
                />
              </div>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </UModal>
</template>
