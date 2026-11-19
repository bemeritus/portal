/**
 * Materials and textures for the four phase 1 modes.
 *
 * Renderers never pick a material themselves: every mesh carries a *role*
 * (`userData.role`, e.g. `rackFrame`, `device:server`, `glass`) and the
 * engine assigns the material for the current mode from this library. A mode
 * switch is therefore a walk over the scene, not a rebuild.
 *
 * - schema: flat, unlit-looking neutral colours, high contrast.
 * - realistic: PBR (powder-coated steel, glass with transmission-like
 *   opacity, perforated mesh by alpha texture), lit by a procedural room
 *   environment bundled with three.js — no HDR file is downloaded.
 * - fill / power: as schema, with racks tinted by the engine.
 *
 * Textures are drawn on canvases once and cached; `dispose()` frees them all.
 */

import * as THREE from "three";

import type { DeviceKind } from "../types";
import { baseRole } from "./renderers/types";
import type { DcTheme } from "./theme";

type FinishKind = "powder" | "galvanised" | "white_plastic";

/** The finish a `surface()` role carries, if any. */
function finishOf(role: string): { kind: FinishKind; color: string } | null {
  const [, kind, color] = role.split("|");
  return kind && color ? { kind: kind as FinishKind, color } : null;
}

/** A dark colour a shade lighter (frames and rims catch the light); light ones as they are. */
export function lighter(color: string, by = 0.18): string {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l > 0.5) return color;
  c.setHSL(hsl.h, hsl.s, Math.min(1, hsl.l + by));
  return `#${c.getHexString()}`;
}

export type Mode = "schema" | "realistic" | "fill" | "power";

/** Device colours by kind, from the prototype. */
export const DEVICE_COLOR: Record<DeviceKind, string> = {
  server: "#39485c",
  storage: "#4b4170",
  switch: "#1d5f6e",
  router: "#2c5c8c",
  patch: "#575c63",
  ups: "#73511f",
  pdu: "#733232",
  kvm: "#3e5c40",
  blank: "#262a30",
  other: "#474d56",
};

