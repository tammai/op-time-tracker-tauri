<script setup lang="ts">
import '@milkdown/prose/view/style/prosemirror.css'
import '@milkdown/prose/tables/style/tables.css'

import { computed, shallowRef, useTemplateRef } from 'vue'

import { DROP_PRIORITY, useFileDrop } from '@renderer/composables/useFileDrop'
import { useDescriptionImages } from '@renderer/composables/useDescriptionImages'
import { useMilkdownEditor } from '@renderer/composables/useMilkdownEditor'
import { isSafeLinkHref } from '@shared/validation/url'

const model = defineModel<string>({ required: true })

const props = defineProps<{
  disabled?: boolean
  label: string
  placeholder?: string
  /**
   * The work package images are attached to, enabling the image button, paste
   * and drop.
   *
   * Absent in the create form, and that is not an oversight: an inline image in
   * an OpenProject description *is* an attachment, and an attachment needs a
   * work package to hang off — there is no id until the thing is saved.
   */
  attachTo?: number | null
}>()

const editorRoot = useTemplateRef<HTMLElement>('editorRoot')
const isLinkOpen = shallowRef(false)
const isEditingExistingLink = shallowRef(false)
const linkHref = shallowRef('')
const headingButtons = [
  { level: 1, icon: 'i-lucide-heading-1' },
  { level: 2, icon: 'i-lucide-heading-2' },
  { level: 3, icon: 'i-lucide-heading-3' }
] as const

const isLinkHrefValid = computed(() => isSafeLinkHref(linkHref.value))

const editor = useMilkdownEditor({
  root: editorRoot,
  markdown: model,
  disabled: () => Boolean(props.disabled),
  label: props.label,
  placeholder: props.placeholder
})

/**
 * Images in the description: upload as an attachment, insert at the cursor.
 *
 * Three ways in, each with a different payload — the toolbar button (Rust opens
 * the picker), a paste (bytes over IPC), and a drop (OS paths). See
 * `useDescriptionImages` for why they differ.
 */
const images = useDescriptionImages({
  workPackageId: () => props.attachTo ?? null,
  insert: (src, alt) => editor.insertImage(src, alt)
})

/**
 * A drop on the editor inserts the image; a drop on the panel behind it only
 * attaches. Registered at the higher priority so exactly one of those happens —
 * Tauri delivers the drop to the window rather than to an element, so without
 * a single owner both would fire.
 */
const { isOver: isDropTarget } = useFileDrop({
  element: () => editorRoot.value,
  enabled: () => images.isEnabled.value && !props.disabled,
  onDrop: (paths) => void images.insertFromPaths(paths),
  priority: DROP_PRIORITY.editor
})

/**
 * Consume a paste that carries an image; let every other paste through
 * untouched, or copying a paragraph into the description would stop working.
 */
function onPaste(event: ClipboardEvent): void {
  if (props.disabled) return
  images.handlePaste(event)
}

function openLinkDialog(): void {
  const activeHref = editor.activeLinkHref()
  linkHref.value = activeHref ?? ''
  isEditingExistingLink.value = activeHref !== null
  isLinkOpen.value = true
}

function applyLink(): void {
  if (!isLinkHrefValid.value) return

  if (editor.setLink(linkHref.value.trim())) {
    isLinkOpen.value = false
  }
}

function removeLink(): void {
  if (editor.removeLink()) {
    isLinkOpen.value = false
  }
}
</script>

