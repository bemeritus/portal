/**
 * Devices in a rack, pure: the text grammar of the elevation editor (ported
 * from the prototype's `parseDev`), guessing a device's kind from its name,
 * free-unit checks per face, and rack totals.
 *
 * Grammar, one device per line:
 *
 *     10-11 DELL R740 | 450 Вт | клиент X | тип=server
 *
 * `10-11` (or `10`) are the units, bottom first or not; then the name; then
 * `|`-separated extras: a power (`450 Вт`, `450 W`, `1,2 кВт`, `2 kW`), a kind
 * (`тип=…` / `type=…` / `tur=…`), a note (`note=…` / `примечание=…` /
 * `izoh=…`); the first other extra is the owner (whose equipment), any
 * further ones join the note.
 */

import type { Device, DeviceFields, DeviceKind, Face } from "../types";
import { DEVICE_KINDS } from "../types";

const KIND_RX: [DeviceKind, RegExp][] = [
  ["ups", /(^|[^a-zа-я])(ибп|ups|apc|smart-?ups)([^a-zа-я]|$)/i],
  ["pdu", /(^|[^a-zа-я])(pdu|розетк\S*|блок розеток)([^a-zа-я]|$)/i],
  ["patch", /(патч|patch|кросс)/i],
  ["kvm", /(^|[^a-zа-я])(kvm|консоль)([^a-zа-я]|$)/i],
  ["blank", /(заглушк|blank)/i],
  ["storage", /(схд|storage|nas|jbod|полка|synology|qnap|netapp)/i],
  ["router", /(маршрутизатор|router|роутер|mikrotik|ccr|juniper mx|asr)/i],
  ["switch", /(коммутатор|switch|свитч|catalyst|nexus|arista|huawei s\d|qfx|crs\d)/i],
];

/** A kind from the name; a server when nothing matches. */
export function guessKind(name: string): DeviceKind {
  for (const [kind, rx] of KIND_RX) if (rx.test(name)) return kind;
  return "server";
}

/** Typical depth per kind (mm), for drawing devices whose depth is unknown. */
export const TYPICAL_DEPTH: Record<DeviceKind, number> = {
  server: 720,
  storage: 750,
  switch: 380,
  router: 400,
  patch: 100,
  ups: 650,
  pdu: 120,
  kvm: 550,
  blank: 15,
  other: 500,
};

const POWER_RX = /^(\d+(?:[.,]\d+)?)\s*(квт|kw|вт|w)$/i;
const KIND_TAG_RX = /^(?:тип|type|tur)\s*=\s*(\w+)$/i;
const NOTE_TAG_RX = /^(?:note|примечание|izoh)\s*=\s*(.*)$/i;

export interface ParsedDevice {
  line: number;
  u_bottom: number;
  u_height: number;
  name: string;
  kind: DeviceKind;
  power_w: number | null;
  owner: string;
  note: string;
}

/** A problem on a line; `code` is translated (`dc.text.<code>`). */
export interface TextError {
  line: number;
  code: "format" | "range" | "emptyName" | "overlap";
  units?: number;
  names?: [string, string];
}

