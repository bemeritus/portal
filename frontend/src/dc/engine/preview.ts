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
 *   dimensions with extension lines in the user's unit, the supply (blue)
 *   and return (red) openings marked on the model, and a 42U rack beside it
 *   for scale; drag turns, the wheel zooms, F frames.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CatalogItem, CoolingProps, DcObject } from "../types";
import { Labels } from "./labels";
import { MaterialLibrary } from "./materials";
import { mergeStatic } from "./merge";
import { RENDERERS } from "./renderers";
import { openings, type Opening } from "./renderers/cooling";
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

/** Pictures asked for and not drawn yet, by key. */
const pending = new Map<
  string,
  {
    draw: () => string;
    urgent: boolean;
    promise: Promise<string>;
    resolve: (u: string) => void;
  }
>();
let drawing = false;

/** Draw the next picture — one that is on screen first — then yield. */
function pump() {
  if (drawing || !pending.size) return;
  const all = [...pending.entries()];
  const [key, job] = all.find(([, j]) => j.urgent) ?? all[0];
  pending.delete(key);
  drawing = true;
  requestAnimationFrame(() => {
    const url = cache.get(key) ?? job.draw();
    cache.set(key, url);
    job.resolve(url);
    drawing = false;
    pump();
  });
}

/**
 * The card picture of `item`: from the cache, or drawn one at a time,
 * yielding to the page between them — cards on screen first (FEEDBACK-7
 * §3): `urgent` moves an asked-for picture ahead of the rest.
 */
