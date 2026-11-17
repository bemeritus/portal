/**
 * The three themes of the module (SPEC §10.1): one token set each. The UI
 * reads them as CSS variables on the module's root (`applyTokens`), the 3D
 * engine through `DcEngine.setTheme(tokens)` — no colour is hard-coded
 * anywhere else. Layout, tools and data are the same in every theme.
 */

export type DcThemeName = "studio" | "drawing" | "light";
export const THEMES: DcThemeName[] = ["studio", "drawing", "light"];

export interface DcTokens {
  name: DcThemeName;
  dark: boolean;
  /** Page and viewport background. */
  bg: string;
  /** Viewport background behind the 3D scene. */
  viewport: string;
  panel: string;
  /** Backdrop blur of floating panels, px (0 = docked, opaque). */
  blur: number;
  /** Panels float over a full-bleed viewport, or are docked beside it. */
  floating: boolean;
  /** The viewport sits in a card with a margin (Светлая). */
  framed: boolean;
  line: string;
  /** Strong rules (Чертёж: 1 px black). */
  rule: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  warn: string;
  good: string;
  /** Assumed / photo values (shown with «Показать допущения»). */
  assumed: string;
  /** Dimension lines and their text. */
  dim: string;
  radius: number;
  shadow: string;
  fontUi: string;
  fontHeading: string;
  /** Headings and labels in uppercase (Чертёж). */
  headingUpper: boolean;
  fontMono: string;
  // --- 3D scene ---
  floor: string;
  wall: string;
  /** Object fill in Схема. */
  objectFill: string;
  /** Object edges in Схема. */
  objectEdge: string;
  /** Schema colours of a few roles. */
  rackFill: string;
  coolingFill: string;
}

const MONO = '"Fira Mono", ui-monospace, monospace';

export const TOKENS: Record<DcThemeName, DcTokens> = {
  studio: {
    name: "studio",
    dark: true,
    bg: "#1b1c1f",
    viewport: "#121316",
    panel: "rgba(32, 33, 37, 0.86)",
    blur: 14,
    floating: true,
    framed: false,
    line: "rgba(255, 255, 255, 0.08)",
    rule: "rgba(255, 255, 255, 0.14)",
    text: "#e4e5e8",
    muted: "#9a9ca3",
    accent: "#3d8bfd",
    accentText: "#ffffff",
    warn: "#ff5f57",
    good: "#32d583",
    assumed: "#e0af68",
    dim: "#9fc3ff",
    radius: 10,
    shadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
    fontUi: '"Golos Text", system-ui, sans-serif',
    fontHeading: '"Golos Text", system-ui, sans-serif',
    headingUpper: false,
    fontMono: MONO,
    floor: "#2a2c31",
    wall: "#3a3d44",
    objectFill: "#4a4e57",
    objectEdge: "#8d929c",
    rackFill: "#3b3f47",
    coolingFill: "#5a6170",
  },
  drawing: {
    name: "drawing",
    dark: false,
    bg: "#f6f5f1",
    viewport: "#f6f5f1",
    panel: "#f6f5f1",
    blur: 0,
    floating: false,
    framed: false,
    line: "#1b1b1b",
    rule: "#1b1b1b",
    text: "#141414",
    muted: "#5b5b57",
    accent: "#c8321f",
    accentText: "#ffffff",
    warn: "#c8321f",
    good: "#1b1b1b",
    assumed: "#8a6d1c",
    dim: "#141414",
    radius: 0,
    shadow: "none",
    fontUi: '"Fira Sans", system-ui, sans-serif',
    fontHeading: '"Fira Sans Condensed", "Fira Sans", sans-serif',
    headingUpper: true,
    fontMono: MONO,
    floor: "#f6f5f1",
    wall: "#d9d7d0",
    objectFill: "#fbfaf7",
    objectEdge: "#1b1b1b",
    rackFill: "#fbfaf7",
    coolingFill: "#fbfaf7",
  },
  light: {
    name: "light",
    dark: false,
    bg: "#f2f2f5",
    viewport: "#e8e8ed",
    panel: "rgba(255, 255, 255, 0.86)",
    blur: 14,
    floating: true,
    framed: true,
    line: "rgba(0, 0, 0, 0.08)",
    rule: "rgba(0, 0, 0, 0.14)",
    text: "#1d1d1f",
    muted: "#6e6e73",
    accent: "#0a84ff",
    accentText: "#ffffff",
    warn: "#ff3b30",
    good: "#34c759",
    assumed: "#b7791f",
    dim: "#0a64c2",
    radius: 14,
    shadow: "0 10px 30px rgba(0, 0, 0, 0.12)",
    fontUi: 'Onest, system-ui, sans-serif',
    fontHeading: 'Onest, system-ui, sans-serif',
    headingUpper: false,
    fontMono: MONO,
    floor: "#dcdce2",
    wall: "#c9c9d0",
    objectFill: "#ffffff",
    objectEdge: "#8e8e96",
    rackFill: "#d4d4da",
    coolingFill: "#c7d7ea",
  },
};

/** Put a theme's tokens on an element as `--dc-*` CSS variables. */
export function applyTokens(el: HTMLElement, t: DcTokens) {
  const v: Record<string, string> = {
    bg: t.bg,
    viewport: t.viewport,
    panel: t.panel,
    blur: `${t.blur}px`,
    line: t.line,
    rule: t.rule,
    text: t.text,
    muted: t.muted,
    accent: t.accent,
    "accent-text": t.accentText,
    warn: t.warn,
    good: t.good,
    assumed: t.assumed,
    dim: t.dim,
    radius: `${t.radius}px`,
    shadow: t.shadow,
    "font-ui": t.fontUi,
    "font-heading": t.fontHeading,
    "font-mono": t.fontMono,
    "heading-transform": t.headingUpper ? "uppercase" : "none",
  };
  for (const [k, val] of Object.entries(v)) el.style.setProperty(`--dc-${k}`, val);
  el.dataset.dcTheme = t.name;
}

/** Undo `applyTokens` (leaving the module). */
export function clearTokens(el: HTMLElement) {
  for (const name of [...el.style].filter((n) => n.startsWith("--dc-"))) el.style.removeProperty(name);
  delete el.dataset.dcTheme;
}
