/**
 * Cooling units as parametric templates (SPEC §11.3): every subtype is built
 * from the item's exact dimensions in mm, so any catalog item — including
 * ones added later — looks right without a model file. The same templates
 * draw the room and the catalog's 3D cards.
 *
 * Supply and return openings are part of the template ([`openings`]), so a
 * preview can show airflow arrows from the same geometry the airflow model
 * will use later.
 */

import * as THREE from "three";

import type {
  CatalogItem,
  CoolingProps,
  CoolingSubtype,
  DcObject,
  Discharge,
} from "../../types";
import {
  display,
  fan,
  perforatedFace,
  plinth,
  rbox,
  seam,
  topVents,
} from "./parts";
import {
  box,
  surface,
  type BuildContext,
  type Built,
  type ObjectRenderer,
} from "./types";

export interface Opening {
  role: "supply" | "return";
  /** Centre, local mm. */
  at: THREE.Vector3;
  /** Direction the air moves through it (out for supply, in for return). */
  dir: THREE.Vector3;
  /** Size across the flow, mm. */
  size: [number, number];
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The usual condensate outlet of a comfort indoor unit, outer diameter. */
export const CONDENSATE_OD_MM = 16;

/**
 * The subtype's default openings (used when the catalog lists none) — wall
 * split: return over the top, supply from the lower front louvre angled
 * down; ducted: supply at the front flange, return at the rear; and so on.
 * The local front faces −z.
 */
export function openings(
  subtype: CoolingSubtype,
  dims: [number, number, number],
  discharge: Discharge | null,
): Opening[] {
  const [w, d, h] = dims;
  switch (subtype) {
    case "split_wall":
      return [
        {
          role: "return",
          at: V(0, h, 0),
          dir: V(0, -1, 0),
          size: [w * 0.85, d * 0.6],
        },
        {
          role: "supply",
          at: V(0, h * 0.12, -d / 2),
          dir: V(0, -0.55, -1).normalize(),
          size: [w * 0.8, h * 0.18],
        },
      ];
    case "split_cassette":
      return [
        {
          role: "return",
          at: V(0, 0, 0),
          dir: V(0, 1, 0),
          size: [w * 0.45, d * 0.45],
        },
        {
          role: "supply",
          at: V(0, 0, -d * 0.36),
          dir: V(0, -0.6, -1).normalize(),
          size: [w * 0.5, 60],
        },
        {
          role: "supply",
          at: V(0, 0, d * 0.36),
          dir: V(0, -0.6, 1).normalize(),
          size: [w * 0.5, 60],
        },
        {
          role: "supply",
          at: V(-w * 0.36, 0, 0),
          dir: V(-1, -0.6, 0).normalize(),
          size: [60, d * 0.5],
        },
        {
          role: "supply",
          at: V(w * 0.36, 0, 0),
          dir: V(1, -0.6, 0).normalize(),
          size: [60, d * 0.5],
        },
      ];
    case "split_floor_ceiling":
      return [
        {
          role: "return",
          at: V(0, 0, d * 0.2),
          dir: V(0, 1, 0),
          size: [w * 0.8, d * 0.4],
        },
        {
          role: "supply",
          at: V(0, h * 0.5, -d / 2),
          dir: V(0, -0.2, -1).normalize(),
          size: [w * 0.8, h * 0.3],
        },
      ];
    case "ducted":
      return [
        {
          role: "supply",
          at: V(0, h / 2, -d / 2),
          dir: V(0, 0, -1),
          size: [w * 0.75, h * 0.6],
        },
        {
          role: "return",
          at: V(0, h / 2, d / 2),
          dir: V(0, 0, -1),
          size: [w * 0.8, h * 0.7],
        },
      ];
    case "in_row":
      // Takes hot air from the rear, blows cold air out of the front.
      return [
        {
          role: "return",
          at: V(0, h * 0.5, d / 2),
          dir: V(0, 0, -1),
          size: [w * 0.8, h * 0.8],
        },
        {
          role: "supply",
          at: V(0, h * 0.5, -d / 2),
          dir: V(0, 0, -1),
          size: [w * 0.8, h * 0.8],
        },
      ];
    case "precision_perimeter":
      return discharge === "downflow"
        ? [
            {
              role: "return",
              at: V(0, h, 0),
              dir: V(0, -1, 0),
              size: [w * 0.8, d * 0.7],
            },
            {
              role: "supply",
              at: V(0, 0, 0),
              dir: V(0, -1, 0),
              size: [w * 0.8, d * 0.7],
            },
          ]
        : [
            {
              role: "return",
              at: V(0, h * 0.4, -d / 2),
              dir: V(0, 0, 1),
              size: [w * 0.8, h * 0.5],
            },
            {
              role: "supply",
              at: V(0, h, 0),
              dir: V(0, 1, 0),
              size: [w * 0.8, d * 0.7],
            },
          ];
  }
}

/**
 * A rounded-profile body extruded along x: the wall split's housing, with a
 * small bevel so its edges catch the light.
 */
function roundedBody(
  ctx: BuildContext,
  role: string,
  w: number,
  h: number,
  d: number,
  r: number,
): THREE.Mesh {
  const s = new THREE.Shape();
  const hz = d / 2;
  s.moveTo(-hz + r, 0);
  s.lineTo(hz, 0);
  s.lineTo(hz, h);
  s.lineTo(-hz + r, h);
  s.quadraticCurveTo(-hz, h, -hz, h - r);
  s.lineTo(-hz, r);
  s.quadraticCurveTo(-hz, 0, -hz + r, 0);
  const bevel = ctx.detail > 0 ? 6 : 0;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: w - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 3,
    curveSegments: 10,
  });
  // Shape is in (z, y); extrude runs along +z: turn so the extrusion is x.
  geo.rotateY(Math.PI / 2);
  geo.translate(-w / 2 + bevel, 0, 0);
  const m = new THREE.Mesh(geo, ctx.lib.role(role));
  m.userData.role = role;
  m.castShadow = ctx.mode === "realistic";
  m.receiveShadow = ctx.mode === "realistic";
  return m;
}

