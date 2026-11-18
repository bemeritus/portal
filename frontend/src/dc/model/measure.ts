/**
 * Measurements as read vs the model (SPEC §3.3), pure. Mirrors
 * `Measurement::disagrees` in `backend/src/dc/model.rs`.
 */

import type { Measurement } from "../types";

/** Model and tape may differ by this much before the dimension is marked. */
export const TAPE_TOLERANCE_MM = 5;

/** Does the model disagree with what was read by more than the tolerance? */
export function disagrees(
  m: Pick<Measurement, "value" | "min" | "max" | "model">,
): boolean {
  if (m.model === undefined) return false;
  const lo = m.min ?? m.value,
    hi = m.max ?? m.value;
  return m.model < lo - TAPE_TOLERANCE_MM || m.model > hi + TAPE_TOLERANCE_MM;
}

/** Was it read as two values? */
export const isRange = (m: Pick<Measurement, "min" | "max">) =>
  m.min !== undefined && m.max !== undefined && m.min !== m.max;

/** The difference model − tape (against the nearer end of a range), mm. */
export function difference(
  m: Pick<Measurement, "value" | "min" | "max" | "model">,
): number | null {
  if (m.model === undefined) return null;
  const lo = m.min ?? m.value,
    hi = m.max ?? m.value;
  if (m.model < lo) return m.model - lo;
  if (m.model > hi) return m.model - hi;
  return 0;
}
