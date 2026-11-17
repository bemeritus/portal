/**
 * Placement geometry, pure — the client's mirror of
 * `backend/src/dc/geometry.rs`, for instant feedback while dragging. The
 * server re-checks everything in the write transaction; this copy only
 * decides what to *show*.
 *
 * Coordinates in millimetres: x along the room, z across it, y up. Rotation 0
 * has a rack's front facing −z; 90 → +x, 180 → +z, 270 → −x.
 */

import type { CatalogItem, DcObject, Instance, RoomSettings, ShelfProps } from "../types";

export const U_MM = 44.45;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export type Dir = "left" | "right" | "up" | "down";

export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  z0: Math.min(z0, z1),
  x1: Math.max(x0, x1),
  z1: Math.max(z0, z1),
});

/** Open intersection: touching is not overlapping. */
export const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

export function intersection(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), z0: Math.max(a.z0, b.z0), x1: Math.min(a.x1, b.x1), z1: Math.min(a.z1, b.z1) };
  return r.x0 < r.x1 && r.z0 < r.z1 ? r : null;
}

export function frontDir(rotation: number): Dir {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return "right";
    case 180:
      return "down";
    case 270:
      return "left";
    default:
      return "up";
  }
}

export const opposite = (d: Dir): Dir => ({ left: "right", right: "left", up: "down", down: "up" })[d] as Dir;

/** Local size before rotation, with the overrides the kind allows. */
export function objectDims(item: CatalogItem, inst: Instance): [number, number, number] {
  const w = item.width_mm,
    d = item.depth_mm,
    h = item.height_mm;
  switch (item.kind) {
    case "cooling":
      return [inst.width_mm ?? w, d, h];
    case "cable_tray":
      return [inst.length_mm ?? w, d, h];
    case "structure":
      return [inst.width_mm ?? w, inst.depth_mm ?? d, inst.height_mm ?? h];
    default:
      return [w, d, h];
  }
}

export function footprint(x0: number, z0: number, w: number, d: number, rotation: number): Rect {
  const swap = ((rotation % 180) + 180) % 180 !== 0;
  const fw = swap ? d : w,
    fd = swap ? w : d;
  return rect(x0, z0, x0 + fw, z0 + fd);
}

export interface Swing {
  hinge: [number, number];
  radius: number;
  quadrant: Rect;
  height: number;
}

export interface Solid {
  id: number;
  name: string;
  kind: CatalogItem["kind"];
  rect: Rect;
  y0: number;
  y1: number;
  rotation: number;
  swing: Swing | null;
}

export const onFloor = (s: Solid) => s.y0 === 0 && s.swing === null;

export function swingHits(sw: Swing, r: Rect): boolean {
  const part = intersection(r, sw.quadrant);
  if (!part) return false;
  const [hx, hz] = sw.hinge;
  const cx = Math.min(Math.max(hx, part.x0), part.x1);
  const cz = Math.min(Math.max(hz, part.z0), part.z1);
  return (cx - hx) ** 2 + (cz - hz) ** 2 < sw.radius ** 2;
}

function centroid(poly: [number, number][]): [number, number] {
  const n = Math.max(poly.length, 1);
  return [poly.reduce((a, p) => a + p[0], 0) / n, poly.reduce((a, p) => a + p[1], 0) / n];
}

export function doorSwing(r: Rect, width: number, height: number, hinge: "low" | "high", poly: [number, number][]): Swing {
  const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
  const [cx, cz] = centroid(poly);
  if (alongX) {
    const z = r.z0;
    const into = cz >= z ? 1 : -1;
    const [hx, toward] = hinge === "low" ? [r.x0, 1] : [r.x1, -1];
    return { hinge: [hx, z], radius: width, quadrant: rect(hx, z, hx + toward * width, z + into * width), height };
  }
  const x = r.x0;
  const into = cx >= x ? 1 : -1;
  const [hz, toward] = hinge === "low" ? [r.z0, 1] : [r.z1, -1];
  return { hinge: [x, hz], radius: width, quadrant: rect(x, hz, x + into * width, hz + toward * width), height };
}

export function solid(o: DcObject, item: CatalogItem, poly: [number, number][]): Solid {
  const [w, d, h] = objectDims(item, o.instance);
  const r = footprint(o.x0_mm, o.z0_mm, w, d, o.rotation_deg);
  const isDoor = item.kind === "structure" && item.props.subtype === "door";
  return {
    id: o.id,
    name: o.name,
    kind: item.kind,
    rect: r,
    y0: o.y0_mm,
    y1: o.y0_mm + h,
    rotation: o.rotation_deg,
    swing: isDoor ? doorSwing(r, w, h, o.instance.hinge ?? "low", poly) : null,
  };
}

// --- Room polygon -----------------------------------------------------------

