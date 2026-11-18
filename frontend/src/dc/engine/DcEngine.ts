/**
 * The 3D view, outside React (SPEC §9). React owns panels, forms and routing;
 * this class owns the three.js renderer, scene, camera, controls and loop,
 * behind a narrow interface:
 *
 *   setModel(model) · select(ref) · setMode(mode) · setTool(tool)
 *   events: onSelect · onHover · onMoveCommit · onCursor · onRuler · onPlaceNote
 *
 * `setModel` diffs by id and rebuilds only objects whose data changed; a mode
 * switch re-assigns materials and overlays without rebuilding anything. Frames
 * are rendered on demand (and continuously only while something moves), and
 * GPU resources are disposed when an object goes away.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeStatic } from "./merge";
import type { PostFx } from "./postfx";

import type {
  Annotation,
  CatalogItem,
  DcObject,
  Device,
  Measurement,
  RackProps,
  Room,
  ShelfCell,
} from "../types";
import {
  candidates,
  measure as rulerMeasure,
  objectGap,
  pickSnap,
  wallGap,
  type Box,
  type Result,
  type Snap,
  type SnapKind,
  type Vec3,
} from "../model/ruler";
import {
  bounds,
  clearances,
  frontDir,
  gap,
  objectDims,
  onFloor,
  problems,
  snap,
  solid,
  type Dir,
  type Rect,
  type Solid,
} from "../model/geometry";
import { freeRuns, rackStats } from "../model/devices";
import { U_MM } from "../model/geometry";
import { CameraRig, type Preset, type View } from "./camera";
import { Labels } from "./labels";
import { MaterialLibrary, type Mode } from "./materials";
import { RENDERERS } from "./renderers";
import type { Built, Pick } from "./renderers/types";
import { themeFromTokens, type DcTheme } from "./theme";
import type { DcTokens } from "../theme/tokens";
import { ViewCube } from "./viewCube";

export type { Mode } from "./materials";
export type Tool = "view" | "edit" | "ruler" | "note";
export type SelRef = Pick | null;

export interface EngineModel {
  room: Room;
  catalog: Map<number, CatalogItem>;
  objects: DcObject[];
  devices: Device[];
  cells: ShelfCell[];
  blocked: Record<string, number[]>;
  annotations: Annotation[];
  /** Object name → keys of its assumed measurements and catalog properties. */
  assumed: Map<string, string[]>;
}

export interface EngineText {
  /** Texts the engine draws itself, in the user's language. */
  notRecorded: string;
  assumed: string;
  units: (used: number, total: number) => string;
  powerW: (w: number) => string;
  unknownPower: string;
  mm: (v: number) => string;
  range: (lo: number, hi: number) => string;
  /** A measurement's dimension text, tooltip, and whether to mark it. */
  measurement: (m: Measurement) => {
    text: string;
    title: string;
    mark: boolean;
  };
  /** A ruler result: `face ⟂ face · 59,5 см`. */
  ruler: (r: Result) => string;
  snap: (k: SnapKind) => string;
}

export type Measure = Result;
export type RulerMode = "points" | "objects";

interface Entry {
  sig: string;
  obj: DcObject;
  item: CatalogItem;
  solid: Solid;
  built: Built;
  /** Door angle, 0 = closed. */
  doorAngle: number;
  doorTarget: number;
  outline: THREE.LineSegments;
  assumedOutline: THREE.LineSegments | null;
  /** Thin outline of the object's box in Схема (dashed when overhead). */
  edges: THREE.LineSegments;
}

const UP = new THREE.Vector3(0, 1, 0);
const FLOOR = new THREE.Plane(UP, 0);
const OPEN_ANGLE = 1.85;

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

