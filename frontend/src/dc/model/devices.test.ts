import { describe, expect, it } from "vitest";

import type { Device } from "../types";
import {
  devicesToText,
  freeRuns,
  guessKind,
  parseDevices,
  rackStats,
  unitsFree,
} from "./devices";

const dev = (
  id: number,
  u: number,
  h: number,
  face: Device["face"],
  power: number | null = null,
): Device => ({
  id,
  rack_id: 1,
  u_bottom: u,
  u_height: h,
  face,
  depth_mm: null,
  kind: "server",
  name: `d${id}`,
  owner: "",
  serial: "",
  power_w: power,
  power_src: null,
  status: "active",
  note: "",
});

describe("parseDevices", () => {
  it("reads the spec's example line", () => {
    const { devices, errors } = parseDevices(
      "10-11 DELL R740 | 450 Вт | клиент X",
      42,
    );
    expect(errors).toEqual([]);
    expect(devices[0]).toMatchObject({
      u_bottom: 10,
      u_height: 2,
      name: "DELL R740",
      power_w: 450,
      owner: "клиент X",
      kind: "server",
    });
  });

  it("accepts reversed ranges, kW and kinds", () => {
    const { devices } = parseDevices(
      "12-10 Huawei S5720 | 1,2 кВт\n40 X | tur=pdu | note=left side",
      42,
    );
    expect(devices[0]).toMatchObject({
      u_bottom: 10,
      u_height: 3,
      kind: "switch",
      power_w: 1200,
    });
    expect(devices[1]).toMatchObject({
      kind: "pdu",
      note: "left side",
      owner: "",
    });
  });

  it("guesses kinds like the prototype", () => {
    expect(guessKind("ИБП APC Smart-UPS 3000")).toBe("ups");
    expect(guessKind("Патч-панель 24")).toBe("patch");
    expect(guessKind("Synology RS820")).toBe("storage");
    expect(guessKind("MikroTik CCR2004")).toBe("router");
    expect(guessKind("DELL R740")).toBe("server");
  });

  it("reports every bad line with its number", () => {
    const { errors } = parseDevices("hello\n0 X\n43 Y\n5 |\n1-2 A\n2 B", 42);
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [1, "format"],
      [2, "range"],
      [3, "range"],
      [4, "emptyName"],
      [6, "overlap"],
    ]);
  });

  it("round-trips through text", () => {
    const text =
      "10-11 DELL R740 | 450 W | клиент X | note=договор 118\n1 Патч-панель\n5 Box | type=kvm";
    const { devices } = parseDevices(text, 42);
    const again = parseDevices(devicesToText(devices), 42).devices;
    const strip = (d: (typeof devices)[number]) => ({ ...d, line: 0 });
    expect(again.map(strip).sort((a, b) => a.u_bottom - b.u_bottom)).toEqual(
      devices.map(strip).sort((a, b) => a.u_bottom - b.u_bottom),
    );
  });
});

describe("units", () => {
  const devices = [
    dev(1, 10, 2, "front"),
    dev(2, 20, 1, "rear"),
    dev(3, 30, 1, "both", 100),
  ];

  it("checks free units per face", () => {
    expect(unitsFree(devices, 42, 10, 1, "front")).toBe(false);
    expect(unitsFree(devices, 42, 10, 1, "rear")).toBe(true);
    expect(unitsFree(devices, 42, 20, 1, "front")).toBe(true);
    expect(unitsFree(devices, 42, 20, 1, "both")).toBe(false);
    expect(unitsFree(devices, 42, 30, 1, "rear")).toBe(false);
    expect(unitsFree(devices, 42, 10, 2, "front", 1)).toBe(true);
    expect(unitsFree(devices, 42, 42, 2, "front")).toBe(false);
  });

  it("lists free runs", () => {
    expect(freeRuns(devices, 42, "front")).toEqual([
      { from: 1, to: 9 },
      { from: 12, to: 29 },
      { from: 31, to: 42 },
    ]);
  });

  it("totals power without treating unknown as zero", () => {
    const s = rackStats(devices, 42, true);
    expect(s).toMatchObject({
      used: 4,
      powerW: 100,
      unknownPower: 2,
      count: 3,
    });
  });
});
