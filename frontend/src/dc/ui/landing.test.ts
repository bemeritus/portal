import { describe, expect, it } from "vitest";

import { planByDefault } from "./landing";

const q = (s: string) => new URLSearchParams(s);

describe("planByDefault", () => {
  it("opens Чертёж on the plan when the link says nothing", () => {
    expect(planByDefault("drawing", q(""), "")).toBe(true);
    // Mode, highlight and tool are not a view.
    expect(planByDefault("drawing", q("mode=fill&owner=X&tool=ruler"), "")).toBe(
      true,
    );
    expect(planByDefault("drawing", q(""), "#")).toBe(true);
  });

  it("leaves the other themes on 3D", () => {
    expect(planByDefault("studio", q(""), "")).toBe(false);
    expect(planByDefault("light", q(""), "")).toBe(false);
  });

  it("lets an explicit link win", () => {
    expect(planByDefault("drawing", q("view=3d"), "")).toBe(false);
    expect(planByDefault("drawing", q("view=plan"), "")).toBe(false);
    expect(planByDefault("drawing", q("cam=1,2,3,4,5,6,50,0"), "")).toBe(false);
    expect(planByDefault("drawing", q(""), "#device-7")).toBe(false);
  });
});
