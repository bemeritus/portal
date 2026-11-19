/**
 * FEEDBACK-5 §5: a ducted unit's condensate outlet is drawn at its real size
 * — the catalog's diameter, 16 mm when none is given — not as a pipe as
 * thick as the unit is tall.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { CoolingProps } from "../../types";
import type { MaterialLibrary } from "../materials";
import { buildCooling, CONDENSATE_OD_MM } from "./cooling";

const lib = {
  theme: {},
  role: () => new THREE.MeshBasicMaterial(),
  line: () => new THREE.LineBasicMaterial(),
  perforation: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialLibrary;

const ducted = (extra: Partial<CoolingProps> = {}) =>
  ({
    subtype: "ducted",
    discharge_options: [],
    openings: [],
    ...extra,
  }) as unknown as CoolingProps;

/** Outer diameter of the condensate outlet as built, mm. */
function outletOd(props: CoolingProps): number {
  const g = buildCooling(
    {
      lib,
      mode: "realistic",
      devices: [],
      cells: [],
      blocked: [],
      dims: [700, 450, 200],
      ceilingAbove: 0,
      detail: 2,
      pxPerMm: null,
    },
    props,
    null,
  ).group;
  const pipes = g.children.filter(
    (c) =>
      (c as THREE.Mesh).geometry?.type === "CylinderGeometry" &&
      c.userData.role === "caster",
  ) as THREE.Mesh[];
  expect(pipes).toHaveLength(1);
  const p = (pipes[0].geometry as THREE.CylinderGeometry).parameters;
  return p.radiusTop * 2;
}

describe("the condensate outlet", () => {
  it("is 16 mm across by default", () => {
    expect(CONDENSATE_OD_MM).toBe(16);
    expect(outletOd(ducted())).toBe(16);
  });

  it("takes its diameter from the catalog", () => {
    expect(outletOd(ducted({ condensate_outlet_mm: 20 }))).toBe(20);
  });
});
