/**
 * Catalog pictures (SPEC §11.3, FEEDBACK-4 §2), drawn from the same
 * parametric templates as the room — nothing is downloaded from
 * manufacturers.
 *
 * - `thumbnail(item, tokens, size)`: the card image. One shared offscreen
 *   renderer draws the cards one after another; each image is cached for
 *   the session by item, props, theme and size, so scrolling or re-rendering
 *   the page never draws a scene again.
 * - `ItemViewer`: the item page's 3D view — 3D / front / side / top, CAD
 *   dimensions with extension lines in the user's unit, supply (blue) and
 *   return (red) arrows from the item's openings, and a 42U rack beside it
 *   for scale; drag turns, the wheel zooms, F frames.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CatalogItem, CoolingProps, DcObject } from "../types";
import { Labels } from "./labels";
import { MaterialLibrary } from "./materials";
import { mergeStatic } from "./merge";
import { RENDERERS } from "./renderers";
import { openings } from "./renderers/cooling";
import type { BuildContext } from "./renderers/types";
import {
  frameBox,
  itemBox,
  setupRenderer,
  Studio,
  viewDirection,
} from "./studio";
import { themeFromTokens } from "./theme";
import type { DcTokens } from "../theme/tokens";

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

/** Items that hang on a wall or under a ceiling: no contact shadow. */
function floating(item: CatalogItem): boolean {
  return (
    item.kind === "cooling" &&
    ["split_wall", "split_cassette", "ducted"].includes(item.props.subtype)
  );
}

/** The item as the room draws it, at full detail, merged per material. */
function build(
  item: CatalogItem,
  lib: MaterialLibrary,
  pxPerMm: number | null,
): THREE.Group {
  const ctx: BuildContext = {
    lib,
    mode: "realistic",
    devices: [],
    cells: [],
    blocked: [],
    dims: [item.width_mm, Math.max(item.depth_mm, 40), item.height_mm],
    ceilingAbove: 0,
    detail: 2,
    pxPerMm,
  };
  const g = RENDERERS[item.kind].build(standIn(item), item, ctx).group;
  mergeStatic(g);
  return g;
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}

/** A short, stable hash of what a card's picture depends on. */
function hashItem(item: CatalogItem): string {
  const s = JSON.stringify([
    item.kind,
    item.width_mm,
    item.depth_mm,
    item.height_mm,
    item.props,
  ]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// --- Thumbnails ------------------------------------------------------------------

export interface ThumbSize {
  /** CSS pixels. */
  w: number;
  h: number;
  /** Device pixel ratio, at most 2. */
  dpr: number;
}

let shared: {
  renderer: THREE.WebGLRenderer;
  studio: Studio;
  theme: string;
  lib: MaterialLibrary;
} | null = null;
const cache = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

/** The key a card's picture is cached under. */
export function thumbKey(item: CatalogItem, tokens: DcTokens, s: ThumbSize) {
  return `${item.id}|${hashItem(item)}|${tokens.name}|${s.w}x${s.h}@${s.dpr}`;
}

/** A cached picture, if this card was drawn before in this session. */
export function cachedThumbnail(
  item: CatalogItem,
  tokens: DcTokens,
  s: ThumbSize,
): string | null {
  return cache.get(thumbKey(item, tokens, s)) ?? null;
}

function draw(item: CatalogItem, tokens: DcTokens, s: ThumbSize): string {
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    setupRenderer(renderer);
    const studio = new Studio(renderer, tokens);
    const lib = new MaterialLibrary(themeFromTokens(tokens));
    lib.reset("realistic", themeFromTokens(tokens));
    shared = { renderer, studio, theme: tokens.name, lib };
  }
  const { renderer, studio } = shared;
  if (shared.theme !== tokens.name) {
    studio.setTheme(tokens);
    shared.lib.reset("realistic", themeFromTokens(tokens));
    shared.theme = tokens.name;
  }
  const W = Math.round(s.w * s.dpr),
    H = Math.round(s.h * s.dpr);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  const fov = 24;
  const box = itemBox(item);
  const dir = viewDirection(item);
  const f = frameBox(box, dir, fov, W / H, 0.1, H);
  const g = build(item, shared.lib, f.pxPerMm);
  studio.stage.add(g);
  studio.place(box, dir, floating(item));
  const cam = new THREE.PerspectiveCamera(fov, W / H, 10, 200000);
  cam.position.copy(f.position);
  cam.lookAt(f.target);
  renderer.render(studio.scene, cam);
  const url = renderer.domElement.toDataURL("image/jpeg", 0.9);
  studio.stage.remove(g);
  disposeGroup(g);
  return url;
}

/**
 * The card picture of `item`: from the cache, or drawn after the pictures
 * already asked for — one at a time, yielding to the page between them.
 */
export function thumbnail(
  item: CatalogItem,
  tokens: DcTokens,
  s: ThumbSize,
): Promise<string> {
  const key = thumbKey(item, tokens, s);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(
    () =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() => {
          const again = cache.get(key);
          if (again) return resolve(again);
          const url = draw(item, tokens, s);
          cache.set(key, url);
          resolve(url);
        }),
      ),
  );
  queue = job.catch(() => undefined);
  return job;
}

