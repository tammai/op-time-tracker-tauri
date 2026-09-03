<script setup lang="ts">
/* eslint-disable vue/no-v-html -- the renderer rebuilds known HTML, escapes the rest, and filters URLs */
import { computed } from 'vue'

import { renderMarkdown } from '@renderer/utils/markdown'

const props = defineProps<{
  source: string
}>()

const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- `renderMarkdown` filters every link and image URL, escapes raw HTML, and
       rebuilds the narrow set OpenProject's own editor stores in a description
       (`utils/openproject-html.ts`) from scratch rather than passing it
       through. Never replace it with OpenProject's `html` field. -->
  <div class="markdown-renderer" v-html="html" />
</template>

<style scoped>
.markdown-renderer {
  color: var(--ui-text);
  font-family: var(--font-sans);
  font-size: 0.875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.markdown-renderer :deep(:first-child) {
  margin-top: 0;
}

.markdown-renderer :deep(:last-child) {
  margin-bottom: 0;
}

.markdown-renderer :deep(p),
.markdown-renderer :deep(blockquote),
.markdown-renderer :deep(pre),
.markdown-renderer :deep(ul),
.markdown-renderer :deep(ol) {
  margin-block: 0.5rem;
}

.markdown-renderer :deep(h1),
.markdown-renderer :deep(h2),
.markdown-renderer :deep(h3) {
  color: var(--ui-text-highlighted);
  font-weight: 600;
  line-height: 1.25;
  margin-block: 0.75rem 0.5rem;
}

.markdown-renderer :deep(h1) {
  font-size: 1.375rem;
}

.markdown-renderer :deep(h2) {
  font-size: 1.2rem;
}

.markdown-renderer :deep(h3) {
  font-size: 1.05rem;
}

.markdown-renderer :deep(ul),
.markdown-renderer :deep(ol) {
  padding-inline-start: 1.5rem;
}

.markdown-renderer :deep(ul) {
  list-style: disc;
}

.markdown-renderer :deep(ol) {
  list-style: decimal;
}

.markdown-renderer :deep(li:has(> input[type='checkbox'])) {
  list-style: none;
  position: relative;
}

.markdown-renderer :deep(li > input[type='checkbox']) {
  accent-color: var(--ui-primary);
  block-size: 1rem;
  inline-size: 1rem;
  inset-block-start: 0.15625rem;
  inset-inline-start: -1.5rem;
  margin: 0;
  opacity: 1;
  position: absolute;
}

.markdown-renderer :deep(blockquote) {
  border-inline-start: 0.2rem solid var(--ui-border-accented);
  color: var(--ui-text-muted);
  padding-inline-start: 0.75rem;
}

.markdown-renderer :deep(code) {
  background: var(--ui-bg-elevated);
  border-radius: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.875em;
  padding: 0.125rem 0.25rem;
}

.markdown-renderer :deep(pre) {
  background: var(--ui-bg-elevated);
  border-radius: 0.375rem;
  overflow-x: auto;
  padding: 0.75rem;
}

.markdown-renderer :deep(pre code) {
  background: transparent;
  padding: 0;
}

.markdown-renderer :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.markdown-renderer :deep(img) {
  border-radius: 0.375rem;
  height: auto;
  max-width: 100%;
}

/* OpenProject stores an inline image as a `<figure>`, because CommonMark has no
   figure node. `figure` carries a browser default margin that would indent the
   image relative to the surrounding text. */
.markdown-renderer :deep(figure) {
  margin: 0.5rem 0;
}

.markdown-renderer :deep(figcaption) {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}

/* An embedded macro — a work package table, a table of contents — is rendered
   server-side from a query this app cannot run, so what appears is a
   placeholder saying so. Dimmed and bordered, because it names something
   missing rather than being content itself. */
.markdown-renderer :deep(.op-uc-macro) {
  border: 1px dashed var(--ui-border-accented);
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: inline-block;
  font-size: 0.8125rem;
  padding: 0.375rem 0.625rem;
}

.markdown-renderer :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  border: 1px solid var(--ui-border-accented);
  padding: 0.375rem 0.5rem;
  text-align: start;
}
</style>
