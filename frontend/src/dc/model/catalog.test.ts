import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { DC_LOCALES } from "../../i18n/dc";
import { openings } from "../engine/renderers/cooling";
import { makeFmt } from "../format";
import type { CatalogItem, CoolingProps, CoolingSubtype } from "../types";
import {
  airFaces,
  applyFilters,
  DEFAULT_FILTERS,
  differing,
  dimsNumbers,
  dimsText,
  filtersToParams,
  parseFilters,
  shortModel,
  sortItems,
  type Filters,
} from "./catalog";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "ru",
    resources: Object.fromEntries(
      Object.entries(DC_LOCALES).map(([l, dc]) => [l, { translation: { dc } }]),
    ),
    interpolation: { escapeValue: false },
  });
});

// Liebert CRV CRD25: 300 × 1132 × 2000 mm (FEEDBACK-4 §1's example).
const crv = {
  id: 1,
  kind: "cooling",
  width_mm: 300,
  depth_mm: 1132,
  height_mm: 2000,
} as CatalogItem;

describe("catalog dimensions (FEEDBACK-4 §1)", () => {
  // [lang, unit, full text, numbers only]: every value in one unit.
  const cases: [string, "mm" | "cm" | "m", string, string][] = [
    ["ru", "mm", "300 × 1 132 × 2 000 мм", "300 × 1 132 × 2 000"],
    ["ru", "cm", "30 × 113,2 × 200 см", "30 × 113,2 × 200"],
    ["ru", "m", "0,3 × 1,132 × 2 м", "0,3 × 1,132 × 2"],
    ["en", "mm", "300 × 1,132 × 2,000 mm", "300 × 1,132 × 2,000"],
    ["en", "cm", "30 × 113.2 × 200 cm", "30 × 113.2 × 200"],
    ["en", "m", "0.3 × 1.132 × 2 m", "0.3 × 1.132 × 2"],
    ["uz", "mm", "300 × 1 132 × 2 000 mm", "300 × 1 132 × 2 000"],
    ["uz", "cm", "30 × 113,2 × 200 sm", "30 × 113,2 × 200"],
    ["uz", "m", "0,3 × 1,132 × 2 m", "0,3 × 1,132 × 2"],
  ];
  it.each(cases)("%s, %s: %s", (lang, unit, full, numbers) => {
    const fmt = makeFmt(i18n.getFixedT(lang), lang, unit);
    // Intl uses a no-break space to group thousands in Russian and Uzbek.
    const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
    expect(norm(dimsText(crv, fmt))).toBe(full);
    expect(norm(dimsNumbers(crv, fmt))).toBe(numbers);
  });
});

// --- Filters, sorting, comparison, airflow legend -------------------------------------

const unit = (
  id: number,
  manufacturer: string,
  model: string,
  subtype: CoolingSubtype,
  p: Partial<CoolingProps>,
  width = 800,
) =>
  ({
    id,
    kind: "cooling",
    manufacturer,
    model,
    width_mm: width,
    depth_mm: 500,
    height_mm: 300,
    props: {
      subtype,
      model_known: true,
      cooling_sensible_w: null,
      cooling_total_w: null,
      airflow_m3h: [],
      designed_24_7: false,
      discharge_options: [],
      weight_kg: null,
      ...p,
    },
  }) as unknown as CatalogItem;

const items = [
  unit(
    1,
    "Vertiv",
    "Liebert CRV CRD25 (DX, air-cooled)",
    "in_row",
    {
      cooling_sensible_w: 25000,
      designed_24_7: true,
      airflow_m3h: [5200],
    },
    300,
  ),
  unit(
    2,
    "Gree",
    "GFH48K (duct, outdoor GUHD48N)",
    "ducted",
    {
      cooling_total_w: 14000,
    },
    1340,
  ),
  unit(
    3,
    "Midea",
    "MSAF-24CRDN1 (Forest Inverter)",
    "split_wall",
    {
      cooling_total_w: 7034,
      airflow_m3h: [1005, 802],
    },
    1040,
  ),
  unit(4, "", "unknown ducted", "ducted", { model_known: false }, 1145),
];
const ids = (xs: CatalogItem[]) => xs.map((i) => i.id);
const f = (p: Partial<Filters>): Filters => ({ ...DEFAULT_FILTERS, ...p });

