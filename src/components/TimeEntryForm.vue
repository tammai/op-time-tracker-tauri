<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
// Imported explicitly rather than relying on the generated `auto-imports.d.ts`
// globals: those satisfy the type checker but not eslint's `no-undef`, and the
// generated file is gitignored, so a fresh clone would fail lint.
import { useToast } from '@nuxt/ui/composables/useToast'
import { z } from 'zod'

import { useWorkPackagePicker } from '@renderer/composables/useWorkPackagePicker'
import {
  WORK_PACKAGE_SEARCH_MAX_CHARS,
  WORK_PACKAGE_SEARCH_MIN_CHARS
} from '@shared/validation/work-package-search'
import { timeEntryActivityQueries } from '@renderer/composables/queries/time-entry-activities'
import {
  useCreateTimeEntry,
  useUpdateTimeEntry
} from '@renderer/composables/queries/time-entries'
import type { TimeEntryDraft } from '@renderer/utils/time-entry-draft'
import { HOURS_MIN, clampEntryHours } from '@renderer/utils/entry-hours'

/**
 * The time-entry form, rendered in the day modal's top section. One component
 * serves both modes: with `draft` unset it logs a new entry, with `draft` set
 * it edits that entry in place.
 *
 * Both modes share every field, every validation rule, and the activity
 * scoping — so they share a component. Splitting them would mean maintaining
 * two copies of the work-package/activity wiring that would drift.
 *
 * Neither mode carries a date field: both write to the day the modal is
 * showing. Moving an entry to another day is the row's own date action in
 * `DayEntriesModal`.
 *
 * Conventions (`docs/conventions-frontend.md`):
 * - No direct `window.openproject.*` calls — the work-package list, the
 *   activity list, and both writes go through query/mutation composables,
 *   so the Colada cache and its invalidation stay wired.
 * - Cache invalidation lives in the mutation composables, not here: after a
 *   successful save the calendar grid, the month total, and this modal's
 *   entry list all refetch without this component knowing about them.
 *
 * OpenProject requires an activity on every entry, and the allowed set is
 * project-scoped — so the activity query is keyed on the selected work
 * package and refetches when it changes.
 *
 * Security: the form sends plain numeric ids. The backend re-validates
 * them and builds the request hrefs itself, so nothing typed here can reach
 * a request path (`docs/security.md`).
 */

const props = defineProps<{
  /** The day being logged against, `YYYY-MM-DD`. */
  date: string
  /**
   * The entry being edited. Unset (or `null`) means add mode. Changing it
   * reloads the fields — the parent owns which entry, if any, is under edit.
   */
  draft?: TimeEntryDraft | null
  /**
   * Lock the form because a write started elsewhere in the modal (a row being
   * moved or deleted). One write at a time across the whole modal: a second
   * one started mid-flight would race the first's cache invalidation.
   */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** A time entry was created or updated successfully. */
  saved: []
  /** The user backed out of edit mode. */
  cancelEdit: []
  /** An edit failed because the entry no longer exists on the server. */
  missing: []
  /** This form's own save started (`true`) or settled (`false`). */
  'update:saving': [value: boolean]
}>()

const isEditing = computed(() => props.draft != null)

/**
 * Default entry length — half a working day, the midpoint of the slider. Whether
 * a log is shorter or longer, it's a drag in one direction rather than a haul
 * from the end of the track.
 */
const DEFAULT_HOURS = 4

/**
 * Longest entry the form accepts, in either mode — a working day. House rule:
 * no single task exceeds 8h on one day, so editing doesn't get a looser cap
 * than logging.
 *
 * The slider's `max` and the schema below share it, so the control can't offer
 * a value the validation would then reject. The backend stays
 * authoritative with its own (looser, 24h) cap in `CreateTimeEntryInputSchema`.
 *
 * An entry longer than this can still arrive from OpenProject's web UI. The form
 * doesn't rewrite it on load — it pins the thumb at the cap, keeps the true
 * figure in the label, and says why (`hoursCappedNotice`), so the correction is
 * the user's to make deliberately.
 */
const MAX_HOURS = 8

/**
 * Client-side schema for immediate field feedback. The backend
 * re-validates with `Create`/`UpdateTimeEntryInputSchema` and remains
 * authoritative — this one exists so the user sees an inline message instead
 * of a round-trip rejection. Zod 4 takes a single `error` for the
 * type-mismatch message.
 */