<template>
  <div class="overflow-hidden rounded-md border border-accented bg-default">
    <div
      v-if="!props.disabled"
      class="flex min-h-10 items-center border-b border-accented p-1"
      role="toolbar"
      aria-label="Text formatting"
    >
      <button
        type="button"
        class="markdown-button"
        aria-label="Bold"
        title="Bold"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleBold"
      >
        <UIcon name="i-lucide-bold" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Italic"
        title="Italic"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleItalic"
      >
        <UIcon name="i-lucide-italic" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Strikethrough"
        title="Strikethrough"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleStrikethrough"
      >
        <UIcon name="i-lucide-strikethrough" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Inline code"
        title="Inline code"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleInlineCode"
      >
        <UIcon name="i-lucide-code" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Code block"
        title="Code block (press Enter twice to exit)"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.createCodeBlock"
      >
        <UIcon name="i-lucide-square-code" class="size-4" />
      </button>

      <span class="mx-0.5 h-5 border-l border-accented" aria-hidden="true" />

      <button
        v-for="heading in headingButtons"
        :key="heading.level"
        type="button"
        class="markdown-button"
        :aria-label="`Heading ${heading.level}`"
        :title="`Heading ${heading.level}`"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.setHeading(heading.level)"
      >
        <UIcon :name="heading.icon" class="size-4" />
      </button>

      <span class="mx-0.5 h-5 border-l border-accented" aria-hidden="true" />

      <button
        type="button"
        class="markdown-button"
        :class="{ 'is-active': editor.activeList.value === 'bullet' }"
        aria-label="Bullet list"
        :aria-pressed="editor.activeList.value === 'bullet'"
        title="Bullet list"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleBulletList"
      >
        <UIcon name="i-lucide-list" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        :class="{ 'is-active': editor.activeList.value === 'ordered' }"
        aria-label="Numbered list"
        :aria-pressed="editor.activeList.value === 'ordered'"
        title="Numbered list"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleOrderedList"
      >
        <UIcon name="i-lucide-list-ordered" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        :class="{ 'is-active': editor.activeList.value === 'task' }"
        aria-label="Checklist"
        :aria-pressed="editor.activeList.value === 'task'"
        title="Checklist"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleTaskList"
      >
        <UIcon name="i-lucide-list-checks" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Quote"
        title="Quote"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.toggleBlockquote"
      >
        <UIcon name="i-lucide-quote" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Link"
        title="Link"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="openLinkDialog"
      >
        <UIcon name="i-lucide-link" class="size-4" />
      </button>
      <!-- Shown only when there is a work package to attach to — see the
           `attachTo` prop. A disabled button here would be unexplainable in the
           create form, where the answer is "save it first". -->
      <button
        v-if="images.isEnabled.value"
        type="button"
        class="markdown-button"
        aria-label="Insert image"
        title="Insert image"
        :disabled="!editor.isReady.value || images.isUploading.value"
        @mousedown.prevent
        @click="images.pickAndInsert()"
      >
        <UIcon
          :name="images.isUploading.value ? 'i-lucide-loader-circle' : 'i-lucide-image'"
          class="size-4"
          :class="images.isUploading.value ? 'animate-spin' : ''"
        />
      </button>

      <span class="mx-0.5 h-5 border-l border-accented" aria-hidden="true" />

      <button
        type="button"
        class="markdown-button"
        aria-label="Undo"
        title="Undo"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.undo"
      >
        <UIcon name="i-lucide-undo-2" class="size-4" />
      </button>
      <button
        type="button"
        class="markdown-button"
        aria-label="Redo"
        title="Redo"
        :disabled="!editor.isReady.value"
        @mousedown.prevent
        @click="editor.redo"
      >
        <UIcon name="i-lucide-redo-2" class="size-4" />
      </button>
    </div>

    <div
      v-show="!editor.error.value"
      ref="editorRoot"
      class="milkdown-root min-h-64"
      :class="isDropTarget ? 'bg-primary/5 outline-2 -outline-offset-2 outline-primary' : ''"
      @paste="onPaste"
    />

    <div v-if="editor.error.value" class="p-3">
      <p class="mb-2 text-xs text-error">
        The visual editor could not start. You can continue editing the Markdown source.
        {{ editor.error.value.message }}
      </p>
      <UTextarea
        v-model="model"
        :aria-label="props.label"
        :disabled="props.disabled"
        :placeholder="props.placeholder"
        :rows="10"
        class="w-full"
        :ui="{
          base: 'min-h-64 resize-y rounded-none border-0 bg-default font-sans text-sm ring-0 focus-visible:ring-0'
        }"
      />
    </div>
  </div>

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
      <p v-if="linkHref.trim() && !isLinkHrefValid" class="mt-2 text-xs text-error">
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
</template>

<style scoped>
.markdown-button {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  cursor: pointer;
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  width: 2rem;
}

.markdown-button:hover,
.markdown-button:focus-visible {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
  outline: none;
}

.markdown-button:focus-visible {
  box-shadow: 0 0 0 2px var(--ui-primary);
}

