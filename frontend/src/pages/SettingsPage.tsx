/**
 * `/settings` — the user's own settings.
 *
 * Available to every signed-in user regardless of section, this page is where
 * the personal, client-side preferences live in full: the system **theme**
 * (all four skins, not just the menu's dark/light switch) and the system
 * **language**. Both write straight through to the same `useTheme` hook and
 * i18n instance the account menu uses, so a change here and a change there are
 * the one setting — persisted to `localStorage` and reflected on `<html>`.
 */

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { LANGUAGES } from "../i18n";
import { THEMES, useTheme, type ThemeValue } from "../components/ThemeSelect";
import { comboFromEvent, formatCombo, SHORTCUTS, type ShortcutDef } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";

/** i18n key for each theme's display name, keyed by its stored value. */
const THEME_LABEL: Record<ThemeValue, string> = {
  dark: "settings.themeDark",
  light: "settings.themeLight",
  gruvbox: "settings.themeGruvbox",
  "gruvbox-light": "settings.themeGruvboxLight",
};

/** A little two-tone chip previewing each theme's surface + accent, so the
 * choice is legible without reading the label. Colours are the themes' own. */
const THEME_SWATCH: Record<ThemeValue, string> = {
  dark: "linear-gradient(135deg, #171a21 55%, #5b8cff 55%)",
  light: "linear-gradient(135deg, #ffffff 55%, #4f7cf7 55%)",
  gruvbox: "linear-gradient(135deg, #32302f 55%, #83a598 55%)",
  "gruvbox-light": "linear-gradient(135deg, #ebdbb2 55%, #076678 55%)",
};

/** A radio drawn as a tile: a bordered card that turns its border and text
 * accent when chosen, like the platform's other selected states. */
function OptionTile({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex min-w-36 cursor-pointer items-center gap-2.5 rounded-md border bg-card px-3.5 py-3 text-left text-sm transition-colors outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/60",
        selected && "border-ring bg-secondary/60 text-link",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useTheme();
  const currentLang = i18n.language.split("-")[0];

  useEffect(() => {
    document.title = t("docTitle", { page: t("settings.heading"), app: t("app.name") });
  }, [t]);

  return (
    <div className="max-w-2xl">
      <h1>{t("settings.heading")}</h1>
      <p className="text-muted-foreground">{t("settings.subtitle")}</p>

      {/* Appearance — the full set of themes as a radio group of swatched tiles. */}
      <section className="mt-7">
        <h2 className="mb-1 text-lg">{t("settings.appearance")}</h2>
        <p className="mb-3.5 text-sm text-muted-foreground">{t("settings.appearanceDesc")}</p>
        <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label={t("settings.appearance")}>
          {THEMES.map((th) => (
            <OptionTile
              key={th.value}
              selected={th.value === theme}
              onClick={() => setTheme(th.value)}
            >
              <span
                className="size-7 shrink-0 rounded-lg border border-gray-400/30"
                style={{ background: THEME_SWATCH[th.value] }}
                aria-hidden="true"
              />
              <span className="flex-1">{t(THEME_LABEL[th.value])}</span>
            </OptionTile>
          ))}
        </div>
      </section>

      {/* Language — the same three languages the account menu offers. */}
      <section className="mt-7">
        <h2 className="mb-1 text-lg">{t("settings.language")}</h2>
        <p className="mb-3.5 text-sm text-muted-foreground">{t("settings.languageDesc")}</p>
        <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label={t("settings.language")}>
          {LANGUAGES.map((l) => (
            <OptionTile
              key={l.value}
              selected={l.value === currentLang}
              onClick={() => void i18n.changeLanguage(l.value)}
            >
              <span className="flex-1">{l.label}</span>
            </OptionTile>
          ))}
        </div>
      </section>

      {/* Keyboard shortcuts — defaults out of the box, each rebindable. */}
      <KeyboardShortcuts />
    </div>
  );
}

function KeyboardShortcuts() {
  const { t } = useTranslation();
  const { resetAll } = useShortcuts();

  return (
    <section className="mt-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="mb-1 text-lg">{t("shortcuts.title")}</h2>
        <Button type="button" variant="outline" size="sm" onClick={resetAll}>
          {t("shortcuts.resetAll")}
        </Button>
      </div>
      <p className="mb-3.5 text-sm text-muted-foreground">{t("shortcuts.desc")}</p>
      <div className="flex flex-col gap-1.5">
        {SHORTCUTS.map((def) => (
          <ShortcutRow key={def.id} def={def} />
        ))}
      </div>
    </section>
  );
}

function ShortcutRow({ def }: { def: ShortcutDef }) {
  const { t } = useTranslation();
  const { bindings, setBinding, resetBinding } = useShortcuts();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    // Capture phase so the recorder wins over the global shortcut handler —
    // otherwise pressing "D" here would also navigate.
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (e.key === "Backspace" || e.key === "Delete") {
        setBinding(def.id, "");
        return setRecording(false);
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // a bare modifier — keep waiting for the real key
      setBinding(def.id, combo);
      setRecording(false);
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, def.id, setBinding]);

  const combo = bindings[def.id];

  return (
    <div className="flex items-center gap-2.5 rounded-md border bg-card px-2.5 py-2">
      <span className="flex-1 text-sm">{t(def.labelKey)}</span>
      <button
        type="button"
        className={cn(
          "min-w-24 cursor-pointer rounded-md border bg-secondary px-2.5 py-1.5 text-center text-[13px] transition-colors outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/60",
          recording && "border-ring text-link",
        )}
        onClick={() => setRecording((v) => !v)}
      >
        {recording ? (
          t("shortcuts.press")
        ) : combo ? (
          <Kbd>{formatCombo(combo)}</Kbd>
        ) : (
          <span className="text-muted-foreground">{t("shortcuts.unbound")}</span>
        )}
      </button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        title={t("shortcuts.reset")}
        aria-label={t("shortcuts.reset")}
        onClick={() => resetBinding(def.id)}
      >
        <RotateCcw />
      </Button>
    </div>
  );
}
