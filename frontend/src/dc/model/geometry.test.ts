import { describe, expect, it } from "vitest";

import {
  blockedCells,
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
import type { Measurement } from "../types";

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

  // A tape reading from the rack's back (x0, front at z) to the rear wall.
  const backTape = (
    x0: number,
    z: number,
    value: number,
    range?: [number, number],
  ): Measurement => ({
    key: "racks.back",
    value,
    min: range?.[0],
    max: range?.[1],
    src: range ? "range" : "measured",
    model: 3845 - (z + 1000),
    line: [
      [x0 + 300, 0, z + 1000],
      [x0 + 300, 0, 3845],
    ],
    objects: [],
  });

  it("decides by the tape where it read the same gap", () => {
    const r1 = rack("r1", 530, 2250),
      r2 = rack("r2", 1595, 2260),
      r3 = rack("r3", 2635, 2220);
    const tapes = [backTape(530, 2250, 610), backTape(1595, 2260, 555)];
    const rear = clearances([shelf, r1, r2, r3], ROOM, settings, tapes).filter(
      (c) => c.side === "rear",
    );
    const pick = (c: (typeof rear)[number]) => [
      c.basis,
      c.measured,
      c.gap.mm,
      c.ok,
      c.split,
    ];
    // r1: 595 by the model, 610 by the tape — passes, and the two disagree.
    expect(pick(rear[0])).toEqual(["measured", 610, 595, true, true]);
    // r2: 585 by the model, 555 by the tape — fails; both say so.
    expect(pick(rear[1])).toEqual(["measured", 555, 585, false, false]);
    // r3: nobody measured its back.
    expect(pick(rear[2])).toEqual(["model", null, 625, true, false]);
  });

  it("ignores a tape line that is not this gap", () => {
    const moved = backTape(530, 2200, 610);
    const beside = backTape(530, 2250, 610);
    beside.line = [
      [1200, 0, 3250],
      [1200, 0, 3845],
    ];
    for (const m of [moved, beside]) {
      const c = clearances([shelf, rack("r1", 530, 2250)], ROOM, settings, [
        m,
      ]).find((x) => x.side === "rear")!;
      expect([c.basis, c.mm]).toEqual(["model", 595]);
    }
  });

  it("takes the lower end of a range that straddles the requirement", () => {
    const solids = [shelf, rack("r", 530, 2240)];
    const c = clearances(solids, ROOM, settings, [
      backTape(530, 2240, 603, [590, 615]),
    ]).find((x) => x.side === "rear")!;
    expect([c.gap.mm, c.measured, c.ok, c.split]).toEqual([
      605,
      590,
      false,
      true,
    ]);
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

describe("blocked cells (the server's blocked_cells)", () => {
  const props = {
    boards_mm: [100, 948, 1795],
    cells_per_board: 14,
    sections: [5, 9],
    plated_boards: 2,
  };
  const sh: Solid = {
    ...s("shelf", "shelf", rect(200, 0, 4730, 910), 0, 1795),
    rotation: 180,
  };
  const acs = [
    s("ac1", "cooling", rect(4005, 30, 5255, 680), 1960, 2340),
    s("ac2", "cooling", rect(2488, 30, 3633, 680), 1965, 2345),
    s("ac3", "cooling", rect(298, 30, 1443, 680), 1935, 2315),
  ];
  it("gives the same cells as the server", () => {
    expect(blockedCells(sh, props, acs)).toEqual([
      1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(blockedCells({ ...sh, rotation: 0 }, props, acs)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14,
    ]);
  });
  it("follows a unit as it moves", () => {
    const moved = { ...acs[1], rect: rect(2488 + 300, 30, 3633 + 300, 680) };
    expect(blockedCells(sh, props, [moved])).not.toEqual(
      blockedCells(sh, props, [acs[1]]),
    );
  });
});
