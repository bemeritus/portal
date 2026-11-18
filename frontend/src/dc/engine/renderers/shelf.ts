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
import { PLATE_ATLAS, plateUv } from "../materials";
import {
  box,
  surface,
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
    // The posts' and boards' colour and surface come from the item.
    const postRole = surface("shelf", p.finish);
    const boardRole = surface("board", p.finish);
    for (const x of postX) {
      g.add(box(ctx, postRole, post, h, post, x, 0, -d / 2 + post / 2, pick));
      g.add(box(ctx, postRole, post, h, post, x, 0, d / 2 - post / 2, pick));
    }
    for (const by of p.boards_mm)
      g.add(box(ctx, boardRole, w, 20, d, 0, by - 20, 0, pick));

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
        const geo = new THREE.PlaneGeometry(56, 34);
        if (n <= PLATE_ATLAS) {
          // Point the plate at its number in the shared atlas.
          const [u0, v0, u1, v1] = plateUv(n);
          const uv = geo.getAttribute("uv");
          for (let i = 0; i < uv.count; i++)
            uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0);
        }
        const pl = new THREE.Mesh(geo, ctx.lib.plate(n));
        pl.position.set(x, y - 10, -d / 2 - 2);
        pl.rotation.y = Math.PI;
        pl.userData.role = "plate";
        pl.userData.fixedMaterial = true;
        pl.userData.plate = n;
        g.add(pl);
      }
      if (blocked.has(n)) {
        // Schema, fill and power modes: a red fill on the board. Realistic
        // shows the cell as it is; an outline and hatch in the warning
        // colour appear only while it is hovered or selected (FEEDBACK-2 §2).
        if (ctx.mode === "realistic")
          g.add(blockedMark(ctx, n, cellW - 30, ch, d - 60, x, y));
        else g.add(box(ctx, "cellBlocked", cellW - 30, 6, d - 60, x, y + 1, 0));
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

/**
 * 45° hatch lines clipped to a w × h rectangle, `step` apart, as
 * `[x0, y0, x1, y1]` from its lower-left corner.
 */
export function hatch(
  w: number,
  h: number,
  step: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  // The line x + y = c crosses it for x in [max(0, c − h), min(w, c)].
  for (let c = step; c < w + h; c += step) {
    const x0 = Math.max(0, c - h);
    const x1 = Math.min(w, c);
    out.push([x0, c - x0, x1, c - x1]);
  }
  return out;
}

/**
 * A blocked cell in realistic: the outline of its space and a hatch over
 * its front opening, in the theme's warning colour, hidden until the engine
 * shows it for the hovered or selected cell (`userData.blockedCell`).
 */
function blockedMark(
  ctx: BuildContext,
  n: number,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
): THREE.Group {
  const mat = ctx.lib.line(ctx.lib.theme.warn);
  const mark = new THREE.Group();
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    mat,
  );
  outline.position.set(x, y + h / 2, 0);
  mark.add(outline);
  // The front faces −z; the hatch sits just inside the opening.
  const pts: number[] = [];
  for (const [x0, y0, x1, y1] of hatch(w, h, 90))
    pts.push(x - w / 2 + x0, y + y0, -d / 2, x - w / 2 + x1, y + y1, -d / 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  mark.add(new THREE.LineSegments(geo, mat));
  mark.visible = false;
  mark.renderOrder = 999;
  mark.children.forEach((c) => (c.renderOrder = 999));
  mark.userData.blockedCell = n;
  return mark;
}
