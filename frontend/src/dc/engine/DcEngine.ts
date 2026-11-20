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
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { mergeStatic } from "./merge";
import type { PostFx } from "./postfx";

import type {
  Annotation,
  CatalogItem,
  DcObject,
  Device,
  Measurement,
  RackProps,
  ShelfProps,
  Room,
  ShelfCell,
  ViewState,
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
  blockedCells,
  bounds,
  clearances,
  frontDir,
  objectDims,
  onFloor,
  problems,
  snap,
  solid,
  type ClearanceCheck,
  type Dir,
  type Rect,
  type Solid,
} from "../model/geometry";
import { freeRuns, rackStats, type RackStats } from "../model/devices";
import { U_MM } from "../model/geometry";
import { CameraRig, type Preset, type View } from "./camera";
import { Labels } from "./labels";
import { DEVICE_COLOR, MaterialLibrary, type Mode } from "./materials";
import { RENDERERS } from "./renderers";
import {
  baseRole,
  type Built,
  type DoorLeaf,
  type Pick,
} from "./renderers/types";
import { categorical, themeFromTokens, type DcTheme } from "./theme";
import { ownerSlots } from "../model/owners";
import type { DcTokens } from "../theme/tokens";
import { ViewCube } from "./viewCube";
import { allDims } from "./dimensions";
import { makeGrid, updateGrid } from "./grid";

export type { Mode } from "./materials";
export type Tool = "view" | "edit" | "ruler" | "note" | "section";
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
  assumed: string;
  /**
   * A rack's compact label under its name in the fill and power modes
   * (FEEDBACK-7 §1.4, §1.7): «31/42U · 9 кВт», or the known power and how
   * many devices have none; «содержимое не записано» when unrecorded.
   */
  rack: (s: RackStats, mode: "fill" | "power") => string;
  mm: (v: number) => string;
  range: (lo: number, hi: number) => string;
  /** A measurement's dimension text, tooltip, and whether to mark it. */
  measurement: (m: Measurement) => {
    text: string;
    title: string;
    mark: boolean;
  };
  /** A ruler result: `face ⟂ face · 59.5 cm`, in the user's language. */
  ruler: (r: Result) => string;
  /**
   * A clearance zone's label: side, value, requirement and basis, and the
   * model and tape both when they disagree about it.
   */
  clearance: (c: ClearanceCheck) => string;
  /** A warning pin's short label: «сзади 55,5 см». */
  pin: (c: ClearanceCheck) => string;
  /** A cooling unit over occupied cells: the pin's label and its full text. */
  condensate: (cells: number[]) => { pin: string; title: string };
  snap: (k: SnapKind) => string;
}

/**
 * What the view draws besides the room (FEEDBACK-6 §1), from the rail's
 * layers list. By default: the room's overall dimensions, the service zones
 * that are violated (as pins) and the objects' labels — nothing else.
 */
export interface Layers {
  /** The room's overall dimensions only. */
  room: boolean;
  /** The plan's chain dimensions outside the outline (FEEDBACK-7 §1.2). */
  chains: boolean;
  /** Gaps between objects (tape measurements that position things). */
  gaps: boolean;
  /** The other tape measurements (sizes). */
  tape: boolean;
  /** The selected object's own dimensions and its gaps to its neighbours. */
  selection: boolean;
  /** Service zones: only violated ones are drawn, each with a pin. */
  zones: boolean;
  /** Objects' names. */
  names: boolean;
  /** The ceiling's tube lights in schema and on the plan (FEEDBACK-7 §1.8). */
  lights: boolean;
  /** Assumed values outlined and badged. */
  assumptions: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  room: true,
  chains: true,
  gaps: false,
  tape: false,
  selection: true,
  zones: true,
  names: true,
  lights: false,
  assumptions: false,
};

/** The marks drawn in the view, for the plan legend (FEEDBACK-5 §2). */
export interface LegendMarks {
  /** Dashed outlines: things that hang above the floor. */
  overhead: boolean;
  /** A dimension whose tape reading and model disagree. */
  tapeDot: boolean;
  /** Requirements of the red zones drawn (mm), ascending. */
  short: number[];
  /** An amber zone: model and tape on different sides of the requirement. */
  split: boolean;
}

export type Measure = Result;
export type RulerMode = "points" | "objects";

/** The section box, mm (FEEDBACK-7 §4.4). */
export interface SectionBox {
  min: Vec3;
  max: Vec3;
}
/** How to set it: the room's bounds, a horizontal cut at a height, a
 * vertical cut through the rack row, or a box. */
export type SectionInput =
  | SectionBox
  | { kind: "room" }
  | { kind: "horizontal"; height: number }
  | { kind: "rackRow" };

/** A cut face's colour: the object's own in the schema. */
function capColour(kind: CatalogItem["kind"], t: DcTheme): string {
  return kind === "rack"
    ? t.tokens.rackFill
    : kind === "cooling"
      ? t.tokens.coolingFill
      : t.tokens.objectFill;
}

interface Entry {
  sig: string;
  obj: DcObject;
  item: CatalogItem;
  solid: Solid;
  built: Built;
  /** Door angles, front and rear, 0 = closed. */
  doorAngle: { front: number; rear: number };
  doorTarget: { front: number; rear: number };
  outline: THREE.LineSegments;
  assumedOutline: THREE.LineSegments | null;
  /** Thin outline of the object's box in schema (dashed when overhead). */
  edges: THREE.LineSegments;
  /** A shelf's blocked cells as built (they follow a dragged unit). */
  blocked: number[];
  /** Opacity now and where it is going: X-ray, occluder fade (FEEDBACK-7 §4.3). */
  alpha: number;
  alphaTarget: number;
}

/** The power mode without a budget: kW at the top of its scale (FEEDBACK-7 §1.7). */
export const POWER_SCALE_W = 10000;

const UP = new THREE.Vector3(0, 1, 0);
const FLOOR = new THREE.Plane(UP, 0);
/** How far a rack door opens, outwards into the aisle: 110°. */
const OPEN_ANGLE = (110 * Math.PI) / 180;

