<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { Attachment } from '@opentracker/preload'

import {
  useDeleteAttachment,
  useSaveAttachment,
  useUploadWorkPackageAttachments,
  useWorkPackageAttachments
} from '@renderer/composables/queries/attachments'
import {
  attachmentAuthorLabel,
  attachmentIcon,
  formatAttachmentTimestamp,
  formatFileSize,
  isImageAttachment
} from '@renderer/utils/attachment-display'
import AttachmentPreviewOverlay from './AttachmentPreviewOverlay.vue'

/**
 * The attachments section of the work package detail panel.
 *
 * Its own component rather than more rows in `WorkPackageDetailPanel.vue`,
 * because it owns four mutations, a pending-delete confirm, and a preview
 * overlay — none of which the panel's read/edit split has any opinion about.
 * The panel passes a work package id and nothing else.
 *
 * ## Where the file paths are
 *
 * "Add files" calls a command that opens the native picker in the **backend**;
 * no path is chosen by or handed to this component. Drag-and-drop is the
 * exception, and it is not an HTML5 drop: Tauri intercepts the window's drop
 * before the webview sees it and delivers an event carrying the OS paths, which
 * `WorkPackageDetailPanel` forwards here. See
 * `src-tauri/src/commands/attachments.rs` for what the boundary trusts.
 *
 * ## Reading an attachment
 *
 * An image row shows a real thumbnail, loaded from `attachment.proxyUrl` — the
 * `opattach:` URL the backend serves the bytes on after authenticating. Clicking
 * an image opens the preview overlay; clicking anything else goes straight to
 * the save dialog, because there is nothing this app can render for a .docx.
 */

const props = defineProps<{
  workPackageId: number
  /**
   * Turn the upload affordances off. The panel sets it while a save is in
   * flight; attaching *during* a description edit is deliberately allowed —
   * `useWorkPackageEditor` adopts the resulting revision bump rather than
   * treating it as a conflict.
   */
  disabled?: boolean
}>()

const toast = useToast()

const { items, isInitialLoading, error, refetch } = useWorkPackageAttachments(
  () => props.workPackageId
)

const { mutateAsync: uploadFiles, isLoading: isUploading } =
  useUploadWorkPackageAttachments()
const { mutateAsync: deleteAttachment } = useDeleteAttachment()
const { mutateAsync: saveAttachment } = useSaveAttachment()

/** The row showing its inline "Delete this file?" confirm, if any. */
const confirmingDeleteId = ref<number | null>(null)
/** Ids with a delete or save in flight, so one row's spinner is its own. */
const busyIds = ref<Set<number>>(new Set())
/** The image being previewed, if any. */
const previewing = ref<Attachment | null>(null)
/**
 * Why the last save failed.
 *
 * Held here rather than only toasted because the preview overlay covers the
 * whole viewport — a toast behind it cannot be seen, which made a failed
 * download indistinguishable from a click that did nothing.
 */
const lastSaveError = ref<string | null>(null)

const count = computed(() => items.value.length)

function isBusy(id: number): boolean {
  return busyIds.value.has(id)
}

