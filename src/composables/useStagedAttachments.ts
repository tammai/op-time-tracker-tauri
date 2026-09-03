import { computed, ref } from 'vue'
import type { StagedAttachment } from '@opentracker/preload'

import {
  useDiscardStagedAttachment,
  useStageAttachmentFiles,
  useUploadStagedAttachments
} from '@renderer/composables/queries/attachments'

/**
 * Files chosen for a work package that does not exist yet.
 *
 * OpenProject attaches to a container — `POST /api/v3/work_packages/{id}/attachments`
 * needs an id — so a create has nothing to attach to until it succeeds. This
 * holds the files the user picked, and [`uploadTo`] flushes them the moment the
 * work package is real.
 *
 * What is held here is a list of **handles**, not files: the backend has custody
 * of the paths and hands back a token plus the metadata needed to draw a row
 * (`src-tauri/src/staged_attachments.rs`). That is what keeps the create flow on
 * the same footing as the edit flow, where the native picker also opens in Rust
 * and no path crosses.
 *
 * ## What this deliberately does not do
 *
 * There is no paste-an-image-into-the-description path during create, and it is
 * not an omission. An inline image is a URL pointing at an attachment id, and
 * until the work package exists no attachment exists to have an id — so there
 * is nothing to insert. The description editor's image affordances stay hidden
 * until the work package has been created, at which point the edit flow offers
 * all of them.
 */
export function useStagedAttachments() {
  const items = ref<StagedAttachment[]>([])
  const error = ref<string | null>(null)

  const { mutateAsync: stageFiles, isLoading: isStaging } = useStageAttachmentFiles()
  const { mutateAsync: discardStaged } = useDiscardStagedAttachment()
  const { mutateAsync: uploadStaged } = useUploadStagedAttachments()

  const count = computed(() => items.value.length)
  const hasItems = computed(() => items.value.length > 0)

  function message(cause: unknown, fallback: string): string {
    const text = (cause as { message?: unknown } | null)?.message
    return typeof text === 'string' && text.length > 0 ? text : fallback
  }

  /**
   * Stage files. `paths` omitted opens the native picker in the backend; pass
   * it only with the paths from a drag-and-drop event.
   *
   * A failure is reported in `error` rather than thrown: the caller is a form,
   * and a rejected file pick is not a reason to unwind anything.
   */
  async function add(paths?: string[]): Promise<void> {
    error.value = null
    try {
      const staged = await stageFiles({
        // The command validates the id only when uploading, so staging is not
        // tied to a work package — but the input shape is shared, and `0` is
        // the honest value for "there isn't one yet".
        workPackageId: 0,
        ...(paths ? { paths } : {})
      })
      // Cancelling the picker yields an empty array, which is not an error.
      if (staged.length > 0) items.value = [...items.value, ...staged]
    } catch (cause) {
      error.value = message(cause, 'Those files could not be attached.')
    }
  }

  /** Remove one staged file, releasing the backend's hold on it. */
  async function remove(token: string): Promise<void> {
    items.value = items.value.filter((item) => item.token !== token)
    // Fire and forget: the row is already gone from the user's view, and the
    // only cost of a failed release is one path held until the app closes.
    try {
      await discardStaged({ token })
    } catch {
      // Nothing actionable — see above.
    }
  }

  /**
   * Forget everything, releasing every held path.
   *
   * Called when a create is cancelled *and* after a successful flush, so a
   * discarded draft never leaves the backend holding paths for the rest of the
   * session.
   */
  async function clear(): Promise<void> {
    const tokens = items.value.map((item) => item.token)
    items.value = []
    error.value = null
    await Promise.all(tokens.map((token) => remove(token)))
  }

  /**
   * Upload everything staged to a work package that now exists.
   *
   * Returns the failure message, or `null` on success — rather than throwing,
   * because the create it follows has already succeeded. Losing the new work
   * package's selection because one attachment was refused would be the wrong
   * trade; the caller shows the message and the work package stands.
   */
  async function uploadTo(workPackageId: number): Promise<string | null> {
    const tokens = items.value.map((item) => item.token)
    if (tokens.length === 0) return null

    try {
      await uploadStaged({ workPackageId, tokens })
      items.value = []
      return null
    } catch (cause) {
      // Uploads stop at the first refusal, so some may have landed. The staged
      // list is dropped either way: the work package now exists, its
      // attachments panel is the truth, and anything missing can be added
      // there.
      items.value = []
      return message(cause, 'The work package was created, but its files were not attached.')
    }
  }

  return { add, clear, count, error, hasItems, isStaging, items, remove, uploadTo }
}
