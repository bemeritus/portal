import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore, parseSpaceQuery } from "./fuzzy";

describe("fuzzy", () => {
  it("matches characters in order, case-insensitively", () => {
    expect(fuzzyScore("св", "Найти свободное место")).not.toBeNull();
    expect(fuzzyScore("стк3", "Стойка 3")).not.toBeNull();
    expect(fuzzyScore("xyz", "Стойка 3")).toBeNull();
    expect(fuzzyScore("ё", "Ещё")).not.toBeNull();
  });

  it("ranks word starts and runs first", () => {
    const r = fuzzyFilter(
      "r740",
      ["DELL R740", "Router 7 40", "srv-r7-40"],
      (s) => s,
    );
    expect(r[0]).toBe("DELL R740");
  });

  it("reads the parameters of a free-space query", () => {
    expect(parseSpaceQuery("свобод 2U 0,8 кВт")).toEqual({ u: 2, powerW: 800 });
    expect(parseSpaceQuery("free 4u 450 W")).toEqual({ u: 4, powerW: 450 });
    expect(parseSpaceQuery("место")).toEqual({ u: null, powerW: null });
    expect(parseSpaceQuery("1.2 kW 1U")).toEqual({ u: 1, powerW: 1200 });
  });
});
