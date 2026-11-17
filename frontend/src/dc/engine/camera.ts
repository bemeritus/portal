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
  "iso" | "top" | "front" | "back" | "left" | "right" | "aisle" | "racks";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class CameraRig {
  readonly persp = new THREE.PerspectiveCamera(45, 1, 20, 120000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -60000, 120000);
  readonly controls: OrbitControls;
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  private w = 1;
  private h = 1;
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
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const z = this.ortho.zoom;
    this.setOrthoFrustum(this.ortho.top);
    this.ortho.zoom = z;
    this.ortho.updateProjectionMatrix();
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
    };
  }

  preset(name: Preset) {
    const r = this.room,
      cx = (r.x0 + r.x1) / 2,
      cz = (r.z0 + r.z1) / 2,
      size = Math.max(r.x1 - r.x0, r.z1 - r.z0);
    const tg: [number, number, number] = [
      cx,
      name === "top" ? 0 : this.roomHeight * 0.4,
      cz,
    ];
    const d = size * 1.55;
    const pos: Record<Preset, [number, number, number]> = {
      iso: [cx + size * 0.1, size * 0.95, r.z1 + size * 0.95],
      top: [cx, d * 1.1, cz + 1],
      front: [cx, this.roomHeight * 0.6, r.z1 + d],
      back: [cx, this.roomHeight * 0.6, r.z0 - d],
      left: [r.x0 - d, this.roomHeight * 0.6, cz],
      right: [r.x1 + d, this.roomHeight * 0.6, cz],
      // Inside views are set by the engine, which knows the room's contents.
      aisle: [cx, this.roomHeight * 0.7, cz],
      racks: [cx, this.roomHeight * 0.6, cz],
    };
    if (name === "top") {
      // A plan is read in orthographic projection.
      this.go({
        position: pos.top,
        target: tg,
        fov: 45,
        ortho: true,
        halfHeight: size * 0.62,
      });
      return;
    }
    this.go({
      position: pos[name],
      target: tg,
      fov: 45,
      ortho: name === "iso" ? false : this.isOrtho,
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
    const dist = clamp(
      (radius / Math.sin((this.persp.fov * Math.PI) / 360)) * 1.15,
      600,
      20000,
    );
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
        halfHeight: radius * 1.25,
      },
      600,
    );
  }

  private clampTarget() {
    const t = this.controls.target,
      r = this.room;
    t.x = clamp(t.x, r.x0 - 2000, r.x1 + 2000);
    t.y = clamp(t.y, 0, this.roomHeight + 600);
    t.z = clamp(t.z, r.z0 - 2000, r.z1 + 2000);
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
