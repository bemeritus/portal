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
