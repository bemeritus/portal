import { describe, expect, it } from "vitest";

import { kwText, parseKw, parseUnits } from "./spaceParams";

describe("palette free-space fields", () => {
  it("reads a unit count", () => {
    expect(parseUnits("2")).toBe(2);
    expect(parseUnits(" 42 ")).toBe(42);
    for (const bad of ["", "0", "61", "1.5", "2U", "-1", "x"])
      expect(parseUnits(bad)).toBeUndefined();
  });

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
