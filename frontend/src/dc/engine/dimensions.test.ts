import { describe, expect, it } from "vitest";

import { rect, type Solid } from "../model/geometry";
import type { Measurement } from "../types";
import { DEFAULT_LAYERS } from "./DcEngine";
import {
  allDims,
  DIM_LAYERS,
  measurementDims,
  planChains,
  selectionGaps,
  type DimInput,
} from "./dimensions";

const s = (
  name: string,
  kind: Solid["kind"],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y0 = 0,
  y1 = 2040,
): Solid => ({
  id: name.length * 7 + x0,
  name,
  kind,
  rect: rect(x0, z0, x1, z1),
  y0,
  y1,
  rotation: 0,
  swing: null,
});
const meas = (
  key: string,
  line: Measurement["line"],
  objects: string[] = [],
): Measurement => ({
  key,
  value: 1000,
  src: "measured",
  line,
  objects,
});

/** The seeded room in miniature: a shelf, two cooling units, four racks. */
const solids = [
  s("Стеллаж", "shelf", 200, 0, 4730, 910, 0, 1795),
  s("Кондиционер 2", "cooling", 2488, 30, 3633, 680, 1965, 2345),
  s("Стойка 1", "rack", 530, 2210, 1130, 3210),
  s("Стойка 2", "rack", 1595, 2215, 2195, 3215),
  s("Стойка 3", "rack", 2635, 2180, 3235, 3180),
  s("Стойка 4", "rack", 3435, 2180, 4035, 3180),
];
const measurements = [
  meas("room.length_x", [
    [0, 0, 4100],
    [5545, 0, 4100],
  ]),
  meas("room.width_z", [
    [5800, 0, 0],
    [5800, 0, 3845],
  ]),
  meas("room.height_y", [
    [5545, 0, 0],
    [5545, 2410, 0],
  ]),
  meas(
    "gap.r2_r3",
    [
      [2195, 10, 2700],
      [2635, 10, 2700],
    ],
    ["Стойка 2", "Стойка 3"],
  ),
  meas(
    "racks.width.r3",
    [
      [2635, 2100, 2180],
      [3235, 2100, 2180],
    ],
    ["Стойка 3"],
  ),
  meas(
    "cooling.height",
    [
      [2488, 1965, 30],
      [2488, 2345, 30],
    ],
    ["Кондиционер 2"],
  ),
];
const input = (over: Partial<DimInput> = {}): DimInput => ({
  floorPlan: [
    [0, 0],
    [5545, 0],
    [5545, 3845],
    [0, 3845],
  ],
  measurements,
  solids,
  selected: null,
  plan: true,
  schema: true,
  measurement: (m) => ({ text: String(m.value), title: m.key, mark: false }),
  mm: String,
  ...over,
});

describe("dimension layers (FEEDBACK-7 §1.2)", () => {
  it("every dimension built belongs to exactly one known layer", () => {
    const states = [
      input(),
      input({ plan: false }),
      input({ schema: false }),
      input({ selected: "Стойка 3" }),
      input({ selected: "Кондиционер 2", plan: false }),
    ];
    const specs = states.flatMap((d) => [
      ...measurementDims(d),
      ...planChains(d),
      ...solids.flatMap((x) => selectionGaps(d, x, null)),
    ]);
    expect(specs.length).toBeGreaterThan(20);
    for (const spec of specs) {
      expect(DIM_LAYERS, spec.key).toContain(spec.layer);
      // And it is a layer the user can switch.
      expect(Object.keys(DEFAULT_LAYERS), spec.key).toContain(spec.layer);
    }
  });

  it("the chains are their own layer; the room's layer is its overall size", () => {
    const specs = allDims(input(), null, null);
    const by = (layer: string) =>
      specs.filter((x) => x.layer === layer).map((x) => x.key);
    expect(by("room")).toEqual([
      "meas:room.length_x",
      "meas:room.width_z",
      "meas:room.height_y",
    ]);
    expect(by("chains").length).toBe(9 + 4);
    expect(by("chains").every((k) => k.startsWith("chain:"))).toBe(true);
    expect(by("gaps")).toEqual(["meas:gap.r2_r3"]);
    expect(by("tape")).toEqual(["meas:racks.width.r3", "meas:cooling.height"]);
  });

  it("with a selection only its own dimensions and gaps remain", () => {
    const r3 = solids.find((x) => x.name === "Стойка 3")!;
    const specs = allDims(input({ selected: r3.name }), r3, null);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((x) => x.layer === "selection")).toBe(true);
    expect(specs.map((x) => x.key)).toContain("meas:racks.width.r3");
    expect(specs.map((x) => x.key)).not.toContain("meas:room.length_x");
  });
});
