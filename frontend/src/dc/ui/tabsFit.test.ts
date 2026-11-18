import { describe, expect, it } from "vitest";

import { fitTabs } from "./tabsFit";

// Five labels of 50 px, 2 px apart: 258 px with no padding at all.
const base = {
  widths: [50, 50, 50, 50, 50],
  more: 30,
  gap: 2,
  padMax: 12,
  padMin: 4,
  active: 0,
};

describe("fitTabs", () => {
  it("keeps the full padding when everything fits", () => {
    expect(fitTabs({ ...base, avail: 400 })).toEqual({
      pad: 12,
      visible: [0, 1, 2, 3, 4],
      overflow: [],
    });
  });

  it("shrinks the padding before moving anything", () => {
    // (318 − 258) / 10 = 6 px a side.
    expect(fitTabs({ ...base, avail: 318 })).toEqual({
      pad: 6,
      visible: [0, 1, 2, 3, 4],
      overflow: [],
    });
    // Half-pixel steps, rounded down so the row never overflows.
    expect(fitTabs({ ...base, avail: 307 }).pad).toBe(4.5);
  });

  it("moves the last tabs into «⋯» below the minimum padding", () => {
    // 297 px: five tabs would need 3.9 px; four tabs and «⋯» fit with
    // (297 − 200 − 8 − 30) / 8 = 7.375 → 7 px.
    expect(fitTabs({ ...base, avail: 297 })).toEqual({
      pad: 7,
      visible: [0, 1, 2, 3],
      overflow: [4],
    });
    // 200 px: three tabs would need 2.3 px; two and «⋯» get the full 12.
    expect(fitTabs({ ...base, avail: 200 })).toEqual({
      pad: 12,
      visible: [0, 1],
      overflow: [2, 3, 4],
    });
  });

  it("keeps the active tab in the row, in order", () => {
    expect(fitTabs({ ...base, avail: 297, active: 4 })).toEqual({
      pad: 7,
      visible: [0, 1, 2, 4],
      overflow: [3],
    });
    expect(fitTabs({ ...base, avail: 200, active: 3 }).visible).toEqual([0, 3]);
  });

  it("shows at least the active tab", () => {
    expect(fitTabs({ ...base, avail: 60, active: 2 })).toEqual({
      pad: 4,
      visible: [2],
      overflow: [0, 1, 3, 4],
    });
  });

  it("uses the real widths, not a count", () => {
    // A long label (EN «Measurements» with its badge) pushes out the last tab.
    const widths = [44, 56, 104, 36, 38];
    const r = fitTabs({ ...base, widths, avail: 320 });
    expect(r.visible).toEqual([0, 1, 2, 3]);
    expect(r.overflow).toEqual([4]);
  });
});
