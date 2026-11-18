import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore } from "./fuzzy";

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
});
