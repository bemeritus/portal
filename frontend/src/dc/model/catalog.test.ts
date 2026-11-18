import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { DC_LOCALES } from "../../i18n/dc";
import { makeFmt } from "../format";
import type { CatalogItem } from "../types";
import { dimsNumbers, dimsText } from "./catalog";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "ru",
    resources: Object.fromEntries(
      Object.entries(DC_LOCALES).map(([l, dc]) => [l, { translation: { dc } }]),
    ),
    interpolation: { escapeValue: false },
  });
});

// Liebert CRV CRD25: 300 × 1132 × 2000 mm (FEEDBACK-4 §1's example).
const crv = {
  id: 1,
  kind: "cooling",
  width_mm: 300,
  depth_mm: 1132,
  height_mm: 2000,
} as CatalogItem;

describe("catalog dimensions (FEEDBACK-4 §1)", () => {
  // [lang, unit, full text, numbers only]: every value in one unit.
  const cases: [string, "mm" | "cm" | "m", string, string][] = [
    ["ru", "mm", "300 × 1 132 × 2 000 мм", "300 × 1 132 × 2 000"],
    ["ru", "cm", "30 × 113,2 × 200 см", "30 × 113,2 × 200"],
    ["ru", "m", "0,3 × 1,132 × 2 м", "0,3 × 1,132 × 2"],
    ["en", "mm", "300 × 1,132 × 2,000 mm", "300 × 1,132 × 2,000"],
    ["en", "cm", "30 × 113.2 × 200 cm", "30 × 113.2 × 200"],
    ["en", "m", "0.3 × 1.132 × 2 m", "0.3 × 1.132 × 2"],
    ["uz", "mm", "300 × 1 132 × 2 000 mm", "300 × 1 132 × 2 000"],
    ["uz", "cm", "30 × 113,2 × 200 sm", "30 × 113,2 × 200"],
    ["uz", "m", "0,3 × 1,132 × 2 m", "0,3 × 1,132 × 2"],
  ];
  it.each(cases)("%s, %s: %s", (lang, unit, full, numbers) => {
    const fmt = makeFmt(i18n.getFixedT(lang), lang, unit);
    // Intl uses a no-break space to group thousands in Russian and Uzbek.
    const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
    expect(norm(dimsText(crv, fmt))).toBe(full);
    expect(norm(dimsNumbers(crv, fmt))).toBe(numbers);
  });
});