const formSchema = z.object({
  workPackageId: z
    .number({ error: 'Choose a work package.' })
    .int()
    .positive('Choose a work package.'),
  activityId: z
    .number({ error: 'Choose an activity.' })
    .int()
    .positive('Choose an activity.'),
  hours: z
    .number({ error: 'Enter the hours worked.' })
    .positive('Hours must be greater than 0.')
    .max(MAX_HOURS, `A single entry cannot exceed ${MAX_HOURS} hours.`),
  comment: z.string().max(2000, 'Comment is too long.').optional()
})

type FormState = z.infer<typeof formSchema>

const state = ref<{
  workPackageId: number | undefined
  activityId: number | undefined
  hours: number
  comment: string
}>({
  workPackageId: undefined,
  activityId: undefined,
  hours: DEFAULT_HOURS,
  comment: ''
})

/**
 * The last failed save. Bridge errors cross IPC as `{ code, message }` — read
 * defensively via `toBridgeError` and never reach into secret-bearing detail.
 */
const saveError = ref<{ code: string; message: string } | null>(null)

/**
 * Load the entry under edit into the fields, and clear them when edit mode
 * ends.
 *
 * Leaving edit mode empties the work package too, not just the hours and
 * comment: the edited entry's item is not a choice the user made for a *new*
 * entry, so keeping it selected turned a cancelled edit into a pre-filled
 * "log time against that same item" form. The activity follows, since the
 * activity watch reselects whenever the work package changes.
 *
 * A successful *create* clears the same four fields, in `onSubmit` — once an
 * entry is logged, nothing about it should still be sitting in the form.
 */
watch(
  () => props.draft,
  (draft) => {
    saveError.value = null
    if (draft) {
      state.value = {
        workPackageId: draft.workPackageId,
        activityId: draft.activityId,
        hours: draft.hours,
        comment: draft.comment
      }
      // An entry logged elsewhere can be longer than the house cap. Its hours
      // are kept as they are — the form doesn't rewrite an entry the user only
      // opened to fix a comment — but the thumb can't go that far, so say why
      // before the save reports it.
      hoursCappedNotice.value = draft.hours > MAX_HOURS ? OVER_CAP_NOTICE : null
      return
    }
    state.value.workPackageId = undefined
    state.value.hours = DEFAULT_HOURS
    state.value.comment = ''
    hoursCappedNotice.value = null
  }
)

// Work packages — the select's options.

// Suggestions are the user's priority items, narrowed by title as you type;
// a term none of them match is searched instance-wide. See
// `useWorkPackagePicker`.
// The edited entry's item is rarely in the suggestions, and the select can
// only label an option it holds — so hand it the subject the entry already
// carries, or the trigger reads as a bare `#12345`.
const {
  items: workPackageItems,
  searchTerm: workPackageSearch,
  isSearching: isSearchingWorkPackages,
  isTermTooShort: isWorkPackageTermTooShort,
  hasSearchFailed: hasWorkPackageSearchFailed,
  isSearchTruncated: isWorkPackageSearchTruncated,
  searchTotal: workPackageSearchTotal,
  isLoading: workPackagesLoading,
  error: workPackagesError,
  searchError: workPackageSearchError
} = useWorkPackagePicker({
  selectedId: () => state.value.workPackageId,
  knownSubject: () =>
    props.draft
      ? { id: props.draft.workPackageId, subject: props.draft.workPackageSubject }
      : null
})

/**
 * Props for the select's search box. Not inline in the template: `InputProps`
 * marks its `InputHTMLAttributes` base `@vue-ignore`, so `maxlength` is
 * missing from the resolved prop type though the `<input>` still honours it.
 * Excess property checking only fires on fresh literals, so passing a variable
 * keeps the behaviour without a cast.
 *
 * No `inputmode: 'numeric'` any more — the term is a title, and a numeric
 * keypad would be the wrong keyboard for it.
 */
const searchInputProps = {
  placeholder: 'Search by title…',
  icon: 'i-lucide-search',
  maxlength: WORK_PACKAGE_SEARCH_MAX_CHARS
}

// Activities — required by OpenProject, scoped to the selected work package.

