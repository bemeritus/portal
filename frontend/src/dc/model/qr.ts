/**
 * QR labels (§11.4), pure: what goes on each sticker. Every code is a deep
 * link — `/dc/<room>#obj-12`, `#device-7`, `#cell-5-16` — so a phone camera
 * opens the room with that thing selected.
 */

import type { CatalogItem, DcObject, Device, ShelfCell } from "../types";

export interface Label {
  key: string;
  title: string;
  /** Second line: units, owner, serial. */
  detail: string;
  url: string;
}

export function labelsFor(
  origin: string,
  roomId: number,
  objects: DcObject[],
  catalog: Map<number, CatalogItem>,
  devices: Device[],
  cells: ShelfCell[],
  cellWord: (n: number) => string,
  only: number | null,
): Label[] {
  const base = `${origin}/dc/${roomId}`;
  const out: Label[] = [];
  for (const o of objects) {
    if (only !== null && o.id !== only) continue;
    const kind = catalog.get(o.catalog_id)?.kind;
    if (kind !== "rack" && kind !== "shelf") continue;
    out.push({
      key: `o${o.id}`,
      title: o.name,
      detail: catalog.get(o.catalog_id)?.model ?? "",
      url: `${base}#obj-${o.id}`,
    });
    if (kind === "rack")
      for (const d of devices
        .filter((x) => x.rack_id === o.id)
        .sort((a, b) => b.u_bottom - a.u_bottom)) {
        const u =
          d.u_height > 1
            ? `U${d.u_bottom}–${d.u_bottom + d.u_height - 1}`
            : `U${d.u_bottom}`;
        out.push({
          key: `d${d.id}`,
          title: d.name,
          detail: [`${o.name} · ${u}`, d.owner, d.serial]
            .filter(Boolean)
            .join(" · "),
          url: `${base}#device-${d.id}`,
        });
      }
    else
      for (const c of cells
        .filter((x) => x.shelf_id === o.id)
        .sort((a, b) => a.cell_no - b.cell_no))
        out.push({
          key: `c${o.id}-${c.cell_no}`,
          title: `${cellWord(c.cell_no)}: ${c.name}`,
          detail: [o.name, c.owner].filter(Boolean).join(" · "),
          url: `${base}#cell-${o.id}-${c.cell_no}`,
        });
  }
  return out;
}
