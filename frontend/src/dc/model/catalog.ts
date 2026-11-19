/**
 * The catalog section's pure logic (SPEC §11.3, FEEDBACK-4): how an item's
 * size is written, what each card and table row shows, the filters held in
 * the URL, sorting, and which rows of a comparison differ. No React, no
 * three.js; the pages and the tests share it.
 */

import type { Fmt } from "../format";
import type { CatalogItem, CatalogUse, CoolingProps, Kind } from "../types";

/** W × D × H in the user's unit, every value in that unit: `60 × 113.2 × 200 cm`. */
export function dimsText(item: CatalogItem, fmt: Fmt): string {
  return fmt.dims(item.width_mm, item.depth_mm, item.height_mm);
}

/** The three numbers alone, for a row that names the unit in its label. */
export function dimsNumbers(item: CatalogItem, fmt: Fmt): string {
  return [item.width_mm, item.depth_mm, item.height_mm]
    .map((v) => fmt.len(v))
    .join(" × ");
}

// --- Sections ----------------------------------------------------------------------

export interface Section {
  key: string;
  kinds: string[];
  /** Comes with the room designer (phase 2): listed, muted, not openable. */
  designer?: boolean;
}

/** Sections of the catalog (and of the phase 2 palette). */
export const SECTIONS: Section[] = [
  { key: "racks", kinds: ["rack", "shelf"] },
  { key: "cooling", kinds: ["cooling"] },
  { key: "power", kinds: ["ups", "pdu", "panel"], designer: true },
  { key: "floor", kinds: ["raised_floor"], designer: true },
  { key: "trays", kinds: ["cable_tray"] },
  { key: "structures", kinds: ["structure"] },
];

export function sectionOf(kind: Kind | string): string {
  return SECTIONS.find((s) => s.kinds.includes(kind))?.key ?? "cooling";
}

// --- What an item is -----------------------------------------------------------------

export const isPrecision = (i: CatalogItem) =>
  i.kind === "cooling" &&
  (i.props.subtype === "in_row" || i.props.subtype === "precision_perimeter");

/** The kind's subtype, for the "execution" filter and column. */
export function execution(i: CatalogItem): string {
  if (i.kind === "cooling" || i.kind === "structure") return i.props.subtype;
  return i.kind;
}

/** The capacity to show and compare: sensible when published, else total, marked. */
export function capacity(
  i: CatalogItem,
): { w: number; sensible: boolean } | null {
  if (i.kind !== "cooling") return null;
  const p = i.props;
  if (p.cooling_sensible_w !== null)
    return { w: p.cooling_sensible_w, sensible: true };
  if (p.cooling_total_w !== null)
    return { w: p.cooling_total_w, sensible: false };
  return null;
}

/** The highest fan step, m³/h, or null when not published. */
export function airflow(i: CatalogItem): number | null {
  if (i.kind !== "cooling" || i.props.airflow_m3h.length === 0) return null;
  return Math.max(...i.props.airflow_m3h);
}

export function mass(i: CatalogItem): number | null {
  return i.kind === "cooling" ? i.props.weight_kg : null;
}

/** The model without its parenthetical remark: `Liebert CRV CRD25`. */
export function shortModel(model: string): string {
  const i = model.indexOf(" (");
  return i > 0 ? model.slice(0, i) : model;
}

/** The parenthetical remark of a model, if any: `DX, air-cooled`. */
export function modelRemark(model: string): string | null {
  const m = model.match(/\(([^)]*)\)\s*$/);
  return m ? m[1] : null;
}

/** An item measured in the user's room, not taken from a datasheet. */
export function fromRoom(i: CatalogItem): boolean {
  return i.kind === "cooling" ? !i.props.model_known : !i.manufacturer;
}

/** How many objects use each item. */
export function usageCount(uses: CatalogUse[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const u of uses) out.set(u.catalog_id, (out.get(u.catalog_id) ?? 0) + 1);
  return out;
}

// --- Filters, in the URL ------------------------------------------------------------

export type Purpose = "all" | "precision" | "comfort";
export type SortKey =
  | "name"
  | "brand"
  | "exec"
  | "cold"
  | "air"
  | "size"
  | "mass"
  | "h247"
  | "used";