const {
  data: activitiesData,
  status: activitiesStatus,
  error: activitiesError,
  refresh: refreshActivities
} = useQuery(() =>
  timeEntryActivityQueries.list(state.value.workPackageId)
)

const activityItems = computed(() =>
  (activitiesData.value?._embedded.elements ?? []).map((a) => ({
    label: a.name,
    value: a.id
  }))
)

const activitiesLoading = computed(() => activitiesStatus.value === 'pending')

/**
 * Preselect an activity once the list arrives: OpenProject's flagged
 * default if there is one, otherwise the first. Also clears a stale
 * selection when switching to a work package whose project doesn't allow
 * the previously chosen activity — otherwise the server would reject the
 * save with a 422 the user can't see the cause of.
 */
watch(
  () => activitiesData.value,
  (data) => {
    const elements = data?._embedded.elements ?? []
    if (elements.length === 0) {
      state.value.activityId = undefined
      return
    }
    const stillValid = elements.some((a) => a.id === state.value.activityId)
    if (stillValid) return
    state.value.activityId =
      elements.find((a) => a.default === true)?.id ?? elements[0].id
  },
  { immediate: true }
)

/** The message shown when the entry's hours sit above the cap. */
const OVER_CAP_NOTICE = `A single entry can't exceed ${MAX_HOURS} hours.`

/**
 * Set when the hours are above the cap, so the correction is announced instead
 * of the number quietly changing under the user. Two ways in: an entry loaded
 * from OpenProject that is already longer than a working day, and `onSubmit`'s
 * last-gate clamp.
 */
const hoursCappedNotice = ref<string | null>(null)

/**
 * Set the hours, from the slider or an anchor. Clears the cap notice: the value
 * the user just chose is the one on screen, so a warning about an earlier one is
 * stale.
 */
function setHours(value: number): void {
  hoursCappedNotice.value = null
  state.value.hours = value
}

/**
 * What the slider binds to. The getter pins an over-cap entry to the end of the
 * track without rewriting its hours; the setter routes through `setHours`.
 *
 * A typed computed with `v-model`, not an inline `@update:model-value` lambda:
 * `components.d.ts` is generated and gitignored, so on a fresh clone (every CI
 * run) `USlider` has no resolved type and such a lambda's parameter would be an
 * implicit `any` — a type error that appears only in CI.
 */
const sliderHours = computed<number>({
  get: () => Math.min(state.value.hours, MAX_HOURS),
  set: setHours
})

/**
 * The marks under the track: the floor, then every whole hour to the cap. Most
 * entries land on one, so they double as one-click shortcuts.
 *
 * The floor earns a mark of its own — it's where the thumb bottoms out, and a
 * quarter hour is the smallest slice that can be logged, so it's worth naming
 * rather than leaving as an unlabelled end of the track.
 *
 * A constant, not a computed: one cap in both modes means one set of marks.
 */
const HOUR_ANCHORS: number[] = [
  HOURS_MIN,
  ...Array.from({ length: MAX_HOURS }, (_, i) => i + 1)
]

/**
 * Where an anchor sits along the track, as a percentage.
 *
 * Measured across `[HOURS_MIN, MAX_HOURS]` rather than `[0, MAX_HOURS]` because
 * that's the range the thumb travels — anchoring against 0 would drift every
 * mark left of the value it names.
 */
function anchorPercent(hours: number): number {
  return ((hours - HOURS_MIN) / (MAX_HOURS - HOURS_MIN)) * 100
}

/** Nothing to pick → the select stays disabled whatever the reason. */
const hasNoActivityOptions = computed(() => activityItems.value.length === 0)

/**
 * The selected work package's project genuinely offers no activity → saving
 * would 422, so block submit and say so.
 *
 * Requires a work package. Without one the activity query never runs, and its
 * empty list means "nothing asked yet" — warning "No activities in this
 * project" there names a project the user hasn't chosen and reads as a fault in
 * an untouched form.
 */
const hasNoActivities = computed(
  () =>
    state.value.workPackageId !== undefined &&
    !activitiesLoading.value &&
    hasNoActivityOptions.value
)

// Save

const { mutateAsync: createTimeEntry, isLoading: creating } = useCreateTimeEntry()
const { mutateAsync: updateTimeEntry, isLoading: updating } = useUpdateTimeEntry()

const saving = computed(() => creating.value || updating.value)

