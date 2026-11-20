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
  /** Catalog previews' backdrop, top to bottom (flat when both are equal). */
  preview: [string, string];
  panel: string;
  /** Backdrop blur of floating panels, px (0 = docked, opaque). */
  blur: number;
  /** Panels float over a full-bleed viewport, or are docked beside it. */
  floating: boolean;
  /** The viewport sits in a card with a margin (light). */
  framed: boolean;
  line: string;
  /** Strong rules (drawing: 1 px black). */
  rule: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  /** Data bars (units used, fill): neutral; red is only for problems (FEEDBACK-7 §1.9). */
  fill: string;
  warn: string;
  good: string;
  /** Assumed / photo values (shown with the "show assumptions" toggle). */
  assumed: string;
  /** Dimension lines and their text. */
  dim: string;
  radius: number;
  shadow: string;
  fontUi: string;
  fontHeading: string;
  /** Headings and labels in uppercase (drawing). */
  headingUpper: boolean;
  fontMono: string;
  // --- 3D scene ---
  floor: string;
  wall: string;
  /** Object fill in the schema mode. */
  objectFill: string;
  /** Object edges in the schema mode. */
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
    preview: ["#33353a", "#1b1c1f"],
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
    fill: "#3d8bfd",
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
    bg: "#f6f4ee",
    viewport: "#f6f4ee",
    preview: ["#f6f4ee", "#f6f4ee"],
    panel: "#fbfaf6",
    blur: 0,
    floating: false,
    framed: false,
    // The chrome: 1 px #2B2B2B at 60 %, not solid black (FEEDBACK-7 §6).
    line: "rgba(43, 43, 43, 0.6)",
    rule: "rgba(43, 43, 43, 0.6)",
    text: "#141414",
    muted: "#5b5b57",
    accent: "#c8321f",
    accentText: "#ffffff",
    fill: "#4a4a46",
    warn: "#c8321f",
    good: "#1b1b1b",
    assumed: "#8a6d1c",
    dim: "#4a4a45",
    radius: 0,
    shadow: "none",
    fontUi: '"Fira Sans", system-ui, sans-serif',
    fontHeading: '"Fira Sans Condensed", "Fira Sans", sans-serif',
    headingUpper: true,
    fontMono: MONO,
    floor: "#f6f4ee",
    wall: "#d9d7d0",
    objectFill: "#fbfaf6",
    objectEdge: "#1b1b1b",
    rackFill: "#fbfaf6",
    coolingFill: "#fbfaf6",
  },
  light: {
    name: "light",
    dark: false,
    bg: "#f2f2f5",
    viewport: "#e8e8ed",
    preview: ["#eef0f3", "#d6d9de"],
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
    fill: "#0a84ff",
    warn: "#ff3b30",
    good: "#34c759",
    assumed: "#b7791f",
    dim: "#0a64c2",
    radius: 14,
    shadow: "0 10px 30px rgba(0, 0, 0, 0.12)",
    fontUi: "Onest, system-ui, sans-serif",
    fontHeading: "Onest, system-ui, sans-serif",
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
    "preview-top": t.preview[0],
    "preview-bottom": t.preview[1],
    panel: t.panel,
    blur: `${t.blur}px`,
    line: t.line,
    rule: t.rule,
    text: t.text,
    muted: t.muted,
    accent: t.accent,
    "accent-text": t.accentText,
    fill: t.fill,
    warn: t.warn,
    good: t.good,
    assumed: t.assumed,
    dim: t.dim,
    "object-edge": t.objectEdge,
    radius: `${t.radius}px`,
    shadow: t.shadow,
    "font-ui": t.fontUi,
    "font-heading": t.fontHeading,
    "font-mono": t.fontMono,
    "heading-transform": t.headingUpper ? "uppercase" : "none",
  };
  for (const [k, val] of Object.entries(v))
    el.style.setProperty(`--dc-${k}`, val);
  el.dataset.dcTheme = t.name;
}

/** Undo `applyTokens` (leaving the module). */
export function clearTokens(el: HTMLElement) {
  for (const name of [...el.style].filter((n) => n.startsWith("--dc-")))
    el.style.removeProperty(name);
  delete el.dataset.dcTheme;
}
