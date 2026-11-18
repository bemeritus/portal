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
  box,
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

/** A rounded-profile body extruded along x: the wall split's housing. */
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
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: w,
    bevelEnabled: false,
    curveSegments: 8,
  });
  // Shape is in (z, y); extrude runs along +z: turn so the extrusion is x.
  geo.rotateY(Math.PI / 2);
  geo.translate(-w / 2, 0, 0);
  const m = new THREE.Mesh(geo, ctx.lib.role(role));
  m.userData.role = role;
  m.castShadow = ctx.mode === "realistic";
  return m;
}

function louvre(
  ctx: BuildContext,
  w: number,
  y: number,
  z: number,
  angle: number,
): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, 8, 50),
    ctx.lib.role("louvre"),
  );
  m.position.set(0, y, z);
  m.rotation.x = angle;
  m.userData.role = "louvre";
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
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars - 0.5;
    const bar =
      axis === "x"
        ? box(ctx, "louvre", w, 6, 8, 0, y, z + t * d)
        : box(ctx, "louvre", 8, 6, d, t * w, y, z);
    g.add(bar);
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
  const bodyRole = precision ? "coolingPrecision" : "cooling";
  switch (props.subtype) {
    case "split_wall": {
      g.add(roundedBody(ctx, bodyRole, w, h, d, Math.min(h, d) * 0.35));
      // Front panel, lower louvre angled down (supply), top grille (return),
      // display window.
      g.add(box(ctx, "louvre", w * 0.96, h * 0.55, 6, 0, h * 0.35, -d / 2 - 1));
      g.add(louvre(ctx, w * 0.8, h * 0.12, -d / 2 + 20, -0.5));
      grille(ctx, g, w * 0.85, d * 0.6, h, 0, 6);
      const disp = box(
        ctx,
        "display",
        w * 0.08,
        h * 0.06,
        4,
        w * 0.36,
        h * 0.6,
        -d / 2 - 4,
      );
      g.add(disp);
      break;
    }
    case "split_cassette": {
      // Ceiling body above, a larger square panel below with four louvres
      // round a central return grille.
      g.add(box(ctx, bodyRole, w * 0.85, h - 30, d * 0.85, 0, 30, 0));
      g.add(box(ctx, "louvre", w, 30, d, 0, 0, 0));
      grille(ctx, g, w * 0.45, d * 0.45, -4, 0, 8);
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
      g.add(roundedBody(ctx, bodyRole, w, h, d, Math.min(h, d) * 0.25));
      g.add(louvre(ctx, w * 0.8, h * 0.5, -d / 2 + 15, -0.2));
      grille(ctx, g, w * 0.8, d * 0.4, -2, d * 0.2, 6);
      break;
    }
    case "ducted": {
      // Box, supply flange at the front, return flange at the rear, hanger
      // brackets, condensate outlet.
      g.add(box(ctx, bodyRole, w, h, d, 0, 0, 0));
      g.add(box(ctx, "rail", w * 0.75, h * 0.6, 40, 0, h * 0.2, -d / 2 - 20));
      g.add(box(ctx, "rail", w * 0.8, h * 0.7, 30, 0, h * 0.15, d / 2 + 15));
      grille(ctx, g, w * 0.7, h * 0.5, h * 0.5, -d / 2 - 42, 1);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          g.add(
            box(
              ctx,
              "rail",
              30,
              60,
              60,
              sx * (w / 2 + 15),
              h - 60,
              sz * d * 0.3,
            ),
          );
          // Threaded rods up to the ceiling (photos 02, 06).
          if (ctx.ceilingAbove > 0)
            g.add(
              box(
                ctx,
                "rod",
                10,
                ctx.ceilingAbove + 60,
                10,
                sx * (w / 2 + 15),
                h - 60,
                sz * d * 0.3,
              ),
            );
        }
      const drain = new THREE.Mesh(
        new THREE.CylinderGeometry(12, 12, 60, 12),
        ctx.lib.role("rail"),
      );
      drain.rotation.x = Math.PI / 2;
      drain.position.set(w / 2 - 60, h * 0.25, d / 2 + 30);
      drain.userData.role = "rail";
      g.add(drain);
      break;
    }
    case "in_row": {
      // Rack-height cabinet of its width, perforated front (supply) and rear
      // (return), fan modules behind the front, casters.
      g.add(box(ctx, bodyRole, w, h - 60, d - 20, 0, 60, 0));
      const perf = (z: number) => {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(w - 40, h - 200),
          ctx.lib.role("perforated"),
        );
        m.position.set(0, (h - 200) / 2 + 120, z);
        if (z < 0) m.rotation.y = Math.PI;
        m.userData.role = "perforated";
        g.add(m);
      };
      perf(-d / 2 - 2);
      perf(d / 2 + 2);
      const fans = Math.max(2, Math.round((h - 400) / 420));
      for (let i = 0; i < fans; i++) {
        const fan = new THREE.Mesh(
          new THREE.CylinderGeometry(w * 0.32, w * 0.32, 30, 24),
          ctx.lib.role("rail"),
        );
        fan.rotation.x = Math.PI / 2;
        fan.position.set(0, 300 + (i + 0.5) * ((h - 500) / fans), -d / 2 + 40);
        fan.userData.role = "rail";
        g.add(fan);
      }
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const c = new THREE.Mesh(
            new THREE.CylinderGeometry(25, 25, 30, 12),
            ctx.lib.role("rackFrame"),
          );
          c.rotation.z = Math.PI / 2;
          c.position.set(sx * (w / 2 - 50), 25, sz * (d / 2 - 80));
          c.userData.role = "rackFrame";
          g.add(c);
        }
      break;
    }
    case "precision_perimeter": {
      g.add(box(ctx, bodyRole, w, h, d, 0, 0, 0));
      // Service panels: vertical seams on the front.
      for (const f of [1 / 3, 2 / 3])
        g.add(box(ctx, "rail", 6, h - 120, 4, -w / 2 + w * f, 60, -d / 2 - 2));
      g.add(box(ctx, "display", 120, 70, 4, w / 2 - 120, h - 300, -d / 2 - 3));
      if (discharge === "downflow") {
        g.add(box(ctx, "louvre", w * 0.8, 10, d * 0.7, 0, -12, 0));
        grille(ctx, g, w * 0.8, d * 0.7, h, 0, 8);
      } else {
        grille(ctx, g, w * 0.8, d * 0.7, h, 0, 8);
        grille(ctx, g, w * 0.8, 6, h * 0.4, -d / 2 - 6, 1);
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
