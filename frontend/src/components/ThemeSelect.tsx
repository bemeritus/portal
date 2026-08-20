/**
 * Theme selection: Dark, White, Gruvbox Dark and Gruvbox Light.
 *
 * The chosen theme is reflected as a `data-theme` attribute on `<html>` (the
 * CSS variables in `styles/main.css` do the rest) and persisted to
 * `localStorage`. The inline script in `index.html` applies the stored value
 * before first paint, so there is no flash of the wrong theme while the bundle
 * loads; this component keeps it in sync afterwards.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "theme";

/** Kept in step with the list in `index.html`'s inline script. */
export const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "White" },
  // Keeps its bare "gruvbox" value rather than becoming "gruvbox-dark": it is
  // already sitting in people's localStorage, and renaming it would silently
  // drop them back to the default.
  { value: "gruvbox", label: "Gruvbox" },
  { value: "gruvbox-light", label: "Gruvbox Light" },
] as const;

type ThemeValue = (typeof THEMES)[number]["value"];

const DEFAULT_THEME: ThemeValue = "dark";

/**
 * The input comes from `localStorage` and from a `<select>`, so an
 * unrecognised value is expected rather than exceptional — it falls back to
 * the default instead of throwing.
 */
function parseTheme(value: string | null): ThemeValue {
  return THEMES.some((t) => t.value === value) ? (value as ThemeValue) : DEFAULT_THEME;
}

function readStored(): ThemeValue {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private browsing can make even reading throw.
    return DEFAULT_THEME;
  }
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<ThemeValue>(readStored);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // A theme that cannot be remembered still applies for this session.
    }
  }, [theme]);

  return (
    <select
      className="theme-select"
      aria-label="Theme"
      value={theme}
      onChange={(e) => setTheme(parseTheme(e.target.value))}
    >
      {THEMES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