function canvas(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function fitText(g: CanvasRenderingContext2D, t: string, maxW: number): string {
  if (g.measureText(t).width <= maxW) return t;
  while (t.length > 1 && g.measureText(t + "…").width > maxW)
    t = t.slice(0, -1);
  return t + "…";
}

/** A device's front panel by kind, with its name — the prototype's `devCanvas`. */
function deviceFront(
  kind: DeviceKind,
  units: number,
  name: string,
): HTMLCanvasElement {
  const cw = 512,
    ch = Math.max(24, Math.round(units * 47));
  const [c, g] = canvas(cw, ch);
  g.fillStyle = "#16181c";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#2b2f35";
  g.fillRect(0, 0, 22, ch);
  g.fillRect(cw - 22, 0, 22, ch);
  g.fillStyle = "#0c0d0f";
  for (const [x, y] of [
    [11, 9],
    [11, ch - 9],
    [cw - 11, 9],
    [cw - 11, ch - 9],
  ]) {
    g.beginPath();
    g.arc(x, y, 3.2, 0, 7);
    g.fill();
  }
  const x0 = 34,
    x1 = cw - 28,
    iw = x1 - x0,
    y0 = 4,
    ih = ch - 8;
  g.fillStyle = kind === "blank" ? "#1d2025" : "#1f2228";
  g.fillRect(24, 2, cw - 48, ch - 4);
  const bays = (bx: number, bw: number, cols: number, rows: number) => {
    const gw = bw / cols,
      gh = ih / rows;
    for (let r = 0; r < rows; r++)
      for (let q = 0; q < cols; q++) {
        g.fillStyle = "#0d0e11";
        g.fillRect(bx + q * gw + 2, y0 + r * gh + 2, gw - 4, gh - 4);
        g.fillStyle = "#343941";
        g.fillRect(
          bx + q * gw + 4,
          y0 + r * gh + 4,
          gw - 8,
          Math.max(2, gh - 8),
        );
      }
  };
  const vents = (vx: number, vw: number) => {
    g.fillStyle = "#0b0c0e";
    for (let y = y0 + 4; y < y0 + ih - 3; y += 6)
      for (let x = vx + ((y / 6) % 2 > 1 ? 3 : 0); x < vx + vw - 3; x += 7)
        g.fillRect(x, y, 4, 3);
  };
  const ports = (
    px: number,
    pw: number,
    cols: number,
    rows: number,
    light: boolean,
  ) => {
    const gw = pw / cols,
      ph = Math.min(15, (ih - 6) / rows - 3);
    for (let r = 0; r < rows; r++)
      for (let q = 0; q < cols; q++) {
        const xx = px + q * gw,
          yy = y0 + ih / 2 - (rows * (ph + 3)) / 2 + r * (ph + 3) + 1.5;
        g.fillStyle = light ? "#b9bec5" : "#0a0b0d";
        g.fillRect(xx + 1, yy, gw - 3, ph);
        g.fillStyle = light ? "#22252a" : "#3a4048";
        g.fillRect(xx + 3, yy + 2, gw - 7, Math.max(2, ph - 5));
      }
  };
  if (kind === "server") {
    bays(
      x0 + 8,
      iw * 0.62,
      units === 1 ? 4 : 8,
      Math.max(1, Math.min(units, 3)),
    );
    vents(x0 + 8 + iw * 0.64, iw * 0.36 - 12);
  } else if (kind === "storage")
    bays(x0 + 8, iw - 12, 4, Math.max(1, Math.round(units * 1.5)));
  else if (kind === "switch" || kind === "router") {
    const rows = ch >= 40 ? 2 : 1;
    ports(x0 + 10, iw * 0.74, kind === "router" ? 12 : 24, rows, false);
    ports(x0 + 10 + iw * 0.78, iw * 0.2, 4, rows, false);
  } else if (kind === "patch")
    ports(x0 + 10, iw - 20, 24, units > 1 ? 2 : 1, true);
  else if (kind === "ups") {
    vents(x0 + 8, iw * 0.34);
    vents(x0 + iw * 0.66, iw * 0.34 - 8);
    g.fillStyle = "#0a1b24";
    g.fillRect(x0 + iw * 0.4, y0 + ih * 0.2, iw * 0.2, ih * 0.6);
  } else if (kind === "pdu") {
    const n = 10,
      gw = (iw - 70) / n;
    for (let q = 0; q < n; q++) {
      g.fillStyle = "#0a0b0d";
      g.beginPath();
      g.arc(
        x0 + 60 + q * gw + gw / 2,
        y0 + ih / 2,
        Math.min(gw * 0.36, ih * 0.36),
        0,
        7,
      );
      g.fill();
    }
  } else if (kind === "kvm") {
    g.fillStyle = "#0d0e11";
    g.fillRect(x0 + 10, y0 + ih * 0.3, iw - 20, ih * 0.4);
  } else if (kind === "other") vents(x0 + 8, iw - 12);
  g.fillStyle = DEVICE_COLOR[kind];
  g.fillRect(24, 2, 7, ch - 4);
  if (name) {
    const fs = Math.max(20, Math.min(30, ch * 0.62));
    g.font = `600 ${fs}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    const t = fitText(g, name, iw * 0.7);
    const tw = g.measureText(t).width;
    g.fillStyle = "rgba(8,9,11,.82)";
    g.fillRect(x0 + 2, ch / 2 - fs * 0.68, tw + 16, fs * 1.36);
    g.fillStyle = "#f4f6f8";
    g.fillText(t, x0 + 10, ch / 2 + 1);
  }
  return c;
}

/** Honeycomb perforation (photos 03, 05): white = metal, black = hole. */
function perforated(): HTMLCanvasElement {
  const [c, g] = canvas(64, 56);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 64, 56);
  g.fillStyle = "#000000";
  const hex = (cx: number, cy: number, r: number) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  };
  // Two rows of a hex grid, tiling seamlessly (pitch 16 × 14).
  for (let row = 0; row < 5; row++)
    for (let col = -1; col < 5; col++)
      hex(col * 16 + (row % 2 ? 8 : 0) + 8, row * 14, 6.2);
  return c;
}

/** A seeded random generator, so procedural textures look the same every time. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Galvanised sheet steel: a light ground with a spangle of zinc crystals. */
function galvanised(): HTMLCanvasElement {
  const n = 256;
  const [c, g] = canvas(n, n);
  const r = seeded(1234567);
  g.fillStyle = "#bcc1c6";
  g.fillRect(0, 0, n, n);
  for (let i = 0; i < 260; i++) {
    const x = r() * n,
      y = r() * n,
      rad = 6 + r() * 18,
      v = (150 + r() * 70) | 0;
    g.fillStyle = `rgba(${v},${v + 4},${v + 8},0.35)`;
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2;
      g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    g.fill();
  }
  return c;
}

/**
 * The floor of the photos: terracotta tiles with an interlocking lighter
 * pattern. One canvas is one 300 mm tile.
 */
function tiles(): HTMLCanvasElement {
  const n = 256;
  const [c, g] = canvas(n, n);
  g.fillStyle = "#b47a4b";
  g.fillRect(0, 0, n, n);
  g.strokeStyle = "#c79466";
  g.lineWidth = n * 0.06;
  g.lineCap = "round";
  // Interlocking arcs, as on the tiles.
  for (const [cx, cy, a0] of [
    [0, 0, 0],
    [n, 0, Math.PI / 2],
    [n, n, Math.PI],
    [0, n, -Math.PI / 2],
  ]) {
    g.beginPath();
    g.arc(cx, cy, n * 0.42, a0, a0 + Math.PI / 2);
    g.stroke();
  }
  g.strokeStyle = "#a9713f";
  g.lineWidth = n * 0.025;
  g.beginPath();
  g.arc(n / 2, n / 2, n * 0.18, 0, Math.PI * 2);
  g.stroke();
  // Grout.
  g.fillStyle = "#9c6a40";
  g.fillRect(0, 0, n, 3);
  g.fillRect(0, 0, 3, n);
  return c;
}

/** A white number plate, as on the shelf's boards (photo 02). */
/** Numbers 1–64 on one texture, 8 × 8 plates of 64 × 40 px. */
export const PLATE_ATLAS = 64;
function plateAtlas(): HTMLCanvasElement {
  const [c, g] = canvas(8 * 64, 8 * 40);
  for (let n = 1; n <= PLATE_ATLAS; n++) {
    const p = plate(n);
    g.drawImage(p, ((n - 1) % 8) * 64, Math.floor((n - 1) / 8) * 40);
  }
  return c;
}

/** The atlas cell of plate `n` as UV bounds [u0, v0, u1, v1]. */
export function plateUv(n: number): [number, number, number, number] {
  const col = (n - 1) % 8,
    row = Math.floor((n - 1) / 8);
  return [col / 8, 1 - (row + 1) / 8, (col + 1) / 8, 1 - row / 8];
}

function plate(n: number): HTMLCanvasElement {
  const [c, g] = canvas(64, 40);
  g.fillStyle = "#f4f4f2";
  g.fillRect(0, 0, 64, 40);
  g.fillStyle = "#111111";
  g.font = "600 26px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), 32, 21);
  return c;
}

/** Diagonal hatching: "unknown power", never drawn as zero. */
function hatch(color: string): HTMLCanvasElement {
  const [c, g] = canvas(32, 32);
  g.fillStyle = "#9aa0a6";
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = color;
  g.lineWidth = 6;
  for (let i = -32; i < 64; i += 12) {
    g.beginPath();
    g.moveTo(i, 32);
    g.lineTo(i + 32, 0);
    g.stroke();
  }
  return c;
}

function uStrip(units: number): HTMLCanvasElement {
  const [c, g] = canvas(28, units * 24);
  g.fillStyle = "#30343a";
  g.fillRect(0, 0, 28, units * 24);
  g.font = "600 13px monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let u = 1; u <= units; u++) {
    const y = (units - u) * 24;
    g.fillStyle = "#16181b";
    g.fillRect(0, y, 28, 1);
    g.fillStyle = "#c9cfd6";
    g.fillText(String(u), 14, y + 13);
  }
  return c;
}

/** Realistic surface parameters per role. */
/** Realistic surfaces, matched to the site photos (`data/photos/`). */
const PBR: Record<
  string,
  { color: string; metalness: number; roughness: number }
> = {
  floor: { color: "#ffffff", metalness: 0, roughness: 0.55 },
  wall: { color: "#efefea", metalness: 0, roughness: 0.95 },
  ceiling: { color: "#f4f4f1", metalness: 0, roughness: 0.95 },
  // Black powder-coated steel.
  rackFrame: { color: "#141518", metalness: 0.35, roughness: 0.6 },
  rackCap: { color: "#17181b", metalness: 0.35, roughness: 0.55 },
  rail: { color: "#2a2c30", metalness: 0.6, roughness: 0.45 },
  // The shelf is black metal.
  shelf: { color: "#18181a", metalness: 0.4, roughness: 0.6 },
  board: { color: "#1c1c1f", metalness: 0.35, roughness: 0.65 },
  // Comfort units: galvanised ducted boxes; precision cabinets dark.
  cooling: { color: "#c3c6ca", metalness: 0.65, roughness: 0.38 },
  coolingPrecision: { color: "#2b2e33", metalness: 0.4, roughness: 0.5 },
  louvre: { color: "#9ea2a7", metalness: 0.6, roughness: 0.4 },
  // Wire mesh basket.
  tray: { color: "#c4c8cc", metalness: 0.85, roughness: 0.3 },
  door: { color: "#c3a27c", metalness: 0.05, roughness: 0.7 },
  safe: { color: "#4b4f55", metalness: 0.6, roughness: 0.4 },
  rod: { color: "#9a9ea3", metalness: 0.8, roughness: 0.35 },
  locker: { color: "#b9bcbe", metalness: 0.35, roughness: 0.5 },
  structure: { color: "#9aa0a6", metalness: 0.1, roughness: 0.8 },
  cell: { color: "#22252b", metalness: 0.35, roughness: 0.5 },
  cellBlocked: { color: "#7a2c26", metalness: 0.1, roughness: 0.8 },
  // Parts of the equipment templates (renderers/parts.ts).
  rim: { color: "#2b2e33", metalness: 0.45, roughness: 0.45 },
  fan: { color: "#80858c", metalness: 0.6, roughness: 0.4 },
  fanHub: { color: "#1c1d20", metalness: 0.2, roughness: 0.45 },
  fanShroud: { color: "#0b0c0e", metalness: 0.2, roughness: 0.8 },
  bezel: { color: "#141518", metalness: 0.2, roughness: 0.4 },
  plinth: { color: "#0f1012", metalness: 0.3, roughness: 0.7 },
  foot: { color: "#a4a8ad", metalness: 0.85, roughness: 0.3 },
  caster: { color: "#1a1b1d", metalness: 0.1, roughness: 0.6 },
  vent: { color: "#0c0d0f", metalness: 0.2, roughness: 0.8 },
  hinge: { color: "#3a3d42", metalness: 0.7, roughness: 0.35 },
  opening: { color: "#0d0e10", metalness: 0, roughness: 0.9 },
  terminal: { color: "#e5e7ea", metalness: 0, roughness: 0.6 },
};

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>();
  private textures = new Map<string, THREE.Texture>();
  mode: Mode = "schema";
  theme: DcTheme;

  constructor(theme: DcTheme) {
    this.theme = theme;
  }

  private tex(
    key: string,
    make: () => HTMLCanvasElement,
    srgb = true,
  ): THREE.Texture {
    let t = this.textures.get(key);
    if (!t) {
      t = new THREE.CanvasTexture(make());
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.set(key, t);
    }
    return t;
  }

  private realistic(): boolean {
    return this.mode === "realistic";
  }

  /** Forget materials; called on a mode or theme switch. */
  reset(mode: Mode, theme: DcTheme) {
    this.mode = mode;
    this.theme = theme;
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
  }

  private memo(key: string, make: () => THREE.Material): THREE.Material {
    const k = `${this.mode}|${key}`;
    let m = this.cache.get(k);
    if (!m) {
      m = make();
      this.cache.set(k, m);
    }
    return m;
  }

  /** A body in its finish (realistic mode): powder coat, galvanised, white plastic. */
  private finish(base: string, f: { kind: FinishKind; color: string }) {
    const color = base === "rim" ? lighter(f.color) : f.color;
    if (f.kind === "galvanised") {
      const t = this.tex("galvanised", galvanised);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return new THREE.MeshStandardMaterial({
        map: t,
        color,
        metalness: 0.8,
        roughness: 0.42,
      });
    }
    if (f.kind === "white_plastic")
      return new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.32,
        clearcoat: 0.5,
        clearcoatRoughness: 0.25,
      });
    return new THREE.MeshStandardMaterial({
      color,
      metalness: 0.35,
      roughness: 0.58,
    });
  }

  /**
   * A honeycomb-perforated sheet of `w × h` mm with holes `pitch` mm apart,
   * in the body's colour. Mipmapped and blended, so from afar it reads as a
   * see-through face rather than a solid one or a moiré.
   */
  perforation(body: string, w: number, h: number, pitch: number) {
    const f = finishOf(body);
    // The tile holds 4 × 4 holes: 4 pitches wide, 3.5 pitches high.
    const rx = w / (4 * pitch),
      ry = h / (3.5 * pitch);
    return this.memo(
      `perf|${f?.color ?? ""}|${rx.toFixed(2)}|${ry.toFixed(2)}`,
      () => {
        if (!this.realistic()) return this.role("perforated");
        const t = this.tex("perf", perforated, false).clone();
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(rx, ry);
        t.anisotropy = 8;
        return new THREE.MeshStandardMaterial({
          color: f?.color ?? "#1b1d22",
          metalness: 0.45,
          roughness: 0.5,
          alphaMap: t,
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
      },
    );
  }

  /** The material for a role in the current mode. */
  role(role: string): THREE.Material {
    return this.memo(role, () => {
      const fin = finishOf(role);
      if (fin && this.realistic()) return this.finish(baseRole(role), fin);
      // The schema modes and bodies without a finish: the base role.
      if (fin) return this.role(baseRole(role));
      if (role === "glass")
        return this.realistic()
          ? new THREE.MeshPhysicalMaterial({
              color: "#1a1f24",
              metalness: 0,
              roughness: 0.08,
              transparent: true,
              opacity: 0.28,
              depthWrite: false,
            })
          : new THREE.MeshBasicMaterial({
              color: this.theme.dark ? "#9fb3c8" : "#5f7a94",
              transparent: true,
              opacity: 0.12,
              depthWrite: false,
            });
      if (role === "perforated") {
        const alpha = this.tex("perf", perforated, false);
        alpha.wrapS = alpha.wrapT = THREE.RepeatWrapping;
        alpha.repeat.set(20, 60);
        return this.realistic()
          ? new THREE.MeshStandardMaterial({
              color: "#1b1d22",
              metalness: 0.5,
              roughness: 0.55,
              alphaMap: alpha,
              transparent: true,
              alphaTest: 0.3,
              side: THREE.DoubleSide,
            })
          : new THREE.MeshBasicMaterial({
              color: this.theme.dark ? "#56606b" : "#9aa3ad",
              transparent: true,
              opacity: 0.25,
              depthWrite: false,
            });
      }
      if (role === "solidDoor")
        return this.realistic()
          ? new THREE.MeshStandardMaterial({
              color: "#202328",
              metalness: 0.55,
              roughness: 0.5,
            })
          : new THREE.MeshBasicMaterial({
              color: this.theme.dark ? "#56606b" : "#9aa3ad",
              transparent: true,
              opacity: 0.35,
              depthWrite: false,
            });
      if (role === "deviceSide")
        return this.realistic()
          ? new THREE.MeshStandardMaterial({
              color: "#22252a",
              metalness: 0.5,
              roughness: 0.55,
            })
          : new THREE.MeshLambertMaterial({ color: "#3c434c" });
      if (role === "light")
        return new THREE.MeshBasicMaterial({
          color: "#fffaf0",
          toneMapped: false,
        });
      if (role === "display")
        return new THREE.MeshBasicMaterial({
          color: "#5fd0ff",
          toneMapped: false,
        });
      if (role.startsWith("device:")) {
        const kind = role.slice(7) as DeviceKind;
        return this.realistic()
          ? new THREE.MeshStandardMaterial({
              color: "#1f2228",
              metalness: 0.3,
              roughness: 0.55,
            })
          : new THREE.MeshLambertMaterial({
              color: DEVICE_COLOR[kind] ?? "#474d56",
            });
      }
      if (this.realistic() && role === "floor") {
        const t = this.tex("tiles", tiles);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        // Floor UVs are in millimetres: one tile is 300 mm.
        t.repeat.set(1 / 300, 1 / 300);
        return new THREE.MeshStandardMaterial({
          map: t,
          roughness: 0.5,
          metalness: 0,
          side: THREE.DoubleSide,
        });
      }
      if (this.realistic()) {
        const p = PBR[role] ?? PBR.structure;
        return new THREE.MeshStandardMaterial({
          color: p.color,
          metalness: p.metalness,
          roughness: p.roughness,
        });
      }
      // Schema: flat fills from the theme's tokens; Lambert keeps a hint of
      // shape under the flat light rig.
      const tk = this.theme.tokens;
      const fill =
        role === "floor"
          ? tk.floor
          : role === "wall" || role === "ceiling"
            ? tk.wall
            : role === "rackFrame" || role === "rackCap" || role === "rail"
              ? tk.rackFill
              : role === "cooling" ||
                  role === "coolingPrecision" ||
                  role === "louvre"
                ? tk.coolingFill
                : role === "cellBlocked"
                  ? tk.warn
                  : role === "cell"
                    ? tk.muted
                    : tk.objectFill;
      return new THREE.MeshLambertMaterial({
        color: fill,
        transparent: role === "cellBlocked",
        opacity: role === "cellBlocked" ? 0.18 : 1,
      });
    });
  }

  /** A device's front panel. Schema mode has no texture: kind colour only. */
  deviceFront(kind: DeviceKind, units: number, name: string): THREE.Material {
    if (!this.realistic()) return this.role(`device:${kind}`);
    return this.memo(`front|${kind}|${units}|${name}`, () => {
      const t = this.tex(`front|${kind}|${units}|${name}`, () =>
        deviceFront(kind, units, name),
      );
      return new THREE.MeshStandardMaterial({
        map: t,
        metalness: 0.3,
        roughness: 0.55,
      });
    });
  }

  /** A shelf number plate. */
  plate(n: number): THREE.Material {
    // One material for every plate: they merge into one draw call.
    if (n >= 1 && n <= PLATE_ATLAS)
      return this.memo(
        "plates",
        () =>
          new THREE.MeshBasicMaterial({ map: this.tex("plates", plateAtlas) }),
      );
    return this.memo(
      `plate|${n}`,
      () =>
        new THREE.MeshBasicMaterial({
          map: this.tex(`plate|${n}`, () => plate(n)),
        }),
    );
  }

  /** Fluorescent tubes (realistic mode only; lighting, not equipment). */
  tube(): THREE.Material {
    return this.memo(
      "tube",
      () =>
        new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    );
  }

  uStrip(units: number): THREE.Material {
    return this.memo(
      `ustrip|${units}`,
      () =>
        new THREE.MeshBasicMaterial({
          map: this.tex(`ustrip|${units}`, () => uStrip(units)),
        }),
    );
  }

  /** A rack tint for the fill / power modes: 0 = green … 1 = red. */
  tint(f: number): THREE.Material {
    const k = Math.round(Math.min(1, Math.max(0, f)) * 20) / 20;
    return this.memo(`tint|${k}`, () => {
      const c = new THREE.Color().setHSL(
        (1 - k) * 0.33,
        0.75,
        this.theme.dark ? 0.42 : 0.52,
      );
      return new THREE.MeshLambertMaterial({ color: c });
    });
  }

  /** Over budget: the warning colour. */
  over(): THREE.Material {
    return this.memo(
      "over",
      () => new THREE.MeshLambertMaterial({ color: this.theme.warn }),
    );
  }

  /** A wall of length `len` (mm) and thickness `t`, hatched at 45° every 60 mm. */
  hatch(len: number, t: number): THREE.Material {
    const tk = this.theme.tokens;
    const key = `hatch:${tk.name}:${Math.round(len)}:${t}`;
    return this.memo(key, () => {
      const tex = this.tex(key, () => {
        const [c, g] = canvas(64, 64);
        g.fillStyle = tk.wall;
        g.fillRect(0, 0, 64, 64);
        g.strokeStyle = tk.text;
        g.lineWidth = 4;
        for (const o of [-64, 0, 64]) {
          g.beginPath();
          g.moveTo(o, 64);
          g.lineTo(o + 64, 0);
          g.stroke();
        }
        return c;
      });
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(len / 60, t / 60);
      return new THREE.MeshBasicMaterial({ map: tex });
    });
  }

  /** Owner highlight: the chosen owner's equipment… */
  highlight(): THREE.Material {
    return this.memo(
      "highlight",
      () => new THREE.MeshBasicMaterial({ color: this.theme.accent }),
    );
  }

  /** …and everything else, dimmed. */
  dimmed(): THREE.Material {
    return this.memo(
      "dimmed",
      () =>
        new THREE.MeshBasicMaterial({
          color: this.theme.dark ? "#3a3c42" : "#c9c9cf",
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        }),
    );
  }

  /** Known power when the room has no budget to judge it against. */
  known(): THREE.Material {
    return this.memo(
      "known",
      () =>
        new THREE.MeshLambertMaterial({
          color: this.theme.dark ? "#3d6ea8" : "#5b8fd1",
        }),
    );
  }

  /** Unknown power: hatched, never a colour that reads as zero. */
  unknown(): THREE.Material {
    return this.memo("unknown", () => {
      const t = this.tex("hatch", () => hatch("#5b6168"));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(4, 12);
      return new THREE.MeshLambertMaterial({ map: t });
    });
  }

  /** Free contiguous units in the fill mode. */
  freeRange(): THREE.Material {
    return this.memo(
      "free",
      () =>
        new THREE.MeshBasicMaterial({
          color: this.theme.good,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        }),
    );
  }

  /** Clearance zones on the floor. */
  zone(ok: boolean): THREE.Material {
    return this.memo(
      `zone|${ok}`,
      () =>
        new THREE.MeshBasicMaterial({
          color: ok ? this.theme.good : this.theme.warn,
          transparent: true,
          opacity: ok ? 0.14 : 0.3,
          depthWrite: false,
        }),
    );
  }

  line(color: string, dashed = false): THREE.LineBasicMaterial {
    return this.memo(`line|${color}|${dashed}`, () =>
      dashed
        ? new THREE.LineDashedMaterial({
            color,
            dashSize: 60,
            gapSize: 40,
            depthTest: false,
            transparent: true,
          })
        : new THREE.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
          }),
    ) as THREE.LineBasicMaterial;
  }

  dispose() {
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
    this.textures.forEach((t) => t.dispose());
    this.textures.clear();
  }
}
