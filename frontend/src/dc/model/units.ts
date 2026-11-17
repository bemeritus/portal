/**
 * Lengths for display, pure (SPEC §3.2): stored and sent as integer mm, shown
 * in the user's unit — mm as integers, cm with up to one decimal, m with up
 * to three. Every mm value survives a round trip exactly: 1 mm is 0.1 cm and
 * 0.001 m, so the decimals allowed are exactly enough.
 */

export type LengthUnit = "mm" | "cm" | "m";
export const UNITS: LengthUnit[] = ["mm", "cm", "m"];

const SCALE: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000 };
const DIGITS: Record<LengthUnit, number> = { mm: 0, cm: 1, m: 3 };
const LOCALE: Record<string, string> = { ru: "ru-RU", uz: "uz-Latn-UZ", en: "en-US" };

function nf(lang: string, unit: LengthUnit, grouping = true): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE[lang.split("-")[0]] ?? "en-US", {
    maximumFractionDigits: DIGITS[unit],
    minimumFractionDigits: 0,
    useGrouping: grouping,
  });
}

/** The number alone, in `unit` (`60,5`, `5.545`, `5 545`). */
export function lengthNumber(mm: number, unit: LengthUnit, lang: string): string {
  return nf(lang, unit).format(Math.round(mm) / SCALE[unit]);
}

/** Two readings: `5,54–5,55` (unit word added by the caller). */
export function rangeNumber(lo: number, hi: number, unit: LengthUnit, lang: string): string {
  return `${lengthNumber(lo, unit, lang)}–${lengthNumber(hi, unit, lang)}`;
}

/** The number for an input field: no grouping, `.` or the locale's comma. */
export function lengthInput(mm: number, unit: LengthUnit, lang: string): string {
  return nf(lang, unit, false).format(Math.round(mm) / SCALE[unit]);
}

/**
 * Parse what a user typed in `unit` back to integer mm. Accepts `,` or `.` as
 * the decimal separator and spaces as grouping; `null` for anything else.
 */
export function parseLength(text: string, unit: LengthUnit): number | null {
  const t = text.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * SCALE[unit]);
}