.markdown-button.is-active {
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  color: var(--ui-primary);
}

.markdown-button:disabled {
  cursor: default;
  opacity: 0.45;
}

/* An inline image OpenProject stored as a `<figure>`, rendered by
   `openProjectHtmlNodeView` instead of shown as tags. Inline-block because the
   node is inline and the figure inside it is not. */
.milkdown-root :deep(.op-uc-html) {
  display: inline-block;
  max-width: 100%;
  vertical-align: top;
}

.milkdown-root :deep(.op-uc-html figure) {
  margin: 0;
}

.milkdown-root :deep(.op-uc-html img) {
  border-radius: 0.375rem;
  height: auto;
  max-width: 100%;
}

.milkdown-root :deep(.op-uc-html figcaption) {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}

.milkdown-root :deep(.milkdown),
.milkdown-root :deep(.milkdown-editor) {
  min-height: 16rem;
}

.milkdown-root :deep(.milkdown-editor) {
  color: var(--ui-text);
  font-family: var(--font-sans);
  font-size: 0.875rem;
  line-height: 1.5;
  outline: none;
  overflow-wrap: anywhere;
  padding: 0.75rem;
}

.milkdown-root :deep(.milkdown-editor[contenteditable='false']) {
  cursor: not-allowed;
  opacity: 0.7;
}

.milkdown-root :deep(.milkdown-editor:has(> p:only-child > br:only-child)::before) {
  color: var(--ui-text-dimmed);
  content: attr(data-placeholder);
  pointer-events: none;
  position: absolute;
}

.milkdown-root :deep(.milkdown-editor > :first-child) {
  margin-top: 0;
}

.milkdown-root :deep(.milkdown-editor > :last-child) {
  margin-bottom: 0;
}

.milkdown-root :deep(p),
.milkdown-root :deep(blockquote),
.milkdown-root :deep(pre),
.milkdown-root :deep(ul),
.milkdown-root :deep(ol),
.milkdown-root :deep(table) {
  margin-block: 0.5rem;
}

.milkdown-root :deep(h1),
.milkdown-root :deep(h2),
.milkdown-root :deep(h3) {
  color: var(--ui-text-highlighted);
  font-weight: 600;
  line-height: 1.25;
  margin-block: 0.75rem 0.5rem;
}

.milkdown-root :deep(h1) {
  font-size: 1.375rem;
}

.milkdown-root :deep(h2) {
  font-size: 1.2rem;
}

.milkdown-root :deep(h3) {
  font-size: 1.05rem;
}

.milkdown-root :deep(ul),
.milkdown-root :deep(ol) {
  padding-inline-start: 1.5rem;
}

.milkdown-root :deep(ul) {
  list-style: disc;
}

.milkdown-root :deep(ol) {
  list-style: decimal;
}

.milkdown-root :deep(li[data-item-type='task']) {
  list-style: none;
  padding-inline-start: 0;
  position: relative;
}

.milkdown-root :deep(.task-list-checkbox) {
  accent-color: var(--ui-primary);
  block-size: 1rem;
  cursor: pointer;
  inline-size: 1rem;
  inset-block-start: 0.15625rem;
  inset-inline-start: -1.5rem;
  margin: 0;
  position: absolute;
}

.milkdown-root
  :deep(.milkdown-editor[contenteditable='false'] .task-list-checkbox) {
  cursor: not-allowed;
  pointer-events: none;
}

.milkdown-root :deep(blockquote) {
  border-inline-start: 0.2rem solid var(--ui-border-accented);
  color: var(--ui-text-muted);
  padding-inline-start: 0.75rem;
}

.milkdown-root :deep(code) {
  background: var(--ui-bg-elevated);
  border-radius: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.875em;
  padding: 0.125rem 0.25rem;
}

.milkdown-root :deep(pre) {
  background: var(--ui-bg-elevated);
  border-radius: 0.375rem;
  overflow-x: auto;
  padding: 0.75rem;
}

.milkdown-root :deep(pre code) {
  background: transparent;
  padding: 0;
}

.milkdown-root :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.milkdown-root :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.milkdown-root :deep(th),
.milkdown-root :deep(td) {
  border: 1px solid var(--ui-border-accented);
  padding: 0.375rem 0.5rem;
  text-align: start;
}
</style>
