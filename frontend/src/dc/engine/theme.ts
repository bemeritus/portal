/**
 * Colours of the 3D view, taken from the app's theme tokens so the scene
 * follows light, dark and gruvbox like the rest of the UI. Re-read whenever
 * `<html data-theme>` changes.
 */

export interface DcTheme {
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

function v(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const s = style.getPropertyValue(name).trim();
  return s || fallback;
}

export function readTheme(): DcTheme {
  const st = getComputedStyle(document.documentElement);
  const theme = document.documentElement.dataset.theme ?? "";
  const dark = theme === "dark" || theme === "gruvbox";
  return {
    background: v(st, "--bg", dark ? "#16181c" : "#f6f7f9"),
    floor: v(st, "--panel-2", dark ? "#22252b" : "#e9ecef"),
    wall: v(st, "--panel", dark ? "#1d2025" : "#ffffff"),
    ink: v(st, "--ink", dark ? "#e8eaed" : "#16181c"),
    inkMuted: v(st, "--ink-muted", "#8a9099"),
    line: v(st, "--line", dark ? "#3a3f47" : "#cfd4da"),
    dim: v(st, "--brand", "#2b6cb0"),
    accent: v(st, "--brand", "#2b6cb0"),
    warn: v(st, "--bad", "#c0392b"),
    good: v(st, "--good", "#2e8b57"),
    assumed: v(st, "--tag-3", "#d39e00"),
    dark,
  };
}

/** Call `fn` on every theme switch; returns the unsubscribe. */
export function watchTheme(fn: (t: DcTheme) => void): () => void {
  const obs = new MutationObserver(() => fn(readTheme()));
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  return () => obs.disconnect();
}
