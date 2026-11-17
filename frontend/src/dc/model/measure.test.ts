import { describe, expect, it } from "vitest";

import { difference, disagrees } from "./measure";

describe("tape vs model", () => {
  it("marks only differences above 5 mm, as the server does", () => {
    expect(disagrees({ value: 610, model: 595 })).toBe(true);
    expect(disagrees({ value: 635, model: 630 })).toBe(false);
    expect(disagrees({ value: 1498, min: 1495, max: 1500, model: 1510 })).toBe(true);
    expect(disagrees({ value: 603, min: 600, max: 605, model: 600 })).toBe(false);
    expect(disagrees({ value: 600 })).toBe(false);
  });

  it("states the difference against the nearer reading", () => {
    expect(difference({ value: 610, model: 595 })).toBe(-15);
    expect(difference({ value: 555, model: 585 })).toBe(30);
    expect(difference({ value: 1498, min: 1495, max: 1500, model: 1510 })).toBe(10);
    expect(difference({ value: 603, min: 600, max: 605, model: 600 })).toBe(0);
  });
});
