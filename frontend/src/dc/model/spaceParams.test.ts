import { describe, expect, it } from "vitest";

import {
  kwText,
  parseKw,
  parseSpaceQuery,
  parseUnits,
  stripSpaceParams,
  withSpaceParams,
} from "./spaceParams";

describe("parseSpaceQuery", () => {
  // [query, units, watts]: RU / UZ / EN, any order, nothing assumed.
  const cases: [string, number | null, number | null][] = [
    ["место 2u 0,8 квт", 2, 800],
    ["свободно 3U", 3, null],
    ["свобод 2 юн", 2, null],
    ["4ю", 4, null],
    ["место 3 юнита", 3, null],
    ["0.8kw 2u", 2, 800],
    ["800 вт свободно 1U", 1, 800],
    ["место 0,8 КВт 2U", 2, 800],
    ["joy 2 yu 0,8 kVt", 2, 800],
    ["bo'sh 3 yunit 800 Vt", 3, 800],
    ["free 4 units 450 W", 4, 450],
    ["free 1.2 kW 1U", 1, 1200],
    // No unit count: none assumed.
    ["свободно", null, null],
    ["место 0,8 квт", null, 800],
    ["", null, null],
    // Numbers in names are not parameters.
    ["Стойка 3", null, null],
    ["DELL R740", null, null],
    ["2юла", null, null],
    ["5 watts", null, null],
  ];
  it.each(cases)("%j → %s U, %s W", (q, u, powerW) => {
    expect(parseSpaceQuery(q)).toEqual({ u, powerW });
  });

  it("takes the last of each when typed twice", () => {
    expect(parseSpaceQuery("2u 3u 1 квт 2 квт")).toEqual({ u: 3, powerW: 2000 });
  });
});

describe("the query and its parameters", () => {
  it("leaves the words to search by", () => {
    expect(stripSpaceParams("место 2u 0,8 квт")).toBe("место");
    expect(stripSpaceParams("0.8kw свободно 3U")).toBe("свободно");
    expect(stripSpaceParams("Стойка 3")).toBe("Стойка 3");
  });

  it("writes the fields' values back so the row reads them", () => {
    const ru = (v: string) => `${v} кВт`;
    expect(withSpaceParams("свобод 1u", { u: 2, powerW: 800 }, "ru", ru)).toBe(
      "свобод 2U 0,8 кВт",
    );
    expect(withSpaceParams("свобод", { u: 3, powerW: null }, "ru", ru)).toBe(
      "свобод 3U",
    );
    const en = (v: string) => `${v} kW`;
    for (const [lang, kw] of [
      ["ru", ru],
      ["en", en],
      ["uz", (v: string) => `${v} kVt`],
    ] as const)
      for (const p of [
        { u: 2, powerW: 800 },
        { u: 42, powerW: 12500 },
        { u: 1, powerW: null },
      ])
        expect(parseSpaceQuery(withSpaceParams("место", p, lang, kw))).toEqual(p);
  });
});

describe("palette free-space fields", () => {
  it.each([
    ["1", 1],
    [" 42 ", 42],
    ["2", 2],
  ])("reads %j as %i units", (s, u) => expect(parseUnits(s)).toBe(u));

  it.each(["", "0", "43", "60", "1.5", "2U", "-1", "x"])(
    "refuses %j units",
    (s) => expect(parseUnits(s)).toBeUndefined(),
  );

  it("reads kW in either decimal separator, as integer watts", () => {
    expect(parseKw("0,8")).toBe(800);
    expect(parseKw("0.8")).toBe(800);
    expect(parseKw("1,25")).toBe(1250);
    expect(parseKw("2")).toBe(2000);
    expect(parseKw(",5")).toBe(500);
    expect(parseKw("0,0004")).toBe(0);
  });

  it("keeps empty as any power, never 0", () => {
    expect(parseKw("")).toBeNull();
    expect(parseKw("  ")).toBeNull();
  });

  it("refuses what is not a number", () => {
    for (const bad of ["abc", "1,2,3", "-1", "0.8 кВт", "1e3"])
      expect(parseKw(bad)).toBeUndefined();
  });

  it("writes kW in the user's language, and reads it back", () => {
    expect(kwText(800, "ru")).toBe("0,8");
    expect(kwText(800, "en")).toBe("0.8");
    expect(kwText(12500, "ru")).toBe("12,5");
    for (const lang of ["ru", "uz", "en"])
      for (const w of [0, 450, 800, 1250, 12000])
        expect(parseKw(kwText(w, lang))).toBe(w);
  });
});