function louvre(
  ctx: BuildContext,
  w: number,
  y: number,
  z: number,
  angle: number,
  role = "louvre",
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 8, 50), ctx.lib.role(role));
  m.position.set(0, y, z);
  m.rotation.x = angle;
  m.userData.role = role;
  m.castShadow = ctx.mode === "realistic";
  return m;
}

function grille(
  ctx: BuildContext,
  g: THREE.Group,
  w: number,
  d: number,
  y: number,
  z: number,
  bars: number,
  axis: "x" | "z" = "x",
) {
  // The grille's bars are detail; at the lowest level one dark panel stands in.
  if (ctx.detail === 0) {
    g.add(
      box(
        ctx,
        "opening",
        axis === "x" ? w : 8,
        2,
        axis === "x" ? d : d,
        0,
        y,
        z,
      ),
    );
    return;
  }
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars - 0.5;
    const bar =
      axis === "x"
        ? box(ctx, "louvre", w, 6, 8, 0, y, z + t * d)
        : box(ctx, "louvre", 8, 6, d, t * w, y, z);
    g.add(bar);
  }
}

/**
 * A duct flange on a face: a collar standing out of the casing and the dark
 * opening inside it, with `vanes` louvre blades across (supply) or none.
 */
function flange(
  ctx: BuildContext,
  g: THREE.Group,
  body: string,
  w: number,
  h: number,
  y: number,
  z: number,
  outward: -1 | 1,
  vanes: number,
) {
  const depth = 50;
  const zc = z + (outward * depth) / 2;
  const t = 14;
  for (const [bw, bh, bx, by] of [
    [w, t, 0, y + h - t],
    [w, t, 0, y],
    [t, h, -w / 2 + t / 2, y],
    [t, h, w / 2 - t / 2, y],
  ])
    g.add(rbox(ctx, body, bw, bh, depth, bx, by, zc, 3));
  g.add(
    box(ctx, "opening", w - 2 * t, h - 2 * t, 4, 0, y + t, z + outward * 4),
  );
  if (ctx.detail === 0) return;
  for (let i = 0; i < vanes; i++) {
    const vy = y + t + ((i + 0.5) * (h - 2 * t)) / vanes;
    const vane = louvre(
      ctx,
      w - 2 * t - 4,
      vy,
      z + outward * 22,
      0.55,
      "louvre",
    );
    vane.scale.z = 0.6;
    g.add(vane);
  }
}