export function pointInPolygon(x: number, z: number, poly: [number, number][]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i],
      [bx, bz] = poly[(i + 1) % n];
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && z >= Math.min(az, bz) && z <= Math.max(az, bz))
      return true;
    if (az > z !== bz > z) {
      const xi = ax + ((z - az) * (bx - ax)) / (bz - az);
      if (x < xi) inside = !inside;
    }
  }
  return inside;
}

export function rectInPolygon(r: Rect, poly: [number, number][]): boolean {
  const corners: [number, number][] = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
  return (
    corners.every(([x, z]) => pointInPolygon(x, z, poly)) &&
    !poly.some(([x, z]) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1)
  );
}

export function bounds(poly: [number, number][]): Rect {
  const xs = poly.map((p) => p[0]),
    zs = poly.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
}

// --- Validity ---------------------------------------------------------------

export type Problem =
  | { type: "outside_room" }
  | { type: "above_ceiling" }
  | { type: "overlaps"; other: string }
  | { type: "blocks_door"; door: string };

export function problems(idx: number, solids: Solid[], poly: [number, number][], roomH: number): Problem[] {
  const s = solids[idx];
  const out: Problem[] = [];
  if (!s.swing && !rectInPolygon(s.rect, poly)) out.push({ type: "outside_room" });
  if (s.y1 > roomH) out.push({ type: "above_ceiling" });
  solids.forEach((o, j) => {
    if (j === idx) return;
    if (!s.swing && !o.swing) {
      if (s.y0 < o.y1 && o.y0 < s.y1 && overlaps(s.rect, o.rect)) out.push({ type: "overlaps", other: o.name });
    } else if (!s.swing && o.swing) {
      if (s.y0 < o.swing.height && swingHits(o.swing, s.rect)) out.push({ type: "blocks_door", door: o.name });
    } else if (s.swing && !o.swing) {
      if (o.y0 < s.swing.height && swingHits(s.swing, o.rect)) out.push({ type: "blocks_door", door: s.name });
    }
  });
  return out;
}

export interface Gap {
  mm: number;
  /** Index into the obstacles, or -1 for a wall. */
  obstacle: number;
  /** The two ends of the gap on the floor, for drawing it. */
  from: [number, number];
  to: [number, number];
}

/** Free distance from a face of `r` to the nearest wall or obstacle in `dir`. */
export function gap(r: Rect, dir: Dir, obstacles: Rect[], poly: [number, number][]): Gap {
  const b = bounds(poly);
  let best = { left: b.x0, right: b.x1, up: b.z0, down: b.z1 }[dir];
  let hit = -1;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i],
      [bx, bz] = poly[(i + 1) % n];
    if ((dir === "left" || dir === "right") && ax === bx) {
      const lo = Math.min(az, bz),
        hi = Math.max(az, bz);
      if (lo < r.z1 && r.z0 < hi) {
        if (dir === "left" && ax <= r.x0 && ax > best) best = ax;
        if (dir === "right" && ax >= r.x1 && ax < best) best = ax;
      }
    }
    if ((dir === "up" || dir === "down") && az === bz) {
      const lo = Math.min(ax, bx),
        hi = Math.max(ax, bx);
      if (lo < r.x1 && r.x0 < hi) {
        if (dir === "up" && az <= r.z0 && az > best) best = az;
        if (dir === "down" && az >= r.z1 && az < best) best = az;
      }
    }
  }
  obstacles.forEach((o, k) => {
    const zSpan = o.z0 < r.z1 && r.z0 < o.z1,
      xSpan = o.x0 < r.x1 && r.x0 < o.x1;
    if (dir === "left" && zSpan && o.x1 <= r.x0 && o.x1 > best) {
      best = o.x1;
      hit = k;
    }
    if (dir === "right" && zSpan && o.x0 >= r.x1 && o.x0 < best) {
      best = o.x0;
      hit = k;
    }
    if (dir === "up" && xSpan && o.z1 <= r.z0 && o.z1 > best) {
      best = o.z1;
      hit = k;
    }
    if (dir === "down" && xSpan && o.z0 >= r.z1 && o.z0 < best) {
      best = o.z0;
      hit = k;
    }
  });
  const cx = (r.x0 + r.x1) / 2,
    cz = (r.z0 + r.z1) / 2;
  switch (dir) {
    case "left":
      return { mm: r.x0 - best, obstacle: hit, from: [best, cz], to: [r.x0, cz] };
    case "right":
      return { mm: best - r.x1, obstacle: hit, from: [r.x1, cz], to: [best, cz] };
    case "up":
      return { mm: r.z0 - best, obstacle: hit, from: [cx, best], to: [cx, r.z0] };
    case "down":
      return { mm: best - r.z1, obstacle: hit, from: [cx, r.z1], to: [cx, best] };
  }
}

