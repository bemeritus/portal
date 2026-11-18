/**
 * The view cube: six CSS-3D faces turned with the camera (`matrix3d`), as in
 * the prototype. Clicking a face flies to that view; the bottom is disabled
 * (the floor is in the way). Labels come from the caller, in the user's
 * language, via `data-dc-face` attributes resolved by the page.
 */

import type * as THREE from "three";

import type { Preset } from "./camera";

const HALF = 30;
const FACES: {
  n: [number, number, number];
  u: [number, number, number];
  preset: Preset | null;
  key: string;
}[] = [
  { n: [0, 1, 0], u: [0, 0, -1], preset: "top", key: "top" },
  { n: [0, -1, 0], u: [0, 0, 1], preset: null, key: "bottom" },
  { n: [1, 0, 0], u: [0, 1, 0], preset: "right", key: "right" },
  { n: [-1, 0, 0], u: [0, 1, 0], preset: "left", key: "left" },
  { n: [0, 0, 1], u: [0, 1, 0], preset: "front", key: "front" },
  { n: [0, 0, -1], u: [0, 1, 0], preset: "back", key: "back" },
];

export class ViewCube {
  readonly root: HTMLDivElement;
  private readonly cube: HTMLDivElement;

  constructor(host: HTMLElement, go: (p: Preset) => void) {
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
      b.dataset.dcFace = f.key;
      b.style.transform = `matrix3d(${m.join(",")})`;
      if (f.preset) {
        const p = f.preset;
        b.addEventListener("click", () => go(p));
      } else b.disabled = true;
      this.cube.appendChild(b);
    }
    host.appendChild(this.root);
  }

  /** Set the face captions (in the user's language). */
  setLabels(labels: Record<string, string>) {
    this.cube
      .querySelectorAll<HTMLButtonElement>(".dc-cube-face")
      .forEach((b) => {
        const t = labels[b.dataset.dcFace ?? ""] ?? "";
        b.textContent = t;
        b.title = t;
        b.setAttribute("aria-label", t);
      });
  }

  update(cam: THREE.Camera) {
    const e = cam.matrixWorldInverse.elements;
    this.cube.style.transform = `matrix3d(${[e[0], -e[1], e[2], 0, -e[4], e[5], -e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1].map((v) => v.toFixed(5)).join(",")})`;
  }

  dispose() {
    this.root.remove();
  }
}
