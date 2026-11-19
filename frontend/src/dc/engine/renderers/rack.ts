/**
 * Racks: frame, rails with a numbered U strip, devices by unit and face, and
 * doors (glass: one leaf; perforated: two; solid: one; none). A rack whose
 * contents were never recorded shows a hatched panel instead of equipment —
 * never decorative devices.
 */

import * as THREE from "three";

import type {
  CatalogItem,
  DcObject,
  Device,
  DeviceStatus,
  DoorType,
  RackProps,
} from "../../types";
import { freeRuns, TYPICAL_DEPTH } from "../../model/devices";
import { U_MM } from "../../model/geometry";
import { perfPitch, rbox, seam } from "./parts";
import {
  box,
  surface,
  withBase,
  type BuildContext,
  type Built,
  type DoorLeaf,
  type ObjectRenderer,
} from "./types";

/** Front rails set back from the front edge (prototype: 9 cm). */
const RAIL_SETBACK = 90;
/** 19-inch rack opening. */
const MOUNT_W = 482.6;

const LED: Record<DeviceStatus, { color: string; blink: boolean }> = {
  active: { color: "#3dff78", blink: true },
  reserved: { color: "#4db8ff", blink: false },
  planned: { color: "#ffb53d", blink: false },
  decommissioning: { color: "#ff4d4d", blink: true },
};

function doorRole(t: DoorType): string {
  return t === "glass"
    ? "glass"
    : t === "perforated"
      ? "perforated"
      : "solidDoor";
}

/** Door leaves on one face: z is the face plane, `outward` its normal sign. */
function doors(
  ctx: BuildContext,
  group: THREE.Group,
  frame: string,
  type: DoorType | null,
  w: number,
  h: number,
  z: number,
  outward: number,
): DoorLeaf[] {
  if (!type || type === "none") return [];
  const fw = w - 30,
    fh = h - 80;
  const leaves: [number, number, number][] =
    type === "perforated"
      ? [
          [-fw / 2, 1, fw / 2],
          [fw / 2, -1, fw / 2],
        ]
      : [[-fw / 2, 1, fw]];
  return leaves.map(([hx, dir, lw]) => {
    const pivot = new THREE.Group();
    pivot.position.set(hx, 0, z + outward * 5);
    // A leaf on the rear face swings the other way.
    pivot.userData.outward = outward;
    group.add(pivot);
    if (type === "perforated") {
      // A frame in the rack's finish round a honeycomb sheet; through it the
      // rails and the equipment show (FEEDBACK-4 §2).
      const bar = 40;
      for (const [bw, bh, bx, by] of [
        [lw - 6, bar, (dir * lw) / 2, 40 + fh - bar],
        [lw - 6, bar, (dir * lw) / 2, 40],
        [bar, fh - 2 * bar, dir * (bar / 2 + 3), 40 + bar],
        [bar, fh - 2 * bar, dir * (lw - 3 - bar / 2), 40 + bar],
      ]) {
        const f = rbox(ctx, withBase(frame, "rim"), bw, bh, 10, bx, by, 0, 3);
        f.userData.door = true;
        pivot.add(f);
      }
      const sw = lw - 6 - 2 * bar,
        sh = fh - 2 * bar;
      const sheet = new THREE.Mesh(
        new THREE.PlaneGeometry(sw, sh),
        ctx.lib.perforation(frame, sw, sh, perfPitch(ctx.pxPerMm)),
      );
      sheet.position.set((dir * lw) / 2, 40 + fh / 2, 0);
      if (outward < 0) sheet.rotation.y = Math.PI;
      sheet.userData.role = "perforated";
      sheet.userData.fixedMaterial = true;
      sheet.userData.noMerge = true;
      sheet.userData.door = true;
      pivot.add(sheet);
    } else {
      const leaf = box(
        ctx,
        doorRole(type),
        lw - 6,
        fh,
        6,
        (dir * lw) / 2,
        40,
        0,
      );
      leaf.userData.door = true;
      pivot.add(leaf);
    }
    if (type === "glass") {
      // A dark frame round the glass.
      for (const [bw, bh, bx, by] of [
        [lw, 26, (dir * lw) / 2, fh + 14],
        [lw, 26, (dir * lw) / 2, 40],
        [26, fh, dir * 13, 40],
        [26, fh, dir * (lw - 13), 40],
      ]) {
        const f = box(ctx, frame, bw, bh, 9, bx, by, 0);
        f.userData.door = true;
        pivot.add(f);
      }
    }
    const handle = box(
      ctx,
      "rail",
      20,
      150,
      22,
      dir * (lw - 35),
      950,
      -outward * 13,
    );
    handle.userData.door = true;
    pivot.add(handle);
    return { pivot, dir: dir * outward };
  });
}

