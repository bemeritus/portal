/**
 * The live keyboard-shortcut bindings, persisted per device like the theme and
 * language are.
 *
 * The map is `actionId -> combo`, seeded from `defaultBindings()` and overlaid
 * with whatever the user has saved under `localStorage["shortcuts"]`. Rebinding
 * de-duplicates: assigning a combo already held by another action clears it
 * from that other action, so no two actions ever fire on one keystroke. A combo
 * of `""` means the action is unbound (the user can disable one).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { defaultBindings, SHORTCUTS } from "./registry";

const STORAGE_KEY = "shortcuts";

interface ShortcutsValue {
  bindings: Record<string, string>;
  setBinding: (id: string, combo: string) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
}

const ShortcutsContext = createContext<ShortcutsValue | null>(null);

/** Stored overrides merged onto the defaults, ignoring unknown/junk ids. */
function readStored(): Record<string, string> {
  const base = defaultBindings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const { id } of SHORTCUTS) {
      if (typeof saved[id] === "string") base[id] = saved[id] as string;
    }
  } catch {
    // Corrupt or unavailable storage falls back to the defaults.
  }
  return base;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState<Record<string, string>>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    } catch {
      // A binding that cannot be remembered still applies for this session.
    }
  }, [bindings]);

  const setBinding = useCallback((id: string, combo: string) => {
    setBindings((prev) => {
      const next = { ...prev };
      // Take the combo away from whoever else holds it — one keystroke, one action.
      if (combo) {
        for (const key of Object.keys(next)) {
          if (key !== id && next[key] === combo) next[key] = "";
        }
      }
      next[id] = combo;
      return next;
    });
  }, []);

  const resetBinding = useCallback((id: string) => {
    setBindings((prev) => ({ ...prev, ...withDefault(prev, id) }));
  }, []);

  const resetAll = useCallback(() => setBindings(defaultBindings()), []);

  const value = useMemo<ShortcutsValue>(
    () => ({ bindings, setBinding, resetBinding, resetAll }),
    [bindings, setBinding, resetBinding, resetAll],
  );

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}

/** Set one id back to its default, still de-duplicating against the others. */
function withDefault(prev: Record<string, string>, id: string): Record<string, string> {
  const def = defaultBindings()[id] ?? "";
  const patch: Record<string, string> = { [id]: def };
  if (def) {
    for (const key of Object.keys(prev)) {
      if (key !== id && prev[key] === def) patch[key] = "";
    }
  }
  return patch;
}

export function useShortcuts(): ShortcutsValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error("useShortcuts must be used within ShortcutsProvider");
  return ctx;
}
