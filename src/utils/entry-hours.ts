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
