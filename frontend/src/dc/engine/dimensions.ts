/**
 * Which dimensions the view draws, as plain data (FEEDBACK-7 §1.2): every
 * dimension on the plan or in 3D comes from one of these builders and
 * belongs to exactly one layer, so the layers list decides all of them. The
 * engine turns the specs into lines and labels.
 */

import type { Measurement } from "../types";
import { bounds, gap, onFloor, type Dir, type Solid } from "../model/geometry";

export type Vec3 = [number, number, number];

/** The layers a dimension can belong to (keys of the engine's `Layers`). */
export const DIM_LAYERS = [
  "room",
  "chains",
  "gaps",
  "tape",
  "selection",
] as const;
export type DimLayer = (typeof DIM_LAYERS)[number];

export interface DimSpec {
  key: string;
  layer: DimLayer;
  a: Vec3;
  b: Vec3;
  text: string;
  /** The length it reads, mm. */
  mm: number;
  priority: number;
  title?: string;
  /** The tape and the model disagree: the label carries a dot. */
  mark?: boolean;
  /** The objects it belongs to (`obj:12`). */
  refs?: string[];
}

export interface DimInput {
  floorPlan: [number, number][];
  measurements: Measurement[];
  solids: Solid[];
  /** The selected object's name, or null. */
  selected: string | null;
  plan: boolean;
  /** Realistic draws only the selection's own dimensions. */
  schema: boolean;
  measurement: (m: Measurement) => {
    text: string;
    title: string;
    mark: boolean;
  };
  mm: (v: number) => string;
}

/** A measurement that sizes an object rather than placing it. */
const SIZE_KEY = /(width|depth|height|length|unit_height|board)/;
/** On the plan: the chains' distance from the walls, mm, and the room's
 * overall dimensions' distance beyond them. */
export const PLAN_CHAIN_OFFSET = 250;
export const PLAN_CHAIN_GAP = 330;

/**
 * The layer a tape measurement belongs to: the room's overall size, the
 * selection's own numbers, the gaps that place objects, or the rest.
 */
export function measurementLayer(
  m: Measurement,
  selected: string | null,
): DimLayer {
  if (selected !== null && m.objects.includes(selected)) return "selection";
  if (m.key.startsWith("room.")) return "room";
  if (!SIZE_KEY.test(m.key)) return "gaps";
  return "tape";
}

/** The tape measurements as dimensions, each in its layer. */
export function measurementDims(d: DimInput): DimSpec[] {
  const ids = new Map(d.solids.map((s) => [s.name, s.id]));
  const b = bounds(d.floorPlan);
  const out: DimSpec[] = [];
  for (const e of d.measurements) {
    if (!e.line) continue;
    const layer = measurementLayer(e, d.selected);
    // Realistic keeps to the selection's own numbers.
    if (!d.schema && layer !== "selection") continue;
    let [p, q] = e.line.map((x) => [...x] as Vec3);
    if (layer === "room" && d.plan) {
      // Outside the chains: further from the walls.
      const ox = p[0] === q[0] ? Math.sign(p[0] - (b.x0 + b.x1) / 2) : 0;
      const oz = p[2] === q[2] ? Math.sign(p[2] - (b.z0 + b.z1) / 2) : 0;
      p = [p[0] + ox * PLAN_CHAIN_GAP, p[1], p[2] + oz * PLAN_CHAIN_GAP];
      q = [q[0] + ox * PLAN_CHAIN_GAP, q[1], q[2] + oz * PLAN_CHAIN_GAP];
    }
    const t = d.measurement(e);
    // Room-level numbers first, then the ones the drawing marks.
    const priority =
      layer === "selection" ? 8 : layer === "room" ? 7 : t.mark ? 6 : 4;
    out.push({
      key: `meas:${e.key}`,
      layer,
      a: p,
      b: q,
      text: t.text,
      mm: e.value,
      priority,
      title: t.title,
      mark: t.mark,
      refs: e.objects.flatMap((n) => (ids.has(n) ? [`obj:${ids.get(n)}`] : [])),
    });
  }
  return out;
}

/**
 * The plan's chain dimensions outside the outline (as on `Drawing.png`):
 * along the bottom, the rack row — wall, racks and the gaps between them; on
 * the right, the last rack's line across the room — the shelf, the aisle,
 * the rack and the gap behind it. Each link reads the tape where a
 * measurement covers it, else the model. Layer `chains`.
 */
