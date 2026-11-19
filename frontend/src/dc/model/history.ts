/**
 * A revision in words (FEEDBACK-6 §6), pure: the digest the server computes
 * (what was added, moved, re-owned …) becomes an i18n key with its values,
 * which the page translates. Sentences are impersonal («Перенесено …»): the
 * author is shown next to them, and the verb needs no gender. No stored
 * English summary and no «seed» ever reach the screen.
 */

import type { Digest, DeviceKind, Place } from "../types";

export interface Phrase {
  key: string;
  values: Record<string, string | number>;
}

/** Kinds with their own counted noun; anything else counts as «устройство». */
const NOUNS: DeviceKind[] = ["server", "storage", "switch"];

/** The counted noun for a list of devices: their kind when they share one. */
export function nounOf(kinds: DeviceKind[]): string {
  const k = kinds[0];
  return kinds.length > 0 && kinds.every((x) => x === k) && NOUNS.includes(k)
    ? k
    : "device";
}

/** «U18–U19», or «U40» for one unit. */
export function uRange(p: Pick<Place, "u_bottom" | "u_height">): string {
  const top = p.u_bottom + p.u_height - 1;
  return top === p.u_bottom ? `U${p.u_bottom}` : `U${p.u_bottom}–U${top}`;
}

const placeText = (p: Place) => `${p.rack}, ${uRange(p)}`;

/**
 * The sentence a revision is listed with: its main change in words, and how
 * many other kinds of change came with it.
 */
export function revisionSentence(d: Digest): { main: Phrase; more: number } {
  const parts = sentences(d);
  return parts.length
    ? { main: parts[0], more: parts.length - 1 }
    : { main: { key: "dc.revs.nothing", values: {} }, more: 0 };
}

/** Every change of a revision as a sentence, the most telling first. */
export function sentences(d: Digest): Phrase[] {
  if (d.kind === "created") return [{ key: "dc.revs.created", values: {} }];
  if (d.kind === "import")
    return [
      {
        key: "dc.revs.import",
        values: {
          count:
            d.devices_added.length +
            d.devices_moved.length +
            d.devices_changed.length +
            d.owners.length,
        },
      },
    ];
  if (d.kind === "restore")
    return [{ key: "dc.revs.restore", values: { n: d.restored ?? "?" } }];

  const out: Phrase[] = [];
  const counted = (kinds: DeviceKind[]) => ({
    noun: nounOf(kinds),
    count: kinds.length,
  });

  if (d.devices_moved.length) {
    const racks = new Set(
      d.devices_moved.map((m) => `${m.from.rack}→${m.to.rack}`),
    );
    const m = d.devices_moved[0];
    if (d.devices_moved.length === 1)
      out.push({
        key: "dc.revs.movedOne",
        values: { name: m.name, from: placeText(m.from), to: placeText(m.to) },
      });
    else if (racks.size === 1 && m.from.rack !== m.to.rack)
      out.push({
        key: "dc.revs.movedRacks",
        values: {
          ...counted(d.devices_moved.map((x) => x.kind)),
          from: m.from.rack,
          to: m.to.rack,
        },
      });
    else
      out.push({
        key: "dc.revs.moved",
        values: counted(d.devices_moved.map((x) => x.kind)),
      });
  }
  for (const [list, one, many] of [
    [d.devices_added, "dc.revs.addedOne", "dc.revs.added"],
    [d.devices_removed, "dc.revs.removedOne", "dc.revs.removed"],
  ] as const) {
    if (!list.length) continue;
    const x = list[0];
    const racks = new Set(list.map((y) => y.rack));
    out.push(
      list.length === 1
        ? {
            key: one,
            values: { kind: x.kind, name: x.name, place: placeText(x) },
          }
        : {
            key: racks.size === 1 ? `${many}In` : many,
            values: { ...counted(list.map((y) => y.kind)), rack: x.rack },
          },
    );
  }
  if (d.owners.length)
    out.push(
      d.owners.length === 1
        ? {
            key: "dc.revs.ownerOne",
            values: { name: d.owners[0].name, owner: d.owners[0].after || "—" },
          }
        : { key: "dc.revs.owners", values: { count: d.owners.length } },
    );
  if (d.devices_changed.length)
    out.push(
      d.devices_changed.length === 1
        ? { key: "dc.revs.changedOne", values: { name: d.devices_changed[0] } }
        : {
            key: "dc.revs.changed",
            values: { count: d.devices_changed.length },
          },
    );
  for (const [list, one, many] of [
    [d.objects_moved, "dc.revs.objectMoved", "dc.revs.objectsMoved"],
    [d.objects_added, "dc.revs.objectAdded", "dc.revs.objectsAdded"],
    [d.objects_removed, "dc.revs.objectRemoved", "dc.revs.objectsRemoved"],
    [d.objects_changed, "dc.revs.objectChanged", "dc.revs.objectsChanged"],
  ] as const)
    if (list.length)
      out.push(
        list.length === 1
          ? { key: one, values: { name: list[0] } }
          : { key: many, values: { count: list.length } },
      );
  if (d.cells_changed)
    out.push({ key: "dc.revs.cells", values: { count: d.cells_changed } });
  if (d.notes_added)
    out.push({ key: "dc.revs.notes", values: { count: d.notes_added } });
  if (d.views_added)
    out.push({ key: "dc.revs.views", values: { count: d.views_added } });
  if (d.annotations_removed)
    out.push({
      key: "dc.revs.annotationsRemoved",
      values: { count: d.annotations_removed },
    });
  return out;
}

