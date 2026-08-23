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
import { useTranslation } from "react-i18next";

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

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useTheme();
  const currentLang = i18n.language.split("-")[0];

  useEffect(() => {
    document.title = t("docTitle", { page: t("settings.heading"), app: t("app.name") });
  }, [t]);

  return (
    <div className="settings-page">
      <h1>{t("settings.heading")}</h1>
      <p className="muted">{t("settings.subtitle")}</p>

      {/* Appearance — the full set of themes as a radio group of swatched tiles. */}
      <section className="settings-section">
        <h2>{t("settings.appearance")}</h2>
        <p className="muted">{t("settings.appearanceDesc")}</p>
        <div className="option-grid" role="radiogroup" aria-label={t("settings.appearance")}>
          {THEMES.map((th) => {
            const selected = th.value === theme;
            return (
              <button
                key={th.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? "option-tile selected" : "option-tile"}
                onClick={() => setTheme(th.value)}
              >
                <span className={`theme-swatch theme-swatch--${th.value}`} aria-hidden="true" />
                <span className="option-name">{t(THEME_LABEL[th.value])}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Language — the same three languages the account menu offers. */}
      <section className="settings-section">
        <h2>{t("settings.language")}</h2>
        <p className="muted">{t("settings.languageDesc")}</p>
        <div className="option-grid" role="radiogroup" aria-label={t("settings.language")}>
          {LANGUAGES.map((l) => {
            const selected = l.value === currentLang;
            return (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? "option-tile selected" : "option-tile"}
                onClick={() => void i18n.changeLanguage(l.value)}
              >
                <span className="option-name">{l.label}</span>
              </button>
            );
          })}
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
    <section className="settings-section">
      <div className="section-head-row">
        <h2>{t("shortcuts.title")}</h2>
        <button type="button" className="btn secondary small" onClick={resetAll}>
          {t("shortcuts.resetAll")}
        </button>
      </div>
      <p className="muted">{t("shortcuts.desc")}</p>
      <div className="shortcut-rows">
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
    <div className="shortcut-row">
      <span className="shortcut-label">{t(def.labelKey)}</span>
      <button
        type="button"
        className={`shortcut-key${recording ? " recording" : ""}`}
        onClick={() => setRecording((v) => !v)}
      >
        {recording ? (
          t("shortcuts.press")
        ) : combo ? (
          <kbd className="kbd">{formatCombo(combo)}</kbd>
        ) : (
          <span className="muted">{t("shortcuts.unbound")}</span>
        )}
      </button>
      <button
        type="button"
        className="btn icon secondary"
        title={t("shortcuts.reset")}
        aria-label={t("shortcuts.reset")}
        onClick={() => resetBinding(def.id)}
      >
        ↺
      </button>
    </div>
  );
}
