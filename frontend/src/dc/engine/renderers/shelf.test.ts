/**
 * FEEDBACK-2 §2: cells under a cooling unit are red in the schema and fill
 * modes; in realistic they look as they are, with a warning-coloured
 * outline and hatch that the engine shows only for the hovered or selected
 * cell.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { CatalogItem, DcObject, ShelfProps } from "../../types";
import type { MaterialLibrary, Mode } from "../materials";
import { hatch, shelfRenderer } from "./shelf";

const props: ShelfProps = {
  boards_mm: [100, 700, 1300],
  cells_per_board: 4,
  sections: [2, 2],
  plated_boards: 0,
};
const item = { id: 1, kind: "shelf", props } as unknown as CatalogItem;
const obj = { id: 7, name: "Полка" } as DcObject;

const WARN = "#ff5f57";
const role = new Map<string, THREE.Material>();
const lines = new Map<string, THREE.LineBasicMaterial>();
const lib = {
  theme: { warn: WARN },
  role: (r: string) => {
    if (!role.has(r)) role.set(r, new THREE.MeshBasicMaterial());
    return role.get(r)!;
  },
  line: (c: string) => {
    if (!lines.has(c)) lines.set(c, new THREE.LineBasicMaterial({ color: c }));
    return lines.get(c)!;
  },
  plate: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialLibrary;

function build(mode: Mode) {
  return shelfRenderer.build(obj, item, {
    lib,
    mode,
    devices: [],
    cells: [],
    blocked: [9, 10],
    dims: [2000, 600, 1800],
    ceilingAbove: 0,
    detail: 2,
    pxPerMm: null,
  }).group;
}

const fills = (g: THREE.Group) =>
  g.children.filter((c) => c.userData.role === "cellBlocked");
const marks = (g: THREE.Group) =>
  g.children.filter((c) => c.userData.blockedCell !== undefined);

describe("blocked shelf cells", () => {
  it("are filled red in schema, fill and power", () => {
    for (const mode of ["schema", "fill", "power"] as Mode[]) {
      const g = build(mode);
      expect(fills(g)).toHaveLength(2);
      expect(marks(g)).toHaveLength(0);
    }
  });

  it("have no fill in realistic, only a hidden warning mark", () => {
    const g = build("realistic");
    expect(fills(g)).toHaveLength(0);
    const m = marks(g);
    expect(m.map((x) => x.userData.blockedCell)).toEqual([9, 10]);
    for (const x of m) {
      expect(x.visible).toBe(false);
      const segs = x.children as THREE.LineSegments[];
      // An outline and a hatch, both thin lines.
      expect(segs).toHaveLength(2);
      for (const s of segs) {
        expect(s.isLineSegments).toBe(true);
        const mat = s.material as THREE.LineBasicMaterial;
        expect(`#${mat.color.getHexString()}`).toBe(WARN);
      }
    }
  });

  it("can still be picked, so hover and selection reach them", () => {
    const g = build("realistic");
    const picks = g.children
      .map((c) => c.userData.pick)
      .filter((p) => p?.type === "cell" && p.cellNo === 9);
    expect(picks).toHaveLength(1);
  });
});

describe("hatch", () => {
  it("clips 45° lines to the rectangle", () => {
    const segs = hatch(200, 100, 50);
    // x + y = 50, 100, 150, 200, 250.
    expect(segs).toEqual([
      [0, 50, 50, 0],
      [0, 100, 100, 0],
      [50, 100, 150, 0],
      [100, 100, 200, 0],
      [150, 100, 200, 50],
    ]);
    for (const [x0, y0, x1, y1] of segs) {
      expect(x0 + y0).toBe(x1 + y1);
      for (const v of [x0, x1]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [x0, x1]) expect(v).toBeLessThanOrEqual(200);
      for (const v of [y0, y1]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [y0, y1]) expect(v).toBeLessThanOrEqual(100);
    }
  });
});
