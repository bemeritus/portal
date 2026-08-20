/** Dates, shown the same way everywhere. */

/** A date for a list or a header: local, day-level. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A timestamp for the audit log, in **UTC**, with the zone written out.
 *
 * The browser's offset is not the server's, and a log that quietly shifts
 * times is worse than one that is explicit about the zone — an admin
 * correlating an entry with a server log needs them to be the same clock.
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The `cat-N` class (N in 1…6) that gives a category its badge colour.
 *
 * Derived from the id so a category keeps the same hue on every page and
 * across reloads — no colour is stored server-side. The sum of the id's
 * character codes is as good as any hash here: the ids are UUIDs, so their
 * bytes are already uniform, and we only need six stable buckets.
 */
export function categoryTagClass(id: string): string {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return `cat-${(sum % 6) + 1}`;
}
