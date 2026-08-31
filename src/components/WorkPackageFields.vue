<script setup lang="ts">
import { computed, ref, shallowRef, useId, type WritableComputedRef } from 'vue'
import { parseDate, type DateValue } from '@internationalized/date'
import type { Editor as TiptapEditor } from '@tiptap/vue-3'
// Type-only, and load-bearing: `setLink`/`unsetLink` reach `ChainedCommands`
// through this extension's module augmentation. Nuxt UI's editor already runs
// the extension (Starter Kit pulls it in), but the augmentation only applies
// where the module is referenced — without this import both commands fail to
// type-check while working perfectly at runtime.
import type {} from '@tiptap/extension-link'

import type { EditorToolbarItem } from '@nuxt/ui/components/EditorToolbar.vue'

import { isCalendarDate } from '@shared/validation/calendar-date'
import { isSafeLinkHref } from '@shared/validation/url'
import type {
  EditableFieldState,
  WorkPackageFieldName
} from '@renderer/composables/useWorkPackageEditor'
import type {
  AssigneeOption,
  FieldOption,
  WorkPackageDraft
} from '@renderer/utils/work-package-draft'

/**
 * The editable field set of a work package.
 *
 * Its own component, and taking **data only** — a draft, the option lists, and a
 * per-field enabled/disabled verdict. It knows nothing about the work package it
 * came from, the form endpoint, saving, or HAL. That is what makes it reusable
 * rather than merely extracted: stage 3's create form mounts this same component
 * against `emptyWorkPackageDraft()` and options from the *create* form endpoint,
 * with no second copy of the layout.
 *
 * One field does differ between the two, and it differs by data rather than by
 * mode: the project is a select when `projectOptions` is passed and a disabled
 * label when it isn't. That is the only branch in here, and it exists because
 * the *edit* form genuinely offers no allowed values for the project — not
 * because this component knows which caller it has.
 *
 * The grid deliberately mirrors the read view's description list — same two
 * columns, same rhythm — so entering edit mode doesn't reflow the panel under
 * the user's eyes.
 *
 * A disabled field carries its reason inline. That is the one piece of helper
 * text worth showing: a greyed-out control with no explanation reads as a bug,
 * and these reasons report real facts about the instance (a workflow with no
 * onward transition, a date derived from child work packages, a request that
 * failed).
 */

const draft = defineModel<WorkPackageDraft>('draft', { required: true })

/**
 * The project, when it is the user's to choose (create mode only).
 *
 * A model of its own rather than a draft field, because it is the *input* the
 * other four selects are derived from rather than one of them — see
 * `resetProjectScopedFields`. Edit mode never binds it and passes
 * `projectLabel` instead.
 */
const projectId = defineModel<number | null>('projectId', { default: null })

const props = defineProps<{
  fields: Record<WorkPackageFieldName, EditableFieldState>
  statusOptions: FieldOption[]
  typeOptions: FieldOption[]
  priorityOptions: FieldOption[]
  assigneeOptions: AssigneeOption[]
  /**
   * The projects a work package may be created in. **Its presence is what
   * switches the project cell from a label to a select** — passing it is how
   * create mode says the field is live here.
   *
   * Absent in edit mode, and deliberately so: OpenProject's *edit* form offers
   * no allowed values for `project` at all, and moving a work package between
   * projects re-derives which types, statuses and assignees are legal. Stage
   * 2's read-only project stands.
   */
  projectOptions?: FieldOption[]
  /**
   * The work package's project, shown but not editable. Used when
   * `projectOptions` is absent.
   */
  projectLabel?: string
  /** True while a save is in flight — everything locks, nothing is lost. */
  busy?: boolean
}>()

/** True when the project is a choice rather than a fact. */
const isProjectEditable = computed(() => props.projectOptions !== undefined)

// Unique per instance, so a second mount (stage 3's create form beside this
// one) can't produce duplicate ids and steal the labels.
const uid = useId()
// `project` isn't a `WorkPackageFieldName` — it has no draft entry and no
// editable state, only a label and an id to tie that label to.
const fieldId = (name: WorkPackageFieldName | 'project'): string => `${uid}-${name}`

