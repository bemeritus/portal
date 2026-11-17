/**
 * Cable trays: a U channel along the run (local x), the item's depth as its
 * width and its height as the side height. Ladder trays get rungs.
 */

import * as THREE from "three";

import type { CableTrayProps, CatalogItem, DcObject } from "../../types";
import { box, emptyBuilt, type BuildContext, type Built, type ObjectRenderer } from "./types";

export const trayRenderer: ObjectRenderer = {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built {
    const p = item.props as CableTrayProps;
    const [len, width, h] = ctx.dims;
    const g = new THREE.Group();
    const pick = { type: "object" as const, id: obj.id };
    const t = 3;
    for (const sz of [-1, 1]) g.add(box(ctx, "tray", len, h, t, 0, 0, sz * (width / 2 - t / 2), pick));
    if (p.tray_type === "ladder") {
      for (let x = -len / 2 + 150; x < len / 2; x += 300) g.add(box(ctx, "tray", 30, 10, width, x, 0, 0, pick));
    } else {
      g.add(box(ctx, "tray", len, t, width, 0, 0, 0, pick));
    }
    return emptyBuilt(g, h);
  },
};