export function thumbnail(
  item: CatalogItem,
  tokens: DcTokens,
  s: ThumbSize,
  urgent = false,
): Promise<string> {
  const key = thumbKey(item, tokens, s);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let job = pending.get(key);
  if (!job) {
    let resolve!: (u: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    job = { draw: () => draw(item, tokens, s), urgent, promise, resolve };
    pending.set(key, job);
  } else if (urgent) job.urgent = true;
  pump();
  return job.promise;
}

// --- The item page's viewer ------------------------------------------------------------

export type ViewName = "3d" | "front" | "side" | "top";

export interface ViewerText {
  /** A length in the user's unit, with its unit word. */
  mm: (v: number) => string;
  /** The rack shown for scale. */
  rack: string;
  /** A face of the unit (`front`, `rear`, `top`, `bottom`, `sides`). */
  face: (key: string) => string;
}

export interface ViewerToggles {
  dims: boolean;
  /** Supply and return openings marked on the model (FEEDBACK-5 §6). */
  openings: boolean;
  rack: boolean;
}

/** A 42U rack's outer size, mm (the room's racks). */
const RACK = { w: 600, d: 1000, h: 2040 };

/** The space round the shown things, as on the catalog's cards. */
const MARGIN = 0.1;

/**
 * Dimensions in screen pixels (FEEDBACK-5 §5): extension lines start `gap`
 * off the body and run `over` past the dimension line; the dimension line
 * stands at the first of `offsets` where it crosses neither the model nor
 * another dimension, or is not drawn.
 */
const DIM = { gap: 4, over: 6, offsets: [20, 34, 50], tick: 5 };

/** Supply and return colours, as in the legend under the viewer. */
const AIR = { supply: 0x3d8bfd, return: 0xff5a4d };

type P2 = [number, number];
type Rect2 = [number, number, number, number];

function cross(o: P2, a: P2, b: P2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull, counter-clockwise (monotone chain). */
function hull(ps: P2[]): P2[] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list: P2[]) => {
    const h: P2[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0)
        h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}

function segsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function inside(p: P2, poly: P2[]): boolean {
  return poly.every((q, i) => cross(q, poly[(i + 1) % poly.length], p) > 0);
}

function rectPoly(r: Rect2): P2[] {
  return [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ];
}

/** Does segment a–b touch the convex polygon? */
function segHitsPoly(a: P2, b: P2, poly: P2[]): boolean {
  if (inside(a, poly) || inside(b, poly)) return true;
  return poly.some((q, i) => segsCross(a, b, q, poly[(i + 1) % poly.length]));
}

function polysTouch(p: P2[], q: P2[]): boolean {
  return (
    p.some((x) => inside(x, q)) ||
    q.some((x) => inside(x, p)) ||
    p.some((x, i) => segHitsPoly(x, p[(i + 1) % p.length], q))
  );
}

/** Which face of the unit an opening is on, by where it sits. */
function openingFace(o: Opening, dims: [number, number, number]): string {
  const [w, d, h] = dims;
  const e = 1;
  const sideways = Math.hypot(o.dir.x, o.dir.z) > Math.abs(o.dir.y);
  if (o.at.y <= e || o.at.y >= h - e)
    return o.role === "supply" && sideways && o.at.y <= e
      ? "sides"
      : o.at.y <= e
        ? "bottom"
        : "top";
  if (o.at.z <= -d / 2 + e) return "front";
  if (o.at.z >= d / 2 - e) return "rear";
  return Math.abs(o.at.x) >= w / 2 - e ? "sides" : "front";
}

/** The outward normal of the face an opening is on. */
function faceNormal(o: Opening, dims: [number, number, number]) {
  const [, d, h] = dims;
  const e = 1;
  if (o.at.y <= e) return new THREE.Vector3(0, -1, 0);
  if (o.at.y >= h - e) return new THREE.Vector3(0, 1, 0);
  if (o.at.z <= -d / 2 + e) return new THREE.Vector3(0, 0, -1);
  if (o.at.z >= d / 2 - e) return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(Math.sign(o.at.x) || 1, 0, 0);
}

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
  private airLabels: {
    face: string;
    role: string;
    at: THREE.Vector3;
    normal: THREE.Vector3;
  }[] = [];
  /** Screen points of the dimensions drawn (ends, labels), for framing. */
  private dimExtent: P2[] = [];
  private rack = new THREE.Group();
  private raf = 0;
  private ro: ResizeObserver;
  private view: ViewName = "3d";
  /** Dimensions drawn in the current view, by key (tests). */
  private shownDims: string[] = [];

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
      MARGIN,
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
    this.buildOpenings();
    this.buildRack();
    this.controls = new OrbitControls(this.cam, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.layoutDims());
    this.renderer.domElement.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") this.frame();
    });
    this.ro = new ResizeObserver(() => {
      this.resize();
      this.frame();
    });
    this.ro.observe(host);
    this.apply();
    this.resize();
    this.frame();
    this.loop();
  }

  /** What is shown besides the dimensions: the item, its marks, the rack. */
  private shownBox(): THREE.Box3 {
    const b = this.box.clone();
    if (this.toggles.rack) b.union(new THREE.Box3().setFromObject(this.rack));
    if (this.toggles.openings && this.air.children.length)
      b.union(new THREE.Box3().setFromObject(this.air));
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

  /**
   * Fit the view to what is shown — the model, its marks and its
   * dimensions — from the current view's direction, with the cards' margin.
   * The dimensions stand off the model by pixels, so they are fitted on
   * screen: frame the model, lay the dimensions out, then zoom and re-centre
   * on everything drawn until it sits within the margin.
   */
  frame() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    const f = frameBox(
      this.shownBox(),
      this.direction(),
      this.cam.fov,
      w / h,
      MARGIN,
      h,
    );
    this.cam.position.copy(f.position);
    this.controls.target.copy(f.target);
    this.cam.up.set(0, 1, 0);
    if (this.view === "top") this.cam.up.set(0, 0, -1);
    this.cam.lookAt(f.target);
    const tanHalf = Math.tan((this.cam.fov * Math.PI) / 360);
    for (let i = 0; i < 4; i++) {
      this.layoutDims();
      const [x0, y0, x1, y1] = this.drawnExtent(w, h);
      const k = Math.max(
        (x1 - x0) / (w * (1 - 2 * MARGIN)),
        (y1 - y0) / (h * (1 - 2 * MARGIN)),
      );
      const dx = (x0 + x1) / 2 - w / 2,
        dy = (y0 + y1) / 2 - h / 2;
      if (Math.abs(k - 1) < 0.01 && Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
      // Re-centre (pixels at the target's depth), then move in or out.
      const tg = this.controls.target;
      const dist = this.cam.position.distanceTo(tg);
      const perPx = (2 * dist * tanHalf) / h;
      const e = this.cam.matrixWorld.elements;
      const shift = new THREE.Vector3(e[0], e[1], e[2])
        .multiplyScalar(dx * perPx)
        .addScaledVector(new THREE.Vector3(e[4], e[5], e[6]), -dy * perPx);
      tg.add(shift);
      this.cam.position.add(shift);
      this.cam.position.sub(tg).multiplyScalar(k).add(tg);
      this.cam.lookAt(tg);
      this.cam.updateMatrixWorld();
    }
    this.controls.update();
    this.layoutDims();
  }

  /** The screen box of everything drawn: model, marks, dimensions, px. */
  private drawnExtent(w: number, h: number): Rect2 {
    this.cam.updateMatrixWorld();
    const pts: P2[] = [...this.dimExtent];
    const b = this.shownBox();
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const v = new THREE.Vector3(x, y, z).project(this.cam);
          pts.push([((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]);
        }
    return [
      Math.min(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
    ];
  }

  setView(v: ViewName) {
    this.view = v;
    this.frame();
  }

  setToggles(t: ViewerToggles) {
    const was = this.toggles;
    this.toggles = t;
    this.apply();
    if (
      t.rack !== was.rack ||
      t.dims !== was.dims ||
      t.openings !== was.openings
    )
      this.frame();
  }

  setText(text: ViewerText) {
    this.text = text;
    this.apply();
  }

  /** The dimensions drawn in this view (tests). */
  dimensions(): string[] {
    return [...this.shownDims];
  }

  /** What the viewer marks on the model (tests). */
  marks(): { arrows: number; outlines: number; ticks: number } {
    let arrows = 0,
      outlines = 0,
      ticks = 0;
    this.studio.stage.traverse((o) => {
      if ((o as THREE.ArrowHelper).type === "ArrowHelper") arrows++;
      if (o.userData.opening === "outline" && o.visible) outlines++;
      if (o.userData.opening === "tick" && o.visible) ticks++;
    });
    return {
      arrows,
      outlines: this.toggles.openings ? outlines : 0,
      ticks: this.toggles.openings ? ticks : 0,
    };
  }

  private apply() {
    this.dims.visible = this.toggles.dims;
    this.air.visible = this.toggles.openings;
    this.rack.visible = this.toggles.rack;
    this.labels.clear("dim");
    this.labels.clear("rack");
    this.labels.clear("air");
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

  /**
   * The supply and return openings (FEEDBACK-5 §6): a thin outline of each
   * grille, blue for supply and red for return, a small label with the
   * face, and one short tick per supply opening in the direction it blows.
   * No jets: nothing here pretends to be a computed flow.
   */
  private buildOpenings() {
    const item = this.catalogItem;
    if (item.kind !== "cooling") return;
    const p = item.props as CoolingProps;
    const dims: [number, number, number] = [
      item.width_mm,
      Math.max(item.depth_mm, 40),
      item.height_mm,
    ];
    const tick = Math.max(60, Math.min(160, Math.max(...dims) * 0.14));
    for (const o of openings(p.subtype, dims, p.discharge_options[0] ?? null)) {
      const n = faceNormal(o, dims);
      // The grille's plane: x across unless the face looks along x.
      const u =
        Math.abs(n.x) > 0.5
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(1, 0, 0);
      const v =
        Math.abs(n.y) > 0.5
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);
      const c = o.at.clone().addScaledVector(n, 3);
      const [a, b] = [o.size[0] / 2, o.size[1] / 2];
      const corners = [
        [-a, -b],
        [a, -b],
        [a, b],
        [-a, b],
      ].map(([i, j]) => c.clone().addScaledVector(u, i).addScaledVector(v, j));
      const color = AIR[o.role];
      // Drawn over the model (a flange may stand proud of the grille), and
      // shown only while its face is turned to the camera.
      const mat = new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
      });
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(corners),
        mat,
      );
      outline.userData = { opening: "outline", at: c, normal: n };
      outline.renderOrder = 998;
      this.air.add(outline);
      if (o.role === "supply") {
        const end = c.clone().addScaledVector(o.dir, tick);
        // A chevron at the end, in the plane of the tick and the normal.
        const side = new THREE.Vector3()
          .crossVectors(o.dir, Math.abs(o.dir.y) > 0.9 ? u : v)
          .normalize();
        const back = o.dir.clone().multiplyScalar(-tick * 0.3);
        const pts = [
          c,
          end,
          end,
          end
            .clone()
            .add(back)
            .addScaledVector(side, tick * 0.18),
          end,
          end
            .clone()
            .add(back)
            .addScaledVector(side, -tick * 0.18),
        ];
        const line = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(pts),
          mat,
        );
        line.userData = { opening: "tick", at: c, normal: n };
        line.renderOrder = 998;
        this.air.add(line);
      }
      this.airLabels.push({
        face: openingFace(o, dims),
        role: o.role,
        at: c.clone().addScaledVector(n, 40),
        normal: n,
      });
    }
    // One label per face and role is enough (a cassette has four sides).
    const seen = new Set<string>();
    this.airLabels = this.airLabels.filter((l) => {
      const k = `${l.role}|${l.face}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * CAD dimensions of the bounding box (FEEDBACK-5 §5): the width along the
   * near bottom edge, the depth along the bottom of the visible side, the
   * height at the vertical edge leftmost on screen. Each has short
   * extension lines (`DIM.gap` off the body, `DIM.over` past the dimension
   * line) and its label in the middle of the line. A dimension that would
   * cross the model, another dimension or the viewer's edge moves outward;
   * if none of the offsets fits, it is not drawn in this view. Laid out
   * again whenever the camera moves.
   */
  private layoutDims() {
    if (!this.dims) return;
    this.dims.traverse((o) => (o as THREE.Line).geometry?.dispose());
    this.dims.clear();
    this.labels.clear("dim");
    this.shownDims = [];
    this.dimExtent = [];
    this.layoutOpeningLabels();
    if (!this.toggles.dims) return;
    const W = Math.max(1, this.host.clientWidth),
      H = Math.max(1, this.host.clientHeight);
    const cam = this.cam;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const screen = (p: THREE.Vector3): P2 => {
      const v = p.clone().project(cam);
      return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
    };
    // Millimetres per screen pixel at a point.
    const perPx = (p: THREE.Vector3) =>
      (2 * Math.max(1, p.clone().sub(cam.position).dot(fwd)) * tanHalf) / H;

    const b = this.box;
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const corners: THREE.Vector3[] = [];
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z])
          corners.push(new THREE.Vector3(x, y, z));
    const model = hull(corners.map(screen));
    const sx = cam.position.x < c.x ? -1 : 1; // the near side in x
    const sz = cam.position.z < c.z ? -1 : 1; // the near side in z
    const nearX = sx < 0 ? b.min.x : b.max.x,
      nearZ = sz < 0 ? b.min.z : b.max.z;
    const y0 = b.min.y;
    // The vertical edge furthest left on screen, and its outward direction.
    let left = { x: b.min.x, z: b.min.z, ex: -1, ez: -1, at: Infinity };
    for (const ex of [-1, 1])
      for (const ez of [-1, 1]) {
        const x = ex < 0 ? b.min.x : b.max.x,
          z = ez < 0 ? b.min.z : b.max.z;
        const p = screen(new THREE.Vector3(x, c.y, z))[0];
        if (p < left.at) left = { x, z, ex, ez, at: p };
      }
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // Each dimension with the directions it may stand off in, away from the
    // body: the one that shows best on screen is tried first (one pointing
    // at the camera would fold the dimension onto its edge).
    const wanted = [
      {
        key: "w",
        a: V(b.min.x, y0, nearZ),
        b: V(b.max.x, y0, nearZ),
        outs: [V(0, 0, sz), V(0, -1, 0)],
        value: size.x,
      },
      {
        key: "d",
        a: V(nearX, y0, b.min.z),
        b: V(nearX, y0, b.max.z),
        outs: [V(sx, 0, 0), V(0, -1, 0)],
        value: size.z,
      },
      {
        key: "h",
        a: V(left.x, y0, left.z),
        b: V(left.x, b.max.y, left.z),
        outs: [
          V(left.ex, 0, left.ez).normalize(),
          V(left.ex, 0, 0),
          V(0, 0, left.ez),
        ],
        value: size.y,
      },
    ];

    const placed: { line: [P2, P2]; label: P2[] }[] = [];
    const pts: THREE.Vector3[] = [];
    const fits = (r: Rect2) =>
      r[0] >= 2 && r[1] >= 2 && r[2] <= W - 2 && r[3] <= H - 2;
    for (const d of wanted) {
      const text = this.text.mm(d.value);
      const lw = text.length * 7 + 12,
        lh = 18;
      // Seen end-on, a dimension says nothing.
      const [ea, eb] = [screen(d.a), screen(d.b)];
      if (Math.hypot(ea[0] - eb[0], ea[1] - eb[1]) < 24) continue;
      const centre = d.a.clone().add(d.b).multiplyScalar(0.5);
      const sc = screen(centre);
      const outs = d.outs
        .map((out) => {
          const q = screen(
            centre.clone().addScaledVector(out, 10 * perPx(centre)),
          );
          return { out, k: Math.hypot(q[0] - sc[0], q[1] - sc[1]) / 10 };
        })
        .filter((o) => o.k > 0.35)
        .sort((x, y) => y.k - x.k);
      let drawn = false;
      for (const { out, k } of outs) {
        for (const offPx of DIM.offsets) {
          // `px` screen pixels off the body, along `out`.
          const at = (p: THREE.Vector3, px: number) =>
            p.clone().addScaledVector(out, (px / k) * perPx(p));
          const da = at(d.a, offPx),
            db = at(d.b, offPx);
          const sa = screen(da),
            sb = screen(db);
          const mid: P2 = [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2];
          const box: Rect2 = [
            mid[0] - lw / 2,
            mid[1] - lh / 2,
            mid[0] + lw / 2,
            mid[1] + lh / 2,
          ];
          const label = rectPoly(box);
          const ends = [
            screen(at(d.a, offPx + DIM.over)),
            screen(at(d.b, offPx + DIM.over)),
          ];
          const clear =
            fits(box) &&
            [sa, sb, ...ends].every((p) => fits([p[0], p[1], p[0], p[1]])) &&
            !segHitsPoly(sa, sb, model) &&
            !polysTouch(label, model) &&
            placed.every(
              (o) =>
                !segsCross(sa, sb, o.line[0], o.line[1]) &&
                !polysTouch(label, o.label) &&
                !segHitsPoly(sa, sb, o.label) &&
                !segHitsPoly(o.line[0], o.line[1], label),
            );
          if (!clear) continue;
          placed.push({ line: [sa, sb], label });
          this.dimExtent.push(...ends, ...label);
          // Extension lines: from just off the body to just past the line.
          for (const p of [d.a, d.b])
            pts.push(at(p, DIM.gap), at(p, offPx + DIM.over));
          pts.push(da, db);
          // Ticks: short slashes at 45° across each end.
          const along = db.clone().sub(da).normalize();
          for (const p of [da, db]) {
            const t = along
              .clone()
              .add(out)
              .normalize()
              .multiplyScalar(DIM.tick * perPx(p));
            pts.push(p.clone().sub(t), p.clone().add(t));
          }
          this.labels.set(
            `dim:${d.key}`,
            text,
            da.clone().add(db).multiplyScalar(0.5),
            { kind: "dim", always: true, priority: 9 },
          );
          this.shownDims.push(d.key);
          drawn = true;
          break;
        }
        if (drawn) break;
      }
    }
    if (!pts.length) return;
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

  /** The openings' marks and labels, on the faces turned to the camera only. */
  private layoutOpeningLabels() {
    const eye = this.cam.position;
    for (const o of this.air.children) {
      const { at, normal } = o.userData as {
        at: THREE.Vector3;
        normal: THREE.Vector3;
      };
      o.visible = normal.dot(eye.clone().sub(at)) > 0;
    }
    this.labels.clear("air");
    if (!this.toggles.openings) return;
    this.airLabels.forEach((l, i) => {
      if (l.normal.dot(this.cam.position.clone().sub(l.at)) <= 0) return;
      this.labels.set(`air:${i}`, this.text.face(l.face), l.at, {
        kind: "air",
        always: true,
        priority: 6,
        className: `dc-label-air-${l.role}`,
      });
    });
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
