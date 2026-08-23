/**
 * Keyboard shortcuts: the catalogue, and the combo <-> event plumbing.
 *
 * A shortcut is one **action id** with a **combo** — a normalised string like
 * `"Mod+K"`, `"N"` or `"?"`. `Mod` means ⌘ on a Mac and Ctrl elsewhere, so a
 * single default works cross-platform. Shift is deliberately *not* a separate
 * modifier: pressing `?` (Shift+/) yields the key `"?"`, and Shift+letter is
 * just the capital, so folding it away keeps rebinding unambiguous.
 *
 * The catalogue here is data only — labels are i18n keys and the actual
 * handlers are wired where the app has the context to run them (see `Layout`).
 * Bindings the user has changed live in `ShortcutsContext` / `localStorage`.
 */

export interface ShortcutDef {
  id: string;
  /** Normalised default combo; "" means unbound by default (none are). */
  defaultCombo: string;
  /** i18n key for the human label. */
  labelKey: string;
  /** Fire even while a text field is focused (true only for Mod combos). */
  allowInInput: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "commandPalette", defaultCombo: "Mod+K", labelKey: "shortcuts.commandPalette", allowInInput: true },
  { id: "newDocument", defaultCombo: "N", labelKey: "shortcuts.newDocument", allowInInput: false },
  { id: "goDocuments", defaultCombo: "D", labelKey: "shortcuts.goDocuments", allowInInput: false },
  { id: "goBookmarks", defaultCombo: "B", labelKey: "shortcuts.goBookmarks", allowInInput: false },
  { id: "goSettings", defaultCombo: "S", labelKey: "shortcuts.goSettings", allowInInput: false },
  { id: "toggleTheme", defaultCombo: "T", labelKey: "shortcuts.toggleTheme", allowInInput: false },
  { id: "showHelp", defaultCombo: "?", labelKey: "shortcuts.showHelp", allowInInput: false },
];

/** The catalogue keyed by id, for quick lookup of a def's metadata. */
export const SHORTCUT_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s]),
);

/** The default binding map (id -> combo). */
export function defaultBindings(): Record<string, string> {
  return Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.defaultCombo]));
}

function keyName(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The combo a key event represents, or `null` for a bare modifier press (which
 * is not a shortcut on its own). `Mod` folds Ctrl and ⌘ together.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Meta" || k === "Alt" || k === "Shift") return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  parts.push(keyName(k));
  return parts.join("+");
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A combo formatted for display, e.g. `"Mod+K"` -> `"⌘ + K"` on a Mac. */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((part) => {
      if (part === "Mod") return IS_MAC ? "⌘" : "Ctrl";
      if (part === "Alt") return IS_MAC ? "⌥" : "Alt";
      return part;
    })
    .join(" + ");
}

/** Whether the event's target is a place where typing should win over a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
