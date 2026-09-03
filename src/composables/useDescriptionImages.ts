import { computed, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'

import {
  useUploadWorkPackageAttachmentData,
  useUploadWorkPackageAttachments
} from '@renderer/composables/queries/attachments'
import {
  fileToBase64,
  imageFileFromTransfer,
  pastedImageFileName
} from '@renderer/utils/clipboard-images'

/**
 * Getting an image into a description: upload it as an attachment, then insert a
 * reference to it at the cursor.
 *
 * ## Why both halves are one composable
 *
 * An inline image in an OpenProject description *is* an attachment — the
 * markdown holds `/api/v3/attachments/{id}/content`, so there is no way to add
 * one without uploading. Splitting "upload" from "insert" would leave every
 * call site to remember to do the second, and an upload with no insert is an
 * attachment the user thinks they placed in the text.
 *
 * ## The three ways in, and why they take different payloads
 *
 * - **Paste** carries `File` objects with no path on disk, so the bytes go over
 *   IPC base64-encoded.
 * - **Drop** carries OS **paths**: Tauri intercepts the window's native drop and
 *   the webview never receives a `File`. Rust reads them.
 * - **The toolbar button** carries nothing at all — Rust opens the native
 *   picker itself, so no path is chosen by or handed to the webview.
 *
 * The inserted URL is the `proxyUrl` the upload response carries, never one
 * built here. On save, the backend rewrites it back to the relative path
 * OpenProject stores (`openproject::attachment_urls`), so the round trip never
 * persists a URL that only means something inside this app.
 */
export function useDescriptionImages(options: {
  /** The work package to attach to; `null` disables everything here. */
  workPackageId: () => number | null
  /** Place a reference at the cursor. Returns false if the editor refused. */
  insert: (src: string, alt: string) => boolean
}) {
  const toast = useToast()
  const { mutateAsync: uploadFiles } = useUploadWorkPackageAttachments()
  const { mutateAsync: uploadData } = useUploadWorkPackageAttachmentData()

  const isUploading = ref(false)

  /**
   * Whether images can be added at all.
   *
   * False in the create form, and that is not an oversight: an attachment needs
   * a work package to hang off, and there is no id until the thing is saved.
   */
  const isEnabled = computed(() => (options.workPackageId() ?? 0) > 0)

  function report(cause: unknown): void {
    const message = (cause as { message?: unknown } | null)?.message
    toast.add({
      title: 'Could not add that image',
      description:
        typeof message === 'string' && message.length > 0
          ? message
          : 'OpenProject refused the upload.',
      color: 'error'
    })
  }

  /**
   * The alt text an inserted image gets.
   *
   * The file name rather than an empty string: it is the only description
   * available, it is what a screen reader will read, and it is what the user
   * sees if the image ever fails to load.
   */
  function altFor(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '')
  }

  /** Insert one uploaded attachment, warning if the editor would not take it. */
  function place(proxyUrl: string, fileName: string): void {
    if (options.insert(proxyUrl, altFor(fileName))) return
    // The file *is* attached — it is in the list, just not in the text. Saying
    // so beats a silent no-op the user reads as a failed upload.
    toast.add({
      title: `${fileName} was attached but not inserted`,
      description: 'Place the cursor in the description and try again.',
      color: 'warning'
    })
  }

  /** Attach files already on disk, by path — the drop case. */
  async function insertFromPaths(paths: string[]): Promise<void> {
    const workPackageId = options.workPackageId()
    if (!workPackageId || paths.length === 0) return

    isUploading.value = true
    try {
      const uploaded = await uploadFiles({ workPackageId, paths })
      for (const attachment of uploaded) place(attachment.proxyUrl, attachment.fileName)
    } catch (cause) {
      report(cause)
    } finally {
      isUploading.value = false
    }
  }

  /** Attach a file chosen from the backend's native picker — the toolbar case. */
  async function pickAndInsert(): Promise<void> {
    const workPackageId = options.workPackageId()
    if (!workPackageId) return

    isUploading.value = true
    try {
      // `paths` omitted: the picker opens in Rust and the choice never crosses.
      const uploaded = await uploadFiles({ workPackageId })
      for (const attachment of uploaded) place(attachment.proxyUrl, attachment.fileName)
    } catch (cause) {
      report(cause)
    } finally {
      isUploading.value = false
    }
  }

  /**
   * Handle a paste that carries an image.
   *
   * Returns true when the paste was consumed, so the caller knows whether to
   * let the editor have it. A text paste returns false and is *not* touched —
   * intercepting every paste would break copying a paragraph in.
   */
  function handlePaste(event: ClipboardEvent): boolean {
    if (!isEnabled.value) return false

    const file = imageFileFromTransfer(event.clipboardData)
    if (!file) return false

    event.preventDefault()
    void uploadPastedFile(file)
    return true
  }

  async function uploadPastedFile(file: File): Promise<void> {
    const workPackageId = options.workPackageId()
    if (!workPackageId) return

    const fileName = pastedImageFileName(file)
    isUploading.value = true
    try {
      const attachment = await uploadData({
        workPackageId,
        fileName,
        contentType: file.type || undefined,
        data: await fileToBase64(file)
      })
      place(attachment.proxyUrl, attachment.fileName)
    } catch (cause) {
      report(cause)
    } finally {
      isUploading.value = false
    }
  }

  return { handlePaste, insertFromPaths, isEnabled, isUploading, pickAndInsert }
}
