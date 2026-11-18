/**
 * The fields of the palette's «Найти свободное место» (FEEDBACK-2 §4), pure:
 * a unit count and a power in kW as typed, in either decimal separator.
 * Power stays integer watts once read; an empty field is "any power", never 0.
 */

/** Rack units the finder accepts (as its own form does). */
export const MAX_U = 60;

/** A unit count, or `undefined` when it is not one. */
export function parseUnits(text: string): number | undefined {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return undefined;
  const u = Number(s);
  return u >= 1 && u <= MAX_U ? u : undefined;
}

/** Watts from kW as typed (`0,8`, `1.25`); `null` for empty, `undefined` when unreadable. */
export function parseKw(text: string): number | null | undefined {
  const s = text.trim().replace(",", ".");
  if (s === "") return null;
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return undefined;
  return Math.round(Number(s) * 1000);
}

/** Watts as kW for the field and the row: `0,8` in Russian, `0.8` in English. */
export function kwText(powerW: number, lang: string): string {
  return (powerW / 1000).toLocaleString(lang, {
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}
