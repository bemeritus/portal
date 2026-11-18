/**
 * The snapping ruler (SPEC §11.1, FEEDBACK-1 §4), pure.
 *
 * The old ruler measured between whatever surface points the rays hit — a
 * 61 cm gap came out as 66.1 cm. This one measures between *things*:
 *
 * - snap targets: vertex, edge midpoint, edge, face (the point on the face),
 *   object centre — the engine shows the active one before the click;
 * - face ⟂ face: two parallel faces give their perpendicular distance, the
 *   same wherever on the faces the clicks land;
 * - object gap: two objects (or an object and a wall) give the shortest clear
 *   distance between them in plan, and the axis it runs along;
 * - in an orthographic top view, distances are in the floor plane unless Alt
 *   is held; Shift locks to the nearest axis.
 *
 * Everything in millimetres, room coordinates (x along the room, y up, z
 * across). Objects are axis-aligned boxes (rotations are multiples of 90°).
 */

export type Vec3 = [number, number, number];
export type Axis = 0 | 1 | 2;
export type SnapKind =
  "vertex" | "midpoint" | "edge" | "face" | "centre" | "free";

export interface Box {
  /** Object id, or a wall's id (negative). */
  id: number;
  min: Vec3;
  max: Vec3;
}

/** A face: the plane `axis = coord`, its outward normal's sign, its extent. */
export interface Face {
  boxId: number;
  axis: Axis;
  /** +1 if the outward normal points along +axis. */
  side: 1 | -1;
  coord: number;
  /** Extent on the two other axes, in axis order. */
  lo: [number, number];
  hi: [number, number];
}

export interface Snap {
  kind: SnapKind;
  p: Vec3;
  /** The face the point lies on, when the snap is on a face. */
  face?: Face;
  boxId?: number;
}

const others = (axis: Axis): [Axis, Axis] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

/** The face of `box` on `axis` at its min (`side` −1) or max (+1). */
export function faceOf(box: Box, axis: Axis, side: 1 | -1): Face {
  const [u, v] = others(axis);
  return {
    boxId: box.id,
    axis,
    side,
    coord: side > 0 ? box.max[axis] : box.min[axis],
    lo: [box.min[u], box.min[v]],
    hi: [box.max[u], box.max[v]],
  };
}

/** The face of `box` a surface point lies on (the nearest box plane). */
export function faceAt(box: Box, p: Vec3): Face {
  let best: Face = faceOf(box, 1, 1);
  let bestD = Infinity;
  for (const axis of [0, 1, 2] as Axis[])
    for (const side of [-1, 1] as const) {
      const f = faceOf(box, axis, side);
      const d = Math.abs(p[axis] - f.coord);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
  return best;
}

function corners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

function edges(b: Box): [Vec3, Vec3][] {
  const c = corners(b);
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++) {
      // Corners differing in exactly one coordinate share an edge.
      const diff = [0, 1, 2].filter((k) => c[i][k] !== c[j][k]).length;
      if (diff === 1) out.push([c[i], c[j]]);
    }
  return out;
}

const mid = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

function nearestOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = len2
    ? Math.max(
        0,
        Math.min(
          1,
          ((p[0] - a[0]) * ab[0] +
            (p[1] - a[1]) * ab[1] +
            (p[2] - a[2]) * ab[2]) /
            len2,
        ),
      )
    : 0;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
}

/** Every snap target of `box` near a surface point `hit` on it. */
export function candidates(box: Box, hit: Vec3): Snap[] {
  const face = faceAt(box, hit);
  const out: Snap[] = [];
  for (const p of corners(box)) out.push({ kind: "vertex", p, boxId: box.id });
  for (const [a, b] of edges(box)) {
    out.push({ kind: "midpoint", p: mid(a, b), boxId: box.id });
    out.push({ kind: "edge", p: nearestOnSegment(a, b, hit), boxId: box.id });
  }
  out.push({ kind: "centre", p: mid(box.min, box.max), boxId: box.id });
  // The point on the face itself: its plane coordinate made exact.
  const onFace: Vec3 = [...hit];
  onFace[face.axis] = face.coord;
  out.push({ kind: "face", p: onFace, face, boxId: box.id });
  return out;
}

