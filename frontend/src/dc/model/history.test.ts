import { describe, expect, it } from "vitest";

import type { Digest } from "../types";
import {
  changeRows,
  nounOf,
  revisionSentence,
  touched,
  uRange,
} from "./history";

const empty: Digest = {
  kind: "edit",
  devices_added: [],
  devices_removed: [],
  devices_moved: [],
  owners: [],
  devices_changed: [],
  objects_added: [],
  objects_removed: [],
  objects_moved: [],
  objects_changed: [],
  notes_added: 0,
  views_added: 0,
  annotations_removed: 0,
  cells_changed: 0,
};

const moved = (name: string, from: number, to: number) => ({
  name,
  kind: "server" as const,
  from: { rack: "Стойка 1", u_bottom: from, u_height: 2 },
  to: { rack: "Стойка 3", u_bottom: to, u_height: 2 },
});

describe("a revision in words", () => {
  it("names the room's creation, an import and a restore", () => {
    expect(revisionSentence({ ...empty, kind: "created" }).main.key).toBe(
      "dc.revs.created",
    );
    const imp = revisionSentence({
      ...empty,
      kind: "import",
      devices_added: Array.from({ length: 92 }, (_, i) => ({
        name: `d${i}`,
        kind: "server" as const,
        rack: "Стойка 1",
        u_bottom: 1,
        u_height: 1,
      })),
    });
    expect(imp.main).toEqual({ key: "dc.revs.import", values: { count: 92 } });
    expect(
      revisionSentence({ ...empty, kind: "restore", restored: 4 }).main,
    ).toEqual({
      key: "dc.revs.restore",
      values: { n: 4 },
    });
  });

  it("says two servers moved from one rack to another", () => {
    const s = revisionSentence({
      ...empty,
      devices_moved: [moved("a", 18, 30), moved("b", 20, 32)],
    });
    expect(s).toEqual({
      main: {
        key: "dc.revs.movedRacks",
        values: { noun: "server", count: 2, from: "Стойка 1", to: "Стойка 3" },
      },
      more: 0,
    });
  });

  it("names a single added device with its place", () => {
    const s = revisionSentence({
      ...empty,
      devices_added: [
        {
          name: "sw-12",
          kind: "switch",
          rack: "Стойка 4",
          u_bottom: 40,
          u_height: 1,
        },
      ],
    });
    expect(s.main).toEqual({
      key: "dc.revs.addedOne",
      values: { kind: "switch", name: "sw-12", place: "Стойка 4, U40" },
    });
  });

  it("counts the other kinds of change", () => {
    const s = revisionSentence({
      ...empty,
      owners: [
        { name: "a", before: "X", after: "Y" },
        { name: "b", before: "X", after: "Y" },
      ],
      notes_added: 1,
    });
    expect(s.main).toEqual({ key: "dc.revs.owners", values: { count: 2 } });
    expect(s.more).toBe(1);
    expect(revisionSentence(empty).main.key).toBe("dc.revs.nothing");
  });

  it("lists the detail's changes with old → new, and what they touched", () => {
    const d = {
      ...empty,
      devices_moved: [moved("srv-kvm-07", 18, 30)],
      objects_moved: ["Стойка 2"],
    };
    expect(changeRows(d)).toEqual([
      {
        tag: "moved",
        name: "srv-kvm-07",
        kind: "server",
        before: "Стойка 1, U18–U19",
        after: "Стойка 3, U30–U31",
      },
      { tag: "moved", name: "Стойка 2" },
    ]);
    expect([...touched(d)].sort()).toEqual([
      "Стойка 1",
      "Стойка 2",
      "Стойка 3",
    ]);
  });

  it("lists a long import per rack", () => {
    const added = Array.from({ length: 12 }, (_, i) => ({
      name: `d${i}`,
      kind: "server" as const,
      rack: i < 8 ? "Стойка 1" : "Стойка 2",
      u_bottom: 1 + i * 2,
      u_height: 2,
    }));
    expect(
      changeRows({ ...empty, kind: "import", devices_added: added }),
    ).toEqual([
      { tag: "added", name: "Стойка 1", count: 8, after: "U1–U16" },
      { tag: "added", name: "Стойка 2", count: 4, after: "U17–U24" },
    ]);
  });

  it("counts devices by their shared kind, or as devices", () => {
    expect(nounOf(["server", "server"])).toBe("server");
    expect(nounOf(["server", "switch"])).toBe("device");
    expect(nounOf(["ups"])).toBe("device");
    expect(uRange({ u_bottom: 40, u_height: 1 })).toBe("U40");
  });
});
