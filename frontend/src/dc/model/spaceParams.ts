/**
 * The parameters of the palette's find-free-space action (FEEDBACK-2 §4,
 * FEEDBACK-3 §2), pure: read from the query as it is typed — in Russian,
 * Uzbek or English, in any order — and from the fields. Nothing is assumed:
 * a query without a unit count has none. Power stays integer watts once read;
 * an empty power is "any power", never 0.
 */

/** Rack units the palette accepts: the racks are 42U. */
export const MAX_U = 42;

/**
 * A unit count: a number and a unit word in Russian, Uzbek or English, with
 * or without a space (the tests list the forms). Longer words come first, so
 * the Russian word for "unit" is not read as its one-letter abbreviation.
 */
const UNITS_RE =
  /(\d+)\s*(?:юнит[а-яё]*|юн|ю|yunit[a-z']*|yu|units?|u)(?![a-zа-яё])/giu;

/** A power in kW or W, in Russian, Uzbek or English unit words, either decimal separator. */
const POWER_RE =
  /(\d+(?:[.,]\d+)?)\s*(квт|kw|kvt|вт|w|vt)(?![a-zа-яё])/giu;

export interface SpaceQuery {
  u: number | null;
  powerW: number | null;
}

/** The parameters typed in a query; the last one of each kind wins. */
export function parseSpaceQuery(q: string): SpaceQuery {
  let u: number | null = null;
  let powerW: number | null = null;
  for (const m of q.matchAll(UNITS_RE)) u = Number(m[1]);
  for (const m of q.matchAll(POWER_RE)) {
    const v = parseFloat(m[1].replace(",", "."));
    const kilo = /^(квт|kw|kvt)$/i.test(m[2]);
    powerW = Math.round(v * (kilo ? 1000 : 1));
  }
  return { u, powerW };
}

/** The query without its parameters: the words left to search by. */
export function stripSpaceParams(q: string): string {
  return q.replace(UNITS_RE, " ").replace(POWER_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * The query with these parameters written into it (replacing any it had),
 * so the row — which reads the query — shows what the fields said.
 * `kw` is the unit's word for kW in the user's language, with `{{v}}`.
 */
export function withSpaceParams(
  q: string,
  p: SpaceQuery,
  lang: string,
  kw: (v: string) => string,
): string {
  const parts = [stripSpaceParams(q)];
  if (p.u !== null) parts.push(`${p.u}U`);
  if (p.powerW !== null) parts.push(kw(kwText(p.powerW, lang)));
  return parts.filter(Boolean).join(" ");
}

/** A unit count from 1 to `MAX_U`, or `undefined` when it is not one. */
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