export type SortDir = "asc" | "desc";

export interface Filters {
  q: string;
  purpose: Purpose;
  /** Executions left out (unticked); empty = all. */
  execOff: string[];
  /** Manufacturers left out; empty = all. */
  brandOff: string[];
  /** Capacity range, W; null ends are open. */
  kw: [number | null, number | null];
  /** Width range, mm. */
  width: [number | null, number | null];
  only247: boolean;
  sensibleOnly: boolean;
  sort: SortKey;
  dir: SortDir;
  view: "cards" | "table";
  /** Items picked for comparison (ids), at most three. */
  compare: number[];
}

export const DEFAULT_FILTERS: Filters = {
  q: "",
  purpose: "all",
  execOff: [],
  brandOff: [],
  kw: [null, null],
  width: [null, null],
  only247: false,
  sensibleOnly: false,
  sort: "cold",
  dir: "desc",
  view: "cards",
  compare: [],
};

const SORTS: SortKey[] = [
  "name",
  "brand",
  "exec",
  "cold",
  "air",
  "size",
  "mass",
  "h247",
  "used",
];

const list = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);
const num = (s: string | undefined) => {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const range = (s: string | null): [number | null, number | null] => {
  if (!s) return [null, null];
  const [a, b] = s.split("..");
  return [num(a), num(b)];
};

/** Filters from the query string; anything unreadable falls back to the default. */
export function parseFilters(q: URLSearchParams): Filters {
  const purpose = q.get("purpose");
  const sort = q.get("sort") as SortKey;
  const dir = q.get("dir");
  return {
    q: q.get("q") ?? "",
    purpose: purpose === "precision" || purpose === "comfort" ? purpose : "all",
    execOff: list(q.get("exec_off")),
    brandOff: list(q.get("brand_off")),
    kw: range(q.get("kw")),
    width: range(q.get("width")),
    only247: q.get("h247") === "1",
    sensibleOnly: q.get("sensible") === "1",
    sort: SORTS.includes(sort) ? sort : DEFAULT_FILTERS.sort,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_FILTERS.dir,
    view: q.get("view") === "table" ? "table" : "cards",
    compare: list(q.get("cmp"))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 3),
  };
}

/** The query string for filters: only what differs from the default. */
export function filtersToParams(f: Filters): URLSearchParams {
  const q = new URLSearchParams();
  const r = (v: [number | null, number | null]) =>
    `${v[0] ?? ""}..${v[1] ?? ""}`;
  if (f.q) q.set("q", f.q);
  if (f.purpose !== "all") q.set("purpose", f.purpose);
  if (f.execOff.length) q.set("exec_off", f.execOff.join(","));
  if (f.brandOff.length) q.set("brand_off", f.brandOff.join(","));
  if (f.kw[0] !== null || f.kw[1] !== null) q.set("kw", r(f.kw));
  if (f.width[0] !== null || f.width[1] !== null) q.set("width", r(f.width));
  if (f.only247) q.set("h247", "1");
  if (f.sensibleOnly) q.set("sensible", "1");
  if (f.sort !== DEFAULT_FILTERS.sort) q.set("sort", f.sort);
  if (f.dir !== DEFAULT_FILTERS.dir) q.set("dir", f.dir);
  if (f.view !== "cards") q.set("view", f.view);
  if (f.compare.length) q.set("cmp", f.compare.join(","));
  return q;
}

/** Filters that narrow the list (not the sort, view or comparison). */
export function filtering(f: Filters): boolean {
  return (
    !!f.q ||
    f.purpose !== "all" ||
    f.execOff.length > 0 ||
    f.brandOff.length > 0 ||
    f.kw.some((v) => v !== null) ||
    f.width.some((v) => v !== null) ||
    f.only247 ||
    f.sensibleOnly
  );
}

/** The filters with every narrowing one reset; sort, view and comparison kept. */
export function resetFilters(f: Filters): Filters {
  return {
    ...DEFAULT_FILTERS,
    sort: f.sort,
    dir: f.dir,
    view: f.view,
    compare: f.compare,
  };
}

