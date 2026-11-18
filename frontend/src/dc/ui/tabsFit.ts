/**
 * How a row of tabs fits its width (FEEDBACK-2 §1), pure: the labels' padding
 * shrinks first, from `padMax` down to `padMin`; if they still do not fit,
 * the last tabs move into a «⋯» menu. The active tab always stays in the
 * row, in its place among the others. The font is never touched.
 */

export interface TabsFitInput {
  /** Each tab's width without its horizontal padding (label, badge, borders), px. */
  widths: number[];
  /** The «⋯» button's full width, px. */
  more: number;
  /** Width available to the row, px. */
  avail: number;
  /** Space between neighbours, px. */
  gap: number;
  padMax: number;
  padMin: number;
  /** Index of the active tab. */
  active: number;
}

export interface TabsFit {
  /** Horizontal padding of each visible tab, px (half-pixel steps). */
  pad: number;
  /** Indices in the row, in order. */
  visible: number[];
  /** Indices in the «⋯» menu, in order. */
  overflow: number[];
}

export function fitTabs(i: TabsFitInput): TabsFit {
  const n = i.widths.length;
  const all = [...Array(n).keys()];
  // The widest padding with which `ids` (and the «⋯» button) fit.
  const padFor = (ids: number[], more: boolean) => {
    const fixed =
      ids.reduce((s, k) => s + i.widths[k], 0) +
      (ids.length - 1 + (more ? 1 : 0)) * i.gap +
      (more ? i.more : 0);
    const pad = (i.avail - fixed) / (2 * ids.length);
    return Math.min(i.padMax, Math.floor(pad * 2) / 2);
  };
  if (n === 0) return { pad: i.padMax, visible: [], overflow: [] };
  const pad = padFor(all, false);
  if (pad >= i.padMin) return { pad, visible: all, overflow: [] };
  for (let k = n - 1; k >= 1; k--) {
    const ids = all.slice(0, k);
    if (i.active >= k) ids[k - 1] = i.active;
    const p = padFor(ids, true);
    if (p >= i.padMin)
      return {
        pad: p,
        visible: ids,
        overflow: all.filter((x) => !ids.includes(x)),
      };
  }
  return {
    pad: i.padMin,
    visible: [i.active],
    overflow: all.filter((x) => x !== i.active),
  };
}
