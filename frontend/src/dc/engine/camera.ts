/**
 * The camera rig, ported from the prototype's `camera.js` (centimetres there,
 * millimetres here): orbit with damping, zoom toward the point under the
 * cursor, perspective ↔ orthographic without losing the framing, tweened
 * preset views, keyboard pan along the floor, and a walk mode with collision
 * and click-to-walk. `prefers-reduced-motion` turns the tweens off.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { Rect } from "../model/geometry";

export interface View {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  ortho: boolean;
  /** Half the visible height at the target, for ortho framing. */
  halfHeight?: number;
}

export type Preset =
  | "iso"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "left"
  | "right"
  | "aisle"
  | "racks";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class CameraRig {
  readonly persp = new THREE.PerspectiveCamera(45, 1, 20, 120000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -60000, 120000);
  readonly controls: OrbitControls;
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  private w = 1;
  private h = 1;
  /**
   * The part of the canvas no panel covers, px (FEEDBACK-7 §1.3). Framing
   * fits into it, and the view is offset so the orbit target sits at its
   * centre, as a 3D tool's viewport does beside its side panels.
   */
  private safe = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** The view offset now in use, px: the canvas centre minus the safe centre. */
  private off = { x: 0, y: 0 };
  private tween: null | {
    t0: number;
    dur: number;
    p0: THREE.Vector3;
    p1: THREE.Vector3;
    g0: THREE.Vector3;
    g1: THREE.Vector3;
    f0: number;
    f1: number;
    h0: number;
    h1: number;
    o0: { x: number; y: number };
    o1: { x: number; y: number };
  } = null;
  readonly reducedMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Room bounds, for clamping the target and for walking. */
  room: Rect = { x0: 0, z0: 0, x1: 5000, z1: 4000 };
  roomHeight = 2400;
  /** Floor obstacles for walk-mode collision. */
  obstacles: Rect[] = [];
  readonly held = new Set<string>();
  readonly walk = {
    on: false,
    yaw: Math.PI / 2,
    pitch: -0.06,
    pos: new THREE.Vector3(0, 1650, 0),
    goto: null as null | { x: number; z: number },
    saved: null as View | null,
    fov0: 45,
  };
  onChange: () => void = () => {};

  constructor(dom: HTMLElement) {
    this.controls = new OrbitControls(this.persp, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    // Wheel zoom is ours, toward the cursor.
    this.controls.enableZoom = false;
    this.controls.minDistance = 400;
    this.controls.maxDistance = 30000;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener("start", () => (this.tween = null));
    this.persp.position.set(2700, 5200, 9000);
    this.controls.target.set(2700, 900, 1900);
    this.setOrthoFrustum(4000);
  }

  private tanHalf() {
    return Math.tan((this.persp.fov * Math.PI) / 360);
  }

  private setOrthoFrustum(hh: number) {
    const a = this.w / this.h;
    Object.assign(this.ortho, {
      top: hh,
      bottom: -hh,
      left: -hh * a,
      right: hh * a,
      zoom: 1,
    });
    this.ortho.updateProjectionMatrix();
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (this.safe.x1 <= 1) this.safe = { x0: 0, y0: 0, x1: w, y1: h };
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const z = this.ortho.zoom;
    this.setOrthoFrustum(this.ortho.top);
    this.ortho.zoom = z;
    this.ortho.updateProjectionMatrix();
    this.applyOffset();
  }

  /** Set the uncovered part of the canvas (px); the next framing uses it. */
  setSafe(r: { x0: number; y0: number; x1: number; y1: number }) {
    this.safe = {
      x0: clamp(r.x0, 0, this.w - 40),
      y0: clamp(r.y0, 0, this.h - 40),
      x1: clamp(r.x1, r.x0 + 40, this.w),
      y1: clamp(r.y1, r.y0 + 40, this.h),
    };
  }

  /** The uncovered part of the canvas, px (tests). */
  safeRect() {
    return { ...this.safe };
  }

  /** Where the safe centre wants the view offset. */
  private safeOffset() {
    return {
      x: Math.round(this.w / 2 - (this.safe.x0 + this.safe.x1) / 2),
      y: Math.round(this.h / 2 - (this.safe.y0 + this.safe.y1) / 2),
    };
  }

  private applyOffset() {
    for (const c of [this.persp, this.ortho]) {
      if (this.off.x || this.off.y)
        c.setViewOffset(this.w, this.h, this.off.x, this.off.y, this.w, this.h);
      else c.clearViewOffset();
    }
  }

  /**
   * The distance at which a sphere of `radius` fills the safe part of the
   * canvas, in perspective.
   */
  fitDistance(radius: number): number {
    const tan = Math.tan((this.persp.fov * Math.PI) / 360);
    const t = Math.min(
      (tan * (this.safe.y1 - this.safe.y0)) / this.h,
      (tan * (this.safe.x1 - this.safe.x0)) / this.h,
    );
    return radius / Math.sin(Math.atan(t));
  }

  /** The orthographic half-height that fits a w × h (mm) box in the safe part. */
  fitHalfHeight(halfW: number, halfH: number): number {
    return Math.max(
      (halfH * this.h) / (this.safe.y1 - this.safe.y0),
      (halfW * this.h) / (this.safe.x1 - this.safe.x0),
    );
  }

  get isOrtho() {
    return this.cam === this.ortho;
  }

  setOrtho(on: boolean) {
    if (on === this.isOrtho) return;
    const tg = this.controls.target;
    if (on) {
      const d = this.persp.position.distanceTo(tg);
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.setOrthoFrustum(d * this.tanHalf());
      this.cam = this.ortho;
    } else {
      const hh = this.ortho.top / this.ortho.zoom;
      const d = hh / this.tanHalf();
      const dir = this.ortho.position.clone().sub(tg).normalize();
      this.persp.position.copy(tg).addScaledVector(dir, d);
      this.cam = this.persp;
    }
    this.controls.object = this.cam;
    this.controls.update();
    this.onChange();
  }

  view(): View {
    const o = this.isOrtho;
    return {
      position: this.cam.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      fov: this.persp.fov,
      ortho: o,
      halfHeight: o
        ? this.ortho.top / this.ortho.zoom
        : this.persp.position.distanceTo(this.controls.target) * this.tanHalf(),
    };
  }

  /** Fly to a view. */
  go(v: View, dur = 750) {
    if (this.walk.on) this.setWalk(false, true);
    if (v.ortho !== this.isOrtho) this.setOrtho(v.ortho);
    const from = this.view();
    const p1 = new THREE.Vector3(...v.position),
      g1 = new THREE.Vector3(...v.target);
    const h1 =
      v.halfHeight ?? p1.distanceTo(g1) * Math.tan((v.fov * Math.PI) / 360);
    this.tween = {
      t0: performance.now(),
      dur: this.reducedMotion ? 0 : dur,
      p0: new THREE.Vector3(...from.position),
      g0: new THREE.Vector3(...from.target),
      p1,
      g1,
      f0: from.fov,
      f1: v.fov,
      h0: from.halfHeight ?? 1000,
      h1,
      o0: { ...this.off },
      o1: this.safeOffset(),
    };
  }

  /**
   * The way the racks' fronts face, on the floor (x, z): the room's "front"
   * is where an operator stands to work on them (FEEDBACK-7 §2.1). Set by
   * the engine from the racks.
   */
  front = new THREE.Vector2(0, -1);

  /** The horizontal unit vector to the right of someone facing the fronts. */
  rightOfFront(): THREE.Vector2 {
    return new THREE.Vector2(this.front.y, -this.front.x);
  }

  /** From the room's centre toward the camera, for a named view. */
  presetDirection(name: Preset): THREE.Vector3 {
    const f = this.front,
      r = this.rightOfFront();
    const flat = (x: number, z: number, downDeg: number) => {
      const h = new THREE.Vector2(x, z).normalize();
      const a = (downDeg * Math.PI) / 180;
      return new THREE.Vector3(
        h.x * Math.cos(a),
        Math.sin(a),
        h.y * Math.cos(a),
      );
    };
    switch (name) {
      case "back":
        return flat(-f.x, -f.y, 18);
      case "right":
        return flat(r.x, r.y, 18);
      case "left":
        return flat(-r.x, -r.y, 18);
      case "front":
        return flat(f.x, f.y, 18);
      default:
        // The default view: the racks' fronts from above the shelf side,
        // about 40° down, a little from the side.
        return flat(f.x - 0.3 * r.x, f.y - 0.3 * r.y, 40);
    }
  }

  preset(name: Preset) {
    const r = this.room,
      cx = (r.x0 + r.x1) / 2,
      cz = (r.z0 + r.z1) / 2;
    if (name === "top" || name === "bottom") {
      // «bottom» (Ctrl+7) is the plan turned 180°: under the floor there is
      // nothing to see.
      // A plan is read in orthographic projection.
      this.go({
        position: [cx, 12000, cz + (name === "top" ? 1 : -1)],
        target: [cx, 0, cz],
        fov: 45,
        ortho: true,
        halfHeight:
          this.fitHalfHeight((r.x1 - r.x0) / 2, (r.z1 - r.z0) / 2) * 1.12,
      });
      return;
    }
    const tg = new THREE.Vector3(cx, this.roomHeight * 0.35, cz);
    const radius = 0.5 * Math.hypot(r.x1 - r.x0, this.roomHeight, r.z1 - r.z0);
    const d = this.presetDirection(name);
    this.go({
      position: tg
        .clone()
        .addScaledVector(d, this.fitDistance(radius) * 0.92)
        .toArray() as [number, number, number],
      target: tg.toArray() as [number, number, number],
      fov: 45,
      ortho: name === "iso" ? false : this.isOrtho,
      halfHeight: this.fitHalfHeight(radius, radius * 0.8),
    });
  }

  /** Bring a point and its surroundings into view, keeping the direction. */
  focus(c: THREE.Vector3, radius: number, dir?: THREE.Vector3) {
    const d = (dir ?? this.cam.position.clone().sub(this.controls.target))
      .clone()
      .normalize();
    if (d.y < 0.12) {
      d.y = 0.12;
      d.normalize();
    }
    const dist = clamp(this.fitDistance(radius) * 1.15, 600, 20000);
    this.go(
      {
        position: c.clone().addScaledVector(d, dist).toArray() as [
          number,
          number,
          number,
        ],
        target: c.toArray() as [number, number, number],
        fov: this.persp.fov,
        ortho: this.isOrtho,
        halfHeight: this.fitHalfHeight(radius, radius) * 1.15,
      },
      600,
    );
  }

  /**
   * Keep the target near the room. The camera moves by the same amount, so
   * this pans and never turns the view (a zoom out from a top view used to
   * pull the target below the floor and tilt the plan).
   */
  private clampTarget() {
    const t = this.controls.target,
      r = this.room;
    const before = t.clone();
    t.x = clamp(t.x, r.x0 - 2000, r.x1 + 2000);
    t.y = clamp(t.y, 0, this.roomHeight + 600);
    t.z = clamp(t.z, r.z0 - 2000, r.z1 + 2000);
    const d = t.clone().sub(before);
    if (d.lengthSq() > 0) this.cam.position.add(d);
  }

  /** Zoom by factor `s` toward `pivot` (the surface under the cursor). */
  zoomAt(ndcX: number, ndcY: number, s: number, pivot: THREE.Vector3 | null) {
    this.tween = null;
    if (this.walk.on) {
      this.persp.fov = clamp(this.persp.fov * s, 25, 95);
      this.persp.updateProjectionMatrix();
      return;
    }
    const tg = this.controls.target;
    if (this.isOrtho) {
      const z0 = this.ortho.zoom,
        z1 = clamp(z0 / s, 0.05, 40);
      if (z1 === z0) return;
      const a = new THREE.Vector3(ndcX, ndcY, 0).unproject(this.ortho);
      const b = new THREE.Vector3(0, 0, 0).unproject(this.ortho);
      const shift = a.sub(b).multiplyScalar(1 - z0 / z1);
      this.ortho.zoom = z1;
      this.ortho.updateProjectionMatrix();
      this.ortho.position.add(shift);
      tg.add(shift);
    } else {
      const d = this.persp.position.distanceTo(tg);
      const nd = clamp(
          d * s,
          this.controls.minDistance,
          this.controls.maxDistance,
        ),
        k = nd / d;
      if (k === 1) return;
      const pv = pivot ?? tg.clone();
      this.persp.position.sub(pv).multiplyScalar(k).add(pv);
      tg.sub(pv).multiplyScalar(k).add(pv);
      if (this.persp.position.y < 60) this.persp.position.y = 60;
    }
    this.clampTarget();
  }

  // --- Walk ---

  private blocked(x: number, z: number) {
    const R = 170,
      r = this.room;
    if (x < r.x0 + R || x > r.x1 - R || z < r.z0 + R || z > r.z1 - R)
      return true;
    return this.obstacles.some(
      (b) => x > b.x0 - R && x < b.x1 + R && z > b.z0 - R && z < b.z1 + R,
    );
  }

  nearestFree(x: number, z: number) {
    if (!this.blocked(x, z)) return { x, z };
    for (let rad = 100; rad < 5000; rad += 100)
      for (let a = 0; a < 16; a++) {
        const nx = x + Math.cos((a * Math.PI) / 8) * rad,
          nz = z + Math.sin((a * Math.PI) / 8) * rad;
        if (!this.blocked(nx, nz)) return { x: nx, z: nz };
      }
    return { x, z };
  }

  setWalk(on: boolean, silent = false) {
    if (on === this.walk.on) return;
    this.tween = null;
    const w = this.walk;
    if (on) {
      if (this.isOrtho) this.setOrtho(false);
      w.saved = this.view();
      w.on = true;
      this.controls.enabled = false;
      w.fov0 = this.persp.fov;
      this.persp.fov = 68;
      this.persp.updateProjectionMatrix();
      const start = this.nearestFree(
        this.controls.target.x,
        this.controls.target.z,
      );
      w.pos.set(start.x, 1650, start.z);
      w.goto = null;
    } else {
      w.on = false;
      this.controls.enabled = true;
      this.persp.fov = w.fov0;
      this.persp.updateProjectionMatrix();
      const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
      this.controls.target.copy(w.pos).addScaledVector(fwd, 1500);
      this.controls.target.y = 1000;
      this.persp.position.copy(w.pos);
      if (!silent && w.saved) this.go({ ...w.saved, ortho: false }, 600);
    }
    this.onChange();
  }

  look(dx: number, dy: number) {
    this.walk.yaw -= dx * 0.0042;
    this.walk.pitch = clamp(this.walk.pitch - dy * 0.0042, -1.35, 1.35);
  }

  walkTo(x: number, z: number) {
    this.walk.goto = this.nearestFree(x, z);
  }

  private tickWalk(dt: number) {
    const held = this.held,
      w = this.walk;
    const sp =
      (held.has("ShiftLeft") || held.has("ShiftRight") ? 3300 : 1500) * dt;
    const turn = 1.7 * dt;
    if (held.has("KeyQ") || held.has("ArrowLeft")) w.yaw += turn;
    if (held.has("KeyE") || held.has("ArrowRight")) w.yaw -= turn;
    const sn = Math.sin(w.yaw),
      cs = Math.cos(w.yaw);
    const f =
      (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) -
      (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0);
    const sd = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
    let fx = 0,
      fz = 0;
    if (f || sd) {
      w.goto = null;
      fx = (-sn * f + cs * sd) * sp;
      fz = (-cs * f - sn * sd) * sp;
    } else if (w.goto) {
      const dx = w.goto.x - w.pos.x,
        dz = w.goto.z - w.pos.z,
        d = Math.hypot(dx, dz);
      if (d < 40) w.goto = null;
      else {
        const st = Math.min(d, 2600 * dt);
        fx = (dx / d) * st;
        fz = (dz / d) * st;
      }
    }
    if (fx || fz) {
      let moved = false;
      if (!this.blocked(w.pos.x + fx, w.pos.z)) {
        w.pos.x += fx;
        moved = true;
      }
      if (!this.blocked(w.pos.x, w.pos.z + fz)) {
        w.pos.z += fz;
        moved = true;
      }
      if (!moved) w.goto = null;
    }
    this.persp.position.copy(w.pos);
    this.persp.rotation.set(w.pitch, w.yaw, 0, "YXZ");
  }

  /** Arrow keys pan along the floor (when nothing is being moved). */
  private tickPan(dt: number) {
    const held = this.held;
    const dx =
      (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
    const dz = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
    if (!dx && !dz) return false;
    this.tween = null;
    const e = this.cam.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], 0, e[2]).normalize();
    const fwd = new THREE.Vector3(-e[8], 0, -e[10]);
    if (fwd.lengthSq() < 0.01) fwd.set(e[4], 0, e[6]);
    fwd.normalize();
    const sp =
      (this.isOrtho
        ? (this.ortho.top / this.ortho.zoom) * 1.4
        : this.persp.position.distanceTo(this.controls.target) * 0.9) * dt;
    right.multiplyScalar(dx * sp).addScaledVector(fwd, dz * sp);
    this.cam.position.add(right);
    this.controls.target.add(right);
    this.clampTarget();
    return true;
  }

  /** Advance one frame; true while something is still moving. */
  update(now: number, dt: number, panEnabled: boolean): boolean {
    let moving = false;
    const t = this.tween;
    if (t) {
      const k = t.dur ? Math.min(1, (now - t.t0) / t.dur) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.cam.position.lerpVectors(t.p0, t.p1, e);
      this.controls.target.lerpVectors(t.g0, t.g1, e);
      this.off = {
        x: Math.round(t.o0.x + (t.o1.x - t.o0.x) * e),
        y: Math.round(t.o0.y + (t.o1.y - t.o0.y) * e),
      };
      this.applyOffset();
      if (this.cam === this.persp) {
        this.persp.fov = t.f0 + (t.f1 - t.f0) * e;
        this.persp.updateProjectionMatrix();
      } else this.setOrthoFrustum(t.h0 + (t.h1 - t.h0) * e);
      if (k >= 1) this.tween = null;
      moving = true;
    }
    if (this.walk.on) {
      this.tickWalk(dt);
      moving = true;
    } else {
      if (panEnabled && this.tickPan(dt)) moving = true;
      if (this.controls.update()) moving = true;
    }
    this.cam.updateMatrixWorld();
    return moving;
  }

  dispose() {
    this.controls.dispose();
  }
}