// The modal locks its entry rows while this form is saving, the mirror of the
// `busy` prop locking the form while a row is being moved or deleted.
watch(saving, (value) => emit('update:saving', value))

/**
 * Every interactive control is disabled while *any* write in the modal is in
 * flight — not just this form's own. Kept separate from `saving` so the submit
 * button only spins for its own save; a row's delete shouldn't make this
 * button look like it's the thing loading.
 */
const locked = computed(() => saving.value || props.busy === true)

function toBridgeError(e: unknown): { code: string; message: string } {
  const err = e as ({ code?: string; message?: string } & Error) | null
  return {
    code: err?.code ?? 'OPENPROJECT_UNKNOWN',
    message:
      err?.message ?? 'An unexpected error occurred while saving the entry.'
  }
}

const toast = useToast()

async function onSubmit(event: { data: FormState }): Promise<void> {
  saveError.value = null

  // Last gate before the write. `UForm` already validated against `formSchema`,
  // so this should be unreachable — it exists because a value above the cap was
  // reported reaching the server, and an entry with the wrong hours is not the
  // kind of bug that should depend on one layer behaving.
  const hours = clampEntryHours(event.data.hours, MAX_HOURS)
  if (hours !== event.data.hours) {
    hoursCappedNotice.value = OVER_CAP_NOTICE
    state.value.hours = hours
    return
  }

  // An empty comment is sent as an absent one. On create that means "no
  // comment"; on update the backend reads it as "clear the stored
  // comment" (the update is a full replacement) — which is exactly what
  // emptying the field should do.
  const comment = event.data.comment?.trim()
  // The form always writes to the day the modal is showing. Moving an entry to
  // another day is the row's own date action in `DayEntriesModal`, not a field
  // here.
  const fields = {
    workPackageId: event.data.workPackageId,
    activityId: event.data.activityId,
    spentOn: props.date,
    hours: event.data.hours,
    ...(comment !== undefined && comment !== '' ? { comment } : {})
  }

  const editingId = props.draft?.id

  try {
    if (editingId !== undefined) {
      await updateTimeEntry({ id: editingId, ...fields })
      toast.add({
        title: 'Entry updated',
        description: `${event.data.hours}h on ${props.date}.`,
        icon: 'i-lucide-check-circle',
        color: 'success'
      })
    } else {
      await createTimeEntry(fields)
      toast.add({
        title: 'Time logged',
        description: `${event.data.hours}h on ${props.date}.`,
        icon: 'i-lucide-check-circle',
        color: 'success'
      })
      // Back to an empty form: the entry is logged, so nothing about it should
      // still be sitting in the fields. `activityId` is cleared explicitly
      // rather than left to the activity watch — that watch only reacts once
      // the activities query has re-settled for the now-undefined work
      // package, which would leave a stale activity visible in between.
      // In edit mode the parent clears `draft` instead, which resets these via
      // the watch above.
      state.value.workPackageId = undefined
      state.value.activityId = undefined
      state.value.hours = DEFAULT_HOURS
      state.value.comment = ''
      hoursCappedNotice.value = null
      // Normally already empty — the select clears its own term on select —
      // but not if the user typed a term and picked nothing, which would
      // leave the next entry's suggestions narrowed by a stale search.
      workPackageSearch.value = ''
    }
    emit('saved')
  } catch (e) {
    const error = toBridgeError(e)
    // The entry vanished under the form — editing it is no longer meaningful,
    // so hand the situation to the parent (which drops edit mode and refreshes
    // the list) rather than showing an alert against a form that can't succeed.
    if (editingId !== undefined && error.code === 'OPENPROJECT_NOT_FOUND') {
      emit('missing')
      return
    }
    saveError.value = error
  }
}
</script>