/** Screen-distance thresholds (px) per snap kind, most specific first. */
export const SNAP_PX: Partial<Record<SnapKind, number>> = {
  vertex: 12,
  midpoint: 10,
  centre: 10,
  edge: 8,
};
const ORDER: SnapKind[] = ["vertex", "midpoint", "centre", "edge"];

/**
 * The snap to use: the most specific target within its threshold of the
 * cursor (screen space, via `project`), otherwise the face point.
 */
export function pickSnap(
  cands: Snap[],
  project: (p: Vec3) => [number, number],
  cursor: [number, number],
): Snap {
  for (const kind of ORDER) {
    let best: Snap | null = null,
      bestD = SNAP_PX[kind]!;
    for (const c of cands) {
      if (c.kind !== kind) continue;
      const [x, y] = project(c.p);
      const d = Math.hypot(x - cursor[0], y - cursor[1]);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) return best;
  }
  return cands.find((c) => c.kind === "face") ?? cands[0];
}

export interface Result {
  a: Vec3;
  b: Vec3;
  /** Millimetres. */
  distance: number;
  /** What was measured: the snap kinds of both ends, or a mode. */
  how: "face_face" | "object_gap" | "points";
  kinds: [SnapKind, SnapKind];
  /** The axis it was measured along, when it was one. */
  axis: Axis | null;
}

/**
 * Face ⟂ face: for two parallel faces, the perpendicular distance between
 * their planes, drawn where the faces overlap (or between the clicks when
 * they do not) — independent of where on the faces the clicks were.
 * `null` if the faces are not parallel.
 */
export function faceToFace(
  fa: Face,
  fb: Face,
  pa: Vec3,
  pb: Vec3,
): Result | null {
  if (fa.axis !== fb.axis) return null;
  const axis = fa.axis;
  const [u, v] = others(axis);
  // A point in the overlap of the two face rectangles, or else the first click.
  const lo = [Math.max(fa.lo[0], fb.lo[0]), Math.max(fa.lo[1], fb.lo[1])];
  const hi = [Math.min(fa.hi[0], fb.hi[0]), Math.min(fa.hi[1], fb.hi[1])];
  const at: [number, number] =
    lo[0] <= hi[0] && lo[1] <= hi[1]
      ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
      : [pa[u], pa[v]];
  void pb;
  const a: Vec3 = [0, 0, 0],
    b: Vec3 = [0, 0, 0];
  a[axis] = fa.coord;
  b[axis] = fb.coord;
  a[u] = b[u] = at[0];
  a[v] = b[v] = at[1];
  return {
    a,
    b,
    distance: Math.abs(fb.coord - fa.coord),
    how: "face_face",
    kinds: ["face", "face"],
    axis,
  };
}

export interface PlanRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * Object gap: the shortest clear distance in plan between two footprints,
 * and the axis it runs along (`null` when the shortest way is diagonal).
 * Overlapping footprints give 0.
 */