/**
 * `null` ↔ `undefined` for the three required selects.
 *
 * The draft says `null` for "we don't know this value" — a work package whose
 * status href was unreadable — because that is what the diff has to recognise
 * to know not to send it. `USelectMenu` derives its model type from its items,
 * whose `value` is a plain number, so it speaks `undefined` for "nothing
 * selected". One adapter per field keeps that presentational difference out of
 * the draft, where it would change what a save means.
 *
 * The assignee select needs no adapter: `null` is a real option there
 * ("Unassigned"), so it is in the item values and types through directly.
 */
function optionalId(
  key: 'statusId' | 'typeId' | 'priorityId'
): WritableComputedRef<number | undefined> {
  return computed({
    get: () => draft.value[key] ?? undefined,
    set: (value) => {
      draft.value[key] = value ?? null
    }
  })
}

const typeId = optionalId('typeId')
const statusId = optionalId('statusId')
const priorityId = optionalId('priorityId')

/** The same `null` ↔ `undefined` adapter, for the project model. */
const projectValue = computed<number | undefined>({
  get: () => projectId.value ?? undefined,
  set: (value) => {
    projectId.value = value ?? null
  }
})

/**
 * Start and due date are **one** control — a range.
 *
 * They are one idea to the user ("when is this work package happening") and
 * OpenProject treats them as a pair, so two independent inputs invited the
 * nonsense state of a due date before its start. The draft still holds two
 * `YYYY-MM-DD` strings, because that is what the diff and the PATCH body speak;
 * only the presentation is unified, exactly as `DayEntriesModal` keeps
 * `spentOn` a string and converts at the calendar's edge.
 *
 * `parseDate` throws on a malformed string, hence the guard: a work package
 * whose stored date is unreadable opens the picker on no selection rather than
 * taking the panel down with it.
 */
const dateRange = computed<{
  start: DateValue | undefined
  end: DateValue | undefined
}>({
  get: () => ({
    start: isCalendarDate(draft.value.startDate)
      ? parseDate(draft.value.startDate)
      : undefined,
    end: isCalendarDate(draft.value.dueDate)
      ? parseDate(draft.value.dueDate)
      : undefined
  }),
  set: (value) => {
    draft.value.startDate = value?.start?.toString() ?? ''
    draft.value.dueDate = value?.end?.toString() ?? ''
  }
})

/** Both halves come from one control, so one verdict governs it. */
const dateField = computed<EditableFieldState>(() => {
  const start = props.fields.startDate
  const end = props.fields.dueDate
  if (start.disabled || end.disabled) {
    return { disabled: true, reason: start.reason ?? end.reason }
  }
  return { disabled: false, reason: null }
})

/**
 * The description toolbar.
 *
 * Deliberately only what **markdown round-trips**. `UEditor` also offers
 * underline, text alignment and colour; none of those survive serialisation to
 * markdown, so a button for them would format text that silently reverts on
 * save. The set here maps one-for-one onto CommonMark.
 *
 * `kind` is what binds a button to `UEditor`'s built-in handler — the component
 * owns execute/isActive, so there is no editor plumbing in this file.
 */