/** Which door a leaf (or a part of it) belongs to: its pivot says outward. */
function doorSide(o: THREE.Object3D): "front" | "rear" {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (cur.userData.outward !== undefined)
      return cur.userData.outward < 0 ? "front" : "rear";
    cur = cur.parent;
  }
  return "front";
}

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
  /** A clearance warning clicked: its gap is drawn like a ruler result. */
  private clearanceFocus: { objectId: number; side: "front" | "rear" } | null =
    null;
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
  private ledMats = new Map<string, THREE.PointsMaterial>();
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
  /** The set of marks drawn changed. */
  onLegend: (m: LegendMarks) => void = () => {};
  /**
   * On the plan, the user turned the view (right drag, a view cube face, a
   * preset, perspective, walking): the page leaves for 3D and flies to
   * `preset` there.
   */
  onLeavePlan: (preset: Preset) => void = () => {};
  /**
   * A warning pin clicked: the page explains it and frames the gap (a
   * clearance), or selects the unit (a cooling unit over occupied cells).
   */
  onPin: (objectId: number, side: "front" | "rear" | "cooling") => void =
    () => {};
  private layers: Layers = { ...DEFAULT_LAYERS };
  /** The plan: straight down, orbit off — only pan and zoom. */
  private planLock = false;
  /** A right drag started on the plan (where it turns into 3D). */
  private turnFrom: { x: number; y: number } | null = null;
  private legendSig = "";
  private disposed = false;

  // View state (FEEDBACK-7 §4): this viewer's, saved with views, never in
  // the room's revisions.
  private hidden = new Set<number>();
  private locked = new Set<number>();
  private isolated: Set<number> | null = null;
  private xray = false;
  private fadeOn = true;
  private openDoors = new Map<number, "front" | "rear">();
  private section: SectionBox | null = null;
  private readonly sectionGroup = new THREE.Group();
  private readonly hoverGroup = new THREE.Group();
  private floorGrid: THREE.Mesh | null = null;
  private sectionDrag: {
    axis: 0 | 1 | 2;
    end: "min" | "max";
    pointerId: number;
  } | null = null;
  /** Objects faded because they stand between the camera and the focus. */
  private occluders = new Set<number>();
  /** The dimensions drawn now, with their layers (tests). */
  private drawnDims: { key: string; layer: string }[] = [];
  private occludersAt = 0;
  /** The view state changed in the view (a door, the section box). */
  onViewState: () => void = () => {};
  /**
   * A door opened less than 110°: the rack, which door, how far, and the
   * object in the way (null: a wall).
   */
  onDoorLimited: (
    rack: string,
    side: "front" | "rear",
    deg: number,
    by: string | null,
  ) => void = () => {};

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
      // The section box's caps count cuts in the stencil buffer.
      stencil: true,
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    RectAreaLightUniformsLib.init();
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
    this.cube = new ViewCube(
      host,
      (p) => this.preset(p),
      (d) => this.viewFrom(d),
    );
    this.scene.add(
      this.roomGroup,
      this.objectsGroup,
      this.overlay,
      this.dims,
      this.ledGroup,
      this.lights,
      this.sectionGroup,
      this.hoverGroup,
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
    // The room's front is where the racks' fronts face (FEEDBACK-7 §2.1).
    const front = new THREE.Vector3();
    for (const e of this.entries.values())
      if (e.item.kind === "rack")
        front.add(this.frontVector(e.solid.rotation).setY(0));
    if (front.lengthSq() > 0.01) {
      front.normalize();
      this.rig.front.set(front.x, front.z);
      this.cube.setFront(this.rig.front);
    }
    this.rebuildLeds();
    this.markBlockedCells();
    this.applyVisibility();
    if (this.section) this.applySection();
    this.occludersAt = 0;
    this.refreshOverlays();
    if (first) this.preset("iso", 0);
    this.dirty = true;
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lib.reset(mode, this.theme);
    // Realistic is exposed like the renders; schema keeps its flat colours.
    this.renderer.toneMapping =
      mode === "realistic" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.ensurePostFx();
    this.scene.environment = mode === "realistic" ? this.env() : null;
    this.applyQuality();
    this.labels.showNames = this.layers.names;
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
    // The section box's handles show while its tool is on.
    if (this.section) this.applySection();
  }

  setGrid(mm: number) {
    this.grid = mm;
  }

  /** "Show assumptions": outline and badge objects with assumed values. */
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

  /** What to draw besides the room (the rail's layers list). */
  setLayers(l: Layers) {
    const lights = l.lights !== this.layers.lights;
    this.layers = { ...l };
    this.labels.showNames = l.names;
    if (lights) this.buildRoom();
    if (l.assumptions !== this.showAssumptions)
      this.setShowAssumptions(l.assumptions);
    this.refreshOverlays();
  }

  /** The labels on screen in the last frame, by key (tests). */
  labelsShown(): string[] {
    return this.labels.shown();
  }

  /** Look at the room from `dir` (a view cube edge or corner). */
  viewFrom(dir: [number, number, number]) {
    this.updateSafe();
    if (this.planLock) {
      this.onLeavePlan("iso");
      return;
    }
    const m = this.model;
    if (!m) return;
    const b = bounds(m.room.floor_plan);
    const radius = 0.5 * Math.hypot(b.x1 - b.x0, m.room.height_mm, b.z1 - b.z0);
    const c = new THREE.Vector3((b.x0 + b.x1) / 2, 900, (b.z0 + b.z1) / 2);
    const d = new THREE.Vector3(...dir);
    d.y = Math.max(d.y, 0.08);
    d.normalize();
    this.rig.go({
      position: c
        .clone()
        .addScaledVector(d, this.rig.fitDistance(radius))
        .toArray() as [number, number, number],
      target: c.toArray() as [number, number, number],
      fov: 45,
      ortho: false,
    });
    this.dirty = true;
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

  /** Blocked cells' marks and whether each is shown (realistic mode; tests). */
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
    // The clearance shown belongs to its rack: selecting anything else ends it.
    const selObj = !ref
      ? null
      : ref.type === "object"
        ? ref.id
        : ref.type === "device"
          ? ref.rackId
          : ref.shelfId;
    if (this.clearanceFocus?.objectId !== selObj) this.clearanceFocus = null;
    for (const e of this.entries.values()) {
      const rackOfDevice = ref?.type === "device" && ref.rackId === e.obj.id;
      e.outline.visible =
        (ref?.type === "object" && ref.id === e.obj.id) ||
        rackOfDevice ||
        (ref?.type === "cell" && ref.shelfId === e.obj.id);
      // A device inside opens its rack's front; a door opened by a double
      // click stays open (a view setting, FEEDBACK-7 §4.6).
      this.aimDoors(e, rackOfDevice);
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

  /**
   * Draw a rack's front or rear clearance gap with its dimension, as the
   * ruler does (FEEDBACK-3 §3), until something else is selected.
   */
  showClearance(objectId: number, side: "front" | "rear") {
    this.updateSafe();
    this.clearanceFocus = { objectId, side };
    this.refreshOverlays();
    // The camera frames the gap (FEEDBACK-6 §1); the plan stays a plan.
    const c = this.focusedClearance();
    if (c && !this.planLock) {
      const [a, b] = [c.gap.from, c.gap.to];
      this.rig.focus(
        new THREE.Vector3((a[0] + b[0]) / 2, 700, (a[1] + b[1]) / 2),
        Math.max(1100, c.mm * 1.6),
      );
      this.dirty = true;
    }
  }

  /** The clearance gap drawn by `showClearance`, mm (tests). */
  shownClearance(): { objectId: number; side: string; mm: number } | null {
    const c = this.focusedClearance();
    return c ? { objectId: c.objectId, side: c.side, mm: c.mm } : null;
  }

  /** The clearance zones drawn on the floor, and how (tests). */
  clearanceZones(): { objectId: number; side: string; state: string }[] {
    return this.overlay.children
      .filter((o) => o.userData.clearance)
      .map((o) => ({ ...o.userData.clearance }));
  }

  flyTo(ref: Pick) {
    this.updateSafe();
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
    // From where it can be seen (FEEDBACK-7 §2.2); what is still in the way
    // fades.
    this.rig.focus(centre, radius, this.bestDirection(e, radius));
    this.occludersAt = 0;
  }

  /**
   * Of the eight horizontal directions at 35° down, the one from which the
   * object is least hidden — rays from its box's corners and centre to the
   * camera's place, counting the other objects they cross — with the current
   * direction preferred on a tie (FEEDBACK-7 §2.2).
   */
  bestDirection(e: Entry, radius: number): THREE.Vector3 {
    const b = this.box3(e);
    const c = b.getCenter(new THREE.Vector3());
    const dist = this.rig.fitDistance(radius) * 1.15;
    const others = [...this.entries.values()]
      .filter((o) => o !== e && this.visibleEntry(o))
      .map((o) => this.box3(o));
    const cur = this.rig.cam.position.clone().sub(this.rig.controls.target);
    cur.y = 0;
    cur.normalize();
    const down = (35 * Math.PI) / 180;
    const pts = [c];
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y + 1, b.max.y - 1])
        for (const z of [b.min.z, b.max.z])
          pts.push(new THREE.Vector3(x, y, z));
    const room = this.model ? bounds(this.model.room.floor_plan) : null;
    let best: { d: THREE.Vector3; score: number } | null = null;
    const ray = new THREE.Ray();
    const hit = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const d = new THREE.Vector3(
        Math.cos(a) * Math.cos(down),
        Math.sin(down),
        Math.sin(a) * Math.cos(down),
      );
      const eye = c.clone().addScaledVector(d, dist);
      let score = 0;
      for (const p of pts) {
        ray.set(eye, p.clone().sub(eye).normalize());
        const len = p.distanceTo(eye);
        // A ray is hidden or not, whatever hides it.
        if (
          others.some(
            (o) => ray.intersectBox(o, hit) && hit.distanceTo(eye) < len - 20,
          )
        )
          score++;
      }
      // A camera outside the room looks through a wall in realistic.
      if (
        room &&
        (eye.x < room.x0 ||
          eye.x > room.x1 ||
          eye.z < room.z0 ||
          eye.z > room.z1)
      )
        score += 0.5;
      // The current direction wins a tie; then the front.
      const flat = new THREE.Vector3(d.x, 0, d.z).normalize();
      score -= 0.25 * flat.dot(cur);
      if (e.item.kind === "rack")
        score -=
          0.2 *
          flat.dot(this.frontVector(e.solid.rotation).setY(0).normalize());
      if (!best || score < best.score) best = { d, score };
    }
    return best!.d;
  }

  /**
   * Detail that costs more than it shows from afar (the racks' cable
   * bundles) is drawn within 4 m of the camera only (FEEDBACK-7 §5).
   */
  private updateNear() {
    const cam = this.rig.cam.position;
    for (const e of this.entries.values())
      for (const c of e.built.group.children)
        if (c.userData.near)
          c.visible = e.built.group.position.distanceTo(cam) < 4000;
  }

  /**
   * The mean time of `n` frames rendered back to back, ms (the PR's frame
   * times; on a GPU, not representative under software WebGL).
   */
  frameTime(n = 60): number {
    this.renderFrame();
    const gl = this.renderer.getContext();
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.renderFrame();
    gl.finish();
    return (performance.now() - t0) / n;
  }

  /** The hovered device outlined (FEEDBACK-7 §4.6). */
  private outlineHover() {
    disposeTree(this.hoverGroup);
    this.hoverGroup.clear();
    const h = this.hover;
    if (h?.type === "device") {
      const mesh = this.findPickMesh(h);
      if (mesh) {
        const b = new THREE.Box3().setFromObject(mesh);
        const size = b.getSize(new THREE.Vector3()).addScalar(8);
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(
            new THREE.BoxGeometry(size.x, size.y, size.z),
          ),
          this.lib.line(this.theme.accent),
        );
        b.getCenter(line.position);
        line.renderOrder = 999;
        this.hoverGroup.add(line);
      }
    }
    this.dirty = true;
  }

  /** The device under the pointer, if any (the owner highlight's `H`). */
  hoveredDevice(): number | null {
    return this.hover?.type === "device" ? this.hover.id : null;
  }

  /** Frame the selection (F, `.`), or everything without one (Home). */
  frameSelection() {
    const sel = this.selection;
    if (sel) this.flyTo(sel);
    else this.frameAll();
  }

  /** Fit the whole room into the view from the current direction. */
  frameAll() {
    if (this.planLock) return this.preset("top");
    const m = this.model;
    if (!m) return;
    this.updateSafe();
    const b = bounds(m.room.floor_plan);
    const c = new THREE.Vector3(
      (b.x0 + b.x1) / 2,
      m.room.height_mm * 0.35,
      (b.z0 + b.z1) / 2,
    );
    const radius = 0.5 * Math.hypot(b.x1 - b.x0, m.room.height_mm, b.z1 - b.z0);
    const d = this.rig.cam.position
      .clone()
      .sub(this.rig.controls.target)
      .normalize();
    this.rig.go({
      position: c
        .clone()
        .addScaledVector(d, this.rig.fitDistance(radius))
        .toArray() as Vec3,
      target: c.toArray() as Vec3,
      fov: this.rig.persp.fov,
      ortho: this.rig.isOrtho,
      halfHeight: this.rig.fitHalfHeight(radius, radius * 0.8),
    });
    this.dirty = true;
  }

  /**
   * Lock the camera to the plan (FEEDBACK-5 §4): orthographic, straight
   * down, no orbit — the left button pans, the wheel zooms. Turning the view
   * asks the page to leave the plan (`onLeavePlan`).
   */
  setPlanLock(on: boolean) {
    this.planLock = on;
    const c = this.rig.controls;
    c.enableRotate = !on;
    c.mouseButtons = on
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null }
      : {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        };
    c.touches = on
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.dirty = true;
    this.refreshOverlays();
  }

  /**
   * The plan from above, framed like a drawing sheet (`Drawing.png`): the
   * room with its chains and overall dimensions in the area above the
   * bottom band — the title block, the legend and the mode bar live there —
   * and clear of the tool rail on the left.
   */
  private framePlan(flip = false) {
    const m = this.model!;
    const b = bounds(m.room.floor_plan);
    // The drawing's real extent (FEEDBACK-7 follow-up): the room, its chains
    // and its overall dimensions as the layers draw them; then fitted to
    // the visible rectangle and centred in it.
    const ext = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 };
    const specs = allDims(
      {
        floorPlan: m.room.floor_plan,
        measurements: m.room.measurements.entries,
        solids: [...this.entries.values()].map((e) => e.solid),
        selected: null,
        plan: true,
        schema: true,
        measurement: this.text.measurement,
        mm: this.text.mm,
      },
      null,
      null,
    );
    for (const sp of specs)
      if (this.layers[sp.layer])
        for (const p of [sp.a, sp.b]) {
          ext.x0 = Math.min(ext.x0, p[0]);
          ext.x1 = Math.max(ext.x1, p[0]);
          ext.z0 = Math.min(ext.z0, p[2]);
          ext.z1 = Math.max(ext.z1, p[2]);
        }
    const [bw, bh] = [ext.x1 - ext.x0, ext.z1 - ext.z0];
    const cx = (ext.x0 + ext.x1) / 2,
      cz = (ext.z0 + ext.z1) / 2;
    this.updateSafe({ w: bw, h: bh }, 44);
    this.rig.go({
      position: [cx, 12000, cz + (flip ? -1 : 1)],
      target: [cx, 0, cz],
      fov: 45,
      ortho: true,
      halfHeight: this.rig.fitHalfHeight(bw / 2, bh / 2),
    });
  }

  /**
   * The viewport's panels, in host pixels: the inspector, the rail, the
   * outliner, the bars, the chips, the view cube, the plan's sheet corner.
   */
  private panelRects(): { el: Element; r: Rect }[] {
    const host = this.host.getBoundingClientRect();
    const out: { el: Element; r: Rect }[] = [];
    this.host
      .querySelectorAll(
        ".dc-panel, .dc-cube-wrap, .dc-plan-corner > *, .dc-statusbar",
      )
      .forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return;
        out.push({
          el,
          r: {
            x0: b.left - host.left,
            z0: b.top - host.top,
            x1: b.right - host.left,
            z1: b.bottom - host.top,
          },
        });
      });
    return out;
  }

  /**
   * The part of the canvas no panel covers (FEEDBACK-7 §1.3): the canvas
   * minus the inspector, the rail and outliner, the bottom bar (and the plan's
   * sheet corner) and the chips at the top left. Every framing fits into it.
   */
  private updateSafe(fit?: { w: number; h: number }, margin = 0) {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    const s = { x0: 0, y0: 0, x1: w, y1: h };
    const gapPx = 16;
    let corner: Rect | null = null;
    for (const { el, r } of this.panelRects()) {
      if (el.matches(".dc-inspector")) s.x1 = Math.min(s.x1, r.x0 - gapPx);
      else if (el.matches(".dc-rail, .dc-outliner"))
        s.x0 = Math.max(s.x0, r.x1 + gapPx);
      else if (el.matches(".dc-modebar, .dc-statusbar"))
        s.y1 = Math.min(s.y1, r.z0 - gapPx);
      else if (this.planLock && el.closest(".dc-plan-corner"))
        corner = corner
          ? {
              x0: Math.min(corner.x0, r.x0),
              z0: Math.min(corner.z0, r.z0),
              x1: Math.max(corner.x1, r.x1),
              z1: Math.max(corner.z1, r.z1),
            }
          : { ...r };
      else if (el.closest(".dc-chips") && r.z0 < h / 3)
        s.y0 = Math.max(s.y0, r.z1 + gapPx);
    }
    // The plan's sheet corner (title block, legend), bottom right: the room
    // stands above it or beside it, whichever draws it larger.
    if (corner) {
      // The whole visible rectangle, unless the fitted drawing would run
      // under the corner; then above it or beside it, whichever draws larger.
      const c = corner;
      const scale = (r: typeof s) =>
        fit
          ? Math.min((r.x1 - r.x0) / fit.w, (r.y1 - r.y0) / fit.h)
          : (r.x1 - r.x0) * (r.y1 - r.y0);
      const clear = (r: typeof s) => {
        if (!fit) return false;
        const k = scale(r);
        const [mx, my] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
        const [hw, hh] = [(fit.w * k) / 2, (fit.h * k) / 2];
        return (
          mx + hw <= c.x0 ||
          mx - hw >= c.x1 ||
          my + hh <= c.z0 ||
          my - hh >= c.z1
        );
      };
      const above = { ...s, y1: Math.min(s.y1, c.z0 - gapPx) };
      const beside = { ...s, x1: Math.min(s.x1, c.x0 - gapPx) };
      if (!clear(s))
        Object.assign(s, scale(above) >= scale(beside) ? above : beside);
    }
    // Room for the outermost labels, which stand past their lines.
    if (fit && margin) {
      s.x0 += margin;
      s.x1 -= margin;
      s.y0 += margin;
      s.y1 -= margin;
    }
    this.rig.setSafe(s);
  }

  /** The dimensions drawn now and the layer of each (tests). */
  drawnDimensions(): { key: string; layer: string }[] {
    return [...this.drawnDims];
  }

  /** The uncovered part of the canvas, px (tests). */
  safeRect() {
    this.updateSafe();
    return this.rig.safeRect();
  }

  /** Whether the camera is locked to the plan (tests). */
  planLocked(): boolean {
    return this.planLock;
  }

  preset(p: Preset, dur?: number) {
    this.updateSafe();
    if (this.planLock && p !== "top" && p !== "bottom") {
      this.onLeavePlan(p);
      return;
    }
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
    } else if ((p === "top" || p === "bottom") && m)
      this.framePlan(p === "bottom");
    else this.rig.preset(p);
    if (dur === 0) this.rig.update(performance.now() + 10000, 0, false);
    this.dirty = true;
  }

  setOrtho(on: boolean) {
    if (this.planLock && !on) {
      this.onLeavePlan("iso");
      return;
    }
    this.rig.setOrtho(on);
  }

  setWalk(on: boolean) {
    if (this.planLock && on) {
      this.onLeavePlan("iso");
      return;
    }
    this.rig.setWalk(on);
    this.dirty = true;
  }

  view(): View {
    return this.rig.view();
  }

  goView(v: View, dur?: number) {
    this.updateSafe();
    this.rig.go(v, dur);
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
    if (this.floorGrid)
      updateGrid(
        this.floorGrid,
        this.rig.cam,
        this.rig.controls.target,
        Math.max(1, this.host.clientHeight),
      );
    // The section's caps need the stencil buffer, which the post pass lacks.
    if (
      this.mode === "realistic" &&
      this.quality === 2 &&
      this.composer &&
      !this.section
    )
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
    // The ceiling tubes' area lights cost per pixel; at quality 0 the
    // tubes still glow, the room is lit by the sky and the sun.
    this.roomGroup.traverse((o) => {
      if (o.userData.areaLight) o.visible = this.quality > 0;
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
      // Templates drop their small detail at the lower tiers.
      this.rebuildAll();
      this.onQuality(this.quality);
    }
  }

  /**
   * A small render of a saved view (FEEDBACK-7 §1.5), as a JPEG data URL:
   * the scene as it is now, from the view's camera, off screen.
   */
  thumbnail(v: View, w = 144, h = 96): string {
    const [px, py, pz] = v.position;
    let cam: THREE.Camera;
    if (v.ortho) {
      const hh =
        v.halfHeight ??
        Math.hypot(px - v.target[0], py - v.target[1], pz - v.target[2]) *
          Math.tan((v.fov * Math.PI) / 360);
      cam = new THREE.OrthographicCamera(
        (-hh * w) / h,
        (hh * w) / h,
        hh,
        -hh,
        -60000,
        120000,
      );
    } else cam = new THREE.PerspectiveCamera(v.fov, w / h, 20, 120000);
    cam.position.set(px, py, pz);
    cam.lookAt(...v.target);
    cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    const px8 = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px8);
    this.renderer.setRenderTarget(prev);
    rt.dispose();
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const img = new ImageData(w, h);
    // The render target's rows run bottom up.
    for (let y = 0; y < h; y++)
      img.data.set(
        px8.subarray((h - 1 - y) * w * 4, (h - y) * w * 4),
        y * w * 4,
      );
    out.getContext("2d")!.putImageData(img, 0, 0);
    this.dirty = true;
    return out.toDataURL("image/jpeg", 0.82);
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

  // --- View state: hide, lock, isolate, X-ray, fade, section (FEEDBACK-7 §4) ---

  /** The view state besides the layers (the page owns those). */
  viewState(): Omit<ViewState, "layers"> {
    return {
      xray: this.xray,
      hidden: [...this.hidden],
      locked: [...this.locked],
      isolate: this.isolated ? [...this.isolated] : [],
      section: this.section
        ? {
            min: this.section.min.map(Math.round) as Vec3,
            max: this.section.max.map(Math.round) as Vec3,
          }
        : null,
      doors: [...this.openDoors].map(([id, side]) => ({ id, side })),
    };
  }

  /** Apply a saved view's state (what it does not say is cleared). */
  setViewState(s: Omit<ViewState, "layers">) {
    this.hidden = new Set(s.hidden ?? []);
    this.locked = new Set(s.locked ?? []);
    this.isolated = s.isolate?.length ? new Set(s.isolate) : null;
    this.xray = !!s.xray;
    this.openDoors = new Map((s.doors ?? []).map((d) => [d.id, d.side]));
    for (const e of this.entries.values()) {
      const sel = this.selection;
      this.aimDoors(e, sel?.type === "device" && sel.rackId === e.obj.id);
    }
    this.section = s.section
      ? {
          min: [...s.section.min] as Vec3,
          max: [...s.section.max] as Vec3,
        }
      : null;
    this.applyVisibility();
    this.applySection();
  }

  /** Hide objects in the viewport, for this viewer (the outliner's eye). */
  setHidden(ids: number[]) {
    this.hidden = new Set(ids);
    this.applyVisibility();
  }

  /** Objects that cannot be selected in the viewport (the outliner's lock). */
  setLocked(ids: number[]) {
    this.locked = new Set(ids);
  }

  /** Show only these objects («Только выбранное»); null shows everything. */
  setIsolate(ids: number[] | null) {
    this.isolated = ids?.length ? new Set(ids) : null;
    this.applyVisibility();
    if (this.isolated) {
      const sel = this.selectedEntry();
      if (sel) this.flyTo({ type: "object", id: sel.obj.id });
    }
  }

  isolatedIds(): number[] {
    return this.isolated ? [...this.isolated] : [];
  }

  /** X-ray: every object at 30 %, outlines kept (FEEDBACK-7 §4.3). */
  setXray(on: boolean) {
    this.xray = on;
    this.applyVisibility();
  }

  /** Fade what stands between the camera and the focus (on by default). */
  setOccluderFade(on: boolean) {
    this.fadeOn = on;
    this.occludersAt = 0;
    this.applyVisibility();
  }

  /** The objects faded right now (tests). */
  fadedIds(): number[] {
    return [...this.entries.values()]
      .filter((e) => e.alphaTarget < 0.5)
      .map((e) => e.obj.id);
  }

  private visibleEntry(e: Entry): boolean {
    return (
      !this.hidden.has(e.obj.id) &&
      (!this.isolated || this.isolated.has(e.obj.id))
    );
  }

  /** Visibility and target opacity of every object, from the view state. */
  private applyVisibility() {
    const hiddenRefs = new Set<string>();
    for (const e of this.entries.values()) {
      const on = this.visibleEntry(e);
      e.built.group.visible = on;
      if (!on) hiddenRefs.add(`obj:${e.obj.id}`);
      e.edges.visible = this.mode !== "realistic" || this.xray;
      const base = this.xray ? 0.3 : 1;
      e.alphaTarget =
        this.fadeOn && this.occluders.has(e.obj.id)
          ? Math.min(base, 0.15)
          : base;
    }
    for (const o of this.overlay.children)
      if (o.userData.clearance || o.userData.zoneOf)
        o.visible = !hiddenRefs.has(
          `obj:${(o.userData.clearance ?? o.userData.zoneOf).objectId}`,
        );
    for (const h of this.ledGroup.children)
      h.visible = !hiddenRefs.has(`obj:${h.userData.objectId}`);
    this.labels.hiddenRefs = hiddenRefs;
    this.dirty = true;
  }

  /** Move opacities toward their targets, 150 ms end to end. */
  private tickFade(dt: number): boolean {
    let moving = false;
    for (const e of this.entries.values()) {
      if (e.alpha === e.alphaTarget) continue;
      const step = this.rig.reducedMotion ? 1 : dt / 0.15;
      e.alpha =
        e.alpha < e.alphaTarget
          ? Math.min(e.alphaTarget, e.alpha + step)
          : Math.max(e.alphaTarget, e.alpha - step);
      this.applyMaterials(e);
      moving = true;
    }
    return moving;
  }

  /**
   * What stands between the camera and the focus — the selection, else the
   * racks — by rays to the focus's centre and corners (FEEDBACK-7 §2.1, §4.3).
   */
  private findOccluders(): Set<number> {
    const out = new Set<number>();
    if (!this.fadeOn || this.planLock || this.rig.walk.on) return out;
    const sel = this.selectedEntry();
    const targets = sel
      ? [sel]
      : [...this.entries.values()].filter((e) => e.item.kind === "rack");
    const cam = this.rig.cam.position;
    const dir = this.rig.cam.getWorldDirection(new THREE.Vector3());
    const boxes = [...this.entries.values()]
      .filter((e) => this.visibleEntry(e))
      .map((e) => ({ e, box: this.box3(e) }));
    const ray = new THREE.Ray();
    const hit = new THREE.Vector3();
    for (const t of targets) {
      const b = this.box3(t);
      const c = b.getCenter(new THREE.Vector3());
      const pts = [c];
      for (const x of [0.15, 0.85])
        for (const y of [0.2, 0.8])
          for (const z of [0.15, 0.85])
            pts.push(
              new THREE.Vector3(
                b.min.x + (b.max.x - b.min.x) * x,
                b.min.y + (b.max.y - b.min.y) * y,
                b.min.z + (b.max.z - b.min.z) * z,
              ),
            );
      for (const p of pts) {
        // An orthographic camera looks along one direction.
        const from = this.rig.isOrtho
          ? p.clone().addScaledVector(dir, -50000)
          : cam;
        const d = p.distanceTo(from);
        ray.set(from, p.clone().sub(from).normalize());
        for (const { e, box } of boxes) {
          if (targets.includes(e) || out.has(e.obj.id)) continue;
          if (box.containsPoint(from)) continue;
          if (ray.intersectBox(box, hit) && hit.distanceTo(from) < d - 30)
            out.add(e.obj.id);
        }
      }
    }
    return out;
  }

  private box3(e: Entry): THREE.Box3 {
    const r = e.solid.rect;
    return new THREE.Box3(
      new THREE.Vector3(r.x0, e.solid.y0, r.z0),
      new THREE.Vector3(r.x1, e.solid.y1, r.z1),
    );
  }

  /** Recompute the faded objects now and then while the view changes. */
  private updateOccluders(now: number) {
    if (now - this.occludersAt < 120) return;
    this.occludersAt = now;
    const next = this.findOccluders();
    const same =
      next.size === this.occluders.size &&
      [...next].every((id) => this.occluders.has(id));
    if (same) return;
    this.occluders = next;
    this.applyVisibility();
  }

  /**
   * The section box (FEEDBACK-7 §4.4): the scene clipped to an axis-aligned
   * box, from a typed preset or by dragging its faces. Null removes it.
   */
  setSection(s: SectionInput | null) {
    const m = this.model;
    if (!m) return;
    const b = bounds(m.room.floor_plan);
    const H = m.room.height_mm;
    const room: SectionBox = {
      min: [b.x0, -20, b.z0],
      max: [b.x1, H + 20, b.z1],
    };
    if (s === null) this.section = null;
    else if ("min" in s) this.section = { min: [...s.min], max: [...s.max] };
    else if (s.kind === "room") this.section = room;
    else if (s.kind === "horizontal")
      this.section = {
        min: room.min,
        max: [room.max[0], s.height, room.max[2]],
      };
    else {
      // Through the rack row, along its fronts' line: the half nearer the
      // fronts stays, the cut shows the racks from the side of their rears.
      const racks = [...this.entries.values()].filter(
        (e) => e.item.kind === "rack",
      );
      if (!racks.length) this.section = room;
      else {
        const z0 = Math.min(...racks.map((e) => e.solid.rect.z0));
        const z1 = Math.max(...racks.map((e) => e.solid.rect.z1));
        this.section = {
          min: room.min,
          max: [room.max[0], room.max[1], Math.round((z0 + z1) / 2)],
        };
      }
    }
    this.applySection();
    this.onViewState();
  }

  /** The section box, mm, or null (the airflow slices attach to it later). */
  sectionBox(): SectionBox | null {
    return this.section
      ? { min: [...this.section.min], max: [...this.section.max] }
      : null;
  }

  /** Clip the scene to the box; cap what it cuts; its outline and handles. */
  private applySection() {
    disposeTree(this.sectionGroup);
    this.sectionGroup.clear();
    const s = this.section;
    // What the box cuts away casts no shadow either: shadow maps are not
    // clipped unless asked, and the cut-away ceiling and lights left a
    // speckle of shadow on the walls below the cut.
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        if (mat.clipShadows !== !!s) {
          mat.clipShadows = !!s;
          mat.needsUpdate = true;
        }
    });
    this.labels.clip = s
      ? new THREE.Box3(new THREE.Vector3(...s.min), new THREE.Vector3(...s.max))
      : null;
    this.renderer.clippingPlanes = s
      ? [
          new THREE.Plane(new THREE.Vector3(1, 0, 0), -s.min[0]),
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), s.max[0]),
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -s.min[1]),
          new THREE.Plane(new THREE.Vector3(0, -1, 0), s.max[1]),
          new THREE.Plane(new THREE.Vector3(0, 0, 1), -s.min[2]),
          new THREE.Plane(new THREE.Vector3(0, 0, -1), s.max[2]),
        ]
      : [];
    this.dirty = true;
    if (!s) return;
    const [x0, y0, z0] = s.min,
      [x1, y1, z1] = s.max;
    // The box's outline.
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)),
      // Red is only for problems: the drawing theme draws it in ink.
      this.lib.line(
        this.theme.tokens.name === "drawing"
          ? this.theme.ink
          : this.theme.accent,
      ),
    );
    outline.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.sectionGroup.add(outline);
    this.capSection(s);
    // Handles at the face centres, while the section tool is on.
    if (this.tool === "section")
      for (const axis of [0, 1, 2] as const)
        for (const end of ["min", "max"] as const) {
          const h = new THREE.Mesh(
            new THREE.SphereGeometry(70, 16, 10),
            new THREE.MeshBasicMaterial({
              color: this.theme.accent,
              depthTest: false,
            }),
          );
          const p = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
          p[axis] = s[end][axis];
          h.position.set(p[0], p[1], p[2]);
          h.renderOrder = 1001;
          h.userData.sectionHandle = { axis, end };
          this.sectionGroup.add(h);
        }
  }

  private insideSection(p: THREE.Vector3): boolean {
    const s = this.section!;
    return [0, 1, 2].every(
      (k) =>
        p.getComponent(k) >= s.min[k] - 1 && p.getComponent(k) <= s.max[k] + 1,
    );
  }

  /**
   * Cap what the section box cuts (FEEDBACK-7 §4.4): for every object — a
   * rack's frame, each device in it, the shelf, the units — and every face
   * of the box that cuts it, its meshes are drawn into the stencil buffer
   * (back faces count up, front faces down, both clipped by the box), then
   * a hatched quad in the object's colour fills the cut where the count is
   * not zero, and resets it. So a cut rack shows its devices in section, not
   * a lid. The room's walls, planes in realistic, get a hatched strip along
   * their cut.
   */
  private capSection(s: SectionBox) {
    const m = this.model!;
    const H = m.room.height_mm;
    const b = bounds(m.room.floor_plan);
    const planes: { axis: 0 | 1 | 2; end: "min" | "max"; at: number }[] = [];
    const roomMin = [b.x0, 0, b.z0],
      roomMax = [b.x1, H, b.z1];
    for (const axis of [0, 1, 2] as const) {
      if (s.min[axis] > roomMin[axis] + 1)
        planes.push({ axis, end: "min", at: s.min[axis] });
      if (s.max[axis] < roomMax[axis] - 1)
        planes.push({ axis, end: "max", at: s.max[axis] });
    }
    if (!planes.length) return;
    // What gets a cap of its own, and in which colour.
    type Unit = { meshes: THREE.Mesh[]; box: THREE.Box3; color: string };
    const units: Unit[] = [];
    for (const e of this.entries.values()) {
      if (!this.visibleEntry(e)) continue;
      e.built.group.updateMatrixWorld(true);
      const own: THREE.Mesh[] = [];
      e.built.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        if (mesh.userData.role === "hit" || mesh.userData.door) return;
        let p: THREE.Object3D | null = mesh.parent;
        while (p && p !== e.built.group) {
          if (!p.visible || p.userData.near) return;
          p = p.parent;
        }
        if (mesh.userData.device) {
          const kind = (mesh.userData.device as { kind: Device["kind"] }).kind;
          units.push({
            meshes: [mesh],
            box: new THREE.Box3().setFromObject(mesh),
            color: DEVICE_COLOR[kind],
          });
        } else own.push(mesh);
      });
      if (own.length)
        units.push({
          meshes: own,
          box: this.box3(e),
          color: capColour(e.item.kind, this.theme),
        });
    }
    let order = 20000;
    for (const pl of planes)
      for (const u of units) {
        const lo = u.box.min.getComponent(pl.axis),
          hi = u.box.max.getComponent(pl.axis);
        if (pl.at <= lo + 0.5 || pl.at >= hi - 0.5) continue;
        // The cut's extent on the plane: the object's box within the box.
        const a = [0, 1, 2].map((k) =>
          Math.max(u.box.min.getComponent(k), s.min[k]),
        );
        const z = [0, 1, 2].map((k) =>
          Math.min(u.box.max.getComponent(k), s.max[k]),
        );
        const [p, q] = pl.axis === 0 ? [2, 1] : pl.axis === 1 ? [0, 2] : [0, 1];
        if (z[p] - a[p] < 1 || z[q] - a[q] < 1) continue;
        for (const mesh of u.meshes)
          for (const side of [THREE.BackSide, THREE.FrontSide] as const) {
            const st = new THREE.Mesh(mesh.geometry, this.lib.stencil(side));
            st.matrixAutoUpdate = false;
            st.matrix.copy(mesh.matrixWorld);
            st.renderOrder = order;
            st.userData.capPass = true;
            this.sectionGroup.add(st);
          }
        const inward = pl.end === "min" ? 1 : -1;
        const c = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2, (a[2] + z[2]) / 2];
        c[pl.axis] = pl.at + inward * 0.5;
        const cap = new THREE.Mesh(
          planeOn(pl.axis, z[p] - a[p], z[q] - a[q], c),
          this.lib.cap(u.color),
        );
        cap.renderOrder = order + 1;
        cap.userData.sectionCap = true;
        this.sectionGroup.add(cap);
        order += 2;
      }
    // Realistic walls are planes: a hatched strip outside each, along the
    // top cut.
    const top = planes.find((pl) => pl.axis === 1 && pl.end === "max");
    if (top && this.mode === "realistic") {
      const poly = m.room.floor_plan;
      for (let i = 0; i < poly.length; i++) {
        const [ax, az] = poly[i],
          [bx, bz] = poly[(i + 1) % poly.length];
        const len = Math.hypot(bx - ax, bz - az);
        // Outwards from the room: the left of a counter-clockwise outline.
        const nx = (bz - az) / len,
          nz = -(bx - ax) / len;
        const cx = (ax + bx) / 2 + nx * 60,
          cz = (az + bz) / 2 + nz * 60;
        const w = Math.abs(bx - ax) > 1 ? len : 120;
        const d = Math.abs(bx - ax) > 1 ? 120 : len;
        const strip = new THREE.Mesh(
          planeOn(1, w, d, [cx, top.at - 0.5, cz]),
          this.lib.cap(this.theme.tokens.wall, false),
        );
        strip.userData.sectionCap = true;
        this.sectionGroup.add(strip);
      }
    }
  }

  /** A section box handle under the pointer, if any. */
  private sectionHandleAt(ev: { clientX: number; clientY: number }) {
    if (this.tool !== "section" || !this.section) return null;
    this.setNdc(ev);
    // Handles are drawn on top: pick them through anything.
    const handles = this.sectionGroup.children.filter(
      (o) => o.userData.sectionHandle,
    );
    const saved = this.renderer.clippingPlanes;
    const hit = this.ray.intersectObjects(handles, false)[0];
    this.renderer.clippingPlanes = saved;
    return hit
      ? (hit.object.userData.sectionHandle as {
          axis: 0 | 1 | 2;
          end: "min" | "max";
        })
      : null;
  }

  /** Drag a face of the box along its axis, to the pointer. */
  private dragSection(ev: PointerEvent) {
    const d = this.sectionDrag!;
    const s = this.section!;
    this.setNdc(ev);
    // The point on the face's axis line nearest the pointer's ray.
    const centre = new THREE.Vector3(
      (s.min[0] + s.max[0]) / 2,
      (s.min[1] + s.max[1]) / 2,
      (s.min[2] + s.max[2]) / 2,
    );
    const axis = new THREE.Vector3().setComponent(d.axis, 1);
    const r = this.ray.ray;
    const w0 = centre.clone().sub(r.origin);
    const b = axis.dot(r.direction);
    const den = 1 - b * b;
    if (den < 1e-4) return;
    const t = (b * w0.dot(r.direction) - w0.dot(axis)) / den;
    const at = Math.round(centre.getComponent(d.axis) + t);
    const other = d.end === "min" ? s.max[d.axis] : s.min[d.axis];
    s[d.end][d.axis] =
      d.end === "min" ? Math.min(at, other - 50) : Math.max(at, other + 50);
    this.applySection();
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
    // Along the normal, mm: no acne on the walls where light grazes them
    // (the section box cuts the ceiling away and lets the sun in).
    sun.shadow.normalBias = 25;
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
    // Realistic sits on a neutral backdrop, so white units and walls read.
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
    // Walls: low in schema so the room reads from above. In realistic they
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
        // The drawing theme hatches walls (mockup Drawing.png).
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
        // A fixture body on the ceiling and the tube under it (FEEDBACK-7
        // §1.8): a light hangs from something, it does not float.
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(1260, 50, 110),
          this.lib.role("ceiling"),
        );
        body.position.set((b.x0 + b.x1) / 2, H - 25, z);
        body.userData.role = "ceiling";
        this.roomGroup.add(body);
        const tube = new THREE.Mesh(
          new THREE.BoxGeometry(1200, 26, 50),
          this.lib.tube(),
        );
        tube.position.set((b.x0 + b.x1) / 2, H - 63, z);
        tube.userData.role = "light";
        tube.userData.fixedMaterial = true;
        this.roomGroup.add(tube);
        // The tube lights as area lights, as on the renders (FEEDBACK-6 §3).
        const light = new THREE.RectAreaLight(0xfff3e4, 9, 1200, 160);
        light.visible = this.quality > 0;
        light.position.set((b.x0 + b.x1) / 2, H - 80, z);
        light.lookAt((b.x0 + b.x1) / 2, 0, z);
        light.userData.areaLight = true;
        this.roomGroup.add(light);
      }
    } else if (this.layers.lights) {
      // Schema and the plan: the tubes as thin dashed outlines on the
      // ceiling plane — a layer, off by default (FEEDBACK-7 §1.8).
      const H = m.room.height_mm;
      const b = bounds(poly);
      const tubes = Math.max(1, Math.round((b.z1 - b.z0) / 1300));
      for (let i = 0; i < tubes; i++) {
        const z = b.z0 + ((i + 0.5) * (b.z1 - b.z0)) / tubes;
        const geo = new THREE.PlaneGeometry(1260, 110);
        geo.rotateX(-Math.PI / 2);
        const rim = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          this.lib.line(this.theme.inkMuted, true),
        );
        rim.computeLineDistances();
        rim.position.set((b.x0 + b.x1) / 2, H - 2, z);
        rim.userData.role = "light";
        this.roomGroup.add(rim);
      }
    }
    // The floor grid (FEEDBACK-7 §4.1): without an edge, fading with
    // distance, its spacing following the zoom; the room's axes through its
    // origin. None in realistic. Drawing: thin, at 20 % ink.
    const t = this.theme;
    this.floorGrid = makeGrid(
      t.tokens.name === "drawing"
        ? { color: "#2b2b2b", minorAlpha: 0.05, majorAlpha: 0.2 }
        : {
            color: t.dark ? "#ffffff" : "#000000",
            minorAlpha: 0.05,
            majorAlpha: 0.13,
          },
    );
    this.floorGrid.visible = !realistic;
    this.roomGroup.add(this.floorGrid);
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
      // Fan blades, perforation detail and bevels follow the quality tier.
      detail: this.quality,
      pxPerMm: null,
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
    // Schema mode: a thin outline of every object, dashed for what hangs
    // overhead — on the plan only (a drawing convention); in 3D the height
    // shows it. Not in the realistic mode.
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
      doorAngle: { front: 0, rear: 0 },
      doorTarget: { front: 0, rear: 0 },
      outline,
      assumedOutline,
      edges,
      blocked,
      alpha: 1,
      alphaTarget: 1,
    };
    const prevSel = this.selection;
    if (prevSel) {
      entry.outline.visible =
        (prevSel.type === "object" && prevSel.id === obj.id) ||
        (prevSel.type === "device" && prevSel.rackId === obj.id) ||
        (prevSel.type === "cell" && prevSel.shelfId === obj.id);
    }
    this.aimDoors(
      entry,
      prevSel?.type === "device" && prevSel.rackId === obj.id,
    );
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

  /** The material each mesh's role calls for, with fill / power mode tints. */
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
      else if (st.powerW === 0 && st.unknownPower > 0)
        tint = this.lib.unknown();
      else {
        // Against the budget; without one, on an absolute scale of known
        // kilowatts (FEEDBACK-7 §1.7). The label says how many devices
        // have no data.
        const budget = m.room.settings.rack_power_budget_w;
        tint =
          budget === null
            ? this.lib.sequential(st.powerW / POWER_SCALE_W)
            : st.powerW > budget
              ? this.lib.over()
              : this.lib.tint(st.powerW / budget);
      }
    }
    e.built.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.fixedMaterial) {
        if (mesh.userData.baseMat) mesh.material = mesh.userData.baseMat;
        return;
      }
      const role = mesh.userData.role as string | undefined;
      if (!role) return;
      const h = this.highlightOwner;
      const owner = (mesh.userData.device?.owner ?? mesh.userData.owner) as
        string | undefined;
      // The owner highlight (FEEDBACK-7 §4.6): that owner's equipment keeps
      // its colour, everything else is dimmed.
      if (h !== null && owner !== h) {
        mesh.material = this.lib.dimmed();
        return;
      }
      // The owners mode (§4.7): devices and cells by owner.
      if (
        this.mode === "owners" &&
        (mesh.userData.device || mesh.userData.owner !== undefined)
      ) {
        mesh.material = this.lib.flat(this.ownerColour(owner ?? ""));
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
        tint && ["rackFrame", "rackCap"].includes(baseRole(role))
          ? tint
          : this.lib.role(role);
    });
    // X-ray and the occluder fade: the same materials, see-through.
    if (e.alpha < 0.999)
      e.built.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.role === "hit") return;
        if (o === e.outline || o === e.edges || o === e.assumedOutline) return;
        if (mesh.userData.fixedMaterial)
          mesh.userData.baseMat ??= mesh.material;
        const base = (mesh.userData.baseMat ?? mesh.material) as
          THREE.Material | THREE.Material[];
        mesh.material = Array.isArray(base)
          ? base.map((x) => this.lib.faded(x, e.alpha))
          : this.lib.faded(base, e.alpha);
      });
  }

  private labelEntry(e: Entry, devices: Device[]) {
    const g = e.built.group;
    g.updateMatrixWorld(true);
    const p = g.localToWorld(e.built.labelAt.clone());
    let text = e.obj.name;
    // Fill and power are about contents; schema stays calm with names only.
    // A compact label above the rack's top, so every rack's fits.
    const contents =
      e.item.kind === "rack" && (this.mode === "fill" || this.mode === "power");
    if (contents) {
      const st = rackStats(
        devices,
        (e.item.props as RackProps).units,
        e.obj.contents_known,
      );
      text += `\n${this.text.rack(st, this.mode as "fill" | "power")}`;
    }
    this.labels.set(`obj:${e.obj.id}:name`, text, p, {
      // A rack's contents label is placed before dimensions, so all four fit.
      priority: contents ? 8.5 : e.item.kind === "rack" ? 6 : 4,
      className: contents ? "dc-label-rack" : undefined,
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
    this.labels.clear("clear");
    this.labels.clear("pin");
    this.labels.clear("chain");
    const m = this.model;
    if (!m) return;
    const solids = [...this.entries.values()].map((e) => e.solid);
    const poly = m.room.floor_plan;
    const schema = this.mode !== "realistic";
    const legend: LegendMarks = {
      overhead:
        schema &&
        [...this.entries.values()].some((e) => e.edges.userData.overhead),
      tapeDot: false,
      short: [],
      split: false,
    };

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

    // Service clearance, decided by the tape where it read the gap: a
    // violation is a thin red zone on the floor with a pin — a short label
    // that opens the explanation (FEEDBACK-6 §1); where model and tape fall
    // on different sides of the requirement the zone and pin are amber; zones
    // that are fine show only while editing.
    if (this.layers.zones || this.tool === "edit") {
      const measured = m.room.measurements.entries;
      for (const c of clearances(solids, poly, m.room.settings, measured)) {
        if (c.ok && !c.split && this.tool !== "edit") continue;
        const state = c.split ? "split" : c.ok ? "ok" : "short";
        if (state === "split") legend.split = true;
        if (state === "short" && !legend.short.includes(c.required))
          legend.short.push(c.required);
        const z = c.zone;
        const geo = new THREE.PlaneGeometry(z.x1 - z.x0, z.z1 - z.z0);
        geo.rotateX(-Math.PI / 2);
        // UVs in room millimetres / 150: a hatch keeps its pitch on any zone.
        {
          const pos = geo.getAttribute("position");
          const uv = geo.getAttribute("uv");
          for (let i = 0; i < pos.count; i++)
            uv.setXY(
              i,
              (pos.getX(i) + (z.x0 + z.x1) / 2) / 150,
              (pos.getZ(i) + (z.z0 + z.z1) / 2) / 150,
            );
        }
        const mesh = new THREE.Mesh(geo, this.lib.zone(state));
        mesh.position.set((z.x0 + z.x1) / 2, 3, (z.z0 + z.z1) / 2);
        mesh.renderOrder = 5;
        mesh.userData.clearance = {
          objectId: c.objectId,
          side: c.side,
          state,
        };
        this.overlay.add(mesh);
        const rim = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          this.lib.line(
            state === "split"
              ? this.theme.assumed
              : c.ok
                ? this.theme.good
                : this.theme.warn,
          ),
        );
        rim.position.copy(mesh.position);
        rim.renderOrder = 6;
        rim.userData.zoneOf = { objectId: c.objectId };
        // A hidden or isolated-away rack takes its zone with it.
        const owner = this.entries.get(c.objectId);
        mesh.visible = rim.visible = !owner || this.visibleEntry(owner);
        this.overlay.add(rim);
        if (!c.ok || c.split) {
          // On the rack's top edge on that side (FEEDBACK-7 §3): never under
          // the cable tray or behind the rack itself. On the plan, where
          // height means nothing, towards the zone's far end, clear of the
          // tape dimension that usually runs through its middle.
          const s = this.entries.get(c.objectId)?.solid;
          const [mx, mz] = [(z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2];
          let at = new THREE.Vector3(mx, 30, mz);
          if (s) {
            const o = s.rect;
            const [ox, oz] = [(o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2];
            const alongZ = Math.abs(mz - oz) >= Math.abs(mx - ox);
            if (this.planLock)
              at = alongZ
                ? new THREE.Vector3(
                    mx,
                    30,
                    mz + Math.sign(mz - oz) * (z.z1 - z.z0) * 0.3,
                  )
                : new THREE.Vector3(
                    mx + Math.sign(mx - ox) * (z.x1 - z.x0) * 0.3,
                    30,
                    mz,
                  );
            else
              at = alongZ
                ? new THREE.Vector3(ox, s.y1 + 60, mz > oz ? o.z1 : o.z0)
                : new THREE.Vector3(mx > ox ? o.x1 : o.x0, s.y1 + 60, oz);
          }
          this.labels.set(`pin:${c.objectId}:${c.side}`, this.text.pin(c), at, {
            kind: c.split ? "caution" : "pin",
            priority: 9.5,
            always: true,
            title: this.text.clearance(c),
            refs: [`obj:${c.objectId}`],
            onClick: () => this.onPin(c.objectId, c.side),
          });
        }
      }
    }

    // A cooling unit over occupied cells (FEEDBACK-7 §1.1): a pin under the
    // unit, live while it is dragged; the full text is in the inspector.
    if (this.layers.zones || this.tool === "edit")
      for (const { unit, cells } of this.coolingOverCells()) {
        const r = unit.solid.rect;
        const t = this.text.condensate(cells);
        this.labels.set(
          `pin:${unit.obj.id}:cooling`,
          t.pin,
          new THREE.Vector3(
            (r.x0 + r.x1) / 2,
            unit.solid.y0 - 60,
            (r.z0 + r.z1) / 2,
          ),
          {
            kind: "pin",
            priority: 9.5,
            always: true,
            title: t.title,
            refs: [`obj:${unit.obj.id}`],
            onClick: () => this.onPin(unit.obj.id, "cooling"),
          },
        );
      }

    // Dimensions by layer (FEEDBACK-6 §1), with the value as read (and a dot
    // where the model disagrees): in schema the room's overall size, gaps or
    // every tape number as asked; on the plan the chains outside the room;
    // in every mode the selected object's own dimensions and its clear
    // distances to its neighbours, live while it moves.
    const sel = this.selectedEntry();
    const focus = this.focusedClearance();
    const specs = allDims(
      {
        floorPlan: poly,
        measurements: m.room.measurements.entries,
        solids,
        selected: sel?.obj.name ?? null,
        plan: this.planLock,
        schema,
        measurement: this.text.measurement,
        mm: this.text.mm,
      },
      sel?.solid ?? null,
      focus ? [focus.gap.from, focus.gap.to] : null,
    );
    this.drawnDims = [];
    for (const s of specs) {
      if (!this.layers[s.layer]) continue;
      this.drawnDims.push({ key: s.key, layer: s.layer });
      this.dim(
        s.key,
        new THREE.Vector3(...s.a),
        new THREE.Vector3(...s.b),
        s.text,
        s.priority,
        { title: s.title, mark: s.mark, refs: s.refs },
      );
      legend.tapeDot ||= !!s.mark;
    }

    // The axes' names at their ends, on the plan (FEEDBACK-7 §4.1).
    this.labels.clear("axis");
    if (this.planLock && schema) {
      const b = bounds(poly);
      this.labels.set("axis:x", "x", new THREE.Vector3(b.x1 + 900, 0, 0), {
        kind: "dim",
        priority: 1,
        className: "dc-label-axis dc-label-axis-x",
      });
      this.labels.set("axis:z", "z", new THREE.Vector3(0, 0, b.z1 + 900), {
        kind: "dim",
        priority: 1,
        className: "dc-label-axis dc-label-axis-z",
      });
    }

    // A clicked clearance warning: its gap as a dimension, in every mode.
    if (focus) {
      const [a, b] = [focus.gap.from, focus.gap.to].map(
        ([x, z]) => new THREE.Vector3(x, 12, z),
      );
      this.dim("clear:line", a, b, "", 0);
      this.labels.remove("clear:line");
      this.labels.set(
        "clear:gap",
        this.text.mm(focus.mm),
        a
          .clone()
          .add(b)
          .multiplyScalar(0.5)
          .add(new THREE.Vector3(0, 80, 0)),
        { kind: "measure", priority: 10, always: true },
      );
    }

    // Fill mode: free contiguous units on the front of each recorded rack.
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
    legend.short.sort((a, b) => a - b);
    const sig = JSON.stringify(legend);
    if (sig !== this.legendSig) {
      this.legendSig = sig;
      this.onLegend(legend);
    }
    this.dirty = true;
  }

  /** Realistic mode: a blocked cell's mark shows while hovered or selected. */
  private markBlockedCells() {
    const is = (r: SelRef, shelf: number, n: number) =>
      r?.type === "cell" && r.shelfId === shelf && r.cellNo === n;
    for (const e of this.entries.values())
      for (const c of e.built.group.children) {
        const n = c.userData.blockedCell as number | undefined;
        if (n === undefined) continue;
        // While a unit is dragged, every cell it would block shows.
        const dragging =
          !!this.drag &&
          this.entries.get(this.drag.id)?.item.kind === "cooling";
        c.visible =
          dragging ||
          is(this.hover, e.obj.id, n) ||
          is(this.selection, e.obj.id, n);
      }
    this.dirty = true;
  }

  /** Shelf id → the cells the cooling units block where they now stand. */
  private liveBlocked(): Map<number, number[]> {
    const units = [...this.entries.values()]
      .filter((e) => e.item.kind === "cooling")
      .map((e) => e.solid);
    const out = new Map<number, number[]>();
    for (const e of this.entries.values())
      if (e.item.kind === "shelf")
        out.set(
          e.obj.id,
          blockedCells(e.solid, e.item.props as ShelfProps, units),
        );
    return out;
  }

  /** Per cooling unit, the occupied cells it blocks where it now stands. */
  private coolingOverCells(): { unit: Entry; cells: number[] }[] {
    const m = this.model!;
    const shelves = [...this.entries.values()].filter(
      (e) => e.item.kind === "shelf",
    );
    const out: { unit: Entry; cells: number[] }[] = [];
    for (const unit of this.entries.values()) {
      if (unit.item.kind !== "cooling") continue;
      const cells = shelves.flatMap((s) =>
        blockedCells(s.solid, s.item.props as ShelfProps, [unit.solid]).filter(
          (n) =>
            m.cells.some((c) => c.shelf_id === s.obj.id && c.cell_no === n),
        ),
      );
      if (cells.length) out.push({ unit, cells });
    }
    return out;
  }

  /** Rebuild the shelves whose blocked cells changed under a moved unit. */
  private followBlocked() {
    const m = this.model!;
    for (const [id, blocked] of this.liveBlocked()) {
      const e = this.entries.get(id);
      if (!e || JSON.stringify(e.blocked) === JSON.stringify(blocked)) continue;
      const { obj, item } = e;
      this.dropEntry(id);
      this.buildEntry(
        obj,
        item,
        m.devices.filter((d) => d.rack_id === id),
        m.cells.filter((c) => c.shelf_id === id),
        blocked,
        "",
      );
    }
    this.markBlockedCells();
  }

  private focusedClearance(): ClearanceCheck | null {
    const f = this.clearanceFocus;
    const m = this.model;
    if (!f || !m) return null;
    const solids = [...this.entries.values()].map((e) => e.solid);
    const c = clearances(
      solids,
      m.room.floor_plan,
      m.room.settings,
      m.room.measurements.entries,
    ).find((x) => x.objectId === f.objectId && x.side === f.side);
    return c && c.gap.mm > 0 ? c : null;
  }

  /** The owners mode's colour of an owner: its slot's, or grey («другие»). */
  private ownerColour(owner: string): string {
    const m = this.model!;
    if (this.ownerSlotsFor !== m) {
      this.ownerSlotsFor = m;
      this.ownerSlot = new Map(
        ownerSlots(m.devices, m.cells).map((o) => [o.name, o.slot]),
      );
    }
    const slot = this.ownerSlot.get(owner);
    return slot === null || slot === undefined
      ? this.theme.dark
        ? "#5b6068"
        : "#a7abb2"
      : categorical(this.theme)[slot];
  }
  private ownerSlotsFor: EngineModel | null = null;
  private ownerSlot = new Map<string, number | null>();

  /** An object's box on screen, px: the bounds of its projected corners. */
  private silhouette(e: Entry | null): [number, number, number, number] | null {
    if (!e) return null;
    const r = e.solid.rect;
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const x of [r.x0, r.x1])
      for (const y of [e.solid.y0, e.solid.y1])
        for (const z of [r.z0, r.z1]) {
          const p = new THREE.Vector3(x, y, z).project(this.rig.cam);
          if (p.z > 1) continue;
          const sx = ((p.x + 1) / 2) * w,
            sy = ((1 - p.y) / 2) * h;
          [x0, y0, x1, y1] = [
            Math.min(x0, sx),
            Math.min(y0, sy),
            Math.max(x1, sx),
            Math.max(y1, sy),
          ];
        }
    return x0 < x1 ? [x0, y0, x1, y1] : null;
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
    extra: { title?: string; mark?: boolean; refs?: string[] } = {},
  ) {
    if (this.planLock) {
      // On the plan every dimension lies on the floor, read from above; a
      // vertical one would be seen end-on, so it is not drawn.
      if (Math.abs(b.y - a.y) > Math.hypot(b.x - a.x, b.z - a.z)) return;
      a = new THREE.Vector3(a.x, 2, a.z);
      b = new THREE.Vector3(b.x, 2, b.z);
    }
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
        refs: extra.refs,
      },
    );
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

  /**
   * Status LEDs as points of a fixed size on screen (FEEDBACK-7 §5): about
   * 2.5 px at any distance, so they show at the default view; hidden behind
   * what stands in front of them.
   */
  private rebuildLeds() {
    disposeTree(this.ledGroup);
    this.ledGroup.clear();
    if (this.mode !== "realistic") return;
    const size = 2.5 * this.renderer.getPixelRatio();
    for (const e of this.entries.values()) {
      if (!e.built.leds.length) continue;
      e.built.group.updateMatrixWorld(true);
      const byMat = new Map<string, number[]>();
      for (const led of e.built.leds) {
        const k = led.color + led.blink;
        let mat = this.ledMats.get(k);
        if (!mat || mat.size !== size) {
          mat = new THREE.PointsMaterial({
            color: led.color,
            size,
            sizeAttenuation: false,
            toneMapped: false,
          });
          mat.userData.base = new THREE.Color(led.color);
          mat.userData.blink = led.blink;
          this.ledMats.set(k, mat);
        }
        const p = led.pos.clone().applyMatrix4(e.built.group.matrixWorld);
        const list = byMat.get(k) ?? [];
        list.push(p.x, p.y, p.z);
        byMat.set(k, list);
      }
      for (const [k, list] of byMat) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(list, 3));
        const pts = new THREE.Points(geo, this.ledMats.get(k)!);
        pts.userData.objectId = e.obj.id;
        this.ledGroup.add(pts);
      }
    }
  }

  private tickDoors(dt: number): boolean {
    let moving = false;
    for (const e of this.entries.values()) {
      if (!e.built.doors.length) continue;
      let changed = false;
      for (const side of ["front", "rear"] as const) {
        const delta = e.doorTarget[side] - e.doorAngle[side];
        if (Math.abs(delta) < 0.002) {
          if (e.doorAngle[side] === e.doorTarget[side]) continue;
          e.doorAngle[side] = e.doorTarget[side];
        } else {
          e.doorAngle[side] = this.rig.reducedMotion
            ? e.doorTarget[side]
            : e.doorAngle[side] + delta * Math.min(1, dt * 6);
          moving = true;
        }
        changed = true;
      }
      if (!changed) continue;
      for (const leaf of e.built.doors)
        leaf.pivot.rotation.y = leaf.dir * e.doorAngle[doorSide(leaf.pivot)];
    }
    return moving;
  }

  /**
   * Where a rack's doors should stand: the front open while one of its
   * devices is selected; either door open while the view says so.
   */
  private aimDoors(e: Entry, deviceSelected: boolean) {
    const open = this.openDoors.get(e.obj.id);
    e.doorTarget.front =
      deviceSelected || open === "front" ? this.doorLimit(e, "front").angle : 0;
    e.doorTarget.rear = open === "rear" ? this.doorLimit(e, "rear").angle : 0;
  }

  /**
   * Where a leaf's free edge stands at `angle`, on the floor (x, z): from its
   * hinge, turned outwards, in the rack's own orientation.
   */
  private leafEdge(e: Entry, leaf: DoorLeaf, angle: number, t = 1) {
    e.built.group.updateMatrixWorld(true);
    const hinge = new THREE.Vector3();
    leaf.pivot.getWorldPosition(hinge);
    const local = new THREE.Vector3(
      leaf.along * leaf.width * t,
      0,
      0,
    ).applyAxisAngle(UP, leaf.dir * angle);
    const q = new THREE.Quaternion();
    e.built.group.getWorldQuaternion(q);
    return hinge.add(local.applyQuaternion(q));
  }

  /**
   * How far a rack's door on `side` may open: 110°, or less where a leaf
   * would pass through a neighbour or a wall — and what stops it.
   */
  private doorLimit(
    e: Entry,
    side: "front" | "rear",
  ): { angle: number; by: string | null } {
    const m = this.model;
    const leaves = e.built.doors.filter((l) => doorSide(l.pivot) === side);
    if (!m || !leaves.length) return { angle: OPEN_ANGLE, by: null };
    const room = bounds(m.room.floor_plan);
    const others = [...this.entries.values()].filter(
      (o) =>
        o !== e &&
        !o.solid.swing &&
        // Within the leaf's height: it stops 40 mm short of the rack's top.
        o.solid.y0 < e.solid.y1 - 40 &&
        e.solid.y0 + 100 < o.solid.y1,
    );
    const step = (2 * Math.PI) / 180;
    let last = 0;
    for (let a = step; a <= OPEN_ANGLE + 1e-6; a += step) {
      for (const leaf of leaves)
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const p = this.leafEdge(e, leaf, a, t);
          if (p.x < room.x0 || p.x > room.x1 || p.z < room.z0 || p.z > room.z1)
            return { angle: last, by: null };
          const hit = others.find(
            (o) =>
              p.x > o.solid.rect.x0 &&
              p.x < o.solid.rect.x1 &&
              p.z > o.solid.rect.z0 &&
              p.z < o.solid.rect.z1,
          );
          if (hit) return { angle: last, by: hit.obj.name };
        }
      last = a;
    }
    return { angle: OPEN_ANGLE, by: null };
  }

  /**
   * The free edges of a rack's door leaves where they stand now, on the
   * floor, and the rack's footprint (tests).
   */
  doorEdges(id: number): {
    rect: Rect;
    edges: { side: string; x: number; z: number; angle: number }[];
  } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return {
      rect: { ...e.solid.rect },
      edges: e.built.doors.map((l) => {
        const side = doorSide(l.pivot);
        const p = this.leafEdge(e, l, e.doorAngle[side]);
        return {
          side,
          x: p.x,
          z: p.z,
          angle: (e.doorAngle[side] * 180) / Math.PI,
        };
      }),
    };
  }

  /**
   * Open a rack's front door, or turn the camera to its rear and open that
   * (FEEDBACK-7 §4.6); again on the same door closes it. A view setting, not
   * a revision.
   */
  toggleDoor(id: number, side: "front" | "rear") {
    const e = this.entries.get(id);
    if (!e || e.item.kind !== "rack") return;
    if (this.openDoors.get(id) === side) this.openDoors.delete(id);
    else this.openDoors.set(id, side);
    const sel = this.selection;
    this.aimDoors(e, sel?.type === "device" && sel.rackId === id);
    // Not as far as it should: say what is in the way.
    if (this.openDoors.get(id) === side) {
      const lim = this.doorLimit(e, side);
      if (lim.angle < OPEN_ANGLE - 1e-3)
        this.onDoorLimited(
          e.obj.name,
          side,
          Math.round((lim.angle * 180) / Math.PI),
          lim.by,
        );
    }
    if (side === "rear" && this.openDoors.get(id) === "rear") {
      this.updateSafe();
      const r = e.solid.rect;
      const c = new THREE.Vector3(
        (r.x0 + r.x1) / 2,
        (e.solid.y0 + e.solid.y1) / 2,
        (r.z0 + r.z1) / 2,
      );
      this.rig.focus(
        c,
        0.65 * Math.hypot(r.x1 - r.x0, e.solid.y1 - e.solid.y0, r.z1 - r.z0),
        this.frontVector(e.solid.rotation).multiply(
          new THREE.Vector3(-1, 1, -1),
        ),
      );
    }
    this.onViewState();
    this.dirty = true;
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
      const objId = this.objectIdOf(h.object);
      const e = objId !== null ? this.entries.get(objId) : undefined;
      // Hidden, locked or outside the isolation: not there for the pointer;
      // nor what the section box cuts away.
      if (!e || !this.visibleEntry(e) || this.locked.has(e.obj.id))
        return false;
      if (this.section && !this.insideSection(h.point)) return false;
      if (!h.object.userData.door) return true;
      const glass = h.object.userData.role === "glass";
      return !!e && e.doorAngle[doorSide(h.object)] < 0.05 && !glass;
    });
    let first = usable[0];
    if (!first) return null;
    // A top-board cell's box reaches up to where a tower would stand; a unit
    // hanging into that space is what the pointer is on.
    if ((first.object.userData.pick as Pick).type === "cell") {
      const shelfId = (first.object.userData.pick as { shelfId: number })
        .shelfId;
      // Only where the point on the cell's box is inside the unit's own
      // volume: hovering the cell itself still finds the cell.
      const p0 = first.point;
      const above = usable.find((h) => {
        const q = h.object.userData.pick as Pick;
        if (q.type !== "object" || q.id === shelfId) return false;
        const e = this.entries.get(q.id);
        if (!e) return false;
        const r = e.solid.rect;
        // Within its footprint, at or above its underside.
        return (
          p0.x >= r.x0 - 2 &&
          p0.x <= r.x1 + 2 &&
          p0.z >= r.z0 - 2 &&
          p0.z <= r.z1 + 2 &&
          p0.y >= e.solid.y0 - 2
        );
      });
      if (above) first = above;
    }
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
      this.turnFrom =
        this.planLock && ev.button === 2
          ? { x: ev.clientX, y: ev.clientY }
          : null;
      if (this.rig.walk.on) {
        el.setPointerCapture(ev.pointerId);
        return;
      }
      // The section tool: a face handle drags that face along its axis.
      const handle = ev.button === 0 ? this.sectionHandleAt(ev) : null;
      if (handle) {
        this.sectionDrag = { ...handle, pointerId: ev.pointerId };
        this.rig.controls.enabled = false;
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
      if (this.sectionDrag && ev.pointerId === this.sectionDrag.pointerId) {
        this.dragSection(ev);
        return;
      }
      if (this.drag && ev.pointerId === this.drag.pointerId) {
        this.dragTo(ev);
        return;
      }
      // A right drag is the rotate gesture: on the plan it means "3D".
      const turn = this.turnFrom;
      if (
        turn &&
        ev.buttons & 2 &&
        Math.hypot(ev.clientX - turn.x, ev.clientY - turn.y) > 6
      ) {
        this.turnFrom = null;
        this.onLeavePlan("iso");
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
        this.outlineHover();
        this.dirty = true;
      }
      this.onHover(h, ev.clientX, ev.clientY);
    });

    el.addEventListener("pointerleave", () => {
      this.onCursor(null);
      this.hover = null;
      this.markBlockedCells();
      this.outlineHover();
      this.onHover(null, 0, 0);
    });

    el.addEventListener("pointerup", (ev) => {
      const d = this.down;
      this.down = null;
      this.turnFrom = null;
      if (this.sectionDrag) {
        this.sectionDrag = null;
        this.rig.controls.enabled = true;
        this.onViewState();
        return;
      }
      if (this.drag) {
        const dr = this.drag;
        this.drag = null;
        this.rig.controls.enabled = true;
        this.markBlockedCells();
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
      if (!hit) return;
      // A rack: its front door opens; with Shift the camera turns to its
      // rear and that door opens (FEEDBACK-7 §4.6).
      const id = hit.pick.type === "object" ? hit.pick.id : null;
      if (id !== null && this.entries.get(id)?.item.kind === "rack")
        this.toggleDoor(id, ev.shiftKey ? "rear" : "front");
      else this.flyTo(hit.pick);
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
    if (e.item.kind === "cooling" || e.item.kind === "shelf")
      this.followBlocked();
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
    if (moving || this.dirty) {
      this.updateOccluders(now);
      this.updateNear();
    }
    if (this.tickFade(dt)) moving = true;
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
    this.labels.avoid = this.silhouette(this.selectedEntry());
    this.labels.update(
      this.rig.cam,
      this.host.clientWidth,
      this.host.clientHeight,
      this.panelRects().map(({ r }) => [r.x0, r.z0, r.x1, r.z1]),
    );
    this.cube.update(this.rig.cam);
  };
}

export type { Rect, View, Preset };

/**
 * A rectangle on the plane square to `axis` through `centre`, `w` × `h`
 * along the other two axes (x→z→y order), facing both ways, with UVs in
 * room millimetres / 60 so a hatch keeps its pitch on any cut.
 */
function planeOn(
  axis: 0 | 1 | 2,
  w: number,
  h: number,
  centre: number[],
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, h);
  if (axis === 0) geo.rotateY(Math.PI / 2);
  else if (axis === 1) geo.rotateX(-Math.PI / 2);
  geo.translate(centre[0], centre[1], centre[2]);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const [p, q] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
  const get = (i: number, k: number) =>
    k === 0 ? pos.getX(i) : k === 1 ? pos.getY(i) : pos.getZ(i);
  for (let i = 0; i < pos.count; i++)
    uv.setXY(i, get(i, p) / 60, get(i, q) / 60);
  return geo;
}