export function objectGap(r1: PlanRect, r2: PlanRect, y = 0): Result {
  const dx = Math.max(0, r2.x0 - r1.x1, r1.x0 - r2.x1);
  const dz = Math.max(0, r2.z0 - r1.z1, r1.z0 - r2.z1);
  // Where the two spans overlap, the dimension sits at the overlap's middle.
  const overlapZ: [number, number] = [
    Math.max(r1.z0, r2.z0),
    Math.min(r1.z1, r2.z1),
  ];
  const overlapX: [number, number] = [
    Math.max(r1.x0, r2.x0),
    Math.min(r1.x1, r2.x1),
  ];
  const ax = r2.x0 >= r1.x1 ? r1.x1 : r1.x0;
  const bx = r2.x0 >= r1.x1 ? r2.x0 : r2.x1;
  const az = r2.z0 >= r1.z1 ? r1.z1 : r1.z0;
  const bz = r2.z0 >= r1.z1 ? r2.z0 : r2.z1;
  if (dx > 0 && dz === 0) {
    const z = (overlapZ[0] + overlapZ[1]) / 2;
    return {
      a: [ax, y, z],
      b: [bx, y, z],
      distance: dx,
      how: "object_gap",
      kinds: ["face", "face"],
      axis: 0,
    };
  }
  if (dz > 0 && dx === 0) {
    const x = (overlapX[0] + overlapX[1]) / 2;
    return {
      a: [x, y, az],
      b: [x, y, bz],
      distance: dz,
      how: "object_gap",
      kinds: ["face", "face"],
      axis: 2,
    };
  }
  if (dx === 0 && dz === 0) {
    const x = (overlapX[0] + overlapX[1]) / 2,
      z = (overlapZ[0] + overlapZ[1]) / 2;
    return {
      a: [x, y, z],
      b: [x, y, z],
      distance: 0,
      how: "object_gap",
      kinds: ["face", "face"],
      axis: null,
    };
  }
  return {
    a: [ax, y, az],
    b: [bx, y, bz],
    distance: Math.hypot(dx, dz),
    how: "object_gap",
    kinds: ["vertex", "vertex"],
    axis: null,
  };
}

/**
 * Object to wall: the clear distance from a footprint to an axis-aligned
 * wall line (`axis` 0 = a wall at x = coord, 2 = at z = coord).
 */
export function wallGap(
  r: PlanRect,
  axis: 0 | 2,
  coord: number,
  y = 0,
): Result {
  if (axis === 0) {
    const fromX = coord >= r.x1 ? r.x1 : r.x0;
    const z = (r.z0 + r.z1) / 2;
    return {
      a: [fromX, y, z],
      b: [coord, y, z],
      distance: Math.abs(coord - fromX),
      how: "object_gap",
      kinds: ["face", "face"],
      axis: 0,
    };
  }
  const fromZ = coord >= r.z1 ? r.z1 : r.z0;
  const x = (r.x0 + r.x1) / 2;
  return {
    a: [x, y, fromZ],
    b: [x, y, coord],
    distance: Math.abs(coord - fromZ),
    how: "object_gap",
    kinds: ["face", "face"],
    axis: 2,
  };
}

/**
 * Point to point, with the options of the ruler: `planar` drops the height
 * (orthographic top view, unless Alt), `lockAxis` keeps the nearest single
 * axis (Shift).
 */
export function pointToPoint(
  a: Snap,
  b: Snap,
  opts: { planar?: boolean; lockAxis?: boolean } = {},
): Result {
  const p: Vec3 = [...a.p],
    q: Vec3 = [...b.p];
  if (opts.planar) q[1] = p[1];
  let axis: Axis | null = null;
  if (opts.lockAxis) {
    const d = [
      Math.abs(q[0] - p[0]),
      Math.abs(q[1] - p[1]),
      Math.abs(q[2] - p[2]),
    ];
    axis = d.indexOf(Math.max(...d)) as Axis;
    for (const k of [0, 1, 2] as Axis[]) if (k !== axis) q[k] = p[k];
  }
  const distance = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  return { a: p, b: q, distance, how: "points", kinds: [a.kind, b.kind], axis };
}

/**
 * The measurement for two picks: face ⟂ face when both are face snaps on
 * parallel planes (the default), otherwise point to point.
 */
export function measure(
  a: Snap,
  b: Snap,
  opts: { planar?: boolean; lockAxis?: boolean } = {},
): Result {
  if (
    a.kind === "face" &&
    b.kind === "face" &&
    a.face &&
    b.face &&
    !opts.lockAxis
  ) {
    const r = faceToFace(a.face, b.face, a.p, b.p);
    if (r && !(opts.planar && a.face.axis === 1)) return r;
  }
  return pointToPoint(a, b, opts);
}
