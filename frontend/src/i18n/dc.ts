/**
 * The server room module's strings (`dc.*`), registered when the module is
 * first opened — its own chunk — so the rest of the portal does not download
 * ~70 kB of translations it never shows.
 */

import i18n from "i18next";

import { dcEn } from "./locales/dc/en";
import { dcRu } from "./locales/dc/ru";
import { dcUz } from "./locales/dc/uz";

export const DC_LOCALES = { en: dcEn, ru: dcRu, uz: dcUz } as const;

let done = false;

export function registerDcLocales() {
  if (done) return;
  done = true;
  for (const [lang, dc] of Object.entries(DC_LOCALES)) i18n.addResourceBundle(lang, "translation", { dc }, true, false);
}
