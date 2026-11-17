/**
 * FEEDBACK-1 §4 / SPEC §17.1: face-to-face between rack 1's back face and the
 * back wall is 595 mm wherever on the faces the clicks land; the object gap
 * between racks 3 and 4 is 200 mm.
 */
import { describe, expect, it } from "vitest";

import { candidates, faceAt, faceOf, measure, objectGap, pickSnap, pointToPoint, wallGap, type Box, type Snap, type Vec3 } from "./ruler";

// The seeded room (room.json v2): 5545 × 3845 × 2410.
const W = 3845;
const r1: Box = { id: 1, min: [530, 0, 2250], max: [1130, 2040, 3250] };
const r3: Box = { id: 3, min: [2635, 0, 2220], max: [3235, 2040, 3220] };
const r4: Box = { id: 4, min: [3435, 0, 2215], max: [4035, 2040, 3215] };
// The back wall as a box whose inner face is the floor line z = 3845.
const backWall: Box = { id: -1, min: [0, 0, W], max: [5545, 2410, W + 60] };

const faceSnap = (box: Box, p: Vec3): Snap => {
  const face = faceAt(box, p);
  const q: Vec3 = [...p];
  q[face.axis] = face.coord;
  return { kind: "face", p: q, face, boxId: box.id };
};

describe("face ⟂ face", () => {
  it("rack 1's back face to the back wall is 595 mm wherever the clicks land", () => {
    const clicks: [Vec3, Vec3][] = [
      [[600, 300, 3250], [100, 50, W]],
      [[1100, 2000, 3250], [5000, 2300, W]],
      [[830, 1020, 3250.4], [2700, 900, W - 0.3]],
      [[531, 1, 3249.8], [4400, 2400, W]],
    ];
    for (const [a, b] of clicks) {
      const r = measure(faceSnap(r1, a), faceSnap(backWall, b));
      expect(r.how).toBe("face_face");
      expect(r.distance).toBe(595);
      expect(r.axis).toBe(2);
      // Drawn between the planes, perpendicular to them.
      expect(r.a[2]).toBe(3250);
      expect(r.b[2]).toBe(W);
      expect(r.a[0]).toBe(r.b[0]);
      expect(r.a[1]).toBe(r.b[1]);
    }
  });

  it("is not used for faces that are not parallel", () => {
    const top = faceSnap(r1, [800, 2040, 2700]);
    const back = faceSnap(r1, [800, 1000, 3250]);
    expect(measure(top, back).how).toBe("points");
  });
});

describe("object gap", () => {
  it("between racks 3 and 4 is 200 mm along x", () => {
    const rect = (b: Box) => ({ x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] });
    const g = objectGap(rect(r3), rect(r4));
    expect(g.distance).toBe(200);
    expect(g.axis).toBe(0);
    expect(objectGap(rect(r4), rect(r3)).distance).toBe(200);
  });

  it("from an object to a wall", () => {
    const g = wallGap({ x0: 530, z0: 2250, x1: 1130, z1: 3250 }, 2, W);
    expect(g.distance).toBe(595);
    expect(wallGap({ x0: 530, z0: 2250, x1: 1130, z1: 3250 }, 0, 0).distance).toBe(530);
  });

  it("is diagonal when the footprints overlap on neither axis", () => {
    const g = objectGap({ x0: 0, z0: 0, x1: 100, z1: 100 }, { x0: 130, z0: 140, x1: 200, z1: 200 });
    expect(g.distance).toBe(50);
    expect(g.axis).toBeNull();
  });
});

describe("snaps", () => {
  const project = (p: Vec3): [number, number] => [p[0] / 10, p[2] / 10]; // top view, 1 px = 10 mm

  // The ray hits the top face right under the cursor.
  const at = (x: number, z: number) => pickSnap(candidates(r1, [x * 10, 2040, z * 10]), project, [x, z]).kind;

  it("prefers a vertex over a midpoint over an edge over the face", () => {
    expect(at(53.5, 225.5)).toBe("vertex");
    expect(at(83, 225.3)).toBe("midpoint");
    expect(at(70, 225.4)).toBe("edge");
    expect(at(70, 270)).toBe("face");
  });

  it("puts face points exactly on the plane", () => {
    const c = candidates(r1, [800, 1000, 3250.7]);
    const f = c.find((s) => s.kind === "face")!;
    expect(f.p[2]).toBe(3250);
    expect(f.face).toEqual(faceOf(r1, 2, 1));
  });
});

describe("point to point", () => {
  const s = (p: Vec3): Snap => ({ kind: "vertex", p });
  it("drops height in a planar (top view) measurement", () => {
    expect(pointToPoint(s([0, 0, 0]), s([300, 2000, 400]), { planar: true }).distance).toBe(500);
    expect(pointToPoint(s([0, 0, 0]), s([300, 0, 400])).distance).toBe(500);
  });
  it("locks to the nearest axis with Shift", () => {
    const r = pointToPoint(s([0, 0, 0]), s([300, 10, 40]), { lockAxis: true });
    expect(r.distance).toBe(300);
    expect(r.axis).toBe(0);
  });
});
