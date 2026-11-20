import { describe, expect, it } from "vitest";

import type { Device } from "../types";
import { ownerSlots } from "./owners";

const dev = (owner: string, u = 1) => ({ owner, u_height: u }) as Device;

describe("owner slots", () => {
  it("orders by device count, then name; eight colours, then «others»", () => {
    const devices = [
      ...Array.from({ length: 3 }, () => dev("B", 2)),
      ...Array.from({ length: 3 }, () => dev("A")),
      dev("C"),
      ...["D", "E", "F", "G", "H", "I"].map((o) => dev(o)),
      dev(""),
    ];
    const s = ownerSlots(devices);
    expect(s.map((o) => o.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    expect(s[1]).toEqual({ name: "B", devices: 3, units: 6, slot: 1 });
    expect(s[7].slot).toBe(7);
    expect(s[8].slot).toBeNull();
  });
});
