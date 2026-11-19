/**
 * Parts the equipment templates share (FEEDBACK-4 §2): bevelled bodies,
 * perforated faces with the fans behind them, displays, plinths with
 * levelling feet, casters, seams. Local frame as in `types.ts` (millimetres,
 * the front faces −z, y up from 0). Small detail obeys `ctx.detail`: fan
 * blades go at 1, guards, seams and feet at 0; the silhouette never does.
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { box, withBase, type BuildContext } from "./types";

/** Real hole pitch of a honeycomb-perforated door or panel, mm. */
export const PERF_PITCH_MM = 7;
/** The smallest hole pitch a preview may draw, in screen pixels. */
export const PERF_MIN_PX = 4;

/**
 * The hole pitch to draw on a face: the real one, unless it would fall
 * below `PERF_MIN_PX` on screen — then coarser, so the pattern still reads.
 */
export function perfPitch(pxPerMm: number | null): number {
  if (!pxPerMm || pxPerMm <= 0) return PERF_PITCH_MM;
  return Math.max(PERF_PITCH_MM, PERF_MIN_PX / pxPerMm);
}

/** A box with rounded edges, bottom-centre at (x, y, z), like `box()`. */
export function rbox(
  ctx: BuildContext,
  role: string,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  radius = 8,
): THREE.Mesh {
  const r = Math.max(
    0.5,
    Math.min(radius, w / 2 - 0.5, h / 2 - 0.5, d / 2 - 0.5),
  );
  // Bevels are detail too: at the lowest level a plain box does.
  const geo =
    ctx.detail === 0 || r < 1
      ? new THREE.BoxGeometry(Math.max(w, 1), Math.max(h, 1), Math.max(d, 1))
      : new RoundedBoxGeometry(w, h, d, 2, r);
  const m = new THREE.Mesh(geo, ctx.lib.role(role));
  m.position.set(x, y + h / 2, z);
  m.userData.role = role;
  m.castShadow = ctx.mode === "realistic";
  m.receiveShadow = ctx.mode === "realistic";
  return m;
}

/** A thin vertical or horizontal seam line on a face (panel joints). */
export function seam(
  ctx: BuildContext,
  g: THREE.Group,
  role: string,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
) {
  if (ctx.detail === 0) return;
  g.add(box(ctx, role, w, h, 3, x, y, z));
}

/** A fan behind a perforated face: guard ring, hub and (at detail 2) blades. */
export function fan(
  ctx: BuildContext,
  g: THREE.Group,
  r: number,
  x: number,
  y: number,
  z: number,
) {
  const at = (m: THREE.Mesh, role: string) => {
    m.position.set(x, y, z);
    m.userData.role = role;
    m.castShadow = ctx.mode === "realistic";
    m.receiveShadow = ctx.mode === "realistic";
    g.add(m);
    return m;
  };
  // The dark shroud the fan sits in reads as depth behind the holes.
  const shroud = at(
    new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.06, r * 1.06, 40, 32, 1, true),
      ctx.lib.role("fanShroud"),
    ),
    "fanShroud",
  );
  shroud.rotation.x = Math.PI / 2;
  shroud.position.z = z + 20;
  if (ctx.detail > 0) {
    const ring = at(
      new THREE.Mesh(
        new THREE.TorusGeometry(r, Math.max(3, r * 0.05), 8, 40),
        ctx.lib.role("fan"),
      ),
      "fan",
    );
    ring.position.z = z - 2;
  }
  const hub = at(
    new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.3, r * 0.3, 24, 24),
      ctx.lib.role("fanHub"),
    ),
    "fanHub",
  );
  hub.rotation.x = Math.PI / 2;
  if (ctx.detail < 2) return;
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(r * 0.32, r * 0.62, 4),
      ctx.lib.role("fan"),
    );
    const a = (b / blades) * Math.PI * 2;
    blade.position.set(
      x + Math.sin(a) * r * 0.6,
      y + Math.cos(a) * r * 0.6,
      z + 6,
    );
    blade.rotation.set(0, 0.45, -a);
    blade.userData.role = "fan";
    blade.castShadow = ctx.mode === "realistic";
    g.add(blade);
  }
}

