import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { CatalogItem } from "../types";
import { frameBox, itemBox, viewDirection } from "./studio";

const cooling = (subtype: string, w: number, d: number, h: number) =>
  ({
    id: 1,
    kind: "cooling",
    width_mm: w,
    depth_mm: d,
    height_mm: h,
    props: { subtype },
  }) as unknown as CatalogItem;

/** The box's projected extents in normalised device coordinates. */
function ndc(
  box: THREE.Box3,
  f: ReturnType<typeof frameBox>,
  fov: number,
  aspect: number,
) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 1, 1e6);
  cam.position.copy(f.position);
  cam.lookAt(f.target);
  cam.updateMatrixWorld();
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(cam);
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
  return { x0, x1, y0, y1 };
}

describe("catalog preview framing (FEEDBACK-4 §2)", () => {
  it("looks at the front, turned 30°, from 17° above", () => {
    const d = viewDirection(cooling("in_row", 300, 1132, 2000));
    // The front faces −z: the camera is in front (z < 0), a little to the left.
    expect(d.z).toBeLessThan(0);
    expect(Math.atan2(-d.x, -d.z) * (180 / Math.PI)).toBeCloseTo(30, 5);
    expect(Math.asin(d.y) * (180 / Math.PI)).toBeCloseTo(17, 5);
  });

  it("shows ceiling cassettes from slightly below", () => {
    expect(
      viewDirection(cooling("split_cassette", 840, 840, 250)).y,
    ).toBeLessThan(0);
    expect(viewDirection(cooling("ducted", 1100, 774, 249)).y).toBeGreaterThan(
      0,
    );
  });

  it("frames every shape with the same margin on its tightest side, centred", () => {
    const fov = 24,
      aspect = 4 / 3,
      margin = 0.1;
    for (const item of [
      cooling("in_row", 300, 1132, 2000), // tall and deep
      cooling("ducted", 1340, 750, 350), // flat and wide
      cooling("split_wall", 1101, 249, 327),
      cooling("precision_perimeter", 876, 879, 1970),
    ]) {
      const box = itemBox(item);
      const f = frameBox(box, viewDirection(item), fov, aspect, margin);
      const e = ndc(box, f, fov, aspect);
      // Inside the frame, the tightest side touching the margin.
      const free = 1 - 2 * margin;
      expect(Math.max(-e.x0, e.x1, -e.y0, e.y1)).toBeLessThanOrEqual(
        free + 1e-6,
      );
      expect(Math.max(e.x1 - e.x0, e.y1 - e.y0) / 2).toBeGreaterThan(
        free * 0.95,
      );
      // Centred: equal space left and right, top and bottom.
      expect((e.x0 + e.x1) / 2).toBeCloseTo(0, 1);
      expect((e.y0 + e.y1) / 2).toBeCloseTo(0, 1);
    }
  });

  it("reports the scale at the target, for the perforation pitch", () => {
    const item = cooling("in_row", 300, 1132, 2000);
    const f = frameBox(itemBox(item), viewDirection(item), 24, 4 / 3, 0.1, 600);
    // 2 m tall in about 80 % of 600 px: roughly 0.2–0.3 px per mm.
    expect(f.pxPerMm).toBeGreaterThan(0.15);
    expect(f.pxPerMm).toBeLessThan(0.35);
  });
});
