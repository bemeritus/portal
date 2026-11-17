/**
 * Materials and textures for the four phase 1 modes.
 *
 * Renderers never pick a material themselves: every mesh carries a *role*
 * (`userData.role`, e.g. `rackFrame`, `device:server`, `glass`) and the
 * engine assigns the material for the current mode from this library. A mode
 * switch is therefore a walk over the scene, not a rebuild.
 *
 * - Схема: flat, unlit-looking neutral colours, high contrast.
 * - Реалистичный: PBR (powder-coated steel, glass with transmission-like
 *   opacity, perforated mesh by alpha texture), lit by a procedural room
 *   environment bundled with three.js — no HDR file is downloaded.
 * - Заполнение / Мощность: Схема, with racks tinted by the engine.
 *
 * Textures are drawn on canvases once and cached; `dispose()` frees them all.
 */

import * as THREE from "three";

import type { DeviceKind } from "../types";
import type { DcTheme } from "./theme";

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

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function fitText(g: CanvasRenderingContext2D, t: string, maxW: number): string {
  if (g.measureText(t).width <= maxW) return t;
  while (t.length > 1 && g.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** A device's front panel by kind, with its name — the prototype's `devCanvas`. */
function deviceFront(kind: DeviceKind, units: number, name: string): HTMLCanvasElement {
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
        g.fillRect(bx + q * gw + 4, y0 + r * gh + 4, gw - 8, Math.max(2, gh - 8));
      }
  };
  const vents = (vx: number, vw: number) => {
    g.fillStyle = "#0b0c0e";
    for (let y = y0 + 4; y < y0 + ih - 3; y += 6)
      for (let x = vx + ((y / 6) % 2 > 1 ? 3 : 0); x < vx + vw - 3; x += 7) g.fillRect(x, y, 4, 3);
  };
  const ports = (px: number, pw: number, cols: number, rows: number, light: boolean) => {
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
    bays(x0 + 8, iw * 0.62, units === 1 ? 4 : 8, Math.max(1, Math.min(units, 3)));
    vents(x0 + 8 + iw * 0.64, iw * 0.36 - 12);
  } else if (kind === "storage") bays(x0 + 8, iw - 12, 4, Math.max(1, Math.round(units * 1.5)));
  else if (kind === "switch" || kind === "router") {
    const rows = ch >= 40 ? 2 : 1;
    ports(x0 + 10, iw * 0.74, kind === "router" ? 12 : 24, rows, false);
    ports(x0 + 10 + iw * 0.78, iw * 0.2, 4, rows, false);
  } else if (kind === "patch") ports(x0 + 10, iw - 20, 24, units > 1 ? 2 : 1, true);
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
      g.arc(x0 + 60 + q * gw + gw / 2, y0 + ih / 2, Math.min(gw * 0.36, ih * 0.36), 0, 7);
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

function perforated(): HTMLCanvasElement {
  const [c, g] = canvas(64, 64);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#000000";
  for (let r = 0; r < 8; r++)
    for (let q = 0; q < 8; q++) {
      g.beginPath();
      g.arc(q * 8 + (r % 2 ? 4 : 0) + 2, r * 8 + 2, 2.4, 0, 7);
      g.fill();
    }
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

/** Schema colours per role, in a light and a dark variant. */
const SCHEMA: Record<string, [string, string]> = {
  floor: ["#e6e9ed", "#24272d"],
  wall: ["#cfd4da", "#3a3f47"],
  rackFrame: ["#8b95a1", "#5b6573"],
  rackCap: ["#7a838e", "#4f5864"],
  rail: ["#a8b0b9", "#6b7480"],
  shelf: ["#b7a68a", "#7d6f58"],
  board: ["#c9b99d", "#8e7f66"],
  cooling: ["#9fc6d8", "#3f6f86"],
  coolingPrecision: ["#7fb0a0", "#2f6b5a"],
  louvre: ["#6e8fa0", "#2a4a5a"],
  tray: ["#b0a080", "#7a6c50"],
  door: ["#c8a27a", "#8a6a48"],
  safe: ["#8e8e8e", "#5e5e5e"],
  locker: ["#a3a7ab", "#6b7075"],
  structure: ["#a0a6ad", "#646b73"],
  cell: ["#55606d", "#8794a3"],
  cellBlocked: ["#e7b4ae", "#6e3a35"],
};

/** Realistic surface parameters per role. */
const PBR: Record<string, { color: string; metalness: number; roughness: number }> = {
  floor: { color: "#b9bcc0", metalness: 0, roughness: 0.85 },
  wall: { color: "#e9e7e2", metalness: 0, roughness: 0.95 },
  rackFrame: { color: "#1b1d21", metalness: 0.55, roughness: 0.5 },
  rackCap: { color: "#26292e", metalness: 0.6, roughness: 0.45 },
  rail: { color: "#3a3e45", metalness: 0.7, roughness: 0.4 },
  shelf: { color: "#3a3d42", metalness: 0.5, roughness: 0.55 },
  board: { color: "#6b6e73", metalness: 0.4, roughness: 0.6 },
  cooling: { color: "#f2f3f4", metalness: 0.05, roughness: 0.35 },
  coolingPrecision: { color: "#2b2e33", metalness: 0.4, roughness: 0.5 },
  louvre: { color: "#d9dcdf", metalness: 0.05, roughness: 0.4 },
  tray: { color: "#a9adb2", metalness: 0.8, roughness: 0.35 },
  door: { color: "#c3a27c", metalness: 0.05, roughness: 0.7 },
  safe: { color: "#4b4f55", metalness: 0.6, roughness: 0.4 },
  locker: { color: "#b3b6b8", metalness: 0.35, roughness: 0.5 },
  structure: { color: "#9aa0a6", metalness: 0.1, roughness: 0.8 },
  cell: { color: "#22252b", metalness: 0.35, roughness: 0.5 },
  cellBlocked: { color: "#7a2c26", metalness: 0.1, roughness: 0.8 },
};

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>();
  private textures = new Map<string, THREE.Texture>();
  mode: Mode = "schema";
  theme: DcTheme;

  constructor(theme: DcTheme) {
    this.theme = theme;
  }

  private tex(key: string, make: () => HTMLCanvasElement, srgb = true): THREE.Texture {
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

  /** The material for a role in the current mode. */
  role(role: string): THREE.Material {
    return this.memo(role, () => {
      if (role === "glass")
        return this.realistic()
          ? new THREE.MeshPhysicalMaterial({ color: "#1a1f24", metalness: 0, roughness: 0.08, transparent: true, opacity: 0.28, depthWrite: false })
          : new THREE.MeshBasicMaterial({ color: this.theme.dark ? "#9fb3c8" : "#5f7a94", transparent: true, opacity: 0.12, depthWrite: false });
      if (role === "perforated") {
        const alpha = this.tex("perf", perforated, false);
        alpha.wrapS = alpha.wrapT = THREE.RepeatWrapping;
        alpha.repeat.set(40, 120);
        return this.realistic()
          ? new THREE.MeshStandardMaterial({ color: "#1b1d22", metalness: 0.5, roughness: 0.55, alphaMap: alpha, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide })
          : new THREE.MeshBasicMaterial({ color: this.theme.dark ? "#56606b" : "#9aa3ad", transparent: true, opacity: 0.25, depthWrite: false });
      }
      if (role === "solidDoor")
        return this.realistic()
          ? new THREE.MeshStandardMaterial({ color: "#202328", metalness: 0.55, roughness: 0.5 })
          : new THREE.MeshBasicMaterial({ color: this.theme.dark ? "#56606b" : "#9aa3ad", transparent: true, opacity: 0.35, depthWrite: false });
      if (role === "deviceSide")
        return this.realistic()
          ? new THREE.MeshStandardMaterial({ color: "#22252a", metalness: 0.5, roughness: 0.55 })
          : new THREE.MeshLambertMaterial({ color: "#3c434c" });
      if (role === "light")
        return new THREE.MeshBasicMaterial({ color: "#fffaf0", toneMapped: false });
      if (role === "display")
        return new THREE.MeshBasicMaterial({ color: "#5fd0ff", toneMapped: false });
      if (role.startsWith("device:")) {
        const kind = role.slice(7) as DeviceKind;
        return this.realistic()
          ? new THREE.MeshStandardMaterial({ color: "#1f2228", metalness: 0.3, roughness: 0.55 })
          : new THREE.MeshLambertMaterial({ color: DEVICE_COLOR[kind] ?? "#474d56" });
      }
      if (this.realistic()) {
        const p = PBR[role] ?? PBR.structure;
        return new THREE.MeshStandardMaterial({ color: p.color, metalness: p.metalness, roughness: p.roughness });
      }
      const c = SCHEMA[role] ?? SCHEMA.structure;
      // Lambert keeps a hint of shape with no shadows; the light rig is flat.
      return new THREE.MeshLambertMaterial({ color: c[this.theme.dark ? 1 : 0] });
    });
  }

  /** A device's front panel. Schema mode has no texture: kind colour only. */
  deviceFront(kind: DeviceKind, units: number, name: string): THREE.Material {
    if (!this.realistic()) return this.role(`device:${kind}`);
    return this.memo(`front|${kind}|${units}|${name}`, () => {
      const t = this.tex(`front|${kind}|${units}|${name}`, () => deviceFront(kind, units, name));
      return new THREE.MeshStandardMaterial({ map: t, metalness: 0.3, roughness: 0.55 });
    });
  }

  uStrip(units: number): THREE.Material {
    return this.memo(`ustrip|${units}`, () => new THREE.MeshBasicMaterial({ map: this.tex(`ustrip|${units}`, () => uStrip(units)) }));
  }

  /** A rack tint for Заполнение / Мощность: 0 = green … 1 = red. */
  tint(f: number): THREE.Material {
    const k = Math.round(Math.min(1, Math.max(0, f)) * 20) / 20;
    return this.memo(`tint|${k}`, () => {
      const c = new THREE.Color().setHSL((1 - k) * 0.33, 0.75, this.theme.dark ? 0.42 : 0.52);
      return new THREE.MeshLambertMaterial({ color: c });
    });
  }

  /** Over budget: the warning colour. */
  over(): THREE.Material {
    return this.memo("over", () => new THREE.MeshLambertMaterial({ color: this.theme.warn }));
  }

  /** Known power when the room has no budget to judge it against. */
  known(): THREE.Material {
    return this.memo("known", () => new THREE.MeshLambertMaterial({ color: this.theme.dark ? "#3d6ea8" : "#5b8fd1" }));
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

  /** Free contiguous units in Заполнение. */
  freeRange(): THREE.Material {
    return this.memo("free", () => new THREE.MeshBasicMaterial({ color: this.theme.good, transparent: true, opacity: 0.35, depthWrite: false }));
  }

  /** Clearance zones on the floor. */
  zone(ok: boolean): THREE.Material {
    return this.memo(`zone|${ok}`, () =>
      new THREE.MeshBasicMaterial({ color: ok ? this.theme.good : this.theme.warn, transparent: true, opacity: ok ? 0.14 : 0.3, depthWrite: false }),
    );
  }

  line(color: string, dashed = false): THREE.LineBasicMaterial {
    return this.memo(`line|${color}|${dashed}`, () =>
      dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 60, gapSize: 40, depthTest: false, transparent: true })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }),
    ) as THREE.LineBasicMaterial;
  }

  dispose() {
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
    this.textures.forEach((t) => t.dispose());
    this.textures.clear();
  }
}
