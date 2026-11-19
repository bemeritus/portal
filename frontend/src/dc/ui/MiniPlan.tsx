/**
 * A small plan of a room drawn from its own geometry (FEEDBACK-6 §5, §6):
 * the outline, the shelf, the racks, units overhead dashed. Some objects can
 * be marked — in red for a warning (room cards) or in the accent for what a
 * revision changed (history's before / after).
 */

import { useMemo } from "react";

import { bounds, solid } from "../model/geometry";
import type { CatalogItem, DcObject } from "../types";

export function MiniPlan({
  floorPlan,
  objects,
  catalog,
  marked = new Set<string>(),
  tone = "warn",
  label,
}: {
  floorPlan: [number, number][];
  objects: DcObject[];
  catalog: Map<number, CatalogItem>;
  /** Names of the objects to mark. */
  marked?: Set<string>;
  tone?: "warn" | "change";
  label?: string;
}) {
  const shapes = useMemo(
    () =>
      objects.flatMap((o) => {
        const item = catalog.get(o.catalog_id);
        if (!item) return [];
        const s = solid(o, item, floorPlan);
        return [{ o, item, r: s.rect, overhead: o.y0_mm > 0 }];
      }),
    [objects, catalog, floorPlan],
  );
  const b = bounds(floorPlan);
  const pad = Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.04;
  const vb = [
    b.x0 - pad,
    b.z0 - pad,
    b.x1 - b.x0 + 2 * pad,
    b.z1 - b.z0 + 2 * pad,
  ].join(" ");
  const stroke = (b.x1 - b.x0) / 200;
  // Under the racks: the shelf and floor things, then the racks, then what
  // hangs overhead (dashed).
  const order = (k: string, overhead: boolean) =>
    overhead ? 3 : k === "rack" ? 2 : 1;
  return (
    <svg
      className="dc-miniplan"
      data-tone={tone}
      viewBox={vb}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      preserveAspectRatio="xMidYMid meet"
    >
      <polygon
        className="dc-miniplan-room"
        points={floorPlan.map(([x, z]) => `${x},${z}`).join(" ")}
        strokeWidth={stroke * 2}
      />
      {[...shapes]
        .sort(
          (a, c) =>
            order(a.item.kind, a.overhead) - order(c.item.kind, c.overhead),
        )
        .filter((s) => s.item.kind !== "cable_tray")
        .map(({ o, item, r, overhead }) => {
          const door =
            item.kind === "structure" && item.props.subtype === "door";
          if (door) return null;
          return (
            <rect
              key={o.id}
              x={r.x0}
              y={r.z0}
              width={Math.max(r.x1 - r.x0, stroke)}
              height={Math.max(r.z1 - r.z0, stroke)}
              strokeWidth={stroke}
              data-kind={overhead ? "overhead" : item.kind}
              data-marked={marked.has(o.name) || undefined}
              strokeDasharray={
                overhead ? `${stroke * 4} ${stroke * 3}` : undefined
              }
            >
              <title>{o.name}</title>
            </rect>
          );
        })}
    </svg>
  );
}