export const rackRenderer: ObjectRenderer = {
  build(obj: DcObject, item: CatalogItem, ctx: BuildContext): Built {
    const p = item.props as RackProps;
    const [w, d, h] = ctx.dims;
    const g = new THREE.Group();
    const pick = { type: "object" as const, id: obj.id };
    const t = 15;
    // The body's colour and surface come from the item (FEEDBACK-4 §2).
    const frame = surface("rackFrame", p.finish);
    const cap = surface("rackCap", p.finish);
    // Frame: side panels (not on an open frame), posts, top cap, plinth.
    if (!obj.instance.open_frame) {
      g.add(box(ctx, frame, t, h, d, -w / 2 + t / 2, 0, 0, pick));
      g.add(box(ctx, frame, t, h, d, w / 2 - t / 2, 0, 0, pick));
      // Each side is two panels: a seam half way along.
      for (const sx of [-1, 1])
        seam(ctx, g, "vent", 3, h - 120, sx * (w / 2 + 1), 60, 0);
    } else {
      // Side rails top and bottom tie the posts of an open frame.
      for (const sx of [-1, 1])
        for (const y of [60, h - 80])
          g.add(box(ctx, frame, 30, 30, d, sx * (w / 2 - 25), y, 0, pick));
    }
    g.add(box(ctx, cap, w + 6, 15, d + 6, 0, h - 15, 0, pick));
    g.add(box(ctx, cap, w, 50, d, 0, 0, 0, pick));
    // The top cable entry: a brushed slot towards the rear. Realistic only:
    // flat, from above, it read as a stray white plate (FEEDBACK-6 §3).
    if (ctx.mode === "realistic")
      g.add(box(ctx, "opening", w * 0.5, 2, 90, 0, h, d / 2 - 160));
    if (ctx.detail > 0)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const foot = new THREE.Mesh(
            new THREE.CylinderGeometry(20, 24, 10, 16),
            ctx.lib.role("foot"),
          );
          foot.position.set(sx * (w / 2 - 45), 5, sz * (d / 2 - 45));
          foot.userData.role = "foot";
          g.add(foot);
        }
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        g.add(
          box(
            ctx,
            frame,
            30,
            h,
            30,
            sx * (w / 2 - 25),
            0,
            sz * (d / 2 - 25),
            pick,
          ),
        );

    const units = p.units;
    const y1 = p.u1_height_mm;
    const zf = -d / 2 + RAIL_SETBACK,
      zr = d / 2 - RAIL_SETBACK;
    const fw = Math.min(MOUNT_W - 10, w - 90);
    for (const sx of [-1, 1]) {
      g.add(
        box(ctx, "rail", 34, units * U_MM, 12, sx * (fw / 2 + 21), y1, zf + 6),
      );
      g.add(
        box(ctx, "rail", 34, units * U_MM, 12, sx * (fw / 2 + 21), y1, zr - 6),
      );
    }
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(26, units * U_MM),
      ctx.lib.uStrip(units),
    );
    strip.rotation.y = Math.PI;
    strip.position.set(-(fw / 2 + 21), y1 + (units * U_MM) / 2, zf - 1);
    strip.userData.role = "ustrip";
    strip.userData.fixedMaterial = true;
    g.add(strip);

    const leds: Built["leds"] = [];
    if (!obj.contents_known) {
      // Not recorded: say so, show nothing pretending to be equipment.
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(fw, units * U_MM),
        ctx.lib.unknown(),
      );
      m.rotation.y = Math.PI;
      m.position.set(0, y1 + (units * U_MM) / 2, zf + 30);
      m.userData.role = "unknownContents";
      m.userData.fixedMaterial = true;
      m.userData.pick = pick;
      g.add(m);
    }
    const inner = d - 2 * RAIL_SETBACK;
    for (const dv of ctx.devices)
      addDevice(ctx, g, dv, fw, y1, zf, zr, inner, leds);
    // A recorded rack's free units carry blanking panels, as in the room —
    // an empty rack shows its rails and the panels (FEEDBACK-6 §3).
    if (obj.contents_known && ctx.mode === "realistic")
      for (const r of freeRuns(ctx.devices, units, "front")) {
        const ph = (r.to - r.from + 1) * U_MM - 2;
        const panel = box(
          ctx,
          "blankPanel",
          fw,
          ph,
          3,
          0,
          y1 + (r.from - 1) * U_MM + 1,
          zf - 2,
        );
        panel.userData.blank = true;
        g.add(panel);
      }

    const rack = item.kind === "rack" ? p : null;
    const front = obj.instance.door_front ?? rack?.door_front ?? null;
    const rear = obj.instance.door_rear ?? rack?.door_rear ?? null;
    const leaves = [
      ...doors(ctx, g, frame, front, w, h, -d / 2, -1),
      ...doors(ctx, g, frame, rear, w, h, d / 2, 1),
    ];
    return {
      group: g,
      doors: leaves,
      labelAt: new THREE.Vector3(0, h + 180, 0),
      leds,
    };
  },
};