/** Build a cooling unit from its subtype; also used by the catalog preview. */
export function buildCooling(
  ctx: BuildContext,
  props: CoolingProps,
  discharge: Discharge | null,
  pickId?: number,
): Built {
  const [w, d, h] = ctx.dims;
  const g = new THREE.Group();
  const pick =
    pickId !== undefined ? { type: "object" as const, id: pickId } : undefined;
  const tagPick = (o: THREE.Object3D) => {
    o.traverse((m) => {
      if (pick && (m as THREE.Mesh).isMesh && !m.userData.pick)
        m.userData.pick = pick;
    });
  };
  const precision =
    props.subtype === "in_row" || props.subtype === "precision_perimeter";
  // The body's colour and surface come from the item (FEEDBACK-4 §2).
  const body = surface(
    precision ? "coolingPrecision" : "cooling",
    props.finish,
  );
  switch (props.subtype) {
    case "split_wall": {
      // A rounded white body, a horizontal louvre at the bottom front
      // (supply, angled down), the intake grille on top and underneath,
      // a display window.
      g.add(roundedBody(ctx, body, w, h, d, Math.min(h, d) * 0.4));
      g.add(louvre(ctx, w * 0.84, h * 0.1, -d / 2 + 18, -0.55, body));
      g.add(box(ctx, "opening", w * 0.86, 14, d * 0.25, 0, 2, -d * 0.18));
      grille(ctx, g, w * 0.85, d * 0.55, h, 0.05 * d, 7);
      display(ctx, g, w * 0.06, h * 0.05, w * 0.33, h * 0.62, -d / 2, -1);
      break;
    }
    case "split_cassette": {
      // A square body in the ceiling, a larger panel below it with four
      // louvres round a central return grille.
      g.add(rbox(ctx, "rim", w * 0.85, h - 30, d * 0.85, 0, 30, 0, 6));
      g.add(rbox(ctx, body, w, 30, d, 0, 0, 0, 10));
      grille(ctx, g, w * 0.42, d * 0.42, -3, 0, 9);
      for (const [x, z, rx, ry] of [
        [0, -d * 0.36, w * 0.5, 0],
        [0, d * 0.36, w * 0.5, 0],
        [-w * 0.36, 0, d * 0.5, Math.PI / 2],
        [w * 0.36, 0, d * 0.5, Math.PI / 2],
      ]) {
        const l = new THREE.Mesh(
          new THREE.BoxGeometry(rx, 6, 60),
          ctx.lib.role("louvre"),
        );
        l.position.set(x, -6, z);
        l.rotation.y = ry;
        l.userData.role = "louvre";
        g.add(l);
      }
      break;
    }
    case "split_floor_ceiling": {
      // A curved low body with a front louvre and a return grille below.
      g.add(roundedBody(ctx, body, w, h, d, Math.min(h, d) * 0.3));
      g.add(louvre(ctx, w * 0.8, h * 0.5, -d / 2 + 15, -0.2, body));
      grille(ctx, g, w * 0.8, d * 0.4, -2, d * 0.2, 6);
      break;
    }
    case "ducted": {
      // A galvanised casing; the supply flange with a louvre at the front,
      // the return flange at the rear; hanger brackets, the condensate
      // outlet and a terminal box on the side.
      g.add(rbox(ctx, body, w, h, d, 0, 0, 0, 5));
      flange(ctx, g, body, w * 0.78, h * 0.62, h * 0.19, -d / 2, -1, 4);
      flange(ctx, g, body, w * 0.82, h * 0.7, h * 0.15, d / 2, 1, 0);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          g.add(
            box(
              ctx,
              "hinge",
              50,
              12,
              70,
              sx * (w / 2 + 25),
              h - 40,
              sz * d * 0.32,
            ),
          );
          // Threaded rods up to the ceiling (photos 02, 06).
          if (ctx.ceilingAbove > 0)
            g.add(
              box(
                ctx,
                "rod",
                10,
                ctx.ceilingAbove + 40,
                10,
                sx * (w / 2 + 30),
                h - 40,
                sz * d * 0.32,
              ),
            );
        }
      // The condensate outlet at its real size: a short stub of the
      // catalog's diameter (16 mm when none is given), not a pipe.
      const od = props.condensate_outlet_mm ?? CONDENSATE_OD_MM;
      const drain = new THREE.Mesh(
        new THREE.CylinderGeometry(od / 2, od / 2, 40, 12),
        ctx.lib.role("caster"),
      );
      drain.rotation.z = Math.PI / 2;
      drain.position.set(w / 2 + 20, Math.max(od, h * 0.15), d / 2 - 60);
      drain.userData.role = "caster";
      g.add(drain);
      // The electrical box: a flat cover on the side, as on the photos.
      g.add(
        rbox(
          ctx,
          body,
          35,
          h * 0.5,
          Math.min(180, d * 0.35),
          -w / 2 - 17,
          h * 0.25,
          d / 2 - Math.min(180, d * 0.35) / 2 - 30,
          3,
        ),
      );
      break;
    }
    case "in_row": {
      // A rack-height cabinet on a plinth with levelling feet: the front
      // door perforated over a stack of fans, a display at the top, the
      // door's hinge line, a vented top, side panel seams; the rear
      // perforated too (return).
      const base = 60;
      plinth(ctx, g, w, d, base);
      // A shell — sides and top over the full depth — round a core set
      // back 90 mm at each end, so the fans have room behind the doors.
      const recess = 90;
      for (const sx of [-1, 1])
        g.add(
          rbox(ctx, body, 24, h - base, d - 20, sx * (w / 2 - 12), base, 0, 4),
        );
      g.add(rbox(ctx, body, w, 30, d - 20, 0, h - 30, 0, 4));
      g.add(box(ctx, body, w - 40, h - base - 30, d - 2 * recess, 0, base, 0));
      for (const sz of [-1, 1])
        g.add(
          box(
            ctx,
            "fanShroud",
            w - 40,
            h - base - 30,
            4,
            0,
            base,
            sz * (d / 2 - recess),
          ),
        );
      const top = h - 340;
      const fanR = Math.min(w * 0.36, 150);
      const cols = w >= 500 ? 2 : 1;
      const perfH = top - (base + 80);
      perforatedFace(
        ctx,
        g,
        body,
        w - 24,
        perfH,
        0,
        base + 80,
        -d / 2 + 10,
        -1,
        (zb) => {
          const rows = Math.max(2, Math.floor(perfH / (fanR * 2.6)));
          for (let i = 0; i < rows; i++)
            for (let j = 0; j < cols; j++)
              fan(
                ctx,
                g,
                fanR,
                cols > 1 ? (j - 0.5) * (w * 0.46) : 0,
                base + 80 + ((i + 0.5) * perfH) / rows,
                zb,
              );
        },
      );
      perforatedFace(ctx, g, body, w - 24, perfH, 0, base + 80, d / 2 - 10, 1);
      display(ctx, g, Math.min(140, w - 80), 80, 0, h - 230, -d / 2 + 10, -1);
      // The door's hinge line, down its left edge as seen from the front.
      g.add(
        box(
          ctx,
          "hinge",
          6,
          h - base - 40,
          6,
          w / 2 - 8,
          base + 20,
          -d / 2 + 8,
        ),
      );
      topVents(ctx, g, w, d, h + 1, 8);
      for (const f of [1 / 3, 2 / 3])
        for (const sx of [-1, 1])
          seam(
            ctx,
            g,
            "rim",
            3,
            h - base - 60,
            sx * (w / 2 + 1),
            base + 30,
            -d / 2 + d * f,
          );
      break;
    }
    case "precision_perimeter": {
      // A floor cabinet on a plinth: front service panels with seams and
      // handles, a display, a top grille (upflow) or a base louvre
      // (downflow).
      const base = 100;
      plinth(ctx, g, w, d, base);
      g.add(rbox(ctx, body, w, h - base, d, 0, base, 0, 6));
      const panels = w > 1200 ? 3 : 2;
      const pw = w / panels;
      for (let i = 0; i < panels; i++) {
        const px = -w / 2 + pw * (i + 0.5);
        g.add(
          rbox(
            ctx,
            body,
            pw - 14,
            h - base - 60,
            10,
            px,
            base + 30,
            -d / 2 - 4,
            3,
          ),
        );
        if (i > 0)
          seam(
            ctx,
            g,
            "vent",
            4,
            h - base - 60,
            -w / 2 + pw * i,
            base + 30,
            -d / 2 - 10,
          );
        // A handle by each panel's opening edge.
        g.add(
          rbox(
            ctx,
            "foot",
            16,
            180,
            22,
            px + (i % 2 ? -1 : 1) * (pw / 2 - 50),
            base + (h - base) * 0.5,
            -d / 2 - 14,
            4,
          ),
        );
      }
      display(ctx, g, 160, 100, w / 2 - pw / 2, h - 420, -d / 2 - 8, -1);
      if (discharge === "downflow") {
        g.add(box(ctx, "opening", w * 0.8, 6, d * 0.7, 0, h, 0));
        grille(ctx, g, w * 0.8, 6, base * 0.5, -d / 2 - 10, 1);
      } else {
        grille(ctx, g, w * 0.84, d * 0.76, h + 1, 0, 14);
      }
      break;
    }
  }
  tagPick(g);
  const lift = props.subtype === "split_cassette" ? 0 : h;
  return {
    group: g,
    doors: [],
    labelAt: new THREE.Vector3(0, lift + 160, 0),
    leds: [],
  };
}

export const coolingRenderer: ObjectRenderer = {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built {
    const props = item.props as CoolingProps;
    return buildCooling(
      ctx,
      props,
      obj.instance.discharge ?? props.discharge_options[0] ?? null,
      obj.id,
    );
  },
};
