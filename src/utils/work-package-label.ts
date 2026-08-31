/**
 * How a work package is labelled in the picker.
 *
 * Pure and outside `useWorkPackagePicker` so the rules are unit-testable: the
 * composable needs a Pinia + Colada app to instantiate and `tests/renderer/`
 * has no component harness, while these are plain functions
 * (`docs/conventions-frontend.md` — logic out of components).
 */

/** A subject the caller already knows for one specific work package. */
export interface KnownWorkPackageSubject {
  id: number
  subject: string
}

/**
 * `#12345 · Subject` — the id leads, because that is what a user looks up in
 * OpenProject itself. An absent or empty subject yields `#12345` alone rather
 * than a label trailing a separator.
 */
export function formatWorkPackageLabel(
  id: number,
  subject?: string | null
): string {
  return subject ? `#${id} · ${subject}` : `#${id}`
}

/**
 * The label for a selection that the currently-shown list doesn't hold.
 *
 * `seen` holds every subject the picker has *displayed*, by id, and is the
 * primary source: both of its lists are transient, so a subject has to be
 * banked when the item passes through rather than looked up when the label is
 * needed. Selecting a search result is precisely that case — the search term
 * resets with the selection, so the chosen item leaves the results in the same
 * tick.
 *
 * `known` covers the id that was never in either list: the edited entry's work
 * package, whose subject rides along on the entry. Neither source has it → the
 * id alone, still a usable reference.
 */
export function workPackageSelectionLabel(
  id: number,
  seen: ReadonlyMap<number, string>,
  known?: KnownWorkPackageSubject | null
): string {
  return formatWorkPackageLabel(
    id,
    seen.get(id) ?? (known?.id === id ? known.subject : undefined)
  )
}
