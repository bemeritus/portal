/**
 * Numbers and units per locale (SPEC §6) and per the user's length unit
 * (§3.2): `62,5` and the cm word in Russian, `5.545 m` in English. The
 * unit words come from the catalog (`dc.unit.*`), so they are translated
 * too.
 */

import type { TFunction } from "i18next";

import {
  lengthInput,
  lengthNumber,
  parseLength,
  rangeNumber,
  type LengthUnit,
} from "./model/units";

const LOCALE: Record<string, string> = {
  ru: "ru-RU",
  uz: "uz-Latn-UZ",
  en: "en-US",
};

export function numberFormat(lang: string, digits = 0): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE[lang.split("-")[0]] ?? "en-US", {
    maximumFractionDigits: digits,
  });
}

export interface Fmt {
  unit: LengthUnit;
  n: (v: number, digits?: number) => string;
  /** A length in the user's unit, with the unit word. */
  mm: (v: number) => string;
  /** The number alone, in the user's unit. */
  len: (v: number) => string;
  /** Two readings. */
  range: (lo: number, hi: number) => string;
  /** W × D × H with one unit word. */
  dims: (w: number, d: number, h: number) => string;
  /** The unit's word, for labels ("x, cm" in the user's language). */
  unitWord: string;
  /** For input fields: format and parse in the user's unit. */
  input: (v: number) => string;
  parse: (text: string) => number | null;
  w: (v: number | null) => string;
  kw: (v: number) => string;
  m3h: (v: number) => string;
  kg: (v: number) => string;
}

export function makeFmt(
  t: TFunction,
  lang: string,
  unit: LengthUnit = "mm",
): Fmt {
  const nf = numberFormat(lang);
  const n = (v: number, digits = 0) =>
    (digits ? numberFormat(lang, digits) : nf).format(v);
  const withUnit = (v: string) => t(`dc.unit.${unit}` as "dc.unit.mm", { v });
  const len = (v: number) => lengthNumber(v, unit, lang);
  return {
    unit,
    n,
    len,
    mm: (v) => withUnit(len(v)),
    range: (lo, hi) => withUnit(rangeNumber(lo, hi, unit, lang)),
    dims: (w, d, h) => withUnit(`${len(w)} × ${len(d)} × ${len(h)}`),
    unitWord: t(`dc.unitWord.${unit}` as "dc.unitWord.mm"),
    input: (v) => lengthInput(v, unit, lang),
    parse: (text) => parseLength(text, unit),
    w: (v) =>
      v === null
        ? t("dc.unknown")
        : v >= 10000
          ? t("dc.unit.kw", { v: n(v / 1000, 1) })
          : t("dc.unit.w", { v: n(v) }),
    kw: (v) => t("dc.unit.kw", { v: n(v / 1000, 1) }),
    m3h: (v) => t("dc.unit.m3h", { v: n(v) }),
    kg: (v) => t("dc.unit.kg", { v: n(v, 1) }),
  };
}
