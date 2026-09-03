<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Attachment } from '@opentracker/preload'

import { formatFileSize } from '@renderer/utils/attachment-display'

/**
 * A full-size look at one image attachment.
 *
 * Not a `UModal`: this is already rendered from inside the work-packages modal,
 * and nesting Reka's dialogs put the image behind its own parent's overlay. A
 * plain fixed-position layer sidesteps that, at the cost of implementing the
 * two things the dialog would have given for free — Escape to close, and a
 * click on the backdrop to dismiss.
 *
 * **The backdrop closes on `.self` only.** That is load-bearing, not stylistic:
 * with the handler on the container and `.stop` sprinkled on the children, a
 * click on the download button still reached the backdrop, closed the overlay,
 * and unmounted the component mid-save — so the download appeared to do nothing
 * at all. `.self` fires only when the click landed *directly* on the backdrop
 * element, which no child click can satisfy, however the tree is rearranged
 * later.
 *
 * The image loads from `attachment.proxyUrl`, the same authenticated
 * `opattach:` URL the description's inline images use. Nothing is fetched here:
 * the webview asks for the URL and the Rust side answers it, so a preview of an
 * image already shown in the description is served from the webview's own cache.
 *
 * Stepping between images is offered when there is more than one, because the
 * common case for this panel is a work package carrying a sequence of
 * screenshots and closing the overlay to open the next one reads as a bug.
 */

const props = defineProps<{
  attachment: Attachment
  /** Every previewable image on this work package, in list order. */
  siblings: Attachment[]
  /** True while this attachment's save is in flight. */
  saving?: boolean
  /**
   * Why the last save failed, if it did.
   *
   * Rendered *inside* the overlay rather than left to the toast the list uses.
   * This layer covers the whole viewport, so a toast raised behind it is
   * invisible — a failed download would look identical to a click that did
   * nothing.
   */
  saveError?: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [attachment: Attachment]
  save: [attachment: Attachment]
}>()

/**
 * Whether the image itself failed to load.
 *
 * Worth surfacing rather than leaving a blank layer: the proxy answers a bare
 * status code with no body (there is no way to render a message into an `<img>`),
 * so a 401 from an expired key looks identical to a working empty box.
 */
const hasFailed = ref(false)

// A different image gets a fresh verdict; the previous one's failure says
// nothing about this one.
watch(
  () => props.attachment.id,
  () => {
    hasFailed.value = false
  }
)

const index = computed(() =>
  props.siblings.findIndex((sibling) => sibling.id === props.attachment.id)
)
const hasSiblings = computed(() => props.siblings.length > 1)

function step(offset: number): void {
  if (!hasSiblings.value) return
  const count = props.siblings.length
  // Wraps: with a handful of screenshots, stopping at the end is a dead button
  // more often than it is a useful boundary.
  const next = props.siblings[(index.value + offset + count) % count]
  if (next) emit('select', next)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'ArrowRight') step(1)
  if (event.key === 'ArrowLeft') step(-1)
}

// On `window` in the capture phase, so Escape closes *this* layer rather than
// the work-packages modal it is rendered inside.
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <!-- `fixed inset-0`, above the modal's own overlay. `@click.self` is what
       keeps a click on any control in here from dismissing the layer — see the
       component note. -->
  <div
    class="fixed inset-0 z-[60] flex flex-col bg-black/80 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    :aria-label="`Preview of ${props.attachment.fileName}`"
    @click.self="emit('close')"
  >
    <!-- `relative z-10` so the controls can never end up under the image.
         z-index applies only to positioned elements, hence `relative`. -->
    <div class="relative z-10 flex shrink-0 items-center justify-between gap-2 p-3">
      <div class="flex min-w-0 flex-col">
        <p
          class="truncate text-sm font-medium text-white"
          :title="props.attachment.fileName"
        >
          {{ props.attachment.fileName }}
        </p>
        <p class="text-xs text-white/70 tabular-nums">
          {{ formatFileSize(props.attachment.fileSize) }}
          <template v-if="hasSiblings">
            · {{ index + 1 }} of {{ props.siblings.length }}
          </template>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-download"
          label="Save"
          :loading="props.saving"
          :disabled="props.saving"
          :aria-label="`Save ${props.attachment.fileName}`"
          class="text-white hover:bg-white/15"
          @click="emit('save', props.attachment)"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-x"
          aria-label="Close preview"
          class="text-white hover:bg-white/15"
          @click="emit('close')"
        />
      </div>
    </div>

    <!-- Inside the layer, because a toast would be behind it. -->
    <p
      v-if="props.saveError"
      class="mx-3 mb-2 shrink-0 rounded-md bg-error/15 px-3 py-2 text-xs text-white"
    >
      {{ props.saveError }}
    </p>

    <!-- `items-stretch`, not `items-center`, and it is load-bearing: with
         `items-center` the image wrapper's height is content-driven, so
         `max-h-full` on the `<img>` has no definite parent height to resolve
         against. A tall screenshot then rendered at natural size, overflowed
         upward over the header, and swallowed the clicks meant for Save.
         `overflow-hidden` is the belt to that braces. -->
    <div class="flex min-h-0 flex-1 items-stretch gap-2 overflow-hidden px-3 pb-3">
      <UButton
        v-if="hasSiblings"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-left"
        aria-label="Previous image"
        class="shrink-0 self-center text-white hover:bg-white/15"
        @click="step(-1)"
      />

      <div
        class="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
      >
        <p v-if="hasFailed" class="text-sm text-white/80">
          This image could not be loaded. Your API key may have expired — reopen
          Settings and re-enter it.
        </p>
        <img
          v-else
          :src="props.attachment.proxyUrl"
          :alt="props.attachment.fileName"
          class="max-h-full max-w-full object-contain"
          @error="hasFailed = true"
        />
      </div>

      <UButton
        v-if="hasSiblings"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-right"
        aria-label="Next image"
        class="shrink-0 self-center text-white hover:bg-white/15"
        @click="step(1)"
      />
    </div>
  </div>
</template>
