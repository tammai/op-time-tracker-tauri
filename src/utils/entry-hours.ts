/**
 * The hours field's own range rules.
 *
 * The slider is bounded by its `min`/`max`, so the cap can't be exceeded by
 * dragging — but an over-cap value once reached the server, and the clamp below
 * stays the last gate before the write rather than trusting one layer.
 *
 * Pure, so the rules are unit-tested rather than inferred from a component.
 */

/** Smallest loggable slice — a quarter hour, matching the slider's `step`. */
export const HOURS_MIN = 0.25

/**
 * `value` brought inside `[HOURS_MIN, max]`.
 *
 * Deliberately only clamps the ends — quarter-hour snapping stays the input's
 * job, so a typed `1.3` isn't rewritten twice (here *and* by the component) with
 * two different answers.
 */
export function clampEntryHours(value: number, max: number): number {
  return Math.min(max, Math.max(HOURS_MIN, value))
}

/**
 * A slider's emitted value, narrowed to a number at runtime — or `null` when it
 * isn't one.
 *
 * `USlider` is a range control underneath, so its model is an **array**, and the
 * wrapper only unwraps a single-thumb array back to a number in the shapes it
 * recognises. One got through: the hours field showed `[ 6 ]h` (Vue's rendering
 * of a one-element array) and the `z.number()` field then reported "Enter the
 * hours worked." about a value the user had plainly set.
 *
 * The lesson is about the type, not the library: the binding was already
 * declared `computed<number>`, and that annotation is erased at runtime, so an
 * array from an untyped third-party emit flowed straight through it. A boundary
 * fed by a component's emit needs a runtime check; a type parameter there is
 * documentation, not a guard.
 *
 * `null` rather than a fallback number, so the caller ignores nonsense instead
 * of silently logging an hour nobody chose.
 */
export function normalizeSliderHours(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  // Exactly one thumb, or it isn't this field's value.
  if (Array.isArray(value) && value.length === 1) {
    return normalizeSliderHours(value[0])
  }
  return null
}
