/**
 * i18next setup — three languages, persisted like the theme is.
 *
 * The chosen language is stored under `localStorage["lang"]` and reflected on
 * `<html lang>`, which `index.html`'s inline script also reads before the
 * bundle loads so the attribute is right from the first paint. Components pull
 * strings with `useTranslation()`; plurals (English one/other, Russian
 * one/few/many/other, Uzbek's single form) are handled by i18next's own CLDR
 * rules from the `_one` / `_few` / … keys in the locale files.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "./locales/en";
import { ru } from "./locales/ru";
import { uz } from "./locales/uz";

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
  { value: "uz", label: "O'zbek" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["value"];

const STORAGE_KEY = "lang";
const DEFAULT_LANG: Lang = "en";

/** A stored value, or the default when it is missing or unrecognised. */
export function readStoredLang(): Lang {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.value === value) ? (value as Lang) : DEFAULT_LANG;
  } catch {
    // Private browsing can make even reading throw.
    return DEFAULT_LANG;
  }
}

void i18n.use(initReactI18next).init({
  resources: { en, ru, uz },
  lng: readStoredLang(),
  fallbackLng: DEFAULT_LANG,
  // React already escapes what it renders; i18next doing it again would turn an
  // apostrophe in a name into an entity.
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Persist the choice and keep <html lang> in step for a11y and the ':lang' CSS
// selector, mirroring how the theme writes `data-theme`.
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // A choice that cannot be remembered still applies for this session.
  }
});
document.documentElement.lang = i18n.language;

export default i18n;
