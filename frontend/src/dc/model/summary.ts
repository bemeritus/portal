/**
 * A room in figures (FEEDBACK-6 §1, §4, §5), pure: what the room list, the
 * room summary and the racks page show — devices, how much of the racks is
 * used, the power that is known and for how many devices, each rack's fill,
 * and the service-clearance shortfalls.
 */

import { rackStats, type RackStats } from "./devices";
import type { Clearance, RackProps, RoomData } from "../types";
import { clearanceGap } from "../types";

export interface RackFigure {
  id: number;
  name: string;
  stats: RackStats;
  /** Its clearance shortfalls. */
  short: Clearance[];
}

export interface RoomFigures {
  racks: RackFigure[];
  devices: number;
  /** Units taken / units in racks whose contents are recorded. */
  used: number;
  units: number;
  /** Σ known power, and how many devices it covers. */
  powerW: number;
  powerKnown: number;
  /** Clearance shortfalls in the room. */
  short: Clearance[];
  /** Overall size: length × width × height, mm. */
  size: [number, number, number];
  /** No device recorded in any rack. */
  empty: boolean;
}

export function roomFigures(data: RoomData): RoomFigures {
  const catalog = new Map(data.catalog.map((c) => [c.id, c]));
  const short = data.analysis.clearances.filter(
    (c) => clearanceGap(c) < c.required_mm,
  );
  const racks: RackFigure[] = data.objects
    .filter((o) => catalog.get(o.catalog_id)?.kind === "rack")
    .map((o) => {
      const p = catalog.get(o.catalog_id)!.props as RackProps;
      const devs = data.devices.filter((d) => d.rack_id === o.id);
      return {
        id: o.id,
        name: o.name,
        stats: rackStats(devs, p.units, o.contents_known),
        short: short.filter((c) => c.object_id === o.id),
      };
    });
  const known = racks.filter((r) => r.stats.known);
  const xs = data.room.floor_plan.map((p) => p[0]),
    zs = data.room.floor_plan.map((p) => p[1]);
  return {
    racks,
    devices: data.devices.length,
    used: known.reduce((a, r) => a + r.stats.used, 0),
    units: known.reduce((a, r) => a + r.stats.units, 0),
    powerW: racks.reduce((a, r) => a + r.stats.powerW, 0),
    powerKnown: data.devices.filter((d) => d.power_w !== null).length,
    short,
    size: [
      Math.max(...xs) - Math.min(...xs),
      Math.max(...zs) - Math.min(...zs),
      data.room.height_mm,
    ],
    empty: data.devices.length === 0,
  };
}

/** Whole percent, or null with nothing to divide by. */
export const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : null;
