/**
 * The view cube (FEEDBACK-7 §2.3): six CSS-3D faces turned with the camera
 * (`matrix3d`) and drawn without perspective — its own orthographic view, as
 * Blender's gizmo is — so its shape never depends on the scene's projection.
 * The face names are not printed on the faces, where a face seen at a
 * grazing angle squashes its text into a line: each name stands upright at
 * its face's centre and fades out as the face turns away. The box is large
 * enough for the cube at any angle, so it never touches the viewport's edge.
 *
 * The faces are named after the room, not the screen: «Фронт стоек» is the
 * side the racks' fronts face (`setFront`), «Тыл стоек» the opposite one.
 * Clicking a face's middle flies to that view; near its edge or corner,
 * from that edge or corner. The bottom is disabled (the floor is in the way).
 */

import type * as THREE from "three";

import type { Preset } from "./camera";

/** Half the cube's edge, px. */
const HALF = 26;
/** Beyond this share of the face's half-width, a click means its edge. */
const EDGE = 0.55;
/** World axes of the faces. */
const FACES: {
  axis: string;
  n: [number, number, number];
  u: [number, number, number];
}[] = [
  { axis: "+y", n: [0, 1, 0], u: [0, 0, -1] },
  { axis: "-y", n: [0, -1, 0], u: [0, 0, 1] },
  { axis: "+x", n: [1, 0, 0], u: [0, 1, 0] },
  { axis: "-x", n: [-1, 0, 0], u: [0, 1, 0] },
  { axis: "+z", n: [0, 0, 1], u: [0, 1, 0] },
  { axis: "-z", n: [0, 0, -1], u: [0, 1, 0] },
];

type Key = "top" | "bottom" | "front" | "back" | "left" | "right";

export class ViewCube {
  readonly root: HTMLDivElement;
  private readonly cube: HTMLDivElement;
  private readonly faces = new Map<string, HTMLButtonElement>();
  private readonly names = new Map<string, HTMLSpanElement>();
  /** World axis → what the face is called in this room. */
  private keyOf = new Map<string, Key>([
    ["+y", "top"],
    ["-y", "bottom"],
    ["-z", "front"],
    ["+z", "back"],
    ["-x", "right"],
    ["+x", "left"],
  ]);
  private labels: Record<string, string> = {};

  constructor(
    host: HTMLElement,
    private readonly go: (p: Preset) => void,
    goDir: (dir: [number, number, number]) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "dc-cube-wrap";
    this.cube = document.createElement("div");
    this.cube.className = "dc-cube";
    this.root.appendChild(this.cube);
    for (const f of FACES) {
      const [n, u] = [f.n, f.u];
      const r = [
        u[1] * n[2] - u[2] * n[1],
        u[2] * n[0] - u[0] * n[2],
        u[0] * n[1] - u[1] * n[0],
      ];
      const m = [
        r[0],
        -r[1],
        r[2],
        0,
        -u[0],
        u[1],
        -u[2],
        0,
        n[0],
        -n[1],
        n[2],
        0,
        n[0] * HALF,
        -n[1] * HALF,
        n[2] * HALF,
        1,
      ];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dc-cube-face";
      b.dataset.axis = f.axis;
      b.style.transform = `matrix3d(${m.join(",")})`;
      if (f.axis !== "-y") {
        b.addEventListener("click", (ev) => {
          // Where on the face: −1…1 across (r) and up (u); a keyboard
          // click (no pointer) means the face itself.
          const pointer = ev.detail > 0;
          const sx = pointer ? (ev.offsetX / b.offsetWidth) * 2 - 1 : 0;
          const sy = pointer ? 1 - (ev.offsetY / b.offsetHeight) * 2 : 0;
          const ex = Math.abs(sx) > EDGE ? Math.sign(sx) : 0,
            ey = Math.abs(sy) > EDGE ? Math.sign(sy) : 0;
          if (!ex && !ey) return this.go(this.keyOf.get(f.axis)! as Preset);
          goDir([
            n[0] + ex * r[0] + ey * u[0],
            n[1] + ex * r[1] + ey * u[1],
            n[2] + ex * r[2] + ey * u[2],
          ]);
        });
      } else b.disabled = true;
      this.cube.appendChild(b);
      this.faces.set(f.axis, b);
      const name = document.createElement("span");
      name.className = "dc-cube-name";
      name.setAttribute("aria-hidden", "true");
      this.root.appendChild(name);
      this.names.set(f.axis, name);
    }
    host.appendChild(this.root);
  }

  /** The racks' fronts face `front` (x, z): that side is «Фронт стоек». */
  setFront(front: { x: number; y: number }) {
    const fx = Math.round(front.x),
      fz = Math.round(front.y);
    if (Math.abs(fx) + Math.abs(fz) !== 1) return;
    const axis = (x: number, z: number) =>
      x ? (x > 0 ? "+x" : "-x") : z > 0 ? "+z" : "-z";
    // Facing the fronts, the right hand is (fz, −fx).
    this.keyOf = new Map<string, Key>([
      ["+y", "top"],
      ["-y", "bottom"],
      [axis(fx, fz), "front"],
      [axis(-fx, -fz), "back"],
      [axis(fz, -fx), "right"],
      [axis(-fz, fx), "left"],
    ]);
    this.setLabels(this.labels);
  }

  /** Set the face captions (in the user's language), by face key. */
  setLabels(labels: Record<string, string>) {
    this.labels = labels;
    for (const [axis, b] of this.faces) {
      const key = this.keyOf.get(axis)!;
      const t = labels[key] ?? "";
      b.dataset.dcFace = key;
      b.title = t;
      b.setAttribute("aria-label", t);
      this.names.get(axis)!.textContent = t;
      this.names.get(axis)!.dataset.dcFace = key;
    }
  }

  update(cam: THREE.Camera) {
    const e = cam.matrixWorldInverse.elements;
    this.cube.style.transform = `matrix3d(${[e[0], -e[1], e[2], 0, -e[4], e[5], -e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1].map((v) => v.toFixed(5)).join(",")})`;
    // Each name at its face's centre, upright; shown while the face looks
    // at the camera.
    for (const f of FACES) {
      const [x, y, z] = f.n;
      const vx = e[0] * x + e[4] * y + e[8] * z,
        vy = e[1] * x + e[5] * y + e[9] * z,
        vz = e[2] * x + e[6] * y + e[10] * z;
      const el = this.names.get(f.axis)!;
      const k = Math.max(0, Math.min(1, (vz - 0.25) / 0.35));
      el.style.opacity = k.toFixed(2);
      el.style.visibility = k > 0 ? "visible" : "hidden";
      el.style.transform = `translate(-50%, -50%) translate(${(vx * HALF).toFixed(1)}px, ${(-vy * HALF).toFixed(1)}px)`;
    }
  }

  dispose() {
    this.root.remove();
  }
}
