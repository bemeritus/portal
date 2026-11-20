/**
 * Owners in a room (FEEDBACK-7 §4.7): who owns what is the first question in
 * a colocation room. The order is fixed — most devices first, then by name —
 * so an owner keeps its colour while the view changes; the first eight take
 * the categorical colours, the rest are grey under «другие».
 */

import type { Device, ShelfCell } from "../types";

export interface OwnerSlot {
  name: string;
  devices: number;
  /** Units the owner's devices take. */
  units: number;
  /** Index into the categorical colours, or null (grey, «другие»). */
  slot: number | null;
}

export const OWNER_SLOTS = 8;

export function ownerSlots(
  devices: Device[],
  cells: ShelfCell[] = [],
): OwnerSlot[] {
  const by = new Map<string, { devices: number; units: number }>();
  const add = (name: string, units: number) => {
    if (!name) return;
    const o = by.get(name) ?? { devices: 0, units: 0 };
    o.devices++;
    o.units += units;
    by.set(name, o);
  };
  for (const d of devices) add(d.owner, d.u_height);
  for (const c of cells) add(c.owner, 0);
  return [...by.entries()]
    .sort((a, b) => b[1].devices - a[1].devices || a[0].localeCompare(b[0]))
    .map(([name, o], i) => ({ name, ...o, slot: i < OWNER_SLOTS ? i : null }));
}