/**
 * A perforated face: a frame and bevelled rim in a lighter tone than the
 * body, the honeycomb sheet (its pitch from `perfPitch`), and what is behind
 * it. `z` is the face plane; `outward` is −1 for a front face, +1 for a rear.
 */
export function perforatedFace(
  ctx: BuildContext,
  g: THREE.Group,
  body: string,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  outward: -1 | 1,
  behind?: (zBehind: number) => void,
) {
  const frame = Math.min(40, w * 0.08);
  // The rim carries the body's finish, a shade lighter (materials.ts).
  const rimRole = withBase(body, "rim");
  // The frame: four bars round the sheet, catching the light on their bevels.
  for (const [bw, bh, bx, by] of [
    [w, frame, x, y + h - frame],
    [w, frame, x, y],
    [frame, h - 2 * frame, x - w / 2 + frame / 2, y + frame],
    [frame, h - 2 * frame, x + w / 2 - frame / 2, y + frame],
  ])
    g.add(rbox(ctx, rimRole, bw, bh, 12, bx, by, z + outward * 6, 4));
  const sw = w - 2 * frame,
    sh = h - 2 * frame;
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh),
    ctx.lib.perforation(body, sw, sh, perfPitch(ctx.pxPerMm)),
  );
  sheet.position.set(x, y + frame + sh / 2, z + outward * 4);
  if (outward < 0) sheet.rotation.y = Math.PI;
  sheet.userData.role = "perforated";
  // Its material depends on its size: keep it through mode and highlight.
  sheet.userData.fixedMaterial = true;
  sheet.userData.noMerge = true;
  g.add(sheet);
  behind?.(z - outward * 30);
}

/** A display with a lit screen in a dark bezel, on a face at `z`. */
export function display(
  ctx: BuildContext,
  g: THREE.Group,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  outward: -1 | 1,
) {
  g.add(rbox(ctx, "bezel", w + 16, h + 16, 8, x, y - 8, z + outward * 4, 3));
  g.add(box(ctx, "display", w, h, 2, x, y, z + outward * 9));
}

/** A plinth under a cabinet, with four levelling feet at its corners. */
export function plinth(
  ctx: BuildContext,
  g: THREE.Group,
  w: number,
  d: number,
  h: number,
) {
  g.add(box(ctx, "plinth", w - 20, h, d - 20, 0, 0, 0));
  if (ctx.detail === 0) return;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(22, 26, 14, 16),
        ctx.lib.role("foot"),
      );
      foot.position.set(sx * (w / 2 - 50), 7, sz * (d / 2 - 50));
      foot.userData.role = "foot";
      g.add(foot);
    }
}

/** Four casters under a cabinet. */
export function casters(
  ctx: BuildContext,
  g: THREE.Group,
  w: number,
  d: number,
) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const c = new THREE.Mesh(
        new THREE.CylinderGeometry(25, 25, 22, 16),
        ctx.lib.role("caster"),
      );
      c.rotation.z = Math.PI / 2;
      c.position.set(sx * (w / 2 - 50), 25, sz * (d / 2 - 80));
      c.userData.role = "caster";
      g.add(c);
    }
}

/** Vent slots on a top face: a row of dark bars across the width. */
export function topVents(
  ctx: BuildContext,
  g: THREE.Group,
  w: number,
  d: number,
  y: number,
  slots: number,
) {
  if (ctx.detail === 0) return;
  for (let i = 0; i < slots; i++) {
    const t = (i + 0.5) / slots - 0.5;
    g.add(box(ctx, "vent", w * 0.7, 2, 14, 0, y, t * d * 0.8));
  }
}
