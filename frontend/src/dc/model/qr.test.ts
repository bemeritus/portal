import { describe, expect, it } from "vitest";
import { encode } from "uqr";

import type { CatalogItem, DcObject, Device, ShelfCell } from "../types";
import { labelsFor } from "./qr";

const obj = (id: number, catalog_id: number, name: string) =>
  ({ id, catalog_id, name }) as DcObject;
const catalog = new Map<number, CatalogItem>([
  [1, { id: 1, kind: "rack", model: "42U" } as CatalogItem],
  [2, { id: 2, kind: "shelf", model: "Стеллаж" } as CatalogItem],
  [3, { id: 3, kind: "cooling", model: "AC" } as CatalogItem],
]);
const objects = [
  obj(10, 1, "Стойка 1"),
  obj(11, 2, "Стеллаж"),
  obj(12, 3, "AC1"),
];
const devices = [
  {
    id: 7,
    rack_id: 10,
    name: "R740",
    u_bottom: 10,
    u_height: 2,
    owner: "X",
    serial: "S1",
  } as Device,
];
const cells = [
  { shelf_id: 11, cell_no: 16, name: "NAS", owner: "" } as ShelfCell,
];

describe("QR labels", () => {
  it("are deep links to racks, devices, shelves and cells — nothing else", () => {
    const l = labelsFor(
      "https://p",
      3,
      objects,
      catalog,
      devices,
      cells,
      (n) => `Ячейка ${n}`,
      null,
    );
    expect(l.map((x) => x.url)).toEqual([
      "https://p/dc/3#obj-10",
      "https://p/dc/3#device-7",
      "https://p/dc/3#obj-11",
      "https://p/dc/3#cell-11-16",
    ]);
    expect(l[1].detail).toBe("Стойка 1 · U10–11 · X · S1");
  });

  it("can be limited to one rack or shelf", () => {
    expect(
      labelsFor("https://p", 3, objects, catalog, devices, cells, String, 11),
    ).toHaveLength(2);
  });

  it("encode to a scannable code size", () => {
    const q = encode("https://portal.example/dc/3#cell-11-16", { ecc: "M" });
    expect(q.size).toBeGreaterThanOrEqual(21);
  });
});
