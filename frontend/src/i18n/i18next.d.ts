/**
 * Types `t()` against the English catalog, so a key that does not exist is a
 * compile error (`npm run typecheck`, part of `just ci`) rather than a raw key
 * shown to a user. Russian and Uzbek are held to the same key set by
 * `locales.test.ts`.
 */
import "i18next";

import type { en } from "./locales/en";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: (typeof en);
    returnNull: false;
  }
}