export function planChains(d: DimInput): DimSpec[] {
  if (!d.plan) return [];
  const b = bounds(d.floorPlan);
  const racks = d.solids
    .filter((x) => x.kind === "rack")
    .sort((x, y) => x.rect.x0 - y.rect.x0);
  if (!racks.length) return [];
  const near = (u: number, v: number) => Math.abs(u - v) <= 2;
  // The tape reading whose line runs along the same stretch.
  const reading = (axis: 0 | 2, lo: number, hi: number) =>
    d.measurements.find((e) => {
      if (!e.line) return false;
      const [p, q] = e.line;
      const other = axis === 0 ? 2 : 0;
      if (p[other] !== q[other] || p[1] !== q[1]) return false;
      const [a, c] = [Math.min(p[axis], q[axis]), Math.max(p[axis], q[axis])];
      return near(a, lo) && near(c, hi);
    });
  const out: DimSpec[] = [];
  const link = (
    key: string,
    axis: 0 | 2,
    lo: number,
    hi: number,
    at: number,
  ) => {
    if (hi - lo < 1) return;
    const e = reading(axis, lo, hi);
    const t = e ? d.measurement(e) : null;
    out.push({
      key: `chain:${key}`,
      layer: "chains",
      a: axis === 0 ? [lo, 0, at] : [at, 0, lo],
      b: axis === 0 ? [hi, 0, at] : [at, 0, hi],
      text: t?.text ?? d.mm(hi - lo),
      mm: hi - lo,
      priority: 7,
      title: t?.title,
      mark: t?.mark,
    });
  };
  // Bottom: the rack row along x.
  const xs = [b.x0, ...racks.flatMap((r) => [r.rect.x0, r.rect.x1]), b.x1];
  const zb = b.z1 + PLAN_CHAIN_OFFSET;
  for (let i = 0; i + 1 < xs.length; i++)
    link(`x:${i}`, 0, xs[i], xs[i + 1], zb);
  // Right: the last rack's line across the room, along z.
  const last = racks[racks.length - 1];
  const shelf = d.solids.find(
    (x) =>
      x.kind === "shelf" &&
      x.rect.x0 < last.rect.x1 &&
      last.rect.x0 < x.rect.x1 &&
      x.rect.z1 <= last.rect.z0,
  );
  const zs = [
    b.z0,
    ...(shelf ? [shelf.rect.z1] : []),
    last.rect.z0,
    last.rect.z1,
    b.z1,
  ];
  const xr = b.x1 + PLAN_CHAIN_OFFSET;
  for (let i = 0; i + 1 < zs.length; i++)
    link(`z:${i}`, 2, zs[i], zs[i + 1], xr);
  return out;
}

/**
 * The selected object's clear distances to its neighbours or the walls, live
 * while it moves. Layer `selection`. `skip` is a gap drawn on its own (a
 * clicked clearance), as `[from, to]`.
 */
export function selectionGaps(
  d: DimInput,
  s: Solid,
  skip: [[number, number], [number, number]] | null,
): DimSpec[] {
  const others = d.solids
    .filter(
      (o) =>
        o !== s &&
        o.id !== s.id &&
        (s.y0 > 0 ? !o.swing && o.y0 < s.y1 && s.y0 < o.y1 : onFloor(o)),
    )
    .map((o) => o.rect);
  const y = s.y0 > 0 ? s.y0 : 12;
  const shown = skip ? JSON.stringify(skip) : "";
  const out: DimSpec[] = [];
  for (const dir of ["left", "right", "up", "down"] as Dir[]) {
    const g = gap(s.rect, dir, others, d.floorPlan);
    if (g.mm <= 0) continue;
    if (JSON.stringify([g.from, g.to]) === shown) continue;
    out.push({
      key: `gap:sel:${dir}`,
      layer: "selection",
      a: [g.from[0], y, g.from[1]],
      b: [g.to[0], y, g.to[1]],
      text: d.mm(g.mm),
      mm: g.mm,
      priority: 9,
    });
  }
  return out;
}

/**
 * Every dimension the view would draw for this state, before the layers
 * filter them. With a selection only its own dimensions and its gaps show
 * (FEEDBACK-7 §1.4): the room's, the chains, the gaps and the rest step back.
 */
export function allDims(
  d: DimInput,
  selected: Solid | null,
  skip: [[number, number], [number, number]] | null,
): DimSpec[] {
  const own = measurementDims(d);
  // A gap the tape already gives as one of the selection's own numbers is
  // drawn once, as the tape reading.
  const axis = (s: DimSpec) =>
    [0, 1, 2].reduce((k, i) =>
      Math.abs(s.b[i] - s.a[i]) > Math.abs(s.b[k] - s.a[k]) ? i : k,
    );
  const gaps = selected
    ? selectionGaps(d, selected, skip).filter(
        (g) =>
          !own.some(
            (m) =>
              m.layer === "selection" &&
              axis(m) === axis(g) &&
              Math.abs(m.mm - g.mm) <= 10,
          ),
      )
    : [];
  const all = [...own, ...(d.schema ? planChains(d) : []), ...gaps];
  return selected ? all.filter((s) => s.layer === "selection") : all;
}
