/**
 * Catalog pictures (SPEC §11.3), drawn from the same parametric templates as
 * the room — nothing is downloaded from manufacturers.
 *
 * - `thumbnail(item)`: a 3D card image at a fixed three-quarter angle,
 *   rendered by one shared offscreen renderer and cached for the session.
 * - `ItemPreview`: an interactive view of one to three items side by side at
 *   the same scale, with dimension arrows in mm, animated supply (blue) and
 *   return (red) arrows, and a scale reference — a 42U rack and a 1.75 m
 *   figure outline.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import type { CatalogItem, CoolingProps, DcObject } from "../types";
import { Labels } from "./labels";
import { MaterialLibrary } from "./materials";
import { RENDERERS } from "./renderers";
import { openings } from "./renderers/cooling";
import type { BuildContext } from "./renderers/types";
import { readTheme } from "./theme";

/** A stand-in object so a renderer can draw a catalog item on its own. */
function standIn(item: CatalogItem): DcObject {
  return {
    id: -item.id,
    catalog_id: item.id,
    name: item.model,
    x0_mm: 0,
    z0_mm: 0,
    y0_mm: 0,
    rotation_deg: 0,
    instance: {},
    contents_known: true,
    note: "",
  };
}

function build(item: CatalogItem, lib: MaterialLibrary): THREE.Group {
  const dims: [number, number, number] = [item.width_mm, Math.max(item.depth_mm, 40), item.height_mm];
  const ctx: BuildContext = { lib, mode: "realistic", devices: [], cells: [], blocked: [], dims };
  const g = RENDERERS[item.kind].build(standIn(item), item, ctx).group;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.role && !m.userData.fixedMaterial && !m.userData.device) m.material = lib.role(m.userData.role);
  });
  return g;
}

function lights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5e66, 1.1));
  const d = new THREE.DirectionalLight(0xffffff, 1.4);
  d.position.set(-2000, 4000, -3000);
  scene.add(d);
}

// --- Thumbnails ------------------------------------------------------------------

let shared: { renderer: THREE.WebGLRenderer; lib: MaterialLibrary; env: THREE.Texture } | null = null;
const cache = new Map<string, string>();

function sharedRenderer() {
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 240, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const lib = new MaterialLibrary(readTheme());
    lib.reset("realistic", readTheme());
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    shared = { renderer, lib, env };
  }
  return shared;
}

