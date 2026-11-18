/**
 * The renderer interface: one implementation per catalog kind, so a phase 2
 * kind plugs in by adding a file and a line in `index.ts`, never by touching
 * the engine.
 *
 * A renderer builds an object in its **local frame** — footprint centred on
 * the origin, width along x, depth along z, the front facing −z, y up from 0,
 * all in millimetres — and the engine places and turns the group. Meshes
 * carry a `role` (for materials) and, if they can be picked, a `pick`.
 */

import * as THREE from "three";

import type { CatalogItem, DcObject, Device, ShelfCell } from "../../types";
import type { MaterialLibrary, Mode } from "../materials";

export type Pick =
  | { type: "object"; id: number }
  | { type: "device"; id: number; rackId: number }
  | { type: "cell"; shelfId: number; cellNo: number };

export interface BuildContext {
  lib: MaterialLibrary;
  mode: Mode;
  /** Devices in this object (racks). */
  devices: Device[];
  /** Occupied cells (shelves). */
  cells: ShelfCell[];
  /** Cells a cooling unit blocks (shelves). */
  blocked: number[];
  /** Local size after the instance's overrides. */
  dims: [number, number, number];
  /** Clear height from the object's top to the ceiling, mm (hangers). */
  ceilingAbove: number;
}

/** What a rack's doors need for the open/close animation. */
export interface DoorLeaf {
  pivot: THREE.Object3D;
  /** +1 hinge on the left (opens anticlockwise from above), −1 on the right. */
  dir: number;
}

export interface Built {
  group: THREE.Group;
  /** Rack door leaves, animated by the engine. */
  doors: DoorLeaf[];
  /** Where a label sits, local. */
  labelAt: THREE.Vector3;
  /** LED positions by status colour, local (realistic mode). */
  leds: { pos: THREE.Vector3; color: string; blink: boolean }[];
}

export interface ObjectRenderer {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built;
}

// --- Helpers shared by the renderers ------------------------------------------

/** A box of size (w, h, d) whose bottom-centre is at (x, y, z). */
export function box(
  ctx: BuildContext,
  role: string,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  pick?: Pick,
): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(w, 1), Math.max(h, 1), Math.max(d, 1)),
    ctx.lib.role(role),
  );
  m.position.set(x, y + h / 2, z);
  m.userData.role = role;
  if (pick) m.userData.pick = pick;
  m.castShadow = ctx.mode === "realistic";
  m.receiveShadow = ctx.mode === "realistic";
  return m;
}

/** A flat rectangle facing −z (or `normal`), centred at (x, y, z). */
export function plane(
  ctx: BuildContext,
  role: string,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  facing: "front" | "back" | "up" = "front",
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), ctx.lib.role(role));
  m.position.set(x, y, z);
  if (facing === "front") m.rotation.y = Math.PI;
  if (facing === "up") m.rotation.x = -Math.PI / 2;
  m.userData.role = role;
  return m;
}

export function emptyBuilt(group: THREE.Group, height: number): Built {
  return {
    group,
    doors: [],
    labelAt: new THREE.Vector3(0, height + 120, 0),
    leds: [],
  };
}