<template>
  <UForm
    :schema="formSchema"
    :state="state"
    class="flex flex-col gap-4"
    @submit="onSubmit"
  >
    <!-- Work package and activity share the top row: the activity is a scope for
         the item beside it rather than a field of its own standing, so they read
         as one choice — and pairing them leaves the whole width below for the
         slider. -->
    <div class="flex items-start gap-3">
      <UFormField name="workPackageId" class="min-w-0 flex-1">
        <USelectMenu
          v-model="state.workPackageId"
          v-model:search-term="workPackageSearch"
          :items="workPackageItems"
          value-key="value"
          :loading="workPackagesLoading"
          :disabled="locked"
          icon="i-lucide-package"
          placeholder="Select a work package"
          aria-label="Work package"
          :search-input="searchInputProps"
          ignore-filter
          class="w-full"
        >
          <!-- `ignore-filter`: the picker composable already filtered these,
               locally or server-side. Letting the select filter again would
               re-test server results against its own fuzzy rules and drop rows
               that legitimately matched the subject. -->
          <!-- The default empty text ("No matching data") reads as "no such work
               package" while a search is still in flight, so say which it is. -->
          <template #empty>
            <span v-if="isSearchingWorkPackages || workPackagesLoading">
              Searching…
            </span>
            <!-- A failed request is not an answer. Saying "no work package
                 matches" here would assert something about the whole instance
                 on the strength of a search that never completed. -->
            <span v-else-if="hasWorkPackageSearchFailed">
              Couldn’t search work packages. Check your connection and retry.
            </span>
            <!-- Below the minimum nothing was sent, so the only honest thing to
                 report is what's missing from the term. -->
            <span v-else-if="isWorkPackageTermTooShort">
              Keep typing — at least {{ WORK_PACKAGE_SEARCH_MIN_CHARS }}
              characters to search.
            </span>
            <span v-else-if="workPackageSearch">
              No work package matches “{{ workPackageSearch }}”.
            </span>
            <span v-else>No work packages.</span>
          </template>
        </USelectMenu>
        <template
          v-if="
            workPackagesError ||
            workPackageSearchError ||
            isWorkPackageSearchTruncated
          "
          #help
        >
          <span v-if="workPackagesError || workPackageSearchError" class="text-error">
            {{
              workPackagesError
                ? "Couldn't load your work packages."
                : "Couldn't search work packages."
            }}
          </span>
          <!-- Silence here would read as "these are all the matches". The
               server caps the page, so say what fraction is on screen. -->
          <span v-else>
            Showing the first {{ workPackageItems.length }} of
            {{ workPackageSearchTotal }} matches — refine your search.
          </span>
        </template>
      </UFormField>

      <!-- A quarter of the row. Activity values are single words
           ("Development", "Management") drawn from a short project-scoped list,
           so they need far less room than a work-package subject; `min-w-0` lets
           a long one truncate instead of pushing the item beside it. The
           placeholder is "Activity" rather than "Select an activity" because at
           this width the longer form truncates mid-word. -->
      <UFormField name="activityId" class="min-w-0 basis-1/4">
        <USelectMenu
          v-model="state.activityId"
          :items="activityItems"
          value-key="value"
          :loading="activitiesLoading"
          :disabled="locked || hasNoActivityOptions"
          icon="i-lucide-tag"
          placeholder="Activity"
          aria-label="Activity"
          class="w-full"
        />
      </UFormField>
    </div>

    <!-- Its own row, the full width of the form: the track is the one control
         here that gets better the wider it is, a quarter-hour being ~3% of it.
         A slider shows no number of its own, so the label row carries the value —
         that's what the `hint` slot is for, keeping the figure on the same line
         as the word it belongs to. -->
    <UFormField name="hours" label="Hours">
      <template #hint>
        <!-- The entry's real hours, which is not always the thumb's position:
             an entry that arrived above the cap keeps its figure here while the
             thumb pins to the end of the track. `text-warning` marks that gap,
             and the notice under the form says what it means. -->
        <span
          class="font-medium tabular-nums"
          :class="state.hours > MAX_HOURS ? 'text-warning' : 'text-highlighted'"
        >
          {{ state.hours }}h
        </span>
      </template>

      <!-- `HOURS_MIN` rather than 0 as the floor: the track then can't offer a
           value the schema's `.positive()` would reject, and `MAX_HOURS` caps it
           in both modes (no task exceeds a working day). The bound value is
           clamped for display only — an over-cap entry must not have its hours
           rewritten just by being opened. -->
      <USlider
        v-model="sliderHours"
        :min="HOURS_MIN"
        :max="MAX_HOURS"
        :step="0.25"
        :disabled="locked"
        tooltip
        class="mt-2"
      />

      <!-- Whole-hour anchors. Inset by half the thumb (`size-4` → `mx-2`) so a
           tick centre and a thumb centre agree at both ends of the track,
           which a plain 0–100% row doesn't. -->
      <div class="relative mx-2 mt-1.5 h-5">
        <button
          v-for="anchor in HOUR_ANCHORS"
          :key="anchor"
          type="button"
          class="absolute top-0 flex -translate-x-1/2 cursor-pointer flex-col items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed"
          :class="
            state.hours === anchor
              ? 'text-primary'
              : 'text-dimmed hover:text-highlighted'
          "
          :style="{ left: `${anchorPercent(anchor)}%` }"
          :disabled="locked"
          :aria-label="`Set hours to ${anchor}`"
          @click="setHours(anchor)"
        >
          <span class="bg-accented h-1 w-px" />
          <span class="text-[10px] leading-none tabular-nums">
            {{ anchor }}
          </span>
        </button>
      </div>
    </UFormField>

    <UFormField name="comment">
      <UTextarea
        v-model="state.comment"
        :rows="2"
        :maxrows="4"
        :disabled="locked"
        autoresize
        placeholder="What did you work on? (optional)"
        aria-label="Comment"
        class="w-full"
      />
    </UFormField>

    <!-- Activities are required by OpenProject — saving without one 422s. -->
    <UAlert
      v-if="activitiesError"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-triangle"
      title="Couldn't load activities"
      description="OpenProject requires an activity on every time entry, so saving is disabled until this loads."
    >
      <template #actions>
        <UButton
          color="error"
          variant="outline"
          size="sm"
          icon="i-lucide-refresh-cw"
          label="Retry"
          :loading="activitiesLoading"
          @click="() => refreshActivities()"
        />
      </template>
    </UAlert>
    <!-- Save failure — includes OpenProject's own 422 message. -->
    <UAlert
      v-if="saveError"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-octagon"
      :title="isEditing ? 'Couldn’t save changes' : 'Couldn’t log time'"
      :description="saveError.message"
    />

    <div class="flex items-center gap-3">
      <!-- Messages take the free space; the buttons keep their intrinsic width
           at the end of the row. Both live here rather than in alert blocks of
           their own: each is a state of the submit sitting beside it — what
           this save will apply to, and why it can't run. -->
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <!-- Edit mode is a different action on the same fields, so say so —
             otherwise "Save changes" is all that distinguishes it. Styled
             identically to the warning below, down to the colour: both are
             one-line states of this submit, and a second colour here made them
             read as two different kinds of notice. -->
        <p
          v-if="isEditing"
          class="text-warning flex items-center gap-1.5 text-xs"
        >
          <UIcon name="i-lucide-pencil" class="size-4 shrink-0" />
          <span class="truncate">Editing entry #{{ props.draft?.id }}</span>
        </p>

        <!-- A typed value was above the cap. Sits with the other one-line
             states of this submit rather than under the field, whose container
             is too narrow to read a sentence in. -->
        <p
          v-if="hoursCappedNotice"
          class="text-warning flex items-center gap-1.5 text-xs"
        >
          <UIcon name="i-lucide-alert-triangle" class="size-4 shrink-0" />
          <span class="truncate">{{ hoursCappedNotice }}</span>
        </p>

        <!-- Suppressed when the activities alert above already explains the
             same gap. -->
        <p
          v-if="hasNoActivities && !activitiesError"
          class="text-warning flex items-center gap-1.5 text-xs"
        >
          <UIcon name="i-lucide-alert-triangle" class="size-4 shrink-0" />
          <span class="truncate">No activities in this project.</span>
        </p>
      </div>

      <!-- Cancel sits apart from the submit rather than grouped with it: they
           aren't two halves of one control, and a gap makes the destructive-ish
           one harder to hit by accident. Only the primary action carries an
           icon. -->
      <div class="flex shrink-0 items-center gap-2">
        <UButton
          v-if="isEditing"
          color="neutral"
          variant="soft"
          label="Cancel"
          :disabled="locked"
          @click="emit('cancelEdit')"
        />
        <UButton
          type="submit"
          color="primary"
          :icon="isEditing ? 'i-lucide-save' : 'i-lucide-plus'"
          :label="isEditing ? 'Save changes' : 'Log time'"
          :loading="saving"
          :disabled="locked || hasNoActivities"
        />
      </div>
    </div>
  </UForm>
</template>