export class DcEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private readonly labels: Labels;
  private readonly cube: ViewCube;
  private lib: MaterialLibrary;
  private theme: DcTheme;
  private mode: Mode = "schema";
  private tool: Tool = "view";
  private model: EngineModel | null = null;
  private entries = new Map<number, Entry>();
  private readonly roomGroup = new THREE.Group();
  private readonly objectsGroup = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly dims = new THREE.Group();
  private readonly ledGroup = new THREE.Group();
  private readonly lights = new THREE.Group();
  private envMap: THREE.Texture | null = null;
  private selection: SelRef = null;
  private hover: SelRef = null;
  private measures: Result[] = [];
  /** The first pick of a measurement in progress. */
  private pending: { snap: Snap; box: Box | null } | null = null;
  private rulerMode: RulerMode = "points";
  private readonly snapMarker: HTMLDivElement;
  private showAssumptions = false;
  private highlightOwner: string | null = null;
  private composer: PostFx | null = null;
  private composerLoading = false;
  /**
   * Rendering quality, stepped down automatically when frames get slow:
   * 2 — ambient occlusion, ceiling lights, 2048 px shadows, up to 1.5× pixels;
   * 1 — no ambient occlusion or point lights, 1024 px shadows, 1× pixels;
   * 0 — no shadows either.
   */
  private quality: 0 | 1 | 2 = DcEngine.initialQuality();
  private frameTimes: number[] = [];

  private static initialQuality(): 0 | 1 | 2 {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 8;
    const mem = nav.deviceMemory ?? 8;
    return cores <= 2 || mem <= 2 ? 0 : cores <= 4 || mem <= 4 ? 1 : 2;
  }
  private drag: null | {
    id: number;
    dx: number;
    dz: number;
    x0: number;
    z0: number;
    moved: boolean;
    pointerId: number;
  } = null;
  private grid = 10;
  private dirty = true;
  private raf = 0;
  private last = performance.now();
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly ro: ResizeObserver;
  private down: { x: number; y: number; t: number } | null = null;
  private ledMats = new Map<string, THREE.MeshBasicMaterial>();
  text: EngineText;

  onSelect: (ref: SelRef) => void = () => {};
  onHover: (ref: SelRef, x: number, y: number) => void = () => {};
  onMoveCommit: (id: number, x0: number, z0: number, rotation: number) => void =
    () => {};
  onCursor: (p: { x: number; z: number } | null) => void = () => {};
  onRuler: (m: Measure[]) => void = () => {};
  onPlaceNote: (p: [number, number, number]) => void = () => {};
  onWalk: (on: boolean) => void = () => {};
  onProjection: (ortho: boolean) => void = () => {};
  /** The rendering quality was lowered because frames were slow. */
  onQuality: (q: 0 | 1 | 2) => void = () => {};
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    text: EngineText,
    tokens: DcTokens,
  ) {
    this.text = text;
    this.theme = themeFromTokens(tokens);
    this.lib = new MaterialLibrary(this.theme);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = "dc-canvas";
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);
    this.rig = new CameraRig(this.renderer.domElement);
    this.rig.onChange = () => {
      this.dirty = true;
      this.onProjection(this.rig.isOrtho);
      this.onWalk(this.rig.walk.on);
    };
    this.rig.controls.addEventListener("change", () => (this.dirty = true));
    this.labels = new Labels(host);
    this.snapMarker = document.createElement("div");
    this.snapMarker.className = "dc-snap";
    this.snapMarker.hidden = true;
    host.appendChild(this.snapMarker);
    this.cube = new ViewCube(host, (p) => this.preset(p));
    this.scene.add(
      this.roomGroup,
      this.objectsGroup,
      this.overlay,
      this.dims,
      this.ledGroup,
      this.lights,
    );
    this.setupLights();
    this.applyTheme();
    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.loop();
  }

  // --- Public interface ---------------------------------------------------------

  setModel(model: EngineModel) {
    const first = this.model === null || this.model.room.id !== model.room.id;
    this.model = model;
    const poly = model.room.floor_plan;
    const b = bounds(poly);
    this.rig.room = b;
    this.rig.roomHeight = model.room.height_mm;
    this.buildRoom();
    const seen = new Set<number>();
    for (const obj of model.objects) {
      const item = model.catalog.get(obj.catalog_id);
      if (!item) continue;
      seen.add(obj.id);
      const devices = model.devices.filter((d) => d.rack_id === obj.id);
      const cells = model.cells.filter((c) => c.shelf_id === obj.id);
      const blocked = model.blocked[String(obj.id)] ?? [];
      const sig = JSON.stringify([
        obj,
        item.id,
        devices,
        cells,
        blocked,
        model.assumed.get(obj.name) ?? null,
      ]);
      const prev = this.entries.get(obj.id);
      if (prev && prev.sig === sig) continue;
      if (prev) this.dropEntry(obj.id);
      this.buildEntry(obj, item, devices, cells, blocked, sig);
    }
    for (const id of [...this.entries.keys()])
      if (!seen.has(id)) this.dropEntry(id);
    this.rig.obstacles = [...this.entries.values()]
      .filter((e) => onFloor(e.solid))
      .map((e) => e.solid.rect);
    this.rebuildLeds();
    this.markBlockedCells();
    this.refreshOverlays();
    if (first) this.preset("iso", 0);
    this.dirty = true;
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lib.reset(mode, this.theme);
    this.ensurePostFx();
    this.scene.environment = mode === "realistic" ? this.env() : null;
    this.applyQuality();
    this.labels.showNames = mode !== "realistic";
    this.applyTheme();
    // Shadows and textured fronts are decided at build time.
    this.rebuildAll();
  }

  /** The module's theme (SPEC §10.1): every colour of the scene comes from it. */
  setTheme(tokens: DcTokens) {
    if (tokens === this.theme.tokens) return;
    this.theme = themeFromTokens(tokens);
    this.lib.reset(this.mode, this.theme);
    this.applyTheme();
    this.rebuildAll();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.pending = null;
    this.snapMarker.hidden = true;
    this.renderer.domElement.style.cursor =
      tool === "ruler" || tool === "note" ? "crosshair" : "";
    this.refreshOverlays();
  }

  setGrid(mm: number) {
    this.grid = mm;
  }

  /** «Показать допущения»: outline and badge objects with assumed values. */
  setShowAssumptions(on: boolean) {
    this.showAssumptions = on;
    for (const e of this.entries.values()) {
      if (e.assumedOutline) e.assumedOutline.visible = on;
      this.labelEntry(
        e,
        this.model?.devices.filter((d) => d.rack_id === e.obj.id) ?? [],
      );
    }
    this.dirty = true;
  }

  /** All labels and dimensions on or off. */
  setLabelsVisible(on: boolean) {
    this.labels.setVisible(on);
  }

  /** Colour one owner's devices and cells, dim everything else (§11.4). */
  setHighlight(owner: string | null) {
    this.highlightOwner = owner;
    for (const e of this.entries.values()) this.applyMaterials(e);
    this.dirty = true;
  }

  /** Ruler: between snapped points/faces, or between two objects. */
  setRulerMode(mode: RulerMode) {
    this.rulerMode = mode;
    this.pending = null;
    this.refreshOverlays();
  }

  /** Change an end of a finished measurement (typed coordinates). */
  setMeasureEnd(i: number, end: "a" | "b", p: Vec3) {
    const m = this.measures[i];
    if (!m) return;
    m[end] = p;
    m.distance = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
    m.how = "points";
    m.axis = null;
    this.onRuler(this.measures);
    this.refreshOverlays();
  }

  /** An object's box by name, mm (for the ruler's end-to-end test). */
  boxNamed(name: string): { min: Vec3; max: Vec3 } | null {
    for (const e of this.entries.values())
      if (e.obj.name === name) {
        const r = e.solid.rect;
        return { min: [r.x0, e.solid.y0, r.z0], max: [r.x1, e.solid.y1, r.z1] };
      }
    return null;
  }

  /** Blocked cells' marks and whether each is shown (Реалистичный; tests). */
  blockedMarks(): {
    shelfId: number;
    cellNo: number;
    shown: boolean;
    centre: Vec3;
  }[] {
    const out: ReturnType<DcEngine["blockedMarks"]> = [];
    for (const e of this.entries.values())
      for (const c of e.built.group.children)
        if (c.userData.blockedCell !== undefined) {
          c.updateWorldMatrix(true, true);
          const p = new THREE.Box3()
            .setFromObject(c)
            .getCenter(new THREE.Vector3());
          out.push({
            shelfId: e.obj.id,
            cellNo: c.userData.blockedCell as number,
            shown: c.visible,
            centre: [p.x, p.y, p.z],
          });
        }
    return out;
  }

  /** Project a room point to viewport pixels (tests, popovers). */
  project(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.rig.cam);
    return [
      ((v.x + 1) / 2) * this.host.clientWidth,
      ((1 - v.y) / 2) * this.host.clientHeight,
    ];
  }

  select(ref: SelRef, fly = false) {
    this.selection = ref;
    for (const e of this.entries.values()) {
      const rackOfDevice = ref?.type === "device" && ref.rackId === e.obj.id;
      e.outline.visible =
        (ref?.type === "object" && ref.id === e.obj.id) ||
        rackOfDevice ||
        (ref?.type === "cell" && ref.shelfId === e.obj.id);
      // A device inside opens its rack's doors.
      e.doorTarget = rackOfDevice ? OPEN_ANGLE : 0;
    }
    this.labels.focus.clear();
    if (ref)
      this.labels.focus.add(
        `obj:${ref.type === "object" ? ref.id : ref.type === "device" ? ref.rackId : ref.shelfId}`,
      );
    this.refreshOverlays();
    this.markBlockedCells();
    if (fly && ref) this.flyTo(ref);
    this.dirty = true;
  }

  flyTo(ref: Pick) {
    const objId =
      ref.type === "object"
        ? ref.id
        : ref.type === "device"
          ? ref.rackId
          : ref.shelfId;
    const e = this.entries.get(objId);
    if (!e) return;
    const r = e.solid.rect;
    const centre = new THREE.Vector3(
      (r.x0 + r.x1) / 2,
      (e.solid.y0 + e.solid.y1) / 2,
      (r.z0 + r.z1) / 2,
    );
    this.updatePlanView();
    // On the plan the whole room is already in view: selecting is enough.
    if (this.planView) return;
    if (ref.type === "device") {
      const mesh = this.findPickMesh(ref);
      if (mesh) {
        const p = new THREE.Vector3();
        mesh.getWorldPosition(p);
        this.rig.focus(p, 450, this.frontVector(e.solid.rotation));
        return;
      }
    }
    if (ref.type === "cell") {
      const mesh = this.findPickMesh(ref);
      if (mesh) {
        const p = new THREE.Vector3();
        mesh.getWorldPosition(p);
        this.rig.focus(p, 650, this.frontVector(e.solid.rotation));
        return;
      }
    }
    const radius =
      0.65 * Math.hypot(r.x1 - r.x0, e.solid.y1 - e.solid.y0, r.z1 - r.z0);
    this.rig.focus(
      centre,
      radius,
      e.item.kind === "rack" ? this.frontVector(e.solid.rotation) : undefined,
    );
  }

  preset(p: Preset, dur?: number) {
    const m = this.model;
    if ((p === "aisle" || p === "racks") && m) {
      // The front aisle: between the shelf's front and the racks' fronts.
      const b = bounds(m.room.floor_plan);
      const solids = [...this.entries.values()].map((e) => e.solid);
      const racks = solids.filter((s) => s.kind === "rack");
      const shelfFront = Math.max(
        b.z0,
        ...solids.filter((s) => s.kind === "shelf").map((s) => s.rect.z1),
      );
      const rackFront = racks.length
        ? Math.min(...racks.map((s) => s.rect.z0))
        : (b.z0 + b.z1) / 2;
      if (p === "aisle") {
        // From the door corner toward the far end of the racks, at eye
        // height — photo 03's camera.
        const racksX0 = racks.length
          ? Math.min(...racks.map((s) => s.rect.x0))
          : b.x0;
        const racksX1 = racks.length
          ? Math.max(...racks.map((s) => s.rect.x1))
          : b.x1;
        this.rig.go({
          position: [
            b.x1 - 350,
            1550,
            Math.max(shelfFront + 150, rackFront - 900),
          ],
          target: [racksX0 + (racksX1 - racksX0) * 0.3, 1050, rackFront + 250],
          fov: 72,
          ortho: false,
        });
      } else {
        this.rig.go({
          position: [(b.x0 + b.x1) / 2, 1500, shelfFront + 150],
          target: [(b.x0 + b.x1) / 2, 1000, rackFront + 500],
          fov: 75,
          ortho: false,
        });
      }
    } else this.rig.preset(p);
    if (dur === 0) this.rig.update(performance.now() + 10000, 0, false);
    this.dirty = true;
  }

  setOrtho(on: boolean) {
    this.rig.setOrtho(on);
  }

  setWalk(on: boolean) {
    this.rig.setWalk(on);
    this.dirty = true;
  }

  view(): View {
    return this.rig.view();
  }

  goView(v: View) {
    this.rig.go(v);
    this.dirty = true;
  }

  clearMeasures() {
    this.measures = [];
    this.pending = null;
    this.onRuler(this.measures);
    this.refreshOverlays();
  }

  setCubeLabels(labels: Record<string, string>) {
    this.cube.setLabels(labels);
  }

  /**
   * The current view as a PNG, with the visible labels drawn onto it (they
   * are HTML above the canvas, so a plain canvas grab would lose them).
   */
  /** Looking straight down in orthographic projection: the plan. */
  private planView = false;

  private updatePlanView() {
    const down =
      this.rig.isOrtho &&
      this.rig.cam.getWorldDirection(new THREE.Vector3()).y < -0.97;
    if (down === this.planView) return;
    this.planView = down;
    for (const e of this.entries.values())
      if (e.edges.userData.overhead)
        e.edges.material = this.lib.line(this.theme.tokens.objectEdge, down);
  }

  private renderFrame() {
    this.updatePlanView();
    if (this.mode === "realistic" && this.quality === 2 && this.composer)
      this.composer.render(this.rig.cam);
    else this.renderer.render(this.scene, this.rig.cam);
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio, this.quality === 2 ? 1.5 : 1);
  }

  /** Ambient occlusion: downloaded and built only when it will be used. */
  private ensurePostFx() {
    if (
      this.mode !== "realistic" ||
      this.quality < 2 ||
      this.composer ||
      this.composerLoading
    )
      return;
    this.composerLoading = true;
    void import("./postfx").then(({ makePostFx }) => {
      this.composerLoading = false;
      if (this.disposed) return;
      this.composer = makePostFx(
        this.renderer,
        this.scene,
        this.rig.cam,
        this.host.clientWidth,
        this.host.clientHeight,
      );
      this.dirty = true;
    });
  }

  /** Lights, shadows and resolution for the current mode and quality. */
  private applyQuality() {
    const realistic = this.mode === "realistic";
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.shadowMap.enabled = realistic && this.quality > 0;
    this.lights.traverse((l) => {
      if (!(l as THREE.Light).isLight) return;
      l.visible = realistic ? l.userData.realistic : l.userData.schema;
      const shadow = (l as THREE.DirectionalLight).shadow;
      if (shadow && (l as THREE.DirectionalLight).castShadow) {
        const size = this.quality === 2 ? 2048 : 1024;
        if (shadow.mapSize.x !== size) {
          shadow.mapSize.set(size, size);
          shadow.map?.dispose();
          shadow.map = null;
        }
      }
    });
    // The ceiling tubes' point lights cost per pixel; below quality 2 the
    // tubes still glow, the room is lit by the sky and the sun.
    this.roomGroup.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) o.visible = this.quality === 2;
    });
    this.resize();
    this.dirty = true;
  }

  /**
   * Watch frame times while something moves; when the median of 45 frames is
   * slower than 25 fps, step the quality down (never back up by itself).
   */
  private watchFrame(interval: number) {
    if (interval > 120) {
      this.frameTimes = [];
      return;
    }
    this.frameTimes.push(interval);
    if (this.frameTimes.length < 45) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    this.frameTimes = [];
    if (sorted[22] > 40 && this.quality > 0) {
      this.quality = (this.quality - 1) as 0 | 1;
      this.applyQuality();
      this.onQuality(this.quality);
    }
  }

  snapshotPng(): string {
    this.renderFrame();
    const src = this.renderer.domElement;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const g = out.getContext("2d")!;
    g.drawImage(src, 0, 0);
    const scale = src.width / Math.max(1, this.host.clientWidth);
    const font = getComputedStyle(this.labels.root).fontFamily || "sans-serif";
    g.textBaseline = "top";
    this.labels.root
      .querySelectorAll<HTMLElement>(".dc-label")
      .forEach((el) => {
        if (el.style.display === "none" || !el.style.transform) return;
        const m = el.style.transform.match(/translate\((-?\d+)px, (-?\d+)px\)/);
        if (!m) return;
        const cs = getComputedStyle(el);
        const x = Number(m[1]) * scale,
          y = Number(m[2]) * scale;
        g.fillStyle = cs.backgroundColor;
        g.fillRect(x, y, el.offsetWidth * scale, el.offsetHeight * scale);
        g.fillStyle = cs.color;
        g.font = `${parseFloat(cs.fontSize) * scale}px ${font}`;
        el.textContent!.split("\n").forEach((line, i) =>
          g.fillText(
            line,
            x + 4 * scale,
            y +
              2 * scale +
              i * parseFloat(cs.lineHeight || cs.fontSize) * scale,
          ),
        );
      });
    return out.toDataURL("image/png");
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const id of [...this.entries.keys()]) this.dropEntry(id);
    disposeTree(this.roomGroup);
    disposeTree(this.overlay);
    disposeTree(this.dims);
    disposeTree(this.ledGroup);
    this.lib.dispose();
    this.composer?.dispose();
    this.disposed = true;
    this.envMap?.dispose();
    this.rig.dispose();
    this.labels.dispose();
    this.cube.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    window.removeEventListener("keydown", this.keydown);
    window.removeEventListener("keyup", this.keyup);
    window.removeEventListener("blur", this.blur);
  }

  // --- Scene -----------------------------------------------------------------------

  private setupLights() {
    const flat = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.4);
    flat.userData = { schema: true, realistic: false };
    const flatDir = new THREE.DirectionalLight(0xffffff, 0.9);
    flatDir.position.set(-3000, 8000, 5000);
    flatDir.userData = { schema: true, realistic: false };
    const amb = new THREE.HemisphereLight(0xfffaf2, 0x8a6a50, 1.1);
    amb.userData = { schema: false, realistic: true };
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(2000, 6000, 3500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 4;
    sun.shadow.bias = -0.0004;
    Object.assign(sun.shadow.camera, {
      left: -6000,
      right: 6000,
      top: 6000,
      bottom: -6000,
      near: 100,
      far: 20000,
    });
    sun.userData = { schema: false, realistic: true };
    this.lights.add(flat, flatDir, amb, sun, sun.target);
    amb.visible = sun.visible = false;
  }

  private env(): THREE.Texture {
    if (!this.envMap) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envMap = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    return this.envMap;
  }

  private applyTheme() {
    // Реалистичный sits on a neutral backdrop, so white units and walls read.
    const bg = new THREE.Color(this.theme.background);
    if (this.mode === "realistic")
      bg.lerp(new THREE.Color(this.theme.dark ? "#3a3d42" : "#9aa0a6"), 0.45);
    this.scene.background = bg;
    this.host.style.setProperty("--dc-dim", this.theme.dim);
    this.host.style.setProperty("--dc-warn", this.theme.warn);
    this.host.style.setProperty("--dc-assumed", this.theme.assumed);
    this.buildRoom();
    this.dirty = true;
  }

  private buildRoom() {
    disposeTree(this.roomGroup);
    this.roomGroup.clear();
    const m = this.model;
    if (!m) return;
    const poly = m.room.floor_plan;
    const shape = new THREE.Shape(
      poly.map(([x, z]) => new THREE.Vector2(x, z)),
    );
    const floorGeo = new THREE.ShapeGeometry(shape);
    floorGeo.rotateX(Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, this.lib.role("floor"));
    floor.userData.floor = true;
    floor.userData.role = "floor";
    floor.receiveShadow = true;
    floor.material.side = THREE.DoubleSide;
    this.roomGroup.add(floor);
    // Walls: low in Схема so the room reads from above. In Реалистичный they
    // are full height and single-sided, facing into the room, so the wall
    // between the camera and the room is culled — a cutaway, from any side.
    const realistic = this.mode === "realistic";
    const h = realistic ? m.room.height_mm : 200;
    const n = poly.length;
    const [cx, cz] = [
      poly.reduce((a, p) => a + p[0], 0) / n,
      poly.reduce((a, p) => a + p[1], 0) / n,
    ];
    for (let i = 0; i < n; i++) {
      const [ax, az] = poly[i],
        [bx, bz] = poly[(i + 1) % n];
      const len = Math.hypot(bx - ax, bz - az);
      const mx = (ax + bx) / 2,
        mz = (az + bz) / 2;
      let wall: THREE.Mesh;
      if (realistic) {
        wall = new THREE.Mesh(
          new THREE.PlaneGeometry(len, h),
          this.lib.role("wall"),
        );
        wall.position.set(mx, h / 2, mz);
        // Face the room's centre.
        wall.lookAt(cx, h / 2, cz);
      } else {
        // Чертёж draws walls hatched, as on a drawing (mockup Drawing.png).
        wall = new THREE.Mesh(
          new THREE.BoxGeometry(len, h, 60),
          this.theme.tokens.name === "drawing"
            ? this.lib.hatch(len, 60)
            : this.lib.role("wall"),
        );
        wall.position.set(mx, h / 2, mz);
        wall.rotation.y = -Math.atan2(bz - az, bx - ax);
        const nx = -(bz - az) / len,
          nz = (bx - ax) / len;
        wall.position.x -= nx * 30;
        wall.position.z -= nz * 30;
      }
      wall.userData.role = "wall";
      wall.userData.wall = {
        axis: ax === bx ? 0 : 2,
        coord: ax === bx ? ax : az,
      };
      wall.receiveShadow = realistic;
      this.roomGroup.add(wall);
    }
    if (realistic) {
      // White ceiling — the floor's outline, whose front face already looks
      // down (culled from above) — and fluorescent tube
      // lights along the room — lighting of the photos, not equipment: they
      // are not objects, not selectable, not exported.
      const H = m.room.height_mm;
      const ceil = new THREE.Mesh(floorGeo.clone(), this.lib.role("ceiling"));
      ceil.position.y = H;
      ceil.userData.role = "ceiling";
      this.roomGroup.add(ceil);
      const b = bounds(poly);
      const tubes = Math.max(1, Math.round((b.z1 - b.z0) / 1300));
      for (let i = 0; i < tubes; i++) {
        const z = b.z0 + ((i + 0.5) * (b.z1 - b.z0)) / tubes;
        const tube = new THREE.Mesh(
          new THREE.BoxGeometry(1200, 30, 60),
          this.lib.tube(),
        );
        tube.position.set((b.x0 + b.x1) / 2, H - 20, z);
        tube.userData.role = "light";
        tube.userData.fixedMaterial = true;
        this.roomGroup.add(tube);
        const light = new THREE.PointLight(0xffffff, 0.5, 0, 0);
        light.visible = this.quality === 2;
        light.position.set((b.x0 + b.x1) / 2, H - 120, z);
        this.roomGroup.add(light);
      }
    }
    // The floor grid: centred on the room with the same margin on every
    // side, 500 mm cells on whole half-metres of the room's own axes.
    const gb = bounds(poly);
    const CELL = 500;
    const snap = (v: number) => Math.round(v / CELL) * CELL;
    const half =
      Math.ceil((Math.max(gb.x1 - gb.x0, gb.z1 - gb.z0) / 2 + 4000) / CELL) *
      CELL;
    const grid = new THREE.GridHelper(
      2 * half,
      (2 * half) / CELL,
      this.theme.line,
      this.theme.line,
    );
    grid.position.set(snap((gb.x0 + gb.x1) / 2), 1, snap((gb.z0 + gb.z1) / 2));
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity =
      this.mode === "realistic" ? 0 : 0.35;
    grid.visible = this.mode !== "realistic";
    this.roomGroup.add(grid);
  }

  private buildEntry(
    obj: DcObject,
    item: CatalogItem,
    devices: Device[],
    cells: ShelfCell[],
    blocked: number[],
    sig: string,
  ) {
    const m = this.model!;
    const dims = objectDims(item, obj.instance);
    const ceilingAbove = Math.max(0, m.room.height_mm - (obj.y0_mm + dims[2]));
    const built = RENDERERS[item.kind].build(obj, item, {
      lib: this.lib,
      mode: this.mode,
      devices,
      cells,
      blocked,
      dims,
      ceilingAbove,
    });
    const s = solid(obj, item, m.room.floor_plan);
    const g = built.group;
    mergeStatic(g);
    g.position.set(
      (s.rect.x0 + s.rect.x1) / 2,
      obj.y0_mm,
      (s.rect.z0 + s.rect.z1) / 2,
    );
    g.rotation.y = (-obj.rotation_deg * Math.PI) / 180;
    g.userData.objectId = obj.id;
    this.objectsGroup.add(g);
    // Selection outline.
    const [w, d, h] = dims;
    const eg = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(w + 30, h + 30, d + 30),
    );
    const outline = new THREE.LineSegments(
      eg,
      this.lib.line(this.theme.accent),
    );
    outline.position.set(0, h / 2, 0);
    outline.visible = false;
    outline.renderOrder = 998;
    g.add(outline);
    let assumedOutline: THREE.LineSegments | null = null;
    if (m.assumed.has(obj.name)) {
      const ag = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(w + 12, h + 12, Math.max(d, 10) + 12),
      );
      assumedOutline = new THREE.LineSegments(
        ag,
        this.lib.line(this.theme.assumed, true),
      );
      assumedOutline.computeLineDistances();
      assumedOutline.position.set(0, h / 2, 0);
      assumedOutline.renderOrder = 997;
      assumedOutline.visible = this.showAssumptions;
      g.add(assumedOutline);
    }
    // Схема: a thin outline of every object, dashed for what hangs overhead
    // — on the plan only (a drawing convention); in 3D the height shows it.
    // (as on the drawing). Not in Реалистичный.
    const overhead = obj.y0_mm > 0 && item.kind !== "structure";
    const edgesGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(w, h, Math.max(d, 1)),
    );
    const edges = new THREE.LineSegments(
      edgesGeo,
      this.lib.line(this.theme.tokens.objectEdge, overhead && this.planView),
    );
    edges.userData.overhead = overhead;
    if (overhead) edges.computeLineDistances();
    edges.position.set(0, h / 2, 0);
    edges.visible = this.mode !== "realistic";
    edges.renderOrder = 2;
    g.add(edges);
    const entry: Entry = {
      sig,
      obj,
      item,
      solid: s,
      built,
      doorAngle: 0,
      doorTarget: 0,
      outline,
      assumedOutline,
      edges,
    };
    const prevSel = this.selection;
    if (prevSel) {
      entry.outline.visible =
        (prevSel.type === "object" && prevSel.id === obj.id) ||
        (prevSel.type === "device" && prevSel.rackId === obj.id) ||
        (prevSel.type === "cell" && prevSel.shelfId === obj.id);
      if (prevSel.type === "device" && prevSel.rackId === obj.id)
        entry.doorTarget = OPEN_ANGLE;
    }
    this.entries.set(obj.id, entry);
    this.applyMaterials(entry);
    this.labelEntry(entry, devices);
  }

  private dropEntry(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    this.objectsGroup.remove(e.built.group);
    disposeTree(e.built.group);
    this.labels.clear(`obj:${id}`);
    this.entries.delete(id);
  }

  private rebuildAll() {
    const m = this.model;
    if (!m) return;
    for (const id of [...this.entries.keys()]) this.dropEntry(id);
    this.buildRoom();
    this.setModel(m);
  }

  /** The material each mesh's role calls for, with Заполнение/Мощность tints. */
  private applyMaterials(e: Entry) {
    const m = this.model!;
    let tint: THREE.Material | null = null;
    if (
      e.item.kind === "rack" &&
      (this.mode === "fill" || this.mode === "power")
    ) {
      const p = e.item.props as RackProps;
      const devs = m.devices.filter((d) => d.rack_id === e.obj.id);
      const st = rackStats(devs, p.units, e.obj.contents_known);
      if (!st.known) tint = this.lib.unknown();
      else if (this.mode === "fill") tint = this.lib.tint(st.used / st.units);
      else if (st.unknownPower > 0) tint = this.lib.unknown();
      else {
        // Against the budget; without one there is nothing to judge
        // against, so every rack with known power gets the same colour.
        const budget = m.room.settings.rack_power_budget_w;
        tint =
          budget === null
            ? this.lib.known()
            : st.powerW > budget
              ? this.lib.over()
              : this.lib.tint(st.powerW / budget);
      }
    }
    e.built.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.fixedMaterial) return;
      const role = mesh.userData.role as string | undefined;
      if (!role) return;
      const h = this.highlightOwner;
      if (h !== null) {
        const owner = (mesh.userData.device?.owner ?? mesh.userData.owner) as
          string | undefined;
        mesh.material = owner === h ? this.lib.highlight() : this.lib.dimmed();
        return;
      }
      if (mesh.userData.device) {
        const d = mesh.userData.device as {
          kind: Device["kind"];
          units: number;
          name: string;
          rear: boolean;
        };
        const side = this.lib.role("deviceSide");
        const front = this.lib.deviceFront(d.kind, d.units, d.name);
        // BoxGeometry faces: +x, −x, +y, −y, +z, −z; the panel faces out of its face.
        mesh.material = [
          side,
          side,
          side,
          side,
          d.rear ? front : side,
          d.rear ? side : front,
        ];
        return;
      }
      mesh.material =
        tint && (role === "rackFrame" || role === "rackCap")
          ? tint
          : this.lib.role(role);
    });
  }

  private labelEntry(e: Entry, devices: Device[]) {
    const g = e.built.group;
    g.updateMatrixWorld(true);
    const p = g.localToWorld(e.built.labelAt.clone());
    let text = e.obj.name;
    // Fill and power are about contents; Схема stays calm with names only.
    if (
      e.item.kind === "rack" &&
      (this.mode === "fill" || this.mode === "power")
    ) {
      const st = rackStats(
        devices,
        (e.item.props as RackProps).units,
        e.obj.contents_known,
      );
      text += st.known
        ? `\n${this.text.units(st.used, st.units)}${st.powerW ? ` · ${this.text.powerW(st.powerW)}` : ""}${st.unknownPower ? ` · ${this.text.unknownPower}` : ""}`
        : `\n${this.text.notRecorded}`;
    }
    this.labels.set(`obj:${e.obj.id}:name`, text, p, {
      priority: e.item.kind === "rack" ? 6 : 4,
    });
    const keys = this.model!.assumed.get(e.obj.name);
    this.labels.remove(`obj:${e.obj.id}:assumed`);
    if (keys && this.showAssumptions) {
      this.labels.set(
        `obj:${e.obj.id}:assumed`,
        `≈ ${this.text.assumed}`,
        p.clone().add(new THREE.Vector3(0, -260, 0)),
        {
          kind: "assumed",
          priority: 5,
          title: keys.join(", "),
        },
      );
    }
  }

  // --- Overlays: dimensions, clearances, door swings, fill ranges, ruler, notes ---

  private refreshOverlays() {
    disposeTree(this.overlay);
    this.overlay.clear();
    disposeTree(this.dims);
    this.dims.clear();
    this.labels.clear("dim");
    this.labels.clear("gap");
    this.labels.clear("note");
    this.labels.clear("ruler");
    this.labels.clear("meas");
    const m = this.model;
    if (!m) return;
    const solids = [...this.entries.values()].map((e) => e.solid);
    const poly = m.room.floor_plan;
    const schema = this.mode !== "realistic";

    // Door swings, on the floor.
    for (const s of solids)
      if (s.swing) {
        const sw = s.swing;
        const q = sw.quadrant;
        const fx = q.x0 === sw.hinge[0] ? q.x1 : q.x0,
          fz = q.z0 === sw.hinge[1] ? q.z1 : q.z0;
        // From the closed leaf (along the wall) to the open one, the short way.
        const alongX = s.rect.x1 - s.rect.x0 >= s.rect.z1 - s.rect.z0;
        const closed = alongX
          ? Math.atan2(0, fx - sw.hinge[0])
          : Math.atan2(fz - sw.hinge[1], 0);
        const open = alongX
          ? Math.atan2(fz - sw.hinge[1], 0)
          : Math.atan2(0, fx - sw.hinge[0]);
        let sweep = open - closed;
        if (sweep > Math.PI) sweep -= 2 * Math.PI;
        if (sweep < -Math.PI) sweep += 2 * Math.PI;
        const pts: THREE.Vector3[] = [
          new THREE.Vector3(sw.hinge[0], 4, sw.hinge[1]),
        ];
        for (let i = 0; i <= 24; i++) {
          const t = closed + (sweep * i) / 24;
          pts.push(
            new THREE.Vector3(
              sw.hinge[0] + Math.cos(t) * sw.radius,
              4,
              sw.hinge[1] + Math.sin(t) * sw.radius,
            ),
          );
        }
        pts.push(pts[0].clone());
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          this.lib.line(this.theme.inkMuted, true),
        );
        line.computeLineDistances();
        this.overlay.add(line);
      }

    // Service clearance: a violation is a thin red zone on the floor with
    // one label; zones that are fine show only while editing.
    if (schema || this.tool === "edit") {
      for (const c of clearances(solids, poly, m.room.settings)) {
        if (c.ok && this.tool !== "edit") continue;
        const z = c.zone;
        const geo = new THREE.PlaneGeometry(z.x1 - z.x0, z.z1 - z.z0);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, this.lib.zone(c.ok));
        mesh.position.set((z.x0 + z.x1) / 2, 3, (z.z0 + z.z1) / 2);
        mesh.renderOrder = 5;
        this.overlay.add(mesh);
        const rim = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          this.lib.line(c.ok ? this.theme.good : this.theme.warn),
        );
        rim.position.copy(mesh.position);
        rim.renderOrder = 6;
        this.overlay.add(rim);
        if (!c.ok) {
          // Towards the zone's far end, clear of the tape dimension that
          // usually runs through its middle.
          const o = this.entries.get(c.objectId)?.solid.rect;
          const [mx, mz] = [(z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2];
          let [lx, lz] = [mx, mz];
          if (o) {
            const [ox, oz] = [(o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2];
            if (Math.abs(mz - oz) >= Math.abs(mx - ox))
              lz = mz + Math.sign(mz - oz) * (z.z1 - z.z0) * 0.3;
            else lx = mx + Math.sign(mx - ox) * (z.x1 - z.x0) * 0.3;
          }
          this.labels.set(
            `gap:${c.objectId}:${c.side}`,
            `${this.text.mm(c.gap.mm)} < ${this.text.mm(c.required)}`,
            new THREE.Vector3(lx, 30, lz),
            {
              kind: "warn",
              priority: 8,
            },
          );
        }
      }
    }

    // Схема: every measurement as a dimension, with the value as read (and a
    // dot where the model disagrees); the selected object's clear distances
    // to its neighbours, live while it moves.
    if (schema) this.measurementDims();
    const sel = this.selectedEntry();
    if (sel && (schema || this.tool === "edit"))
      this.gapDims(sel.solid, solids);

    // Заполнение: free contiguous units on the front of each recorded rack.
    if (this.mode === "fill") {
      for (const e of this.entries.values()) {
        if (e.item.kind !== "rack" || !e.obj.contents_known) continue;
        const p = e.item.props as RackProps;
        const devs = m.devices.filter((d) => d.rack_id === e.obj.id);
        const [w, d] = objectDims(e.item, e.obj.instance);
        for (const r of freeRuns(devs, p.units, "front")) {
          const hgt = (r.to - r.from + 1) * U_MM - 4;
          const geo = new THREE.BoxGeometry(w - 120, hgt, 20);
          const mesh = new THREE.Mesh(geo, this.lib.freeRange());
          mesh.position.set(
            0,
            p.u1_height_mm + (r.from - 1) * U_MM + hgt / 2 + 2,
            -d / 2 + 60,
          );
          const holder = new THREE.Group();
          holder.position.copy(e.built.group.position);
          holder.rotation.copy(e.built.group.rotation);
          holder.add(mesh);
          this.overlay.add(holder);
        }
      }
    }

    // Notes pinned in 3D.
    for (const a of m.annotations)
      if (a.kind === "note") {
        const [x, y, z] = a.payload.position;
        const pin = new THREE.Mesh(
          new THREE.SphereGeometry(40, 12, 8),
          new THREE.MeshBasicMaterial({ color: this.theme.assumed }),
        );
        pin.position.set(x, y, z);
        this.overlay.add(pin);
        this.labels.set(
          `note:${a.id}`,
          a.payload.text,
          new THREE.Vector3(x, y + 120, z),
          { kind: "note", priority: 7, always: true },
        );
      }

    // Ruler.
    this.measures.forEach((ms, i) => this.drawMeasure(ms, `ruler:${i}`));
    if (this.pending) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(22, 12, 8),
        new THREE.MeshBasicMaterial({
          color: this.theme.dim,
          depthTest: false,
        }),
      );
      dot.position.set(...this.pending.snap.p);
      dot.renderOrder = 1000;
      this.overlay.add(dot);
    }
    this.dirty = true;
  }

  /** Реалистичный: a blocked cell's mark shows while hovered or selected. */
  private markBlockedCells() {
    const is = (r: SelRef, shelf: number, n: number) =>
      r?.type === "cell" && r.shelfId === shelf && r.cellNo === n;
    for (const e of this.entries.values())
      for (const c of e.built.group.children) {
        const n = c.userData.blockedCell as number | undefined;
        if (n === undefined) continue;
        c.visible =
          is(this.hover, e.obj.id, n) || is(this.selection, e.obj.id, n);
      }
    this.dirty = true;
  }

  private selectedEntry(): Entry | null {
    const s = this.selection;
    if (!s) return null;
    return (
      this.entries.get(
        s.type === "object" ? s.id : s.type === "device" ? s.rackId : s.shelfId,
      ) ?? null
    );
  }

  /** A dimension line with ticks and a label, on the floor or at a height. */
  private dim(
    key: string,
    a: THREE.Vector3,
    b: THREE.Vector3,
    text: string,
    priority = 3,
    extra: { title?: string; mark?: boolean } = {},
  ) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1) return;
    dir.normalize();
    // Ticks across the line: horizontal for horizontal lines, along x for
    // vertical ones.
    const n = (
      Math.abs(dir.y) > 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(-dir.z, 0, dir.x)
    ).multiplyScalar(60);
    const pts = [
      a,
      b,
      a.clone().add(n),
      a.clone().sub(n),
      b.clone().add(n),
      b.clone().sub(n),
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setIndex([0, 1, 2, 3, 4, 5]);
    const line = new THREE.LineSegments(geo, this.lib.line(this.theme.dim));
    line.renderOrder = 999;
    this.dims.add(line);
    this.labels.set(
      key,
      text,
      a
        .clone()
        .add(b)
        .multiplyScalar(0.5)
        .add(new THREE.Vector3(0, 40, 0)),
      {
        kind: "dim",
        priority,
        title: extra.title,
        className: extra.mark ? "dc-label-mark" : undefined,
        span: [a, b],
      },
    );
  }

  /** Every measurement of the room that has a place to be drawn. */
  private measurementDims() {
    const m = this.model!;
    for (const e of m.room.measurements.entries) {
      if (!e.line) continue;
      const [p, q] = e.line;
      const t = this.text.measurement(e);
      // Room-level numbers first, then the ones the drawing marks.
      const priority = e.key.startsWith("room.") ? 7 : t.mark ? 6 : 4;
      this.dim(
        `meas:${e.key}`,
        new THREE.Vector3(...p),
        new THREE.Vector3(...q),
        t.text,
        priority,
        { title: t.title, mark: t.mark },
      );
    }
  }

  private gapDims(s: Solid, solids: Solid[]) {
    const poly = this.model!.room.floor_plan;
    const others = solids
      .filter(
        (o) =>
          o !== s &&
          o.id !== s.id &&
          (s.y0 > 0 ? !o.swing && o.y0 < s.y1 && s.y0 < o.y1 : onFloor(o)),
      )
      .map((o) => o.rect);
    const y = s.y0 > 0 ? s.y0 : 12;
    for (const dir of ["left", "right", "up", "down"] as Dir[]) {
      const g = gap(s.rect, dir, others, poly);
      if (g.mm <= 0) continue;
      this.dim(
        `gap:sel:${dir}`,
        new THREE.Vector3(g.from[0], y, g.from[1]),
        new THREE.Vector3(g.to[0], y, g.to[1]),
        this.text.mm(g.mm),
        9,
      );
    }
  }

  private drawMeasure(r: Result, key: string) {
    const a = new THREE.Vector3(...r.a),
      b = new THREE.Vector3(...r.b);
    this.dim(`${key}:line`, a, b, "", 0);
    this.labels.remove(`${key}:line`);
    this.labels.set(
      key,
      this.text.ruler(r),
      a
        .clone()
        .add(b)
        .multiplyScalar(0.5)
        .add(new THREE.Vector3(0, 80, 0)),
      { kind: "measure", priority: 10, always: true },
    );
  }

  // --- LEDs and doors --------------------------------------------------------------

  private rebuildLeds() {
    disposeTree(this.ledGroup);
    this.ledGroup.clear();
    if (this.mode !== "realistic") return;
    const geo = new THREE.PlaneGeometry(9, 5);
    for (const e of this.entries.values())
      for (const led of e.built.leds) {
        let mat = this.ledMats.get(led.color + led.blink);
        if (!mat) {
          mat = new THREE.MeshBasicMaterial({
            color: led.color,
            toneMapped: false,
          });
          mat.userData.base = new THREE.Color(led.color);
          mat.userData.blink = led.blink;
          this.ledMats.set(led.color + led.blink, mat);
        }
        const m = new THREE.Mesh(geo, mat);
        m.position.copy(led.pos);
        m.rotation.y = led.pos.z < 0 ? Math.PI : 0;
        const holder = new THREE.Group();
        holder.position.copy(e.built.group.position);
        holder.rotation.copy(e.built.group.rotation);
        holder.add(m);
        this.ledGroup.add(holder);
      }
  }

  private tickDoors(dt: number): boolean {
    let moving = false;
    for (const e of this.entries.values()) {
      if (!e.built.doors.length) continue;
      const delta = e.doorTarget - e.doorAngle;
      if (Math.abs(delta) < 0.002) {
        if (e.doorAngle !== e.doorTarget) e.doorAngle = e.doorTarget;
        else continue;
      } else {
        e.doorAngle = this.rig.reducedMotion
          ? e.doorTarget
          : e.doorAngle + delta * Math.min(1, dt * 6);
        moving = true;
      }
      for (const leaf of e.built.doors)
        leaf.pivot.rotation.y = leaf.dir * e.doorAngle;
    }
    return moving;
  }

  private tickLeds(now: number) {
    if (this.mode !== "realistic" || this.rig.reducedMotion) return;
    const on = Math.floor(now / 420) % 2 === 0;
    for (const mat of this.ledMats.values()) {
      if (!mat.userData.blink) continue;
      mat.color
        .copy(mat.userData.base as THREE.Color)
        .multiplyScalar(on ? 1 : 0.15);
    }
  }

  // --- Input -------------------------------------------------------------------------

  private keydown = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    )
      return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (this.rig.walk.on && ev.code === "Escape") {
      this.setWalk(false);
      return;
    }
    if (
      ev.code.startsWith("Arrow") &&
      !this.rig.walk.on &&
      this.tool === "edit" &&
      this.selection?.type === "object"
    )
      return;
    this.rig.held.add(ev.code);
    this.dirty = true;
  };
  private keyup = (ev: KeyboardEvent) => {
    this.rig.held.delete(ev.code);
  };
  private blur = () => this.rig.held.clear();

  private setNdc(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.ndc, this.rig.cam);
  }

  private pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.objectsGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.pick) out.push(o);
    });
    return out;
  }

  /** What is under the pointer: devices before rack bodies, doors only when closed. */
  private pick(ev: {
    clientX: number;
    clientY: number;
  }): { pick: Pick; point: THREE.Vector3 } | null {
    this.setNdc(ev);
    const hits = this.ray.intersectObjects(this.pickables(), false);
    const usable = hits.filter((h) => {
      if (!h.object.userData.door) return true;
      const objId = this.objectIdOf(h.object);
      const e = objId !== null ? this.entries.get(objId) : undefined;
      const glass = h.object.userData.role === "glass";
      return !!e && e.doorAngle < 0.05 && !glass;
    });
    const first = usable[0];
    if (!first) return null;
    const p = first.object.userData.pick as Pick;
    if (p.type === "object") {
      const dev = usable.find((h) => {
        const q = h.object.userData.pick as Pick;
        return q.type === "device" && q.rackId === p.id;
      });
      if (dev && !first.object.userData.door)
        return { pick: dev.object.userData.pick as Pick, point: dev.point };
    }
    return { pick: p, point: first.point };
  }

  private objectIdOf(o: THREE.Object3D): number | null {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if (cur.userData.objectId !== undefined)
        return cur.userData.objectId as number;
      cur = cur.parent;
    }
    return null;
  }

  private findPickMesh(ref: Pick): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    this.objectsGroup.traverse((o) => {
      if (found) return;
      const p = o.userData.pick as Pick | undefined;
      if (!p || p.type !== ref.type) return;
      if (p.type === "device" && ref.type === "device" && p.id === ref.id)
        found = o;
      if (
        p.type === "cell" &&
        ref.type === "cell" &&
        p.shelfId === ref.shelfId &&
        p.cellNo === ref.cellNo
      )
        found = o;
    });
    return found;
  }

  private frontVector(rotation: number): THREE.Vector3 {
    const d: Record<Dir, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    const [x, z] = d[frontDir(rotation)];
    // From the front, a little above: over whatever stands in the aisle.
    return new THREE.Vector3(x, 0.85, z);
  }

  private floorPoint(ev: {
    clientX: number;
    clientY: number;
  }): THREE.Vector3 | null {
    this.setNdc(ev);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(FLOOR, p) ? p : null;
  }

  // --- Ruler ------------------------------------------------------------------

  /** Walls as boxes whose inner face is the floor line. */
  private wallBox(axis: 0 | 2, coord: number): Box {
    const b = bounds(this.model!.room.floor_plan);
    const H = this.model!.room.height_mm;
    const t = 60;
    if (axis === 0) {
      const outside = coord <= b.x0 ? -t : t;
      return {
        id: -1 - Math.round(coord),
        min: [Math.min(coord, coord + outside), 0, b.z0],
        max: [Math.max(coord, coord + outside), H, b.z1],
      };
    }
    const outside = coord <= b.z0 ? -t : t;
    return {
      id: -100000 - Math.round(coord),
      min: [b.x0, 0, Math.min(coord, coord + outside)],
      max: [b.x1, H, Math.max(coord, coord + outside)],
    };
  }

  private boxOf(e: Entry): Box {
    const r = e.solid.rect;
    return {
      id: e.obj.id,
      min: [r.x0, e.solid.y0, r.z0],
      max: [r.x1, e.solid.y1, r.z1],
    };
  }

  /** In an orthographic view from above, measure in the floor plane. */
  private planar(ev: { altKey: boolean }): boolean {
    if (ev.altKey || !this.rig.isOrtho) return false;
    const dir = new THREE.Vector3();
    this.rig.cam.getWorldDirection(dir);
    return dir.y < -0.9;
  }

  /** What the ruler would pick under the pointer: the snap, and the box. */
  private rulerPick(ev: {
    clientX: number;
    clientY: number;
  }): { snap: Snap; box: Box | null } | null {
    this.setNdc(ev);
    // Objects are measured by their envelope — an open frame or a glass door
    // still has faces — and the room by its walls and floor.
    const ray = this.ray.ray;
    let objHit: { e: Entry; point: THREE.Vector3; d: number } | null = null;
    for (const e of this.entries.values()) {
      const b = this.boxOf(e);
      const q = ray.intersectBox(
        new THREE.Box3(
          new THREE.Vector3(...b.min),
          new THREE.Vector3(...b.max),
        ),
        new THREE.Vector3(),
      );
      if (q) {
        const d = q.distanceTo(ray.origin);
        if (!objHit || d < objHit.d) objHit = { e, point: q, d };
      }
    }
    const room: THREE.Object3D[] = [];
    this.roomGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o.userData.wall || o.userData.floor))
        room.push(o);
    });
    const roomHit = this.ray.intersectObjects(room, false)[0];
    if (objHit && (!roomHit || objHit.d <= roomHit.distance)) {
      const r = this.renderer.domElement.getBoundingClientRect();
      const project = (q: Vec3): [number, number] => {
        const [x, y] = this.project(q);
        return [x + r.left, y + r.top];
      };
      const box = this.boxOf(objHit.e);
      const p: Vec3 = [objHit.point.x, objHit.point.y, objHit.point.z];
      return {
        snap: pickSnap(candidates(box, p), project, [ev.clientX, ev.clientY]),
        box,
      };
    }
    const hit = roomHit;
    if (!hit) return null;
    const p: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    const wall = hit.object.userData.wall as
      { axis: 0 | 2; coord: number } | undefined;
    if (wall) {
      // A wall is its plane at the floor line, wherever it was clicked.
      const box = this.wallBox(wall.axis, wall.coord);
      const q: Vec3 = [...p];
      q[wall.axis] = wall.coord;
      const face = {
        boxId: box.id,
        axis: wall.axis,
        side: (box.min[wall.axis] === wall.coord ? -1 : 1) as 1 | -1,
        coord: wall.coord,
        lo: [
          box.min[wall.axis === 0 ? 1 : 0],
          box.min[wall.axis === 0 ? 2 : 1],
        ] as [number, number],
        hi: [
          box.max[wall.axis === 0 ? 1 : 0],
          box.max[wall.axis === 0 ? 2 : 1],
        ] as [number, number],
      };
      return { snap: { kind: "face", p: q, face, boxId: box.id }, box };
    }
    if (hit.object.userData.floor) {
      const b = bounds(this.model!.room.floor_plan);
      const face = {
        boxId: 0,
        axis: 1 as const,
        side: 1 as const,
        coord: 0,
        lo: [b.x0, b.z0] as [number, number],
        hi: [b.x1, b.z1] as [number, number],
      };
      return {
        snap: { kind: "face", p: [p[0], 0, p[2]], face, boxId: 0 },
        box: null,
      };
    }
    return null;
  }

  /** The active snap, shown before the click. */
  private showSnap(ev: PointerEvent) {
    const pick = this.rulerPick(ev);
    if (!pick) {
      this.snapMarker.hidden = true;
      return;
    }
    const [x, y] = this.project(pick.snap.p);
    this.snapMarker.hidden = false;
    this.snapMarker.className = `dc-snap dc-snap-${this.rulerMode === "objects" ? "centre" : pick.snap.kind}`;
    this.snapMarker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.snapMarker.dataset.label =
      this.rulerMode === "objects" ? "" : this.text.snap(pick.snap.kind);
  }

  private rulerClick(ev: PointerEvent) {
    const pick = this.rulerPick(ev);
    if (!pick) return;
    if (!this.pending) {
      if (this.rulerMode === "objects" && !pick.box) return;
      this.pending = pick;
      this.refreshOverlays();
      return;
    }
    const first = this.pending;
    this.pending = null;
    let result: Result | null = null;
    if (this.rulerMode === "objects") {
      const a = first.box,
        b = pick.box;
      if (!a || !b || a.id === b.id) return this.refreshOverlays();
      const rect = (x: Box) => ({
        x0: x.min[0],
        z0: x.min[2],
        x1: x.max[0],
        z1: x.max[2],
      });
      const y = Math.max(a.min[1], b.min[1]) + 20;
      if (a.id < 0 && b.id < 0) result = null;
      else if (a.id < 0 || b.id < 0) {
        const wall = a.id < 0 ? first.snap : pick.snap;
        const obj = a.id < 0 ? b : a;
        const axis = wall.face!.axis as 0 | 2;
        result = wallGap(rect(obj), axis, wall.face!.coord, y);
      } else result = objectGap(rect(a), rect(b), y);
    } else {
      result = rulerMeasure(first.snap, pick.snap, {
        planar: this.planar(ev),
        lockAxis: ev.shiftKey,
      });
    }
    if (result) {
      this.measures.push(result);
      this.onRuler(this.measures);
    }
    this.refreshOverlays();
  }

  private bindInput() {
    const el = this.renderer.domElement;
    window.addEventListener("keydown", this.keydown);
    window.addEventListener("keyup", this.keyup);
    window.addEventListener("blur", this.blur);

    el.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        let dy =
          ev.deltaY * (ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? 400 : 1);
        if (ev.ctrlKey) dy *= 6;
        const s = Math.exp(Math.max(-260, Math.min(260, dy)) * 0.0011);
        this.setNdc(ev);
        const hit =
          this.ray.intersectObjects(this.pickables(), false)[0]?.point ??
          this.floorPoint(ev);
        this.rig.zoomAt(this.ndc.x, this.ndc.y, s, hit ?? null);
        this.dirty = true;
      },
      { passive: false },
    );

    el.addEventListener("pointerdown", (ev) => {
      el.focus();
      this.down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
      if (this.rig.walk.on) {
        el.setPointerCapture(ev.pointerId);
        return;
      }
      if (this.tool === "edit" && ev.button === 0) {
        const hit = this.pick(ev);
        if (hit && hit.pick.type === "object") {
          const e = this.entries.get(hit.pick.id);
          const fp = this.floorPoint(ev);
          if (e && fp && e.item.kind !== "structure") {
            this.drag = {
              id: e.obj.id,
              dx: fp.x - e.solid.rect.x0,
              dz: fp.z - e.solid.rect.z0,
              x0: e.solid.rect.x0,
              z0: e.solid.rect.z0,
              moved: false,
              pointerId: ev.pointerId,
            };
            this.rig.controls.enabled = false;
            el.setPointerCapture(ev.pointerId);
            if (
              this.selection?.type !== "object" ||
              this.selection.id !== e.obj.id
            ) {
              this.select({ type: "object", id: e.obj.id });
              this.onSelect(this.selection);
            }
          }
        }
      }
    });

    el.addEventListener("pointermove", (ev) => {
      if (this.rig.walk.on) {
        if (this.down && ev.buttons & 1) {
          this.rig.look(ev.movementX, ev.movementY);
          this.dirty = true;
        }
        return;
      }
      if (this.drag && ev.pointerId === this.drag.pointerId) {
        this.dragTo(ev);
        return;
      }
      const fp = this.floorPoint(ev);
      this.onCursor(fp ? { x: Math.round(fp.x), z: Math.round(fp.z) } : null);
      if (ev.buttons) return;
      if (this.tool === "ruler") {
        this.showSnap(ev);
        return;
      }
      const hit = this.pick(ev);
      const h = hit?.pick ?? null;
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h;
        this.labels.focus.clear();
        if (h)
          this.labels.focus.add(
            `obj:${h.type === "object" ? h.id : h.type === "device" ? h.rackId : h.shelfId}`,
          );
        const s = this.selection;
        if (s)
          this.labels.focus.add(
            `obj:${s.type === "object" ? s.id : s.type === "device" ? s.rackId : s.shelfId}`,
          );
        this.markBlockedCells();
        this.dirty = true;
      }
      this.onHover(h, ev.clientX, ev.clientY);
    });

    el.addEventListener("pointerleave", () => {
      this.onCursor(null);
      this.hover = null;
      this.markBlockedCells();
      this.onHover(null, 0, 0);
    });

    el.addEventListener("pointerup", (ev) => {
      const d = this.down;
      this.down = null;
      if (this.drag) {
        const dr = this.drag;
        this.drag = null;
        this.rig.controls.enabled = true;
        const e = this.entries.get(dr.id);
        if (e && dr.moved) {
          const r = e.solid.rect;
          this.onMoveCommit(dr.id, r.x0, r.z0, e.obj.rotation_deg);
        }
        return;
      }
      const click = d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5;
      if (!click) return;
      if (this.rig.walk.on) {
        const fp = this.floorPoint(ev);
        if (fp) this.rig.walkTo(fp.x, fp.z);
        return;
      }
      if (this.tool === "ruler") {
        this.rulerClick(ev);
        return;
      }
      if (this.tool === "note") {
        const hit = this.pick(ev);
        const p = hit?.point ?? this.floorPoint(ev);
        if (p)
          this.onPlaceNote([Math.round(p.x), Math.round(p.y), Math.round(p.z)]);
        return;
      }
      const hit = this.pick(ev);
      this.select(hit?.pick ?? null);
      this.onSelect(this.selection);
    });

    el.addEventListener("dblclick", (ev) => {
      const hit = this.pick(ev);
      if (hit) this.flyTo(hit.pick);
    });
  }

  private dragTo(ev: PointerEvent) {
    const dr = this.drag!;
    const e = this.entries.get(dr.id);
    const fp = this.floorPoint(ev);
    if (!e || !fp) return;
    const m = this.model!;
    const r = e.solid.rect;
    const fw = r.x1 - r.x0,
      fd = r.z1 - r.z0;
    const others = [...this.entries.values()]
      .filter(
        (o) =>
          o.obj.id !== dr.id &&
          (e.solid.y0 > 0 ? !o.solid.swing : onFloor(o.solid)),
      )
      .map((o) => o.solid.rect);
    const sn = snap(
      fp.x - dr.dx,
      fp.z - dr.dz,
      fw,
      fd,
      others,
      m.room.floor_plan,
      this.grid,
      !ev.altKey,
    );
    if (sn.x0 === r.x0 && sn.z0 === r.z0) return;
    dr.moved = true;
    this.moveEntry(e, sn.x0, sn.z0, e.obj.rotation_deg);
  }

  /** Show an object at a new place before the server confirms it. */
  previewMove(id: number, x0: number, z0: number, rotation: number) {
    const e = this.entries.get(id);
    if (e) this.moveEntry(e, x0, z0, rotation);
  }

  private moveEntry(e: Entry, x0: number, z0: number, rotation: number) {
    const m = this.model!;
    const moved: DcObject = {
      ...e.obj,
      x0_mm: x0,
      z0_mm: z0,
      rotation_deg: rotation as DcObject["rotation_deg"],
    };
    e.solid = solid(moved, e.item, m.room.floor_plan);
    e.obj = moved;
    e.sig = "";
    const g = e.built.group;
    g.position.set(
      (e.solid.rect.x0 + e.solid.rect.x1) / 2,
      moved.y0_mm,
      (e.solid.rect.z0 + e.solid.rect.z1) / 2,
    );
    g.rotation.y = (-rotation * Math.PI) / 180;
    // Red outline while the place is not allowed.
    const solids = [...this.entries.values()].map((x) => x.solid);
    const bad =
      problems(
        solids.indexOf(e.solid),
        solids,
        m.room.floor_plan,
        m.room.height_mm,
      ).length > 0;
    e.outline.material = this.lib.line(
      bad ? this.theme.warn : this.theme.accent,
    );
    e.outline.visible = true;
    this.labelEntry(
      e,
      m.devices.filter((d) => d.rack_id === e.obj.id),
    );
    this.refreshOverlays();
  }

  /** Problems with an object's current (possibly previewed) place. */
  problemsOf(id: number) {
    const m = this.model;
    const e = this.entries.get(id);
    if (!m || !e) return [];
    const solids = [...this.entries.values()].map((x) => x.solid);
    return problems(
      solids.indexOf(e.solid),
      solids,
      m.room.floor_plan,
      m.room.height_mm,
    );
  }

  // --- Loop --------------------------------------------------------------------------

  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.rig.resize(w, h);
    this.dirty = true;
  }

  private lastFrame = 0;

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const panAllowed = !(
      this.tool === "edit" && this.selection?.type === "object"
    );
    let moving = this.rig.update(now, dt, panAllowed);
    if (this.tickDoors(dt)) moving = true;
    const blinking =
      this.mode === "realistic" &&
      !this.rig.reducedMotion &&
      this.ledGroup.children.length > 0;
    if (blinking) this.tickLeds(now);
    if (!(moving || blinking || this.dirty)) {
      this.lastFrame = 0;
      return;
    }
    if (this.lastFrame) this.watchFrame(now - this.lastFrame);
    this.lastFrame = now;
    this.dirty = false;
    this.renderFrame();
    this.labels.update(
      this.rig.cam,
      this.host.clientWidth,
      this.host.clientHeight,
    );
    this.cube.update(this.rig.cam);
  };
}

export type { Rect, View, Preset };
