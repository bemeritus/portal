import { describe, expect, it } from "vitest";

import {
  lengthInput,
  lengthNumber,
  parseLength,
  rangeNumber,
  UNITS,
} from "./units";

describe("display units", () => {
  it("formats as the spec says", () => {
    expect(lengthNumber(605, "mm", "en")).toBe("605");
    expect(lengthNumber(605, "cm", "en")).toBe("60.5");
    expect(lengthNumber(600, "cm", "en")).toBe("60");
    expect(lengthNumber(5545, "m", "en")).toBe("5.545");
    expect(lengthNumber(5545, "mm", "en")).toBe("5,545");
    expect(lengthNumber(625, "cm", "ru")).toBe("62,5");
    expect(rangeNumber(5540, 5550, "m", "en")).toBe("5.54–5.55");
    expect(rangeNumber(1495, 1500, "cm", "en")).toBe("149.5–150");
  });

  it("round-trips every millimetre exactly in every unit and language", () => {
    for (const unit of UNITS)
      for (const lang of ["ru", "uz", "en"])
        for (let mm = -50; mm <= 12000; mm += 7) {
          expect(parseLength(lengthInput(mm, unit, lang), unit)).toBe(mm);
        }
  });

  it("parses what people type", () => {
    expect(parseLength("60,5", "cm")).toBe(605);
    expect(parseLength(" 5.545 ", "m")).toBe(5545);
    expect(parseLength("5 545", "mm")).toBe(5545);
    expect(parseLength("abc", "cm")).toBeNull();
    expect(parseLength("", "cm")).toBeNull();
  });
});
