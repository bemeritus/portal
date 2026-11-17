/**
 * Structures: doors, safes, walls, columns, windows, furniture. Simple,
 * recognisable shapes; a door is its closed leaf in the opening (its swing
 * is drawn on the floor by the engine, from the same geometry the server
 * checks).
 */

import * as THREE from "three";

import type { CatalogItem, DcObject, StructureProps } from "../../types";
import { box, emptyBuilt, type BuildContext, type Built, type ObjectRenderer } from "./types";

export const structureRenderer: ObjectRenderer = {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built {
    const p = item.props as StructureProps;
    const [w, d, h] = ctx.dims;
    const g = new THREE.Group();
    const pick = { type: "object" as const, id: obj.id };
    switch (p.subtype) {
      case "door": {
        const t = 45;
        g.add(box(ctx, "door", w - 20, h - 10, t, 0, 0, 0, pick));
        g.add(box(ctx, "rail", 20, h, t + 20, -w / 2 + 10, 0, 0, pick));
        g.add(box(ctx, "rail", 20, h, t + 20, w / 2 - 10, 0, 0, pick));
        g.add(box(ctx, "rail", w, 20, t + 20, 0, h - 20, 0, pick));
        const handleX = obj.instance.hinge === "high" ? -w / 2 + 90 : w / 2 - 90;
        g.add(box(ctx, "rail", 120, 25, t + 50, handleX, 1000, 0, pick));
        break;
      }
      case "safe": {
        g.add(box(ctx, "safe", w, h, d, 0, 0, 0, pick));
        g.add(box(ctx, "rail", w - 40, h - 40, 8, 0, 20, -d / 2 - 4, pick));
        const dial = new THREE.Mesh(new THREE.CylinderGeometry(45, 45, 25, 24), ctx.lib.role("rail"));
        dial.rotation.x = Math.PI / 2;
        dial.position.set(w * 0.2, h * 0.6, -d / 2 - 15);
        dial.userData.role = "rail";
        dial.userData.pick = pick;
        g.add(dial);
        break;
      }
      case "locker": {
        // Grey two-section metal locker (photos 02, 06): body, a seam between
        // the two doors, two handles.
        g.add(box(ctx, "locker", w, h, d, 0, 0, 0, pick));
        g.add(box(ctx, "rail", w - 20, 6, 6, 0, h / 2, -d / 2 - 3, pick));
        for (const y of [h * 0.75, h * 0.25]) g.add(box(ctx, "rail", 30, 60, 14, w / 2 - 50, y, -d / 2 - 7, pick));
        break;
      }
      case "window":
        g.add(box(ctx, "glass", w, h, Math.max(d, 20), 0, 0, 0, pick));
        break;
      default:
        g.add(box(ctx, "structure", w, h, Math.max(d, 10), 0, 0, 0, pick));
    }
    return emptyBuilt(g, h);
  },
};
