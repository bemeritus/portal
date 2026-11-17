import { describe, expect, it } from "vitest";

import {
  clearances,
  doorSwing,
  footprint,
  gap,
  problems,
  rect,
  rectInPolygon,
  snap,
  swingHits,
  type Solid,
} from "./geometry";

const ROOM: [number, number][] = [
  [0, 0],
  [5545, 0],
  [5545, 3845],
  [0, 3845],
];

const s = (
  name: string,
  kind: Solid["kind"],
  r: ReturnType<typeof rect>,
  y0 = 0,
  y1 = 2040,
): Solid => ({
  id: name.length,
  name,
  kind,
  rect: r,
  y0,
  y1,
  rotation: 0,
  swing: null,
});
const rack = (name: string, x0: number, z0: number) =>
  s(name, "rack", rect(x0, z0, x0 + 600, z0 + 1000));
const shelf = s("shelf", "shelf", rect(200, 25, 4730, 935), 0, 1795);
const settings = {
  clearance_front_mm: 1000,
  clearance_rear_mm: 600,
  rack_power_budget_w: null,
  electrical_rule_set: "pue" as const,
};

describe("geometry mirrors the server", () => {
  it("rotates footprints", () => {
    expect(footprint(10, 20, 600, 1000, 90)).toEqual(rect(10, 20, 1010, 620));
  });

  it("keeps things inside the room", () => {
    expect(rectInPolygon(rect(0, 0, 600, 1000), ROOM)).toBe(true);
    expect(rectInPolygon(rect(5000, 0, 5600, 1000), ROOM)).toBe(false);
  });

  it("finds overlaps in 3D only", () => {
    const ac = s("ac", "cooling", rect(297, 30, 1442, 680), 1935, 2315);
    expect(problems(1, [shelf, ac], ROOM, 2410)).toEqual([]);
    expect(
      problems(1, [rack("a", 0, 2000), rack("b", 599, 2000)], ROOM, 2410),
    ).toEqual([{ type: "overlaps", other: "a" }]);
  });

  it("knows the door's swing", () => {
    const sw = doorSwing(rect(5545, 860, 5545, 1790), 930, 1970, "high", ROOM);
    expect(sw.quadrant).toEqual(rect(4615, 860, 5545, 1790));
    expect(swingHits(sw, rect(5300, 1500, 5400, 1600))).toBe(true);
    expect(swingHits(sw, rect(4620, 865, 4700, 900))).toBe(false);
  });

  it("gives the seeded room's rear warnings for racks 1 and 2", () => {
    const solids = [
      shelf,
      rack("r1", 530, 2275),
      rack("r2", 1595, 2285),
      rack("r3", 2635, 2245),
      rack("r4", 3435, 2240),
    ];
    const short = clearances(solids, ROOM, settings)
      .filter((c) => !c.ok)
      .map((c) => [
        solids.find((x) => x.id === c.objectId)!.name,
        c.side,
        c.gap.mm,
      ]);
    // ids collide by name length here, so check by values instead
    expect(short.map((x) => [x[1], x[2]])).toEqual([
      ["rear", 570],
      ["rear", 560],
    ]);
    expect(gap(rect(530, 2275, 1130, 3275), "up", [shelf.rect], ROOM).mm).toBe(
      1340,
    );
  });

  it("snaps to walls and neighbours within 25 mm, else to the grid", () => {
    expect(snap(18, 1007, 600, 1000, [], ROOM, 10)).toMatchObject({
      x0: 0,
      guideX: 0,
      z0: 1010,
    });
    const next = rect(530, 2275, 1130, 3275);
    expect(snap(1140, 2290, 600, 1000, [next], ROOM, 50)).toMatchObject({
      x0: 1130,
      z0: 2275,
    });
    expect(snap(18, 1007, 600, 1000, [], ROOM, 100, false)).toMatchObject({
      x0: 0,
      z0: 1000,
      guideX: null,
    });
  });
});
