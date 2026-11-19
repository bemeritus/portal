/**
 * The catalog's picture studio (FEEDBACK-4 §2): how an item is looked at
 * and lit for its card and its page.
 *
 * - `viewDirection`: a front-dominant three-quarter view — the front turned
 *   30° from the camera, 17° from above; ceiling units from slightly below.
 * - `frameBox`: the camera distance and target that fit a box into the
 *   frame with the same margin for every item, whatever its proportions.
 * - `Studio`: ACES tone mapping and sRGB output, a PMREM environment from
 *   three's procedural room, one key and one rim light, a soft contact
 *   shadow, and a backdrop gradient from the theme's tokens.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import type { CatalogItem } from "../types";
import type { DcTokens } from "../theme/tokens";

const DEG = Math.PI / 180;

/** Items hung under a ceiling are shown from slightly below. */
export function seenFromBelow(item: CatalogItem): boolean {
  return item.kind === "cooling" && item.props.subtype === "split_cassette";
}

/**
 * Where the camera looks from (a unit vector from the item's centre): the
 * front (−z) turned `turn`° towards the item's left, `elevation`° above —
 * or below for ceiling units.
 */
export function viewDirection(
  item: CatalogItem,
  turn = 30,
  elevation = 17,
): THREE.Vector3 {
  const e = (seenFromBelow(item) ? -12 : elevation) * DEG;
  const a = turn * DEG;
  return new THREE.Vector3(
    -Math.sin(a) * Math.cos(e),
    Math.sin(e),
    -Math.cos(a) * Math.cos(e),
  ).normalize();
}

/** The item's box in its own frame: footprint centred, y from 0 (mm). */
export function itemBox(item: CatalogItem): THREE.Box3 {
  const w = item.width_mm,
    d = Math.max(item.depth_mm, 40),
    h = item.height_mm;
  return new THREE.Box3(
    new THREE.Vector3(-w / 2, 0, -d / 2),
    new THREE.Vector3(w / 2, h, d / 2),
  );
}

export interface Framing {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** Screen pixels per millimetre at the target, for `viewHeightPx` pixels. */
  pxPerMm: number;
}

/**
 * Fit `box` into a perspective view from `dir` so that its projection
 * leaves `margin` (a fraction of the frame) free on the tightest side, and
 * sits centred. Two passes: fit about the box centre, then re-centre on the
 * projected box and fit again.
 */
export function frameBox(
  box: THREE.Box3,
  dir: THREE.Vector3,
  fovDeg: number,
  aspect: number,
  margin = 0.1,
  viewHeightPx = 1,
): Framing {
  const f = dir.clone().negate().normalize();
  const worldUp =
    Math.abs(f.y) > 0.99
      ? new THREE.Vector3(0, 0, -1)
      : new THREE.Vector3(0, 1, 0);
  const r = new THREE.Vector3().crossVectors(f, worldUp).normalize();
  const u = new THREE.Vector3().crossVectors(r, f).normalize();
  const tanY = Math.tan((fovDeg * DEG) / 2) * (1 - 2 * margin);
  const tanX = tanY * aspect;
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z])
        corners.push(new THREE.Vector3(x, y, z));

  let target = box.getCenter(new THREE.Vector3());
  let dist = 0;
  for (let pass = 0; pass < 2; pass++) {
    // The distance at which every corner is inside the frame.
    dist = 0;
    for (const c of corners) {
      const p = c.clone().sub(target);
      const z = p.dot(f);
      dist = Math.max(
        dist,
        Math.abs(p.dot(r)) / tanX - z,
        Math.abs(p.dot(u)) / tanY - z,
      );
    }
    if (pass === 1) break;
    // Re-centre on the projected box (perspective makes it lopsided).
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const c of corners) {
      const p = c.clone().sub(target);
      const depth = dist + p.dot(f);
      const sx = p.dot(r) / depth,
        sy = p.dot(u) / depth;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    target = target
      .clone()
      .addScaledVector(r, ((x0 + x1) / 2) * dist)
      .addScaledVector(u, ((y0 + y1) / 2) * dist);
  }
  const position = target.clone().addScaledVector(f, -dist);
  const pxPerMm = viewHeightPx / 2 / (dist * Math.tan((fovDeg * DEG) / 2));
  return { position, target, pxPerMm };
}

/** A vertical gradient canvas from the theme's preview tokens. */
function backdrop(tokens: DcTokens): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, tokens.preview[0]);
  grad.addColorStop(1, tokens.preview[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round shadow texture: dark in the middle, clear at the edge. */
function blob(): THREE.Texture {
  const n = 128;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  return new THREE.CanvasTexture(c);
}

/** Tone mapping, output and shadows for a renderer that draws previews. */
export function setupRenderer(r: THREE.WebGLRenderer) {
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
}

/**
 * Lights, environment, contact shadow and backdrop for one item. The item
 * goes into `stage`; `place()` sizes the lights and the shadow to it.
 */
export class Studio {
  readonly scene = new THREE.Scene();
  readonly stage = new THREE.Group();
  private readonly key: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly shadow: THREE.Mesh;
  private readonly contact: THREE.Mesh;
  private env: THREE.Texture;
  private bg: THREE.Texture | null = null;

  constructor(renderer: THREE.WebGLRenderer, tokens: DcTokens) {
    const pm = new THREE.PMREMGenerator(renderer);
    this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.75;
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0004;
    this.rim = new THREE.DirectionalLight(0xdfe8ff, 1.4);
    this.scene.add(this.key, this.key.target, this.rim, this.rim.target);
    // The floor itself is invisible: only the shadows show on it.
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.receiveShadow = true;
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: blob(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.5;
    this.scene.add(this.shadow, this.contact, this.stage);
    this.setTheme(tokens);
  }

  setTheme(tokens: DcTokens) {
    this.bg?.dispose();
    this.bg = backdrop(tokens);
    this.scene.background = this.bg;
    // Shadows read darker on a light ground than on a dark one.
    (this.shadow.material as THREE.ShadowMaterial).opacity = tokens.dark
      ? 0.35
      : 0.2;
  }

  /**
   * Size the lights, the shadow camera and the contact shadow to `box`,
   * with the key light from over the camera's left shoulder and the rim
   * light from behind on the right.
   */
  place(box: THREE.Box3, dir: THREE.Vector3, floating: boolean) {
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const reach = size.length() * 1.5 + 500;
    const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
    this.key.position
      .copy(centre)
      .addScaledVector(dir, reach * 0.6)
      .addScaledVector(side, -reach * 0.5)
      .add(new THREE.Vector3(0, reach, 0));
    this.key.target.position.copy(centre);
    const cam = this.key.shadow.camera;
    const half = Math.max(size.x, size.z, size.y) * 0.9 + 300;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.near = 10;
    cam.far = reach * 4;
    cam.updateProjectionMatrix();
    this.rim.position
      .copy(centre)
      .addScaledVector(dir, -reach)
      .addScaledVector(side, reach * 0.6)
      .add(new THREE.Vector3(0, reach * 0.4, 0));
    this.rim.target.position.copy(centre);
    const ground = floating ? box.min.y - 600 : box.min.y;
    this.shadow.position.set(centre.x, ground, centre.z);
    this.shadow.scale.set(half * 6, half * 6, 1);
    // The contact shadow: just under the footprint, a little wider.
    this.contact.visible = !floating;
    this.contact.position.set(centre.x, ground + 0.5, centre.z);
    this.contact.scale.set(size.x * 1.5 + 200, size.z * 1.5 + 200, 1);
  }

  dispose() {
    this.env.dispose();
    this.bg?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
  }
}