function addDevice(
  ctx: BuildContext,
  g: THREE.Group,
  dv: Device,
  fw: number,
  y1: number,
  zf: number,
  zr: number,
  inner: number,
  leds: Built["leds"],
) {
  const depth =
    dv.face === "both"
      ? inner
      : Math.max(15, Math.min(dv.depth_mm ?? TYPICAL_DEPTH[dv.kind], inner));
  const bh = dv.u_height * U_MM - 3;
  const yb = y1 + (dv.u_bottom - 1) * U_MM + 1.5;
  const front = ctx.lib.deviceFront(dv.kind, dv.u_height, dv.name);
  const side = ctx.lib.role("deviceSide");
  const rearMounted = dv.face === "rear";
  // BoxGeometry faces: +x, −x, +y, −y, +z, −z. The panel faces out of its
  // face; a deep device (a server, storage, a UPS) shows a panel at its back
  // too, so a rack seen from behind shows its contents (FEEDBACK-6 §3).
  const back = depth >= inner * 0.6 ? front : side;
  const mats = [
    side,
    side,
    side,
    side,
    rearMounted ? front : back,
    rearMounted ? back : front,
  ];
  const m = new THREE.Mesh(new THREE.BoxGeometry(fw, bh, depth), mats);
  const zc = rearMounted ? zr - depth / 2 : zf + depth / 2;
  m.position.set(0, yb + bh / 2, zc);
  m.userData.role = `device:${dv.kind}`;
  m.userData.device = {
    kind: dv.kind,
    units: dv.u_height,
    name: dv.name,
    rear: rearMounted,
    owner: dv.owner,
  };
  m.userData.pick = { type: "device", id: dv.id, rackId: dv.rack_id };
  m.castShadow = ctx.mode === "realistic";
  g.add(m);
  // One status LED per device, at the top right of its panel.
  const led = LED[dv.status];
  const zLed = rearMounted ? zr + 1 : zf - 1;
  leds.push({
    pos: new THREE.Vector3(
      rearMounted ? -fw / 2 + 30 : fw / 2 - 30,
      yb + bh - 12,
      zLed,
    ),
    ...led,
  });
}
