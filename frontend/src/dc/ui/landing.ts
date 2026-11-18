/**
 * Where a room opens (FEEDBACK-2 §3). In the drawing theme — a CAD sheet —
 * the room opens on its plan; in the other themes on 3D. A link that says
 * what to show always wins: a section (`?view=plan`, `?view=3d`, which the
 * 3D tab carries), a camera (`?cam=`, as in a saved view's link) or a
 * selection to fly to (`#obj-12`, `#device-7`, `#cell-5-16`, as on a QR
 * label). Decided once, when the room opens: switching the theme later
 * never moves the camera.
 */

import type { DcThemeName } from "../theme/tokens";

/** Whether to put the room on its plan because nothing in the link says otherwise. */
export function planByDefault(
  theme: DcThemeName,
  search: URLSearchParams,
  hash: string,
): boolean {
  if (theme !== "drawing") return false;
  const explicit =
    search.has("view") || search.has("cam") || hash.replace(/^#/, "") !== "";
  return !explicit;
}
