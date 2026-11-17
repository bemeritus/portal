/**
 * Numbers and units per locale (SPEC §6): `5 545 мм` in Russian, `5,545 mm`
 * in English, `5 545 mm` in Uzbek. The unit words come from the catalog
 * (`dc.unit.*`) so they are translated like everything else.
 */

import type { TFunction } from "i18next";

const LOCALE: Record<string, string> = { ru: "ru-RU", uz: "uz-Latn-UZ", en: "en-US" };

export function numberFormat(lang: string, digits = 0): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE[lang.split("-")[0]] ?? "en-US", { maximumFractionDigits: digits });
}

export interface Fmt {
  n: (v: number, digits?: number) => string;
  mm: (v: number) => string;
  range: (lo: number, hi: number) => string;
  w: (v: number | null) => string;
  kw: (v: number) => string;
  m3h: (v: number) => string;
  kg: (v: number) => string;
}

export function makeFmt(t: TFunction, lang: string): Fmt {
  const nf = numberFormat(lang);
  const n = (v: number, digits = 0) => (digits ? numberFormat(lang, digits) : nf).format(v);
  return {
    n,
    mm: (v) => t("dc.unit.mm", { v: n(Math.round(v)) }),
    range: (lo, hi) => t("dc.unit.mm", { v: `${n(lo)}–${n(hi)}` }),
    w: (v) => (v === null ? t("dc.unknown") : v >= 10000 ? t("dc.unit.kw", { v: n(v / 1000, 1) }) : t("dc.unit.w", { v: n(v) })),
    kw: (v) => t("dc.unit.kw", { v: n(v / 1000, 1) }),
    m3h: (v) => t("dc.unit.m3h", { v: n(v) }),
    kg: (v) => t("dc.unit.kg", { v: n(v, 1) }),
  };
}