// --- The item page's viewer ------------------------------------------------------------

export type ViewName = "3d" | "front" | "side" | "top";

export interface ViewerText {
  /** A length in the user's unit, with its unit word. */
  mm: (v: number) => string;
  /** The rack shown for scale. */
  rack: string;
}

export interface ViewerToggles {
  dims: boolean;
  airflow: boolean;
  rack: boolean;
}

/** A 42U rack's outer size, mm (the room's racks). */
const RACK = { w: 600, d: 1000, h: 2040 };

export class ItemViewer {
  private renderer: THREE.WebGLRenderer;
  private studio: Studio;
  private lib: MaterialLibrary;
  private cam = new THREE.PerspectiveCamera(24, 1, 10, 200000);
  private controls: OrbitControls;
  private labels: Labels;
  private item: THREE.Group;
  private box: THREE.Box3;
  private dims = new THREE.Group();
  private air = new THREE.Group();
  private rack = new THREE.Group();
  private arrows: {
    mesh: THREE.Object3D;
    from: THREE.Vector3;
    dir: THREE.Vector3;
    len: number;
  }[] = [];
  private raf = 0;
  private ro: ResizeObserver;
  private view: ViewName = "3d";
  private readonly reduced =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private host: HTMLElement,
    private catalogItem: CatalogItem,
    private text: ViewerText,
    tokens: DcTokens,
    private toggles: ViewerToggles,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    setupRenderer(this.renderer);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);
    this.studio = new Studio(this.renderer, tokens);
    this.lib = new MaterialLibrary(themeFromTokens(tokens));
    this.lib.reset("realistic", themeFromTokens(tokens));
    this.labels = new Labels(host);
    this.box = itemBox(catalogItem);
    // The perforation pitch for the view's scale (frame first, then build).
    const h = Math.max(1, host.clientHeight);
    const f = frameBox(
      this.box,
      viewDirection(catalogItem),
      24,
      host.clientWidth / h || 1,
      0.14,
      h,
    );
    this.item = build(
      catalogItem,
      this.lib,
      f.pxPerMm * Math.min(window.devicePixelRatio, 2),
    );
    this.studio.stage.add(this.item, this.dims, this.air, this.rack);
    this.studio.place(
      this.box,
      viewDirection(catalogItem),
      floating(catalogItem),
    );
    this.buildAirflow();
    this.buildRack();
    this.controls = new OrbitControls(this.cam, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.layoutDims());
    this.renderer.domElement.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") this.frame();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.apply();
    this.resize();
    this.frame();
    this.loop();
  }

  /** The box of everything shown: the item, and the rack when it is on. */
  private shownBox(): THREE.Box3 {
    const b = this.box.clone();
    if (this.toggles.rack) b.union(new THREE.Box3().setFromObject(this.rack));
    return b;
  }

  private direction(): THREE.Vector3 {
    switch (this.view) {
      case "front":
        return new THREE.Vector3(0, 0, -1);
      case "side":
        return new THREE.Vector3(-1, 0, 0);
      case "top":
        return new THREE.Vector3(0, 1, 0);
      default:
        return viewDirection(this.catalogItem);
    }
  }

  /** Fit the view to what is shown, from the current view's direction. */
  frame() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    const f = frameBox(
      this.shownBox(),
      this.direction(),
      this.cam.fov,
      w / h,
      0.14,
    );
    this.cam.position.copy(f.position);
    this.controls.target.copy(f.target);
    this.cam.up.set(0, 1, 0);
    if (this.view === "top") this.cam.up.set(0, 0, -1);
    this.cam.lookAt(f.target);
    this.controls.update();
    this.layoutDims();
  }

  setView(v: ViewName) {
    this.view = v;
    this.frame();
  }

  setToggles(t: ViewerToggles) {
    const reframe = t.rack !== this.toggles.rack;
    this.toggles = t;
    this.apply();
    if (reframe) this.frame();
  }

  setText(text: ViewerText) {
    this.text = text;
    this.apply();
  }

  private apply() {
    this.dims.visible = this.toggles.dims;
    this.air.visible = this.toggles.airflow;
    this.rack.visible = this.toggles.rack;
    this.labels.clear("dim");
    this.labels.clear("rack");
    if (this.toggles.rack)
      this.labels.set(
        "rack:name",
        this.text.rack,
        new THREE.Vector3(...this.rackTop()),
        {
          kind: "name",
          always: true,
          priority: 5,
        },
      );
    this.layoutDims();
  }

  private rackTop(): [number, number, number] {
    const x = this.box.max.x + 400 + RACK.w / 2;
    return [x, RACK.h + 120, 0];
  }

  /** A 600 × 1000 × 2040 rack outline beside the item, for scale. */
  private buildRack() {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK.w, RACK.h, RACK.d)),
      new THREE.LineBasicMaterial({ color: this.lib.theme.inkMuted }),
    );
    edges.position.set(this.box.max.x + 400 + RACK.w / 2, RACK.h / 2, 0);
    this.rack.add(edges);
  }

  /** Supply (blue) and return (red) arrows at the item's openings. */
  private buildAirflow() {
    const item = this.catalogItem;
    if (item.kind !== "cooling") return;
    const p = item.props as CoolingProps;
    const dims: [number, number, number] = [
      item.width_mm,
      item.depth_mm,
      item.height_mm,
    ];
    const len = Math.max(400, Math.min(900, Math.max(...dims) * 0.4));
    for (const o of openings(p.subtype, dims, p.discharge_options[0] ?? null)) {
      const color = o.role === "supply" ? 0x3d8bfd : 0xff5a4d;
      const across = Math.max(o.size[0], o.size[1]);
      for (let k = 0; k < 3; k++) {
        const arrow = new THREE.ArrowHelper(
          o.dir,
          new THREE.Vector3(),
          len * 0.6,
          color,
          120,
          70,
        );
        // Spread across the opening, along its wider side.
        const spread = new THREE.Vector3(1, 0, 0);
        if (Math.abs(o.dir.x) > 0.9) spread.set(0, 0, 1);
        if (o.size[1] > o.size[0] && Math.abs(o.dir.y) < 0.9)
          spread.set(0, 1, 0);
        const from = o.at
          .clone()
          .addScaledVector(spread, (k - 1) * across * 0.3);
        // Return arrows arrive at the opening; supply arrows leave it.
        const start =
          o.role === "return"
            ? from.clone().addScaledVector(o.dir, -len)
            : from;
        arrow.position.copy(start);
        this.air.add(arrow);
        this.arrows.push({ mesh: arrow, from: start, dir: o.dir.clone(), len });
      }
    }
  }

  /**
   * CAD-style dimensions offset outward from the edges facing the camera,
   * with extension lines and ticks: the width along the near bottom edge,
   * the depth along the bottom of the visible side, the height at the
   * vertical edge that is leftmost on screen (the silhouette, so it never
   * crosses the model). Laid out again whenever the camera moves.
   */
  private layoutDims() {
    if (!this.dims) return;
    this.dims.traverse((o) => (o as THREE.Line).geometry?.dispose());
    this.dims.clear();
    this.labels.clear("dim");
    if (!this.toggles.dims) return;
    const b = this.box;
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const cam = this.cam.position;
    const sx = cam.x < c.x ? -1 : 1; // the near side in x
    const sz = cam.z < c.z ? -1 : 1; // the near side in z
    const off = Math.max(size.x, size.y, size.z) * 0.1 + 80;
    const nearX = sx < 0 ? b.min.x : b.max.x,
      nearZ = sz < 0 ? b.min.z : b.max.z;
    const y0 = b.min.y;
    // The vertical edge furthest left on screen, and its outward direction.
    this.cam.updateMatrixWorld();
    let left = { x: b.min.x, z: b.min.z, sx: -1, sz: -1, screen: Infinity };
    for (const ex of [-1, 1])
      for (const ez of [-1, 1]) {
        const x = ex < 0 ? b.min.x : b.max.x,
          z = ez < 0 ? b.min.z : b.max.z;
        const p = new THREE.Vector3(x, c.y, z).project(this.cam);
        if (p.x < left.screen) left = { x, z, sx: ex, sz: ez, screen: p.x };
      }
    const dir = cam.clone().sub(c).normalize();
    const pts: THREE.Vector3[] = [];
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const dim = (
      key: string,
      a: THREE.Vector3,
      bEnd: THREE.Vector3,
      out: THREE.Vector3,
      value: number,
    ) => {
      const da = a.clone().addScaledVector(out, off),
        db = bEnd.clone().addScaledVector(out, off);
      // Extension lines from the edge past the dimension line.
      pts.push(
        a.clone().addScaledVector(out, 20),
        a.clone().addScaledVector(out, off + 40),
      );
      pts.push(
        bEnd.clone().addScaledVector(out, 20),
        bEnd.clone().addScaledVector(out, off + 40),
      );
      // The dimension line and its ticks (short slashes at 45°).
      pts.push(da, db);
      const along = db.clone().sub(da).normalize();
      const tick = along.clone().add(out).normalize().multiplyScalar(35);
      for (const p of [da, db])
        pts.push(p.clone().sub(tick), p.clone().add(tick));
      this.labels.set(
        `dim:${key}`,
        this.text.mm(value),
        da.clone().add(db).multiplyScalar(0.5).addScaledVector(out, 70),
        { kind: "dim", always: true, priority: 8, span: [da, db] },
      );
    };
    // Seen end-on, a dimension says nothing: leave it out.
    if (Math.abs(dir.x) < 0.95 || this.view === "top")
      dim(
        "w",
        V(b.min.x, y0, nearZ),
        V(b.max.x, y0, nearZ),
        V(0, 0, sz),
        size.x,
      );
    if (Math.abs(dir.z) < 0.95 || this.view === "top")
      dim(
        "d",
        V(nearX, y0, b.min.z),
        V(nearX, y0, b.max.z),
        V(sx, 0, 0),
        size.z,
      );
    if (Math.abs(dir.y) < 0.95)
      dim(
        "h",
        V(left.x, y0, left.z),
        V(left.x, b.max.y, left.z),
        V(left.sx, 0, left.sz).normalize(),
        size.y,
      );
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: this.lib.theme.dim,
        depthTest: false,
        transparent: true,
      }),
    );
    lines.renderOrder = 999;
    this.dims.add(lines);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const t = performance.now() / 1000;
    if (!this.reduced && this.toggles.airflow)
      for (const [i, a] of this.arrows.entries()) {
        const k = (t * 0.6 + (i % 3) / 3) % 1;
        a.mesh.position.copy(a.from).addScaledVector(a.dir, a.len * 0.4 * k);
      }
    this.controls.update();
    this.renderer.render(this.studio.scene, this.cam);
    this.labels.update(this.cam, this.host.clientWidth, this.host.clientHeight);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    disposeGroup(this.studio.stage);
    this.studio.dispose();
    this.lib.dispose();
    this.labels.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