const descriptionToolbar: EditorToolbarItem[][] = [
  [
    { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold', 'aria-label': 'Bold' },
    { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic', 'aria-label': 'Italic' },
    {
      kind: 'mark',
      mark: 'strike',
      icon: 'i-lucide-strikethrough',
      'aria-label': 'Strikethrough'
    },
    { kind: 'mark', mark: 'code', icon: 'i-lucide-code', 'aria-label': 'Inline code' }
  ],
  [
    { kind: 'heading', level: 1, icon: 'i-lucide-heading-1', 'aria-label': 'Heading 1' },
    { kind: 'heading', level: 2, icon: 'i-lucide-heading-2', 'aria-label': 'Heading 2' },
    { kind: 'heading', level: 3, icon: 'i-lucide-heading-3', 'aria-label': 'Heading 3' }
  ],
  [
    { kind: 'bulletList', icon: 'i-lucide-list', 'aria-label': 'Bullet list' },
    { kind: 'orderedList', icon: 'i-lucide-list-ordered', 'aria-label': 'Numbered list' },
    { kind: 'blockquote', icon: 'i-lucide-quote', 'aria-label': 'Quote' },
    { kind: 'codeBlock', icon: 'i-lucide-square-code', 'aria-label': 'Code block' }
  ],
  [
    { kind: 'undo', icon: 'i-lucide-undo-2', 'aria-label': 'Undo' },
    { kind: 'redo', icon: 'i-lucide-redo-2', 'aria-label': 'Redo' }
  ]
]

/**
 * The link dialog.
 *
 * Ours rather than `UEditor`'s built-in `{ kind: 'link' }`, which falls back to
 * `window.prompt()` for the href — and the Tauri webview doesn't implement
 * `prompt`, so that button is dead on click. Passing the href in ourselves uses
 * the same underlying commands with a control that exists.
 *
 * `shallowRef` for the editor: it is a large non-reactive TipTap instance, and
 * making it deeply reactive would be pointless work on every keystroke.
 */
const isLinkOpen = ref(false)
const linkHref = ref('')
const linkEditor = shallowRef<TiptapEditor | null>(null)

/** True once the href is one we're willing to render as an anchor. */
const isLinkHrefValid = computed(() => isSafeLinkHref(linkHref.value))

/** Whether the cursor already sits in a link, which turns Add into Update. */
const isEditingExistingLink = computed(
  () => linkEditor.value?.isActive('link') ?? false
)

function openLinkDialog(editor: TiptapEditor): void {
  linkEditor.value = editor
  // Prefill from the link under the cursor, so editing one isn't retyping it.
  linkHref.value = (editor.getAttributes('link').href as string | undefined) ?? ''
  isLinkOpen.value = true
}

function applyLink(): void {
  const editor = linkEditor.value
  if (editor === null || !isLinkHrefValid.value) return
  // `extendMarkRange` so the whole existing link is replaced rather than the
  // part the cursor happens to sit in.
  editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: linkHref.value.trim() })
    .run()
  isLinkOpen.value = false
}

function removeLink(): void {
  const editor = linkEditor.value
  if (editor === null) return
  editor.chain().focus().extendMarkRange('link').unsetLink().run()
  isLinkOpen.value = false
}

function clearDates(): void {
  draft.value.startDate = ''
  draft.value.dueDate = ''
}
</script>

