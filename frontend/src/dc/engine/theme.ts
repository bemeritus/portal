/**
 * Scene colours, from the module's theme tokens (`src/dc/theme/tokens.ts`):
 * `DcEngine.setTheme(tokens)` is the only way colour reaches the 3D view.
 */

import type { DcTokens } from "../theme/tokens";

export interface DcTheme {
  tokens: DcTokens;
  background: string;
  floor: string;
  wall: string;
  ink: string;
  inkMuted: string;
  line: string;
  /** Dimension lines and their text. */
  dim: string;
  /** Selection outline. */
  accent: string;
  warn: string;
  good: string;
  /** Assumed values. */
  assumed: string;
  dark: boolean;
}

export function themeFromTokens(t: DcTokens): DcTheme {
  return {
    tokens: t,
    background: t.viewport,
    floor: t.floor,
    wall: t.wall,
    ink: t.text,
    inkMuted: t.muted,
    line: opaque(t.rule, t.viewport),
    dim: t.dim,
    accent: t.accent,
    warn: t.warn,
    good: t.good,
    assumed: t.assumed,
    dark: t.dark,
  };
}

/** A CSS `rgba()` laid over an opaque `#rrggbb`, as `#rrggbb` (three.js colours have no alpha). */
export function opaque(c: string, over: string): string {
  const m = c.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (!m) return c;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const bg = [1, 3, 5].map((i) => parseInt(over.slice(i, i + 2), 16) || 0);
  return `#${[1, 2, 3]
    .map((i, k) =>
      Math.round(Number(m[i]) * a + bg[k] * (1 - a))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Eight categorical colours, in a fixed order (the owners mode, FEEDBACK-7
 * §4.7): a validated palette, one step for light surfaces and one for dark.
 * A ninth owner is never a new hue: it is grey and listed under «другие».
 */
export const CATEGORICAL = {
  light: [
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#6250d6",
    "#e34948",
  ],
  dark: [
    "#3987e5",
    "#d95926",
    "#199e70",
    "#c98500",
    "#d55181",
    "#008300",
    "#9085e9",
    "#e66767",
  ],
};

/** The categorical colours for a theme. */
export const categorical = (t: DcTheme) =>
  t.dark ? CATEGORICAL.dark : CATEGORICAL.light;