describe("catalog filters (FEEDBACK-4 §3.1)", () => {
  it("round-trip through the URL, writing only what differs", () => {
    const all: Filters = {
      q: "crv",
      purpose: "precision",
      execOff: ["ducted", "split_wall"],
      brandOff: ["Gree"],
      kw: [3000, 40000],
      width: [null, 1400],
      only247: true,
      sensibleOnly: true,
      sort: "air",
      dir: "asc",
      view: "table",
      compare: [1, 3],
    };
    expect(parseFilters(filtersToParams(all))).toEqual(all);
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe("");
    // Junk falls back to the defaults.
    expect(
      parseFilters(new URLSearchParams("sort=x&dir=up&cmp=a,0,-1&kw=..z")),
    ).toEqual(DEFAULT_FILTERS);
  });

  it("narrow by purpose, execution, maker, 24/7 and published sensible capacity", () => {
    expect(ids(applyFilters(items, f({ purpose: "precision" })))).toEqual([1]);
    expect(ids(applyFilters(items, f({ purpose: "comfort" })))).toEqual([
      2, 3, 4,
    ]);
    expect(ids(applyFilters(items, f({ execOff: ["ducted"] })))).toEqual([
      1, 3,
    ]);
    expect(ids(applyFilters(items, f({ brandOff: ["Gree", ""] })))).toEqual([
      1, 3,
    ]);
    expect(ids(applyFilters(items, f({ only247: true })))).toEqual([1]);
    expect(ids(applyFilters(items, f({ sensibleOnly: true })))).toEqual([1]);
    expect(ids(applyFilters(items, f({ q: "forest midea" })))).toEqual([3]);
  });

  it("narrow by capacity and width; an unknown capacity is out once narrowed", () => {
    expect(ids(applyFilters(items, f({ kw: [null, null] })))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(ids(applyFilters(items, f({ kw: [10000, null] })))).toEqual([1, 2]);
    expect(ids(applyFilters(items, f({ kw: [null, 20000] })))).toEqual([2, 3]);
    expect(ids(applyFilters(items, f({ width: [null, 1100] })))).toEqual([
      1, 3,
    ]);
  });
});

describe("catalog sorting and comparison", () => {
  const used = new Map([[4, 3]]);
  const label = (i: CatalogItem) => i.manufacturer;
  it("sorts by any column, unknown values last in both directions", () => {
    expect(ids(sortItems(items, "cold", "desc", used, label))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(ids(sortItems(items, "cold", "asc", used, label))).toEqual([
      3, 2, 1, 4,
    ]);
    expect(ids(sortItems(items, "air", "desc", used, label))).toEqual([
      1, 3, 2, 4,
    ]);
    expect(ids(sortItems(items, "used", "desc", used, label))[0]).toBe(4);
    expect(ids(sortItems(items, "name", "asc", used, label))).toEqual([
      2, 1, 3, 4,
    ]);
  });

  it("names the model without its remark", () => {
    expect(shortModel("Liebert CRV CRD25 (DX, air-cooled)")).toBe(
      "Liebert CRV CRD25",
    );
    expect(shortModel("FTXM35R + RXM35R")).toBe("FTXM35R + RXM35R");
  });

  it("marks the rows where the compared items differ", () => {
    expect(
      differing([
        ["a", "a"],
        ["a", "b"],
        ["1", "1", "2"],
      ]),
    ).toEqual([false, true, true]);
  });
});

describe("airflow legend", () => {
  // The legend names the faces the template's openings are on.
  const faceOf = (
    at: { x: number; y: number; z: number },
    d: [number, number, number],
  ) => {
    const [w, dd, h] = d;
    if (Math.abs(at.z + dd / 2) < 1) return "front";
    if (Math.abs(at.z - dd / 2) < 1) return "rear";
    if (Math.abs(at.y - h) < 1) return "top";
    if (Math.abs(at.y) < 1 && Math.abs(at.x) < 1 && Math.abs(at.z) < 1)
      return "bottom";
    if (
      Math.abs(at.y) < 1 &&
      (Math.abs(at.x) > w * 0.3 || Math.abs(at.z) > dd * 0.3)
    )
      return "sides";
    return "bottom";
  };
  const subtypes: [CoolingSubtype, "upflow" | "downflow" | null][] = [
    ["split_wall", null],
    ["split_cassette", null],
    ["split_floor_ceiling", null],
    ["ducted", null],
    ["in_row", null],
    ["precision_perimeter", "upflow"],
    ["precision_perimeter", "downflow"],
  ];
  it.each(subtypes)(
    "%s %s matches the template's openings",
    (subtype, discharge) => {
      const dims: [number, number, number] = [800, 600, 1000];
      const p = {
        subtype,
        discharge_options: discharge ? [discharge] : [],
      } as unknown as CoolingProps;
      const faces = airFaces(p);
      for (const o of openings(subtype, dims, discharge)) {
        const face = faceOf(o.at, dims);
        expect(o.role === "supply" ? faces.supply : faces.ret).toContain(face);
      }
    },
  );
});
