/**
 * The catalog section's pure logic (SPEC §11.3, FEEDBACK-4): how an item's
 * size is written, what each card and table row shows, the filters held in
 * the URL, sorting, and which rows of a comparison differ. No React, no
 * three.js; the pages and the tests share it.
 */

import type { Fmt } from "../format";
import type { CatalogItem } from "../types";

/** W × D × H in the user's unit, every value in that unit: `60 × 113.2 × 200 cm`. */
export function dimsText(item: CatalogItem, fmt: Fmt): string {
  return fmt.dims(item.width_mm, item.depth_mm, item.height_mm);
}

/** The three numbers alone, for a row that names the unit in its label. */
export function dimsNumbers(item: CatalogItem, fmt: Fmt): string {
  return [item.width_mm, item.depth_mm, item.height_mm]
    .map((v) => fmt.len(v))
    .join(" × ");
}