/** One line of a revision's detail: what changed, from what to what. */
export interface ChangeRow {
  tag: "moved" | "added" | "removed" | "owner" | "changed";
  name: string;
  kind?: DeviceKind;
  before?: string;
  after?: string;
  /** Devices added to (or removed from) a rack, when listed per rack. */
  count?: number;
}

/** Above this many, added or removed devices are listed per rack. */
const PER_RACK_ABOVE = 10;

/** «Стойка 1: 21» rows for a long list of added or removed devices. */
function perRack(
  tag: "added" | "removed",
  list: Digest["devices_added"],
): ChangeRow[] {
  const racks = new Map<string, typeof list>();
  for (const x of list) racks.set(x.rack, [...(racks.get(x.rack) ?? []), x]);
  return [...racks].map(([rack, xs]) => {
    const lo = Math.min(...xs.map((x) => x.u_bottom));
    const hi = Math.max(...xs.map((x) => x.u_bottom + x.u_height - 1));
    const span = `U${lo}–U${hi}`;
    return {
      tag,
      name: rack,
      count: xs.length,
      ...(tag === "added" ? { after: span } : { before: span }),
    };
  });
}

/** The detail's changes, grouped by what happened, with old → new. */
export function changeRows(d: Digest): ChangeRow[] {
  if (
    d.devices_added.length > PER_RACK_ABOVE ||
    d.devices_removed.length > PER_RACK_ABOVE
  )
    return [
      ...(d.devices_added.length > PER_RACK_ABOVE
        ? perRack("added", d.devices_added)
        : []),
      ...(d.devices_removed.length > PER_RACK_ABOVE
        ? perRack("removed", d.devices_removed)
        : []),
      ...changeRows({
        ...d,
        devices_added:
          d.devices_added.length > PER_RACK_ABOVE ? [] : d.devices_added,
        devices_removed:
          d.devices_removed.length > PER_RACK_ABOVE ? [] : d.devices_removed,
      }),
    ];
  return [
    ...d.devices_moved.map((m) => ({
      tag: "moved" as const,
      name: m.name,
      kind: m.kind,
      before: placeText(m.from),
      after: placeText(m.to),
    })),
    ...d.devices_added.map((x) => ({
      tag: "added" as const,
      name: x.name,
      kind: x.kind,
      after: placeText(x),
    })),
    ...d.devices_removed.map((x) => ({
      tag: "removed" as const,
      name: x.name,
      kind: x.kind,
      before: placeText(x),
    })),
    ...d.owners.map((o) => ({
      tag: "owner" as const,
      name: o.name,
      before: o.before || "—",
      after: o.after || "—",
    })),
    ...d.devices_changed.map((name) => ({ tag: "changed" as const, name })),
    ...d.objects_moved.map((name) => ({ tag: "moved" as const, name })),
    ...d.objects_added.map((name) => ({ tag: "added" as const, name })),
    ...d.objects_removed.map((name) => ({ tag: "removed" as const, name })),
    ...d.objects_changed.map((name) => ({ tag: "changed" as const, name })),
  ];
}

/** Names of the objects (racks, …) a revision touched, for the mini plans. */
export function touched(d: Digest): Set<string> {
  return new Set([
    ...d.devices_moved.flatMap((m) => [m.from.rack, m.to.rack]),
    ...d.devices_added.map((x) => x.rack),
    ...d.devices_removed.map((x) => x.rack),
    ...d.objects_moved,
    ...d.objects_added,
    ...d.objects_changed,
  ]);
}
