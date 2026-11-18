/**
 * Fuzzy matching for the command palette, pure: every query character must
 * appear in order; consecutive runs, word starts and an early first match
 * score higher. Case-insensitive, and the Cyrillic "yo" matches "ye".
 */

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** A score (higher is better), or `null` when the text does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = norm(query).replace(/\s+/g, "");
  if (!q) return 0;
  const t = norm(text);
  let score = 0,
    ti = 0,
    run = 0,
    first = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    if (first < 0) first = i;
    run = i === ti ? run + 1 : 1;
    score += run * 2;
    if (i === 0 || /[\s\-_·.,/(«]/.test(t[i - 1])) score += 3;
    ti = i + 1;
  }
  return score - first * 0.1 - (t.length - q.length) * 0.01;
}

/** Items sorted by score, non-matches dropped. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  text: (t: T) => string,
): T[] {
  return items
    .map((it) => ({ it, s: fuzzyScore(query, text(it)) }))
    .filter((x): x is { it: T; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}