function setBusy(id: number, busy: boolean): void {
  const next = new Set(busyIds.value)
  if (busy) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

/**
 * The message to show for a failed mutation.
 *
 * `BridgeError.message` is the backend's own wording, which for a 422 is
 * OpenProject's — "File is too large (maximum size: 5242880 Bytes)" says
 * more than anything this component could invent.
 */
function failureMessage(cause: unknown, fallback: string): string {
  const message = (cause as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/**
 * Attach files.
 *
 * `paths` omitted opens the native picker in the backend; the drop path passes
 * the OS-supplied paths through. An empty result is a cancelled picker, which is
 * not worth a toast.
 */
async function upload(paths?: string[]): Promise<void> {
  if (props.disabled) return

  try {
    const uploaded = await uploadFiles({ workPackageId: props.workPackageId, paths })
    if (uploaded.length === 0) return
    toast.add({
      title:
        uploaded.length === 1
          ? `Attached ${uploaded[0]?.fileName ?? 'the file'}.`
          : `Attached ${uploaded.length} files.`,
      color: 'success'
    })
  } catch (cause) {
    // Uploads stop at the first failure, so earlier files may have landed. The
    // mutation refetches the list either way, and the toast does not claim
    // nothing happened.
    toast.add({
      title: 'Some files were not attached',
      description: failureMessage(cause, 'OpenProject refused the upload.'),
      color: 'error'
    })
  }
}

/**
 * Handle paths dropped on the panel.
 *
 * Exposed rather than listened for here so the parent decides when a drop
 * belongs to this section: the event arrives at the *window*, and it is the
 * panel that owns the rectangle a drop has to land in.
 */
function handleDrop(paths: string[]): void {
  if (paths.length === 0) return
  void upload(paths)
}

defineExpose({ handleDrop })

function askDelete(attachment: Attachment): void {
  confirmingDeleteId.value = attachment.id
}

function cancelDelete(): void {
  confirmingDeleteId.value = null
}

/**
 * Delete an attachment.
 *
 * Irreversible, hence the inline confirm — and it can break the description
 * above it, because an inline image *is* an attachment. The confirm says so.
 */
async function confirmDelete(attachment: Attachment): Promise<void> {
  setBusy(attachment.id, true)
  try {
    await deleteAttachment({ id: attachment.id })
    if (previewing.value?.id === attachment.id) previewing.value = null
    toast.add({ title: `Deleted ${attachment.fileName}.`, color: 'success' })
  } catch (cause) {
    toast.add({
      title: 'Could not delete that file',
      description: failureMessage(cause, 'OpenProject refused the deletion.'),
      color: 'error'
    })
  } finally {
    setBusy(attachment.id, false)
    confirmingDeleteId.value = null
  }
}

/**
 * Save an attachment to disk.
 *
 * The backend opens the save dialog and takes the file name from OpenProject, so
 * a `null` result is the user cancelling — reported as nothing, not as a
 * success.
 */
async function save(attachment: Attachment): Promise<void> {
  setBusy(attachment.id, true)
  lastSaveError.value = null
  try {
    const savedAs = await saveAttachment({ id: attachment.id })
    // `null` is the user cancelling the save dialog, which is not a success to
    // report and not a failure either.
    if (savedAs === null) return
    toast.add({ title: `Saved ${savedAs}.`, color: 'success' })
  } catch (cause) {
    const message = failureMessage(cause, 'The file could not be downloaded.')
    lastSaveError.value = message
    toast.add({
      title: 'Could not save that file',
      description: message,
      color: 'error'
    })
  } finally {
    setBusy(attachment.id, false)
  }
}

/** Open an image in the overlay; send everything else to the save dialog. */
function activate(attachment: Attachment): void {
  if (isImageAttachment(attachment)) {
    lastSaveError.value = null
    previewing.value = attachment
    return
  }
  void save(attachment)
}

/** The images, in list order, so the overlay can step between them. */
const previewableImages = computed(() => items.value.filter(isImageAttachment))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <!-- Header. The count is on the heading rather than a separate badge: it is
         the one thing a collapsed-looking section needs to answer, and "no
         files" is a real answer worth stating. -->
    <div class="flex items-center justify-between gap-2">
      <p class="text-muted text-xs">
        Attachments
        <span v-if="count > 0" class="tabular-nums">({{ count }})</span>
      </p>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-paperclip"
        label="Add files"
        :loading="isUploading"
        :disabled="props.disabled || isUploading"
        :title="props.disabled ? 'Not available right now' : 'Choose files to attach'"
        @click="upload()"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-triangle"
      title="Couldn't load the attachments"
      :description="error.message"
    >
      <template #actions>
        <UButton
          color="neutral"
          variant="subtle"
          size="xs"
          label="Retry"
          @click="refetch()"
        />
      </template>
    </UAlert>

    <div v-else-if="isInitialLoading" class="flex flex-col gap-1">
      <USkeleton v-for="i in 2" :key="i" class="h-11 w-full" />
    </div>

    <!-- Empty state names the two ways in, because neither is discoverable:
         the button is small, and dropping onto a panel is not something a user
         tries unprompted. -->
    <p v-else-if="count === 0" class="text-muted text-xs">
      No files yet. Use <span class="text-highlighted">Add files</span>, or drop
      them here.
    </p>

    <ul v-else class="flex flex-col divide-y divide-default rounded-md bg-elevated">
      <li v-for="attachment in items" :key="attachment.id" class="flex flex-col">
        <div class="flex min-w-0 items-center gap-2 p-2">
          <!-- Thumbnail for an image, icon for everything else. The thumbnail
               loads from `proxyUrl` — the app's own authenticated proxy — so
               this is the same URL the description's inline images use. -->
          <button
            type="button"
            class="flex size-9 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded bg-default"
            :aria-label="
              isImageAttachment(attachment)
                ? `Preview ${attachment.fileName}`
                : `Save ${attachment.fileName}`
            "
            @click="activate(attachment)"
          >
            <img
              v-if="isImageAttachment(attachment)"
              :src="attachment.proxyUrl"
              :alt="attachment.fileName"
              class="size-full object-cover"
              loading="lazy"
            />
            <UIcon v-else :name="attachmentIcon(attachment)" class="text-muted size-4" />
          </button>

          <div class="flex min-w-0 flex-1 flex-col">
            <button
              type="button"
              class="cursor-pointer truncate text-left text-sm text-highlighted hover:underline"
              :title="attachment.fileName"
              @click="activate(attachment)"
            >
              {{ attachment.fileName }}
            </button>
            <p class="text-muted flex flex-wrap items-center gap-x-1.5 text-xs">
              <span class="tabular-nums">{{ formatFileSize(attachment.fileSize) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ attachmentAuthorLabel(attachment) }}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">
                {{ formatAttachmentTimestamp(attachment.createdAt) }}
              </span>
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-0.5">
            <UTooltip text="Save to disk">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-download"
                :loading="isBusy(attachment.id)"
                :aria-label="`Save ${attachment.fileName}`"
                @click="save(attachment)"
              />
            </UTooltip>
            <!-- Only offered when OpenProject says this key may: the permission
                 arrives as the presence of a `_links.delete`, and a button that
                 always 403s is worse than no button. -->
            <UTooltip v-if="attachment.canDelete" text="Delete">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-trash-2"
                :disabled="isBusy(attachment.id)"
                :aria-label="`Delete ${attachment.fileName}`"
                @click="askDelete(attachment)"
              />
            </UTooltip>
          </div>
        </div>

        <!-- Inline confirm, in place rather than in a nested modal — same
             pattern as the day modal's entry rows. It names the description
             risk, which is the part a user cannot see coming. -->
        <div
          v-if="confirmingDeleteId === attachment.id"
          class="flex flex-wrap items-center justify-between gap-2 border-t border-default px-2 py-1.5"
        >
          <p class="text-warning min-w-0 text-xs">
            Delete this file? It can't be undone, and any image using it in the
            description will break.
          </p>
          <div class="flex shrink-0 items-center gap-1">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              label="Cancel"
              :disabled="isBusy(attachment.id)"
              @click="cancelDelete()"
            />
            <UButton
              color="error"
              size="xs"
              label="Delete"
              :loading="isBusy(attachment.id)"
              @click="confirmDelete(attachment)"
            />
          </div>
        </div>
      </li>
    </ul>

    <AttachmentPreviewOverlay
      v-if="previewing"
      :attachment="previewing"
      :siblings="previewableImages"
      :saving="isBusy(previewing.id)"
      :save-error="lastSaveError"
      @close="previewing = null"
      @select="previewing = $event"
      @save="save($event)"
    />
  </div>
</template>
