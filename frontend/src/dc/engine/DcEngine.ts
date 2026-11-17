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

import type { Annotation, CatalogItem, DcObject, Device, RackProps, Room, ShelfCell } from "../types";
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
import { readTheme, watchTheme, type DcTheme } from "./theme";
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
}

export interface Measure {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

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
  private measures: Measure[] = [];
  private pendingMeasure: THREE.Vector3 | null = null;
  private drag: null | { id: number; dx: number; dz: number; x0: number; z0: number; moved: boolean; pointerId: number } = null;
  private grid = 10;
  private dirty = true;
  private raf = 0;
  private last = performance.now();
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly ro: ResizeObserver;
  private readonly unwatch: () => void;
  private down: { x: number; y: number; t: number } | null = null;
  private ledMats = new Map<string, THREE.MeshBasicMaterial>();
  text: EngineText;

  onSelect: (ref: SelRef) => void = () => {};
  onHover: (ref: SelRef, x: number, y: number) => void = () => {};
  onMoveCommit: (id: number, x0: number, z0: number, rotation: number) => void = () => {};
  onCursor: (p: { x: number; z: number } | null) => void = () => {};
  onRuler: (m: Measure[]) => void = () => {};
  onPlaceNote: (p: [number, number, number]) => void = () => {};
  onWalk: (on: boolean) => void = () => {};
  onProjection: (ortho: boolean) => void = () => {};

  constructor(
    private readonly host: HTMLElement,
    text: EngineText,
  ) {
    this.text = text;
    this.theme = readTheme();
    this.lib = new MaterialLibrary(this.theme);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    this.cube = new ViewCube(host, (p) => this.preset(p));
    this.scene.add(this.roomGroup, this.objectsGroup, this.overlay, this.dims, this.ledGroup, this.lights);
    this.setupLights();
    this.applyTheme();
    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.unwatch = watchTheme((t) => {
      this.theme = t;
      this.lib.reset(this.mode, t);
      this.applyTheme();
      this.rebuildAll();
    });
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
      const sig = JSON.stringify([obj, item.id, devices, cells, blocked, model.assumed.get(obj.name) ?? null]);
      const prev = this.entries.get(obj.id);
      if (prev && prev.sig === sig) continue;
      if (prev) this.dropEntry(obj.id);
      this.buildEntry(obj, item, devices, cells, blocked, sig);
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.dropEntry(id);
    this.rig.obstacles = [...this.entries.values()].filter((e) => onFloor(e.solid)).map((e) => e.solid.rect);
    this.rebuildLeds();
    this.refreshOverlays();
    if (first) this.preset("iso", 0);
    this.dirty = true;
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lib.reset(mode, this.theme);
    this.renderer.shadowMap.enabled = mode === "realistic";
    this.scene.environment = mode === "realistic" ? this.env() : null;
    this.lights.children.forEach((l) => (l.visible = mode === "realistic" ? l.userData.realistic : l.userData.schema));
    this.labels.showNames = mode !== "realistic";
    this.applyTheme();
    // Shadows and textured fronts are decided at build time.
    this.rebuildAll();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.pendingMeasure = null;
    this.renderer.domElement.style.cursor = tool === "ruler" || tool === "note" ? "crosshair" : "";
    this.refreshOverlays();
  }

  setGrid(mm: number) {
    this.grid = mm;
  }

  select(ref: SelRef, fly = false) {
    this.selection = ref;
    for (const e of this.entries.values()) {
      const rackOfDevice = ref?.type === "device" && ref.rackId === e.obj.id;
      e.outline.visible = (ref?.type === "object" && ref.id === e.obj.id) || rackOfDevice || (ref?.type === "cell" && ref.shelfId === e.obj.id);
      // A device inside opens its rack's doors.
      e.doorTarget = rackOfDevice ? OPEN_ANGLE : 0;
    }
    this.labels.focus.clear();
    if (ref) this.labels.focus.add(`obj:${ref.type === "object" ? ref.id : ref.type === "device" ? ref.rackId : ref.shelfId}`);
    this.refreshOverlays();
    if (fly && ref) this.flyTo(ref);
    this.dirty = true;
  }