<template>
  <!-- Four columns, label above its control. The four enumerated fields sit on
       one line in workflow order — status and assignee are what actually change
       day to day, type and priority rarely. Dates take half the row below them,
       and the subject goes last: it is the field least often edited and the one
       that needs the most width.

       `items-start` because a field carrying a reason is taller than its
       neighbours and they should top-align rather than centre. -->
  <div class="grid grid-cols-4 items-start gap-x-4 gap-y-4 text-sm">
    <!-- Project. A select when creating — it is what every other field's legal
         values come from, so it leads the form — and a disabled input when
         editing, where OpenProject offers no allowed values for it at all. A
         disabled input rather than plain text so the row keeps its rhythm, and
         the label carries the reason so a greyed control doesn't read as a bug
         without costing a line of helper text under the field. -->
    <div class="col-span-2 flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('project')">
        {{ isProjectEditable ? 'Project' : 'Project (Edit isn’t supported)' }}
      </label>
      <!-- Search kept here, unlike the short workflow lists: an instance can
           have dozens of projects. -->
      <USelectMenu
        v-if="props.projectOptions"
        :id="fieldId('project')"
        v-model="projectValue"
        :items="props.projectOptions"
        value-key="value"
        :disabled="props.busy"
        placeholder="Choose a project"
        class="w-full"
      />
      <UInput
        v-else
        :id="fieldId('project')"
        :model-value="props.projectLabel ?? ''"
        class="w-full"
        disabled
      />
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('type')">Type</label>
      <!-- `search-input: false` on the short lists: a search box above four
           workflow values is chrome that costs a keystroke and saves none. The
           assignee select keeps its search, where a project's membership can
           run to dozens. -->
      <USelectMenu
        :id="fieldId('type')"
        v-model="typeId"
        :items="props.typeOptions"
        value-key="value"
        :search-input="false"
        :disabled="props.busy || props.fields.type.disabled"
        placeholder="—"
        class="w-full"
      />
      <p v-if="props.fields.type.reason" class="text-muted text-xs">
        {{ props.fields.type.reason }}
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('priority')">Priority</label>
      <USelectMenu
        :id="fieldId('priority')"
        v-model="priorityId"
        :items="props.priorityOptions"
        value-key="value"
        :search-input="false"
        :disabled="props.busy || props.fields.priority.disabled"
        placeholder="—"
        class="w-full"
      />
      <p v-if="props.fields.priority.reason" class="text-muted text-xs">
        {{ props.fields.priority.reason }}
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('assignee')">Assignee</label>
      <!-- The list leads with "Unassigned", so clearing is a pick rather than a
           hidden gesture — and the placeholder says the same thing, since a
           null model renders as unset either way. -->
      <USelectMenu
        :id="fieldId('assignee')"
        v-model="draft.assigneeId"
        :items="props.assigneeOptions"
        value-key="value"
        :disabled="props.busy || props.fields.assignee.disabled"
        placeholder="Unassigned"
        class="w-full"
      />
      <p v-if="props.fields.assignee.reason" class="text-muted text-xs">
        {{ props.fields.assignee.reason }}
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('status')">Status</label>
      <USelectMenu
        :id="fieldId('status')"
        v-model="statusId"
        :items="props.statusOptions"
        value-key="value"
        :search-input="false"
        :disabled="props.busy || props.fields.status.disabled"
        placeholder="—"
        class="w-full"
      />
      <p v-if="props.fields.status.reason" class="text-muted text-xs">
        {{ props.fields.status.reason }}
      </p>
    </div>

    <!-- One control for both dates: they are one decision to the user, and
         OpenProject treats them as a pair. `UInputDate` in range mode is a
         segmented text field — it types dates, it does not pick them, so the
         calendar is a separate popover bound to the same model. The whole field
         is that popover's trigger.

         `justify-center` lands on the field's own `base` slot (an
         `inline-flex`), so the segments sit centred rather than hugging the
         start edge. The trailing padding is unconditional: reserving the clear
         button's space keeps the segments from shifting the moment a date is
         set.

         Clearing has to stay reachable: neither control offers a gesture for
         unsetting a date, and "no dates" is a state OpenProject accepts —
         losing it would break the cleared-versus-untouched distinction the
         PATCH depends on. -->
    <div class="col-span-2 flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('startDate')">
        Start Date → Due Date
      </label>
      <UPopover :disabled="props.busy || dateField.disabled">
        <!-- No separate calendar button and no leading icon: the whole field
             opens the grid, and the label above already says what it is. -->
        <UInputDate
          :id="fieldId('startDate')"
          v-model="dateRange"
          range
          class="w-full justify-center pe-8"
          :disabled="props.busy || dateField.disabled"
        >
          <template #trailing>
            <!-- `.stop`, or clearing would bubble to the trigger and open the
                 calendar on its way out. -->
            <UButton
              v-if="draft.startDate || draft.dueDate"
              color="neutral"
              variant="link"
              size="sm"
              icon="i-lucide-x"
              aria-label="Clear dates"
              class="px-0"
              :disabled="props.busy || dateField.disabled"
              @click.stop="clearDates"
            />
          </template>
        </UInputDate>

        <template #content>
          <UCalendar v-model="dateRange" class="p-2" :number-of-months="2" range />
        </template>
      </UPopover>
      <p v-if="dateField.reason" class="text-muted text-xs">
        {{ dateField.reason }}
      </p>
    </div>

    <!-- Subject full width: the one single-line free-text field, the one most
         likely to be long, and the one already shown as the panel's heading —
         so it needs the room but not the prominence. -->
    <div class="col-span-4 flex min-w-0 flex-col gap-1">
      <label class="text-muted" :for="fieldId('subject')">Subject</label>
      <!-- The placeholder shows the *shape* of a good subject rather than
           naming the field again — the label above already does that, and
           "Subject" as its own placeholder tells a user nothing they can act
           on. -->
      <UInput
        :id="fieldId('subject')"
        v-model="draft.subject"
        class="w-full"
        placeholder="What needs doing — e.g. “Fix login redirect on expired session”"
        :disabled="props.busy || props.fields.subject.disabled"
      />
      <p v-if="props.fields.subject.reason" class="text-muted text-xs">
        {{ props.fields.subject.reason }}
      </p>
    </div>

    <!-- Description last and full width: the only multi-line field, and the one
         with no natural length, so it takes the room the panel has left.
         `min-h-64` rather than a row count — `UEditor` sizes by CSS, having no
         `rows` prop — and the panel scrolls past it rather than the field
         growing without limit.

         `content-type="markdown"` is load-bearing, not cosmetic: the draft holds
         **raw markdown**, which is what `toCreateWorkPackageInput` sends and what
         the backend wraps in a Formattable with the format pinned there. An
         editor bound as HTML would put HTML in that field and OpenProject would
         store it as markdown source. -->
    <div class="col-span-4 flex min-w-0 flex-col gap-1">
      <!-- A `span`, not a `label`: `UEditor` renders a wrapper `div` around a
           contenteditable, and `for=` only binds to labelable form controls —
           pointing at the wrapper would look correct and focus nothing. The
           editor carries its own `aria-label` instead. -->
      <span class="text-muted">Description</span>
      <!-- The border and the toolbar are both ours to supply: `UEditor`'s root
           slot ships empty, so without them the field reads as loose prose on
           the page rather than an input. `layout="fixed"` keeps the toolbar
           pinned above the text — the bubble and floating layouts need two more
           TipTap packages we deliberately didn't install.

           `mode: 'firstLine'` because the default, `everyLine`, repeats the
           placeholder on every empty paragraph — so pressing Enter inside a
           description that already has content shows the prompt again halfway
           down the field.

           The `base` overrides fix spacing meant for a full-width document:
           `sm:px-8` indents the text away from every other field, `*:my-5` puts
           1.25rem between blocks, and `leading-7` loosens the lines.

           `:key` on the disabled verdict: `UEditor` reads `editable` once at
           creation and never watches it, so an editor created non-editable (no
           project chosen yet) stays non-editable after the project is picked and
           the prop flips to true. Re-keying on the disabled state forces a fresh
           editor — created already-editable — the moment a project is chosen.
           The draft holds the text, so recreation loses no content. -->

      <UEditor
        v-slot="{ editor }"
        :key="`description-${props.fields.description.disabled}`"
        v-model="draft.description"
        content-type="markdown"
        class="w-full min-h-64 rounded-md border border-accented divide-y divide-accented"
        :placeholder="{
          placeholder:
            'Context, acceptance criteria, links — anything the next person needs',
          mode: 'firstLine'
        }"
        aria-label="Description"
        :editable="!(props.busy || props.fields.description.disabled)"
        :ui="{ content: 'p-2', base: 'sm:px-0 *:my-2 [&_p]:leading-normal' }"
      >
        <div
          v-if="!(props.busy || props.fields.description.disabled)"
          class="flex items-center gap-1 p-1"
        >
          <UEditorToolbar
            :editor="editor"
            :items="descriptionToolbar"
            layout="fixed"
          />
          <!-- Outside `items` because it opens a dialog rather than running a
               command — the toolbar's own link item would call `prompt()`. -->
          <UTooltip text="Link">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-link"
              aria-label="Link"
              :ui="{ base: editor.isActive('link') ? 'bg-elevated' : '' }"
              @click="openLinkDialog(editor)"
            />
          </UTooltip>
        </div>
      </UEditor>

      <UModal
        v-model:open="isLinkOpen"
        :title="isEditingExistingLink ? 'Edit link' : 'Add link'"
        :ui="{ content: 'max-w-md' }"
      >
        <template #body>
          <UInput
            v-model="linkHref"
            class="w-full"
            placeholder="https://example.com"
            autofocus
            aria-label="Link URL"
            @keydown.enter="applyLink"
          />
          <!-- Shown only once something has been typed: an empty field is not
               yet a mistake, and saying so on open is nagging. -->
          <p v-if="linkHref.trim() && !isLinkHrefValid" class="text-error mt-2 text-xs">
            Enter a full http or https URL, including the scheme.
          </p>
        </template>
        <template #footer>
          <div class="flex w-full items-center justify-end gap-2">
            <UButton
              v-if="isEditingExistingLink"
              color="neutral"
              variant="ghost"
              label="Remove link"
              @click="removeLink"
            />
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="isLinkOpen = false"
            />
            <UButton
              color="primary"
              :label="isEditingExistingLink ? 'Update' : 'Add'"
              :disabled="!isLinkHrefValid"
              @click="applyLink"
            />
          </div>
        </template>
      </UModal>
      <p v-if="props.fields.description.reason" class="text-muted text-xs">
        {{ props.fields.description.reason }}
      </p>
    </div>
  </div>
</template>