export function parseDevices(text: string, units: number): { devices: ParsedDevice[]; errors: TextError[] } {
  const devices: ParsedDevice[] = [];
  const errors: TextError[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const ln = raw.trim();
    if (!ln) return;
    const m = ln.match(/^(\d+)(?:\s*[-–—]\s*(\d+))?\s+(.+)$/);
    if (!m) {
      errors.push({ line, code: "format" });
      return;
    }
    let a = Number(m[1]),
      b = m[2] ? Number(m[2]) : a;
    if (b < a) [a, b] = [b, a];
    if (a < 1 || b > units) {
      errors.push({ line, code: "range", units });
      return;
    }
    const parts = m[3].split("|").map((s) => s.trim());
    const name = (parts.shift() ?? "").slice(0, 120);
    if (!name) {
      errors.push({ line, code: "emptyName" });
      return;
    }
    const dev: ParsedDevice = { line, u_bottom: a, u_height: b - a + 1, name, kind: guessKind(name), power_w: null, owner: "", note: "" };
    const addNote = (t: string) => {
      if (t) dev.note = dev.note ? `${dev.note} | ${t}` : t;
    };
    for (const p of parts) {
      const pm = p.match(POWER_RX);
      const km = p.match(KIND_TAG_RX);
      const nm = p.match(NOTE_TAG_RX);
      if (pm) {
        const v = parseFloat(pm[1].replace(",", "."));
        dev.power_w = Math.round(v * (/^(квт|kw)$/i.test(pm[2]) ? 1000 : 1));
      } else if (km && (DEVICE_KINDS as string[]).includes(km[1].toLowerCase())) {
        dev.kind = km[1].toLowerCase() as DeviceKind;
      } else if (nm) {
        addNote(nm[1].trim());
      } else if (p && !dev.owner) {
        dev.owner = p;
      } else {
        addNote(p);
      }
    }
    devices.push(dev);
  });
  const sorted = [...devices].sort((p, q) => p.u_bottom - q.u_bottom);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (sorted[i].u_bottom < prev.u_bottom + prev.u_height)
      errors.push({ line: sorted[i].line, code: "overlap", names: [prev.name, sorted[i].name] });
  }
  return { devices, errors };
}

/** The inverse of [`parseDevices`] for one face's devices, top unit first. */
export function devicesToText(devices: Pick<DeviceFields, "u_bottom" | "u_height" | "name" | "kind" | "power_w" | "owner" | "note">[]): string {
  return [...devices]
    .sort((a, b) => b.u_bottom - a.u_bottom)
    .map((d) => {
      const top = d.u_bottom + d.u_height - 1;
      let s = `${d.u_height > 1 ? `${d.u_bottom}-${top}` : d.u_bottom} ${d.name}`;
      if (d.power_w !== null) s += ` | ${d.power_w} W`;
      if (d.owner) s += ` | ${d.owner}`;
      if (d.note) s += ` | note=${d.note.replace(/\n/g, " ")}`;
      if (d.kind !== guessKind(d.name)) s += ` | type=${d.kind}`;
      return s;
    })
    .join("\n");
}

export const facesConflict = (a: Face, b: Face) => a === "both" || b === "both" || a === b;

/** Is `u..u+n-1` free on `face`, ignoring device `skip`? */
export function unitsFree(devices: Device[], units: number, u: number, n: number, face: Face, skip?: number): boolean {
  if (u < 1 || u + n - 1 > units) return false;
  return !devices.some(
    (d) => d.id !== skip && facesConflict(d.face, face) && u < d.u_bottom + d.u_height && d.u_bottom < u + n,
  );
}

export interface RackStats {
  units: number;
  /** Units taken on either face. */
  used: number;
  /** Σ known power. */
  powerW: number;
  /** Devices whose power is unknown. */
  unknownPower: number;
  count: number;
  known: boolean;
}

export function rackStats(devices: Device[], units: number, contentsKnown: boolean): RackStats {
  const taken = new Set<number>();
  let powerW = 0,
    unknownPower = 0;
  for (const d of devices) {
    for (let u = d.u_bottom; u < d.u_bottom + d.u_height; u++) taken.add(u);
    if (d.power_w === null) unknownPower++;
    else powerW += d.power_w;
  }
  return { units, used: taken.size, powerW, unknownPower, count: devices.length, known: contentsKnown };
}

/** Maximal free runs on a face, bottom first — for the fill mode's highlight. */
export function freeRuns(devices: Device[], units: number, face: Face): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start: number | null = null;
  for (let u = 1; u <= units; u++) {
    const busy = devices.some((d) => facesConflict(d.face, face) && u >= d.u_bottom && u < d.u_bottom + d.u_height);
    if (!busy && start === null) start = u;
    if (busy && start !== null) {
      out.push({ from: start, to: u - 1 });
      start = null;
    }
  }
  if (start !== null) out.push({ from: start, to: units });
  return out;
}
