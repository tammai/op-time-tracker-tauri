import { defineQueryOptions, useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { computed } from 'vue'
import type {
  Attachment,
  AttachmentCollection,
  AttachmentIdInput,
  StagedAttachment,
  StagedTokenInput,
  UploadAttachmentDataInput,
  UploadAttachmentFilesInput,
  UploadStagedAttachmentsInput
} from '@opentracker/preload'

/**
 * Attachments domain query options.
 *
 * Per `docs/conventions-frontend.md` ("Server State: Pinia Colada"):
 * - One file per domain under `composables/queries/<domain>.ts`.
 * - Keys are defined once here, never hand-written inline in a component.
 * - This is the **only** place `window.openproject.*` is called for
 *   attachments — components consume these composables, so the cache and its
 *   invalidation stay wired.
 *
 * The key root is `['attachments', …]` rather than nested under
 * `['work-packages', …]`, which is deliberate. The work-package mutations
 * invalidate their whole prefix on every save, and a subject edit has no
 * bearing on the attachment list — nesting would refetch every attachment of
 * every open work package each time somebody renamed one.
 *
 * The reverse dependency *is* real and is handled below: uploading or deleting
 * an attachment can change a description (an inline image), so those mutations
 * invalidate `['work-packages']` as well as their own key.
 */
export const attachmentQueries = {
  list: defineQueryOptions((workPackageId: number) => ({
    key: ['attachments', 'list', workPackageId],
    query: () => window.openproject.listWorkPackageAttachments({ workPackageId })
  }))
}

/**
 * The attachments of one work package.
 *
 * `workPackageId` is a getter, not a number, so switching rows in the browse
 * screen rekeys the query instead of freezing it at whatever was selected when
 * the panel mounted. A non-positive id disables the query rather than sending a
 * request the backend would refuse — the create panel has no work package yet.
 */
export function useWorkPackageAttachments(workPackageId: () => number | null) {
  const query = useQuery(() => {
    const id = workPackageId() ?? 0
    return {
      ...attachmentQueries.list(id),
      enabled: id > 0
    }
  })

  const items = computed<Attachment[]>(() => query.data.value?._embedded.elements ?? [])

  /** True while the *first* load is in flight, so the list can skeleton. */
  const isInitialLoading = computed(
    () => query.status.value === 'pending' && query.data.value === undefined
  )

  return { ...query, items, isInitialLoading }
}

/**
 * Everything a change to one work package's attachments makes stale.
 *
 * Both the list and `['work-packages']`: an upload or a delete can change what
 * a description renders, because an inline image *is* an attachment. Skipping
 * the second one left a deleted screenshot showing until the next unrelated
 * refetch.
 */
function invalidateAttachments(cache: ReturnType<typeof useQueryCache>): void {
  cache.invalidateQueries({ key: ['attachments'] })
  cache.invalidateQueries({ key: ['work-packages'] })
}

/**
 * Attach files.
 *
 * With `paths` omitted the **backend** opens the native file picker, so no path
 * is chosen by or handed to the webview (`src-tauri/src/commands/attachments.rs`).
 * An empty array back means the user cancelled, which is not an error.
 *
 * Invalidation runs `onSettled` rather than `onSuccess`, unusually for this
 * codebase and for a specific reason: uploads run sequentially and stop at the
 * first failure, so a *rejected* call may still have attached earlier files. The
 * list has to be refetched either way, or those files would be invisible until
 * something else happened to refresh it.
 */
export function useUploadWorkPackageAttachments() {
  const cache = useQueryCache()
  return useMutation<Attachment[], UploadAttachmentFilesInput>({
    mutation: (input: UploadAttachmentFilesInput) =>
      window.openproject.uploadWorkPackageAttachments(input),
    onSettled: () => {
      invalidateAttachments(cache)
    }
  })
}

/**
 * Attach bytes that never had a path — a screenshot pasted into the description
 * editor.
 *
 * One file per call, so unlike the batch above there is no partial outcome and
 * `onSuccess` is enough: a failure attached nothing.
 */
export function useUploadWorkPackageAttachmentData() {
  const cache = useQueryCache()
  return useMutation<Attachment, UploadAttachmentDataInput>({
    mutation: (input: UploadAttachmentDataInput) =>
      window.openproject.uploadWorkPackageAttachmentData(input),
    onSuccess: () => {
      invalidateAttachments(cache)
    }
  })
}

/**
 * Delete an attachment.
 *
 * Irreversible, and it can break a description — the caller confirms first.
 * Nothing is invalidated on failure: a refused delete changed nothing.
 */
export function useDeleteAttachment() {
  const cache = useQueryCache()
  return useMutation<void, AttachmentIdInput>({
    mutation: (input: AttachmentIdInput) => window.openproject.deleteAttachment(input),
    onSuccess: () => {
      invalidateAttachments(cache)
    }
  })
}

/**
 * Save an attachment to a location the user picks.
 *
 * A mutation rather than a query because it is a command with a side effect
 * outside OpenProject, and it lives here rather than in a component because the
 * bridge is reached through this layer or not at all. Nothing is invalidated:
 * writing a local file changes no server state.
 *
 * Resolves to the file name written, or `null` when the user cancelled the save
 * dialog — the caller should not report a cancellation as a success.
 */
export function useSaveAttachment() {
  return useMutation<string | null, AttachmentIdInput>({
    mutation: (input: AttachmentIdInput) => window.openproject.saveAttachment(input)
  })
}

/**
 * Choose files for a work package that does not exist yet.
 *
 * Nothing is invalidated: staging touches no OpenProject state at all — the
 * backend has merely taken custody of some local files.
 */
export function useStageAttachmentFiles() {
  return useMutation<StagedAttachment[], UploadAttachmentFilesInput>({
    mutation: (input: UploadAttachmentFilesInput) =>
      window.openproject.stageAttachmentFiles(input)
  })
}

/** Drop one staged file. Also nothing to invalidate. */
export function useDiscardStagedAttachment() {
  return useMutation<void, StagedTokenInput>({
    mutation: (input: StagedTokenInput) =>
      window.openproject.discardStagedAttachment(input)
  })
}

/**
 * Upload the staged files to the work package that was just created.
 *
 * `onSettled`, for the same reason as `useUploadWorkPackageAttachments`: these
 * upload sequentially and stop at the first failure, so a rejection may still
 * have attached earlier files and the list has to be refetched either way.
 */
export function useUploadStagedAttachments() {
  const cache = useQueryCache()
  return useMutation<Attachment[], UploadStagedAttachmentsInput>({
    mutation: (input: UploadStagedAttachmentsInput) =>
      window.openproject.uploadStagedAttachments(input),
    onSettled: () => {
      invalidateAttachments(cache)
    }
  })
}

export type { Attachment, AttachmentCollection, StagedAttachment }