/** A PNG data URL of the item at a three-quarter angle from the front. */
export function thumbnail(item: CatalogItem): string {
  const key = `${item.id}|${item.width_mm}|${item.depth_mm}|${item.height_mm}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { renderer, lib, env } = sharedRenderer();
  const scene = new THREE.Scene();
  scene.environment = env;
  lights(scene);
  const g = build(item, lib);
  scene.add(g);
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) * 0.62;
  const cam = new THREE.PerspectiveCamera(30, 320 / 240, 10, 100000);
  // Front is −z: look from front-left, a little above.
  cam.position.copy(centre).add(new THREE.Vector3(-0.75, 0.55, -1).normalize().multiplyScalar(r / Math.tan((15 * Math.PI) / 180)));
  cam.lookAt(centre);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL("image/png");
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  cache.set(key, url);
  return url;
}

// --- Interactive preview -----------------------------------------------------------

export interface PreviewText {
  mm: (v: number) => string;
  supply: string;
  ret: string;
  rack: string;
  person: string;
}

export class ItemPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(35, 1, 10, 200000);
  private controls: OrbitControls;
  private labels: Labels;
  private lib: MaterialLibrary;
  private arrows: { mesh: THREE.Object3D; from: THREE.Vector3; dir: THREE.Vector3; len: number }[] = [];
  private raf = 0;
  private ro: ResizeObserver;
  private readonly reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private host: HTMLElement,
    items: CatalogItem[],
    text: PreviewText,
  ) {
    const theme = readTheme();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(theme.background);
    this.lib = new MaterialLibrary(theme);
    this.lib.reset("realistic", theme);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    lights(this.scene);
    this.labels = new Labels(host);
    this.controls = new OrbitControls(this.cam, this.renderer.domElement);
    this.controls.enableDamping = true;

    // Items side by side, same scale, then the scale references.
    let x = 0;
    const gap = 600;
    for (const item of items) {
      const g = build(item, this.lib);
      const w = item.width_mm,
        h = item.height_mm,
        d = Math.max(item.depth_mm, 40);
      g.position.set(x + w / 2, item.kind === "cooling" && (item.props as CoolingProps).subtype === "split_cassette" ? 2400 - h : 0, 0);
      this.scene.add(g);
      this.dimensions(g.position, w, d, h, text, theme.dim, `${item.id}`);
      if (item.kind === "cooling") this.airflow(item, g.position, text);
      x += w + gap;
    }
    // A 42U rack outline and a 1.75 m figure.
    const rackW = 600,
      rackD = 1000,
      rackH = 2040;
    const rack = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(rackW, rackH, rackD)), new THREE.LineBasicMaterial({ color: theme.inkMuted }));
    rack.position.set(x + rackW / 2, rackH / 2, 0);
    this.scene.add(rack);
    this.labels.set(`ref:rack`, text.rack, new THREE.Vector3(x + rackW / 2, rackH + 120, 0), { kind: "dim", always: true, priority: 3 });
    x += rackW + gap;
    this.scene.add(this.figure(x + 250, theme.inkMuted));
    this.labels.set(`ref:person`, text.person, new THREE.Vector3(x + 250, 1880, 0), { kind: "dim", always: true, priority: 3 });
    x += 500;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x + 4000, 6000), new THREE.MeshStandardMaterial({ color: theme.floor, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x / 2, -1, 0);
    this.scene.add(floor);

    // Frame the whole line-up from the front-left, a little above.
    this.span = Math.max(x, 2500);
    this.centreX = x / 2;
    this.controls.target.set(x / 2, 900, 0);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.loop();
  }

  private dimensions(at: THREE.Vector3, w: number, d: number, h: number, text: PreviewText, color: string, key: string) {
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const add = (a: THREE.Vector3, b: THREE.Vector3, label: string, k: string) => {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
      line.renderOrder = 999;
      this.scene.add(line);
      for (const p of [a, b]) {
        const tick = new THREE.Mesh(new THREE.SphereGeometry(12, 8, 6), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        tick.position.copy(p);
        tick.renderOrder = 999;
        this.scene.add(tick);
      }
      this.labels.set(`dim:${key}:${k}`, label, a.clone().add(b).multiplyScalar(0.5), { kind: "dim", always: true, priority: 9 });
    };
    const x0 = at.x - w / 2,
      x1 = at.x + w / 2,
      z0 = -d / 2,
      z1 = d / 2,
      y0 = at.y,
      y1 = at.y + h;
    add(new THREE.Vector3(x0, y0, z0 - 150), new THREE.Vector3(x1, y0, z0 - 150), text.mm(w), "w");
    add(new THREE.Vector3(x1 + 150, y0, z0), new THREE.Vector3(x1 + 150, y0, z1), text.mm(d), "d");
    add(new THREE.Vector3(x0 - 150, y0, z0), new THREE.Vector3(x0 - 150, y1, z0), text.mm(h), "h");
  }

  private airflow(item: CatalogItem, at: THREE.Vector3, text: PreviewText) {
    const p = item.props as CoolingProps;
    const dims: [number, number, number] = [item.width_mm, item.depth_mm, item.height_mm];
    for (const o of openings(p.subtype, dims, p.discharge_options[0] ?? null)) {
      const color = o.role === "supply" ? 0x3d8bff : 0xff5a4d;
      const len = 500;
      for (let k = 0; k < 3; k++) {
        const arrow = new THREE.ArrowHelper(o.dir, new THREE.Vector3(), len * 0.6, color, 120, 70);
        const from = at.clone().add(o.at).add(new THREE.Vector3((k - 1) * o.size[0] * 0.3, 0, 0));
        // Return arrows arrive at the opening; supply arrows leave it.
        const start = o.role === "return" ? from.clone().addScaledVector(o.dir, -len) : from;
        arrow.position.copy(start);
        this.scene.add(arrow);
        this.arrows.push({ mesh: arrow, from: start, dir: o.dir.clone(), len });
      }
      this.labels.set(`air:${item.id}:${o.role}:${o.at.x}:${o.at.y}:${o.at.z}`, o.role === "supply" ? text.supply : text.ret, at.clone().add(o.at).addScaledVector(o.dir, o.role === "supply" ? len : -len), {
        kind: "note",
        always: true,
        priority: 4,
      });
    }
  }

  private figure(x: number, color: string): THREE.Object3D {
    // A 1.75 m person as a line drawing: head, body, arms, legs.
    const h = 1750,
      g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color });
    const head = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 25 }, (_, i) => new THREE.Vector3(Math.cos((i / 24) * Math.PI * 2) * 110, h - 110 + Math.sin((i / 24) * Math.PI * 2) * 110, 0))),
      mat,
    );
    const seg = (pts: number[][]) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([a, b]) => new THREE.Vector3(a, b, 0))), mat);
    g.add(head, seg([[0, h - 220], [0, 850]]), seg([[-250, 1150], [0, h - 380], [250, 1150]]), seg([[-180, 0], [0, 850], [180, 0]]));
    g.position.set(x, 0, 0);
    return g;
  }

  private span = 2500;
  private centreX = 0;
  private framed = false;

  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    if (!this.framed) {
      this.framed = true;
      // Distance at which the span fits the width, with a margin.
      const half = Math.tan((this.cam.fov * Math.PI) / 360);
      const dist = (this.span / 2 / (half * this.cam.aspect)) * 1.25;
      this.cam.position.set(this.centreX + dist * 0.25, dist * 0.45 + 900, -dist);
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const t = performance.now() / 1000;
    if (!this.reduced)
      for (const [i, a] of this.arrows.entries()) {
        const k = (t * 0.6 + (i % 3) / 3) % 1;
        a.mesh.position.copy(a.from).addScaledVector(a.dir, a.len * 0.4 * k);
      }
    this.controls.update();
    this.renderer.render(this.scene, this.cam);
    this.labels.update(this.cam, this.host.clientWidth, this.host.clientHeight);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.lib.dispose();
    this.labels.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