const inRange = (
  v: number | null,
  [lo, hi]: [number | null, number | null],
) => {
  if (lo === null && hi === null) return true;
  // An unknown value cannot be said to be in a narrowed range.
  if (v === null) return false;
  return (lo === null || v >= lo) && (hi === null || v <= hi);
};

// Case-insensitive, and the Cyrillic "yo" matches "ye".
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** The items of a section that pass the filters (unsorted). */
export function applyFilters(items: CatalogItem[], f: Filters): CatalogItem[] {
  const words = norm(f.q).split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (f.purpose === "precision" && !isPrecision(i)) return false;
    if (f.purpose === "comfort" && (i.kind !== "cooling" || isPrecision(i)))
      return false;
    if (f.execOff.includes(execution(i))) return false;
    if (f.brandOff.includes(i.manufacturer)) return false;
    if (!inRange(capacity(i)?.w ?? null, f.kw)) return false;
    if (!inRange(i.width_mm, f.width)) return false;
    if (f.only247 && !(i.kind === "cooling" && i.props.designed_24_7))
      return false;
    if (
      f.sensibleOnly &&
      !(i.kind === "cooling" && i.props.cooling_sensible_w !== null)
    )
      return false;
    const text = norm(`${i.manufacturer} ${i.model}`);
    return words.every((w) => text.includes(w));
  });
}

/** Counts per value of `key` among `items`, for the checkbox lists. */
export function counts(
  items: CatalogItem[],
  key: (i: CatalogItem) => string,
): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

/** The bounds of a numeric property over items, for a range slider. */
export function bounds(
  items: CatalogItem[],
  value: (i: CatalogItem) => number | null,
): [number, number] | null {
  const v = items.map(value).filter((x): x is number => x !== null);
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
}

/** Sort by a column; unknown values go last whatever the direction. */
export function sortItems(
  items: CatalogItem[],
  key: SortKey,
  dir: SortDir,
  used: Map<number, number>,
  label: (i: CatalogItem) => string,
): CatalogItem[] {
  const value = (i: CatalogItem): number | string | null => {
    switch (key) {
      case "name":
        return shortModel(i.model).toLowerCase();
      case "brand":
        return i.manufacturer.toLowerCase() || null;
      case "exec":
        return label(i).toLowerCase();
      case "cold":
        return capacity(i)?.w ?? null;
      case "air":
        return airflow(i);
      case "size":
        return i.width_mm * i.depth_mm * i.height_mm;
      case "mass":
        return mass(i);
      case "h247":
        return i.kind === "cooling" && i.props.designed_24_7 !== null
          ? Number(i.props.designed_24_7)
          : null;
      case "used":
        return used.get(i.id) ?? 0;
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const va = value(a),
      vb = value(b);
    if (va === null && vb === null) return a.id - b.id;
    if (va === null) return 1;
    if (vb === null) return -1;
    const c =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return c * sign || a.id - b.id;
  });
}

/** For each row of a comparison, whether the items differ in it. */
export function differing(rows: string[][]): boolean[] {
  return rows.map((r) => new Set(r).size > 1);
}

// --- Airflow legend ------------------------------------------------------------------

export type Face = "front" | "rear" | "top" | "bottom" | "sides";

/**
 * Which faces air leaves (supply) and enters (return) through, as the
 * subtype's openings place them (renderers/cooling.ts `openings`) — for the
 * legend under the item page's 3D view.
 */
export function airFaces(p: CoolingProps): { supply: Face[]; ret: Face[] } {
  switch (p.subtype) {
    case "split_wall":
      return { supply: ["front"], ret: ["top"] };
    case "split_cassette":
      return { supply: ["sides"], ret: ["bottom"] };
    case "split_floor_ceiling":
      return { supply: ["front"], ret: ["bottom"] };
    case "ducted":
    case "in_row":
      return { supply: ["front"], ret: ["rear"] };
    case "precision_perimeter":
      return (p.discharge_options[0] ?? "upflow") === "downflow"
        ? { supply: ["bottom"], ret: ["top"] }
        : { supply: ["top"], ret: ["front"] };
  }
}
