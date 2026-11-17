/**
 * Fewer draw calls: an object's static parts that share a material are drawn
 * as one mesh. A cable tray of 172 meshes becomes 8; a rack's
 * frame, caps and panels a handful.
 *
 * Only direct children of the object's group are merged — door leaves hang
 * under pivots and keep moving — and never anything that can be picked on
 * its own (devices, shelf cells) or carries its own data (an owner). A
 * fixed material (the shelf's number plates, one atlas) merges with its own
 * kind and stays fixed. The merged mesh keeps the role, so mode, theme and
 * highlight still swap its material like any other.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const KEEP = ["position", "normal", "uv"] as const;

function mergeable(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  return (
    !!m.isMesh &&
    !Array.isArray(m.material) &&
    !m.userData.pick &&
    !m.userData.device &&
    m.userData.owner === undefined &&
    !m.userData.noMerge &&
    KEEP.every((a) => !!m.geometry.getAttribute(a))
  );
}

/** Merge in place; returns how many meshes were removed. */
export function mergeStatic(group: THREE.Group): number {
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const c of group.children) {
    if (!mergeable(c)) continue;
    const mat = c.material as THREE.Material;
    const key = [
      c.userData.role ?? "",
      mat.uuid,
      !!c.userData.fixedMaterial,
      c.castShadow,
      c.receiveShadow,
      c.renderOrder,
      c.visible,
    ].join("|");
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  let removed = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos = list.map((m) => {
      m.updateMatrix();
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes))
        if (!(KEEP as readonly string[]).includes(name))
          g.deleteAttribute(name);
      g = g.applyMatrix4(m.matrix);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const first = list[0];
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.userData = { role: first.userData.role, merged: list.length };
    if (first.userData.fixedMaterial) mesh.userData.fixedMaterial = true;
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    for (const m of list) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(mesh);
    removed += list.length - 1;
  }
  return removed;
}
