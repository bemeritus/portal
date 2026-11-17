import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { mergeStatic } from "./merge";

const mat = new THREE.MeshBasicMaterial();
const other = new THREE.MeshBasicMaterial();
const rod = (x: number, m: THREE.Material = mat) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 100), m);
  mesh.position.set(x, 0, 0);
  mesh.userData.role = "tray";
  return mesh;
};

describe("mergeStatic", () => {
  it("draws parts that share a material as one mesh, where they were", () => {
    const g = new THREE.Group();
    for (let i = 0; i < 170; i++) g.add(rod(i * 20));
    expect(mergeStatic(g)).toBe(169);
    expect(g.children).toHaveLength(1);
    const m = g.children[0] as THREE.Mesh;
    expect(m.userData.role).toBe("tray");
    m.geometry.computeBoundingBox();
    expect(m.geometry.boundingBox!.min.x).toBeCloseTo(-5);
    expect(m.geometry.boundingBox!.max.x).toBeCloseTo(169 * 20 + 5);
  });

  it("keeps pickable parts, owners, door leaves, fixed and other materials apart", () => {
    const g = new THREE.Group();
    g.add(rod(0), rod(20), rod(40, other));
    const device = rod(60);
    device.userData.pick = { type: "device", id: 1, rackId: 2 };
    const cell = rod(80);
    cell.userData.owner = "X";
    const plate = rod(100);
    plate.userData.fixedMaterial = true;
    const pivot = new THREE.Group();
    pivot.add(rod(120), rod(140));
    g.add(device, cell, plate, pivot);
    mergeStatic(g);
    // two rods → one; the rest untouched
    expect(g.children).toHaveLength(6);
    expect(g.children).toContain(device);
    expect(g.children).toContain(cell);
    expect(g.children).toContain(plate);
    expect(pivot.children).toHaveLength(2);
  });

  it("merges plates on one atlas and keeps them fixed", () => {
    const g = new THREE.Group();
    for (let i = 0; i < 28; i++) {
      const p = rod(i * 20);
      p.userData = { role: "plate", fixedMaterial: true, plate: i + 1 };
      g.add(p);
    }
    mergeStatic(g);
    expect(g.children).toHaveLength(1);
    expect(g.children[0].userData.fixedMaterial).toBe(true);
  });
});
