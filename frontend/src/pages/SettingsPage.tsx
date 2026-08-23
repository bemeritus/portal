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

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { LANGUAGES } from "../i18n";
import { THEMES, useTheme, type ThemeValue } from "../components/ThemeSelect";

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
    </div>
  );
}