  flyTo(ref: Pick) {
    const objId = ref.type === "object" ? ref.id : ref.type === "device" ? ref.rackId : ref.shelfId;
    const e = this.entries.get(objId);
    if (!e) return;
    const r = e.solid.rect;
    const centre = new THREE.Vector3((r.x0 + r.x1) / 2, (e.solid.y0 + e.solid.y1) / 2, (r.z0 + r.z1) / 2);
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
    const radius = 0.65 * Math.hypot(r.x1 - r.x0, e.solid.y1 - e.solid.y0, r.z1 - r.z0);
    this.rig.focus(centre, radius, e.item.kind === "rack" ? this.frontVector(e.solid.rotation) : undefined);
  }

  preset(p: Preset, dur?: number) {
    this.rig.preset(p);
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
    this.pendingMeasure = null;
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
  snapshotPng(): string {
    this.renderer.render(this.scene, this.rig.cam);
    const src = this.renderer.domElement;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const g = out.getContext("2d")!;
    g.drawImage(src, 0, 0);
    const scale = src.width / Math.max(1, this.host.clientWidth);
    const font = getComputedStyle(this.labels.root).fontFamily || "sans-serif";
    g.textBaseline = "top";
    this.labels.root.querySelectorAll<HTMLElement>(".dc-label").forEach((el) => {
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
      el.textContent!.split("\n").forEach((line, i) => g.fillText(line, x + 4 * scale, y + 2 * scale + i * parseFloat(cs.lineHeight || cs.fontSize) * scale));
    });
    return out.toDataURL("image/png");
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.unwatch();
    for (const id of [...this.entries.keys()]) this.dropEntry(id);
    disposeTree(this.roomGroup);
    disposeTree(this.overlay);
    disposeTree(this.dims);
    disposeTree(this.ledGroup);
    this.lib.dispose();
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
    const amb = new THREE.HemisphereLight(0xfffaf2, 0x52565c, 0.6);
    amb.userData = { schema: false, realistic: true };
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2000, 6000, 3500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 4;
    sun.shadow.bias = -0.0004;
    Object.assign(sun.shadow.camera, { left: -6000, right: 6000, top: 6000, bottom: -6000, near: 100, far: 20000 });
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
    if (this.mode === "realistic") bg.lerp(new THREE.Color(this.theme.dark ? "#3a3d42" : "#9aa0a6"), 0.45);
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
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, z)));
    const floorGeo = new THREE.ShapeGeometry(shape);
    floorGeo.rotateX(Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, this.lib.role("floor"));
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
    const [cx, cz] = [poly.reduce((a, p) => a + p[0], 0) / n, poly.reduce((a, p) => a + p[1], 0) / n];
    for (let i = 0; i < n; i++) {
      const [ax, az] = poly[i],
        [bx, bz] = poly[(i + 1) % n];
      const len = Math.hypot(bx - ax, bz - az);
      const mx = (ax + bx) / 2,
        mz = (az + bz) / 2;
      let wall: THREE.Mesh;
      if (realistic) {
        wall = new THREE.Mesh(new THREE.PlaneGeometry(len, h), this.lib.role("wall"));
        wall.position.set(mx, h / 2, mz);
        // Face the room's centre.
        wall.lookAt(cx, h / 2, cz);
      } else {
        wall = new THREE.Mesh(new THREE.BoxGeometry(len, h, 60), this.lib.role("wall"));
        wall.position.set(mx, h / 2, mz);
        wall.rotation.y = -Math.atan2(bz - az, bx - ax);
        const nx = -(bz - az) / len,
          nz = (bx - ax) / len;
        wall.position.x -= nx * 30;
        wall.position.z -= nz * 30;
      }
      wall.userData.role = "wall";
      wall.receiveShadow = realistic;
      this.roomGroup.add(wall);
    }
    const grid = new THREE.GridHelper(Math.max(bounds(poly).x1, bounds(poly).z1) * 2, 40, this.theme.line, this.theme.line);
    grid.position.set(0, 1, 0);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = this.mode === "realistic" ? 0 : 0.35;
    grid.visible = this.mode !== "realistic";
    this.roomGroup.add(grid);
  }

  private buildEntry(obj: DcObject, item: CatalogItem, devices: Device[], cells: ShelfCell[], blocked: number[], sig: string) {
    const m = this.model!;
    const dims = objectDims(item, obj.instance);
    const built = RENDERERS[item.kind].build(obj, item, { lib: this.lib, mode: this.mode, devices, cells, blocked, dims });
    const s = solid(obj, item, m.room.floor_plan);
    const g = built.group;
    g.position.set((s.rect.x0 + s.rect.x1) / 2, obj.y0_mm, (s.rect.z0 + s.rect.z1) / 2);
    g.rotation.y = (-obj.rotation_deg * Math.PI) / 180;
    g.userData.objectId = obj.id;
    this.objectsGroup.add(g);
    // Selection outline.
    const [w, d, h] = dims;
    const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 30, h + 30, d + 30));
    const outline = new THREE.LineSegments(eg, this.lib.line(this.theme.accent));
    outline.position.set(0, h / 2, 0);
    outline.visible = false;
    outline.renderOrder = 998;
    g.add(outline);
    let assumedOutline: THREE.LineSegments | null = null;
    if (m.assumed.has(obj.name)) {
      const ag = new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 12, h + 12, Math.max(d, 10) + 12));
      assumedOutline = new THREE.LineSegments(ag, this.lib.line(this.theme.assumed, true));
      assumedOutline.computeLineDistances();
      assumedOutline.position.set(0, h / 2, 0);
      assumedOutline.renderOrder = 997;
      g.add(assumedOutline);
    }
    const entry: Entry = { sig, obj, item, solid: s, built, doorAngle: 0, doorTarget: 0, outline, assumedOutline };
    const prevSel = this.selection;
    if (prevSel) {
      entry.outline.visible =
        (prevSel.type === "object" && prevSel.id === obj.id) ||
        (prevSel.type === "device" && prevSel.rackId === obj.id) ||
        (prevSel.type === "cell" && prevSel.shelfId === obj.id);
      if (prevSel.type === "device" && prevSel.rackId === obj.id) entry.doorTarget = OPEN_ANGLE;
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
    if (e.item.kind === "rack" && (this.mode === "fill" || this.mode === "power")) {
      const p = e.item.props as RackProps;
      const devs = m.devices.filter((d) => d.rack_id === e.obj.id);
      const st = rackStats(devs, p.units, e.obj.contents_known);
      if (!st.known) tint = this.lib.unknown();
      else if (this.mode === "fill") tint = this.lib.tint(st.used / st.units);
      else if (st.unknownPower > 0) tint = this.lib.unknown();
      else {
        const budget = m.room.settings.rack_power_budget_w;
        const max = Math.max(1, ...this.rackPowers());
        const f = budget ? st.powerW / budget : st.powerW / max;
        tint = budget && st.powerW > budget ? this.lib.over() : this.lib.tint(f);
      }
    }
    e.built.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.fixedMaterial) return;
      const role = mesh.userData.role as string | undefined;
      if (!role) return;
      if (mesh.userData.device) {
        const d = mesh.userData.device as { kind: Device["kind"]; units: number; name: string; rear: boolean };
        const side = this.lib.role("deviceSide");
        const front = this.lib.deviceFront(d.kind, d.units, d.name);
        // BoxGeometry faces: +x, −x, +y, −y, +z, −z; the panel faces out of its face.
        mesh.material = [side, side, side, side, d.rear ? front : side, d.rear ? side : front];
        return;
      }
      mesh.material = tint && (role === "rackFrame" || role === "rackCap") ? tint : this.lib.role(role);
    });
  }

  private rackPowers(): number[] {
    const m = this.model!;
    return [...this.entries.values()]
      .filter((e) => e.item.kind === "rack")
      .map((e) => m.devices.filter((d) => d.rack_id === e.obj.id).reduce((a, d) => a + (d.power_w ?? 0), 0));
  }

  private labelEntry(e: Entry, devices: Device[]) {
    const g = e.built.group;
    g.updateMatrixWorld(true);
    const p = g.localToWorld(e.built.labelAt.clone());
    let text = e.obj.name;
    if (e.item.kind === "rack") {
      const st = rackStats(devices, (e.item.props as RackProps).units, e.obj.contents_known);
      text += st.known
        ? `\n${this.text.units(st.used, st.units)}${st.powerW ? ` · ${this.text.powerW(st.powerW)}` : ""}${st.unknownPower ? ` · ${this.text.unknownPower}` : ""}`
        : `\n${this.text.notRecorded}`;
    }
    this.labels.set(`obj:${e.obj.id}:name`, text, p, { priority: e.item.kind === "rack" ? 6 : 4 });
    const keys = this.model!.assumed.get(e.obj.name);
    if (keys) {
      this.labels.set(`obj:${e.obj.id}:assumed`, `≈ ${this.text.assumed}`, p.clone().add(new THREE.Vector3(0, -260, 0)), {
        kind: "assumed",
        priority: 5,
        title: keys.join(", "),
      });
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
        const closed = alongX ? Math.atan2(0, fx - sw.hinge[0]) : Math.atan2(fz - sw.hinge[1], 0);
        const open = alongX ? Math.atan2(fz - sw.hinge[1], 0) : Math.atan2(0, fx - sw.hinge[0]);
        let sweep = open - closed;
        if (sweep > Math.PI) sweep -= 2 * Math.PI;
        if (sweep < -Math.PI) sweep += 2 * Math.PI;
        const pts: THREE.Vector3[] = [new THREE.Vector3(sw.hinge[0], 4, sw.hinge[1])];
        for (let i = 0; i <= 24; i++) {
          const t = closed + (sweep * i) / 24;
          pts.push(new THREE.Vector3(sw.hinge[0] + Math.cos(t) * sw.radius, 4, sw.hinge[1] + Math.sin(t) * sw.radius));
        }
        pts.push(pts[0].clone());
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.lib.line(this.theme.inkMuted, true));
        line.computeLineDistances();
        this.overlay.add(line);
      }

    // Service clearance zones: in Схема and while editing.
    if (schema || this.tool === "edit") {
      for (const c of clearances(solids, poly, m.room.settings)) {
        const z = c.zone;
        const geo = new THREE.PlaneGeometry(z.x1 - z.x0, z.z1 - z.z0);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, this.lib.zone(c.ok));
        mesh.position.set((z.x0 + z.x1) / 2, 3, (z.z0 + z.z1) / 2);
        mesh.renderOrder = 5;
        this.overlay.add(mesh);
        if (!c.ok) {
          this.labels.set(`gap:${c.objectId}:${c.side}`, `${this.text.mm(c.gap.mm)} < ${this.text.mm(c.required)}`, new THREE.Vector3((z.x0 + z.x1) / 2, 30, (z.z0 + z.z1) / 2), {
            kind: "warn",
            priority: 8,
          });
        }
      }
    }

    // Dimensions in Схема: the room, rack rows, the selected object's gaps.
    if (schema) this.roomDims(solids);
    const sel = this.selectedEntry();
    if (sel && (schema || this.tool === "edit")) this.gapDims(sel.solid, solids);

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
          mesh.position.set(0, p.u1_height_mm + (r.from - 1) * U_MM + hgt / 2 + 2, -d / 2 + 60);
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
        const pin = new THREE.Mesh(new THREE.SphereGeometry(40, 12, 8), new THREE.MeshBasicMaterial({ color: this.theme.assumed }));
        pin.position.set(x, y, z);
        this.overlay.add(pin);
        this.labels.set(`note:${a.id}`, a.payload.text, new THREE.Vector3(x, y + 120, z), { kind: "note", priority: 7, always: true });
      }

    // Ruler.
    this.measures.forEach((ms, i) => this.drawMeasure(ms.a, ms.b, `ruler:${i}`));
    if (this.pendingMeasure) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(25, 12, 8), new THREE.MeshBasicMaterial({ color: this.theme.dim, depthTest: false }));
      dot.position.copy(this.pendingMeasure);
      dot.renderOrder = 1000;
      this.overlay.add(dot);
    }
    this.dirty = true;
  }

  private selectedEntry(): Entry | null {
    const s = this.selection;
    if (!s) return null;
    return this.entries.get(s.type === "object" ? s.id : s.type === "device" ? s.rackId : s.shelfId) ?? null;
  }

  /** A dimension line with ticks and a label, on the floor or at a height. */
  private dim(key: string, a: THREE.Vector3, b: THREE.Vector3, text: string, priority = 3) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1) return;
    dir.normalize();
    const n = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(60);
    const pts = [a, b, a.clone().add(n), a.clone().sub(n), b.clone().add(n), b.clone().sub(n)];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setIndex([0, 1, 2, 3, 4, 5]);
    const line = new THREE.LineSegments(geo, this.lib.line(this.theme.dim));
    line.renderOrder = 999;
    this.dims.add(line);
    this.labels.set(key, text, a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 40, 0)), { kind: "dim", priority });
  }

  private measureText(key: string, computed: number): string {
    const e = this.model!.room.measurements.entries.find((m) => m.key === key);
    if (e && e.min !== undefined && e.max !== undefined && e.min !== e.max) return this.text.range(e.min, e.max);
    return this.text.mm(computed);
  }

  private roomDims(solids: Solid[]) {
    const b = bounds(this.model!.room.floor_plan);
    const y = 10;
    this.dim("dim:room:x", new THREE.Vector3(b.x0, y, b.z1 + 300), new THREE.Vector3(b.x1, y, b.z1 + 300), this.measureText("room.length_x", b.x1 - b.x0), 6);
    this.dim("dim:room:z", new THREE.Vector3(b.x0 - 300, y, b.z0), new THREE.Vector3(b.x0 - 300, y, b.z1), this.measureText("room.width_z", b.z1 - b.z0), 6);
    // Racks in a row facing −z: gaps along x, as on the plan.
    const row = solids.filter((s) => s.kind === "rack" && s.rotation === 0).sort((a, c) => a.rect.x0 - c.rect.x0);
    if (row.length) {
      const z = Math.min(...row.map((s) => s.rect.z0)) - 160;
      let prev = b.x0;
      row.forEach((s, i) => {
        this.dim(`dim:row:${i}`, new THREE.Vector3(prev, y, z), new THREE.Vector3(s.rect.x0, y, z), this.text.mm(s.rect.x0 - prev));
        prev = s.rect.x1;
      });
      this.dim("dim:row:end", new THREE.Vector3(prev, y, z), new THREE.Vector3(b.x1, y, z), this.text.mm(b.x1 - prev));
    }
  }

  private gapDims(s: Solid, solids: Solid[]) {
    const poly = this.model!.room.floor_plan;
    const others = solids.filter((o) => o !== s && o.id !== s.id && (s.y0 > 0 ? !o.swing && o.y0 < s.y1 && s.y0 < o.y1 : onFloor(o))).map((o) => o.rect);
    const y = s.y0 > 0 ? s.y0 : 12;
    for (const dir of ["left", "right", "up", "down"] as Dir[]) {
      const g = gap(s.rect, dir, others, poly);
      if (g.mm <= 0) continue;
      this.dim(`gap:sel:${dir}`, new THREE.Vector3(g.from[0], y, g.from[1]), new THREE.Vector3(g.to[0], y, g.to[1]), this.text.mm(g.mm), 9);
    }
  }

  private drawMeasure(a: THREE.Vector3, b: THREE.Vector3, key: string) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, this.lib.line(this.theme.dim));
    line.renderOrder = 999;
    this.overlay.add(line);
    const d = a.distanceTo(b);
    const t = `${this.text.mm(Math.round(d))}  Δx ${Math.round(Math.abs(a.x - b.x))} · Δy ${Math.round(Math.abs(a.y - b.y))} · Δz ${Math.round(Math.abs(a.z - b.z))}`;
    this.labels.set(key, t, a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 60, 0)), { kind: "measure", priority: 10, always: true });
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
          mat = new THREE.MeshBasicMaterial({ color: led.color, toneMapped: false });
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
        e.doorAngle = this.rig.reducedMotion ? e.doorTarget : e.doorAngle + delta * Math.min(1, dt * 6);
        moving = true;
      }
      for (const leaf of e.built.doors) leaf.pivot.rotation.y = leaf.dir * e.doorAngle;
    }
    return moving;
  }

  private tickLeds(now: number) {
    if (this.mode !== "realistic" || this.rig.reducedMotion) return;
    const on = Math.floor(now / 420) % 2 === 0;
    for (const mat of this.ledMats.values()) {
      if (!mat.userData.blink) continue;
      mat.color.copy(mat.userData.base as THREE.Color).multiplyScalar(on ? 1 : 0.15);
    }
  }

  // --- Input -------------------------------------------------------------------------

  private keydown = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (this.rig.walk.on && ev.code === "Escape") {
      this.setWalk(false);
      return;
    }
    if (ev.code.startsWith("Arrow") && !this.rig.walk.on && this.tool === "edit" && this.selection?.type === "object") return;
    this.rig.held.add(ev.code);
    this.dirty = true;
  };
  private keyup = (ev: KeyboardEvent) => {
    this.rig.held.delete(ev.code);
  };
  private blur = () => this.rig.held.clear();

  private setNdc(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
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
  private pick(ev: { clientX: number; clientY: number }): { pick: Pick; point: THREE.Vector3 } | null {
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
      if (dev && !first.object.userData.door) return { pick: dev.object.userData.pick as Pick, point: dev.point };
    }
    return { pick: p, point: first.point };
  }

  private objectIdOf(o: THREE.Object3D): number | null {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if (cur.userData.objectId !== undefined) return cur.userData.objectId as number;
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
      if (p.type === "device" && ref.type === "device" && p.id === ref.id) found = o;
      if (p.type === "cell" && ref.type === "cell" && p.shelfId === ref.shelfId && p.cellNo === ref.cellNo) found = o;
    });
    return found;
  }

  private frontVector(rotation: number): THREE.Vector3 {
    const d: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const [x, z] = d[frontDir(rotation)];
    // From the front, a little above: over whatever stands in the aisle.
    return new THREE.Vector3(x, 0.55, z);
  }

  private floorPoint(ev: { clientX: number; clientY: number }): THREE.Vector3 | null {
    this.setNdc(ev);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(FLOOR, p) ? p : null;
  }

  /** Corner snapping for the ruler: object footprint corners near the hit. */
  private snapCorner(p: THREE.Vector3): THREE.Vector3 {
    const camDist = this.rig.cam.position.distanceTo(p);
    const thresh = Math.max(40, camDist * 0.025);
    let best: THREE.Vector3 | null = null,
      bestD = thresh;
    for (const e of this.entries.values()) {
      const r = e.solid.rect;
      for (const [x, z] of [
        [r.x0, r.z0],
        [r.x1, r.z0],
        [r.x0, r.z1],
        [r.x1, r.z1],
      ])
        for (const y of [e.solid.y0, e.solid.y1]) {
          const c = new THREE.Vector3(x, y, z);
          const dd = c.distanceTo(p);
          if (dd < bestD) {
            bestD = dd;
            best = c;
          }
        }
    }
    return best ?? p;
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
        let dy = ev.deltaY * (ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? 400 : 1);
        if (ev.ctrlKey) dy *= 6;
        const s = Math.exp(Math.max(-260, Math.min(260, dy)) * 0.0011);
        this.setNdc(ev);
        const hit = this.ray.intersectObjects(this.pickables(), false)[0]?.point ?? this.floorPoint(ev);
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
            this.drag = { id: e.obj.id, dx: fp.x - e.solid.rect.x0, dz: fp.z - e.solid.rect.z0, x0: e.solid.rect.x0, z0: e.solid.rect.z0, moved: false, pointerId: ev.pointerId };
            this.rig.controls.enabled = false;
            el.setPointerCapture(ev.pointerId);
            if (this.selection?.type !== "object" || this.selection.id !== e.obj.id) {
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
      const hit = this.pick(ev);
      const h = hit?.pick ?? null;
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h;
        this.labels.focus.clear();
        if (h) this.labels.focus.add(`obj:${h.type === "object" ? h.id : h.type === "device" ? h.rackId : h.shelfId}`);
        const s = this.selection;
        if (s) this.labels.focus.add(`obj:${s.type === "object" ? s.id : s.type === "device" ? s.rackId : s.shelfId}`);
        this.dirty = true;
      }
      this.onHover(h, ev.clientX, ev.clientY);
    });

    el.addEventListener("pointerleave", () => {
      this.onCursor(null);
      this.hover = null;
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
        const hit = this.pick(ev);
        let p = hit?.point ?? this.floorPoint(ev);
        if (!p) return;
        p = this.snapCorner(p);
        if (this.pendingMeasure) {
          const a = this.pendingMeasure;
          if (ev.shiftKey) {
            const dx = Math.abs(p.x - a.x),
              dy = Math.abs(p.y - a.y),
              dz = Math.abs(p.z - a.z);
            const max = Math.max(dx, dy, dz);
            p = new THREE.Vector3(max === dx ? p.x : a.x, max === dy ? p.y : a.y, max === dz ? p.z : a.z);
          }
          this.measures.push({ a, b: p });
          this.pendingMeasure = null;
          this.onRuler(this.measures);
        } else this.pendingMeasure = p;
        this.refreshOverlays();
        return;
      }
      if (this.tool === "note") {
        const hit = this.pick(ev);
        const p = hit?.point ?? this.floorPoint(ev);
        if (p) this.onPlaceNote([Math.round(p.x), Math.round(p.y), Math.round(p.z)]);
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
      .filter((o) => o.obj.id !== dr.id && (e.solid.y0 > 0 ? !o.solid.swing : onFloor(o.solid)))
      .map((o) => o.solid.rect);
    const sn = snap(fp.x - dr.dx, fp.z - dr.dz, fw, fd, others, m.room.floor_plan, this.grid, !ev.altKey);
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
    const moved: DcObject = { ...e.obj, x0_mm: x0, z0_mm: z0, rotation_deg: rotation as DcObject["rotation_deg"] };
    e.solid = solid(moved, e.item, m.room.floor_plan);
    e.obj = moved;
    e.sig = "";
    const g = e.built.group;
    g.position.set((e.solid.rect.x0 + e.solid.rect.x1) / 2, moved.y0_mm, (e.solid.rect.z0 + e.solid.rect.z1) / 2);
    g.rotation.y = (-rotation * Math.PI) / 180;
    // Red outline while the place is not allowed.
    const solids = [...this.entries.values()].map((x) => x.solid);
    const bad = problems(solids.indexOf(e.solid), solids, m.room.floor_plan, m.room.height_mm).length > 0;
    e.outline.material = this.lib.line(bad ? this.theme.warn : this.theme.accent);
    e.outline.visible = true;
    this.labelEntry(e, m.devices.filter((d) => d.rack_id === e.obj.id));
    this.refreshOverlays();
  }

  /** Problems with an object's current (possibly previewed) place. */
  problemsOf(id: number) {
    const m = this.model;
    const e = this.entries.get(id);
    if (!m || !e) return [];
    const solids = [...this.entries.values()].map((x) => x.solid);
    return problems(solids.indexOf(e.solid), solids, m.room.floor_plan, m.room.height_mm);
  }

  // --- Loop --------------------------------------------------------------------------

  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
    this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const panAllowed = !(this.tool === "edit" && this.selection?.type === "object");
    let moving = this.rig.update(now, dt, panAllowed);
    if (this.tickDoors(dt)) moving = true;
    const blinking = this.mode === "realistic" && !this.rig.reducedMotion && this.ledGroup.children.length > 0;
    if (blinking) this.tickLeds(now);
    if (!(moving || blinking || this.dirty)) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.rig.cam);
    this.labels.update(this.rig.cam, this.host.clientWidth, this.host.clientHeight);
    this.cube.update(this.rig.cam);
  };
}

export type { Rect, View, Preset };