export interface ClearanceCheck {
  objectId: number;
  side: "front" | "rear";
  gap: Gap;
  required: number;
  /** The zone that must stay free, on the floor. */
  zone: Rect;
  ok: boolean;
}

/** Front and rear service clearance of each rack (§4.4); a shortfall warns. */
export function clearances(solids: Solid[], poly: [number, number][], settings: RoomSettings): ClearanceCheck[] {
  const out: ClearanceCheck[] = [];
  solids.forEach((s, i) => {
    if (s.kind !== "rack") return;
    const others = solids.filter((o, j) => j !== i && onFloor(o)).map((o) => o.rect);
    const front = frontDir(s.rotation);
    for (const [side, dir, required] of [
      ["front", front, settings.clearance_front_mm],
      ["rear", opposite(front), settings.clearance_rear_mm],
    ] as const) {
      const g = gap(s.rect, dir, others, poly);
      const r = s.rect;
      const zone =
        dir === "up"
          ? rect(r.x0, r.z0 - required, r.x1, r.z0)
          : dir === "down"
            ? rect(r.x0, r.z1, r.x1, r.z1 + required)
            : dir === "left"
              ? rect(r.x0 - required, r.z0, r.x0, r.z1)
              : rect(r.x1, r.z0, r.x1 + required, r.z1);
      out.push({ objectId: s.id, side, gap: g, required, zone, ok: g.mm >= required });
    }
  });
  return out;
}

// --- Snapping ---------------------------------------------------------------

/** Distance within which an edge snaps to a wall or a neighbour's edge. */
export const SNAP_MM = 25;

export interface Snapped {
  x0: number;
  z0: number;
  /** The line it snapped to, for drawing a guide. */
  guideX: number | null;
  guideZ: number | null;
}

/**
 * Snap a footprint's min corner: edges within 25 mm of a wall or another
 * object's edge stick to it; otherwise the corner goes to the grid.
 */
export function snap(
  x0: number,
  z0: number,
  fw: number,
  fd: number,
  others: Rect[],
  poly: [number, number][],
  grid: number,
  edges = true,
): Snapped {
  const toGrid = (v: number) => Math.round(v / grid) * grid;
  if (!edges) return { x0: toGrid(x0), z0: toGrid(z0), guideX: null, guideZ: null };
  const b = bounds(poly);
  const xs = [b.x0, b.x1, ...others.flatMap((o) => [o.x0, o.x1])];
  const zs = [b.z0, b.z1, ...others.flatMap((o) => [o.z0, o.z1])];
  let bx: number | null = null,
    bz: number | null = null,
    gx: number | null = null,
    gz: number | null = null,
    dx = SNAP_MM,
    dz = SNAP_MM;
  for (const e of xs) {
    if (Math.abs(x0 - e) < dx) {
      dx = Math.abs(x0 - e);
      bx = e;
      gx = e;
    }
    if (Math.abs(x0 + fw - e) < dx) {
      dx = Math.abs(x0 + fw - e);
      bx = e - fw;
      gx = e;
    }
  }
  for (const e of zs) {
    if (Math.abs(z0 - e) < dz) {
      dz = Math.abs(z0 - e);
      bz = e;
      gz = e;
    }
    if (Math.abs(z0 + fd - e) < dz) {
      dz = Math.abs(z0 + fd - e);
      bz = e - fd;
      gz = e;
    }
  }
  return { x0: bx ?? toGrid(x0), z0: bz ?? toGrid(z0), guideX: gx, guideZ: gz };
}

// --- Racks and shelves ------------------------------------------------------

/** Height above the floor of the bottom edge of unit `u` (1-based). */
export const unitBottomMm = (u1HeightMm: number, u: number) => u1HeightMm + (u - 1) * U_MM;

export const cellCount = (p: ShelfProps) => p.boards_mm.length * p.cells_per_board;

export interface CellInfo {
  cellNo: number;
  /** 0 = top board. */
  boardFromTop: number;
  column: number;
  plated: boolean;
  /** Board surface height above the floor. */
  boardY: number;
}

export function cellInfo(p: ShelfProps, n: number): CellInfo | null {
  if (n < 1 || n > cellCount(p)) return null;
  const boardFromTop = Math.floor((n - 1) / p.cells_per_board);
  return {
    cellNo: n,
    boardFromTop,
    column: (n - 1) % p.cells_per_board,
    plated: boardFromTop < p.plated_boards,
    boardY: p.boards_mm[p.boards_mm.length - 1 - boardFromTop],
  };
}

/**
 * What a cell is called: its plate number on a plated board, otherwise its
 * position on the unplated board ("bottom 3").
 */
export function cellLabel(p: ShelfProps, n: number): { n: number; plated: boolean } {
  const c = cellInfo(p, n);
  if (!c || c.plated) return { n, plated: true };
  return { n: n - p.plated_boards * p.cells_per_board, plated: false };
}
