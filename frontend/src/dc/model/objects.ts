/** Pure helpers over a room's objects, shared by the panels and the page. */

import type { DcObject, RoomData } from "../types";

export function objectFields(o: DcObject): Omit<DcObject, "id"> {
  const { id: _id, ...rest } = o;
  void _id;
  return rest;
}

/** Object name → keys of assumed numbers that position or size it. */
export function assumedByObject(data: RoomData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, key: string) =>
    out.set(name, [...(out.get(name) ?? []), key]);
  for (const m of data.room.measurements.entries)
    if (m.src === "assumed" || m.src === "photo")
      for (const o of m.objects) add(o, m.key);
  for (const o of data.objects) {
    const item = data.catalog.find((c) => c.id === o.catalog_id);
    if (!item) continue;
    for (const [prop, s] of Object.entries(item.props_src))
      // The finish is how a body looks, not a number that places or sizes it.
      if ((s.src === "assumed" || s.src === "photo") && prop !== "finish")
        add(o.name, `item.${prop}`);
    // Supply outlets not set by hand are the subtype's default (§14.1).
    if (o.instance.supply_outlets?.some((x) => x.source === "catalog_default"))
      add(o.name, "item.supply_outlets");
  }
  return out;
}
