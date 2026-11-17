/**
 * Shelves: posts, boards, section dividers, and what stands in each cell.
 * Cells are numbered from the top board down, left to right as seen from the
 * front (column 0 at local +x, since the local front faces −z). Every cell
 * has an invisible hit box so a click selects it; cells under a cooling unit
 * are marked as blocked.
 */

import * as THREE from "three";

import type { CatalogItem, DcObject, ShelfProps } from "../../types";
import { cellCount, cellInfo } from "../../model/geometry";
import {
  box,
  type BuildContext,
  type Built,
  type ObjectRenderer,
} from "./types";

/** What stands in a cell: a tower case, as in the prototype. */
const ITEM = { w: 200, h: 440, d: 460 };

export const shelfRenderer: ObjectRenderer = {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built {
    const p = item.props as ShelfProps;
    const [w, d, h] = ctx.dims;
    const g = new THREE.Group();
    const pick = { type: "object" as const, id: obj.id };
    const post = 40;
    const cellW = w / p.cells_per_board;
    // Posts at both ends and between sections.
    const postX = [-w / 2 + post / 2, w / 2 - post / 2];
    let at = 0;
    for (const sec of p.sections.slice(0, -1)) {
      at += sec;
      postX.push(w / 2 - at * cellW);
    }
    for (const x of postX) {
      g.add(box(ctx, "shelf", post, h, post, x, 0, -d / 2 + post / 2, pick));
      g.add(box(ctx, "shelf", post, h, post, x, 0, d / 2 - post / 2, pick));
    }
    for (const by of p.boards_mm)
      g.add(box(ctx, "board", w, 20, d, 0, by - 20, 0, pick));

    const blocked = new Set(ctx.blocked);
    const cells = new Map(ctx.cells.map((c) => [c.cell_no, c]));
    const boards = [...p.boards_mm].sort((a, b) => a - b);
    for (let n = 1; n <= cellCount(p); n++) {
      const c = cellInfo(p, n)!;
      const x = w / 2 - cellW * (c.column + 0.5);
      const y = c.boardY;
      // Height up to the next board, or a nominal top-board cell.
      const above = boards.find((b) => b > y);
      const ch = above ? above - y - 30 : 580;
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(cellW - 10, ch, d - 10),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.set(x, y + ch / 2, 0);
      hit.userData.pick = { type: "cell", shelfId: obj.id, cellNo: n };
      hit.userData.role = "hit";
      hit.userData.fixedMaterial = true;
      g.add(hit);
      // White number plates on the front edge of plated boards (photo 02).
      if (c.plated) {
        const pl = new THREE.Mesh(
          new THREE.PlaneGeometry(56, 34),
          ctx.lib.plate(n),
        );
        pl.position.set(x, y - 10, -d / 2 - 2);
        pl.rotation.y = Math.PI;
        pl.userData.role = "plate";
        pl.userData.fixedMaterial = true;
        pl.userData.plate = n;
        g.add(pl);
      }
      if (blocked.has(n)) {
        g.add(box(ctx, "cellBlocked", cellW - 30, 6, d - 60, x, y + 1, 0));
      }
      const cell = cells.get(n);
      if (cell) {
        const m = box(
          ctx,
          "cell",
          ITEM.w,
          Math.min(ITEM.h, ch - 10),
          ITEM.d,
          x,
          y,
          -d / 2 + 40 + ITEM.d / 2,
          {
            type: "cell",
            shelfId: obj.id,
            cellNo: n,
          },
        );
        m.userData.owner = cell.owner;
        g.add(m);
      }
    }
    return {
      group: g,
      doors: [],
      labelAt: new THREE.Vector3(0, h + 140, 0),
      leds: [],
    };
  },
};
