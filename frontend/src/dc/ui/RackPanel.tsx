/**
 * The rack elevation editor (SPEC §11.1): front and rear, one row per unit.
 * Click a free unit to add a device there; drag a device to move it within
 * the rack or onto another rack's chip; drag its top edge to change its
 * height; or edit the whole face as text (`10-11 DELL R740 | 450 Вт | клиент X`).
 * Every edit is checked against the units as you go (the server and the
 * database check again).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SelRef } from "../engine/DcEngine";
import { useFmt } from "../settings";
import {
  devicesToText,
  facesConflict,
  parseDevices,
  rackStats,
  unitsFree,
} from "../model/devices";
import { DEVICE_COLOR } from "../engine/materials";
import type {
  CatalogItem,
  DcObject,
  Device,
  DeviceFields,
  Face,
  Op,
  RackProps,
  RoomData,
} from "../types";
import { DeviceForm } from "./DeviceForm";
import { objectFields } from "./DcRoomPage";
import type { Prefill } from "./SelectionPanel";

const ROW = 15;

interface Props {
  obj: DcObject;
  item: CatalogItem;
  data: RoomData;
  selection: SelRef;
  canEdit: boolean;
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onSelect: (ref: SelRef, fly?: boolean) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
}

/** Ops for a device edit, marking the rack's contents recorded if they were not. */
export function withRecorded(obj: DcObject, ops: Op[]): Op[] {
  return obj.contents_known
    ? ops
    : [
        {
          op: "object_update",
          id: obj.id,
          object: { ...objectFields(obj), contents_known: true },
        },
        ...ops,
      ];
}

export function RackPanel({
  obj,
  item,
  data,
  selection,
  canEdit,
  prefill,
  onPrefillUsed,
  onSelect,
  run,
}: Props) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const p = item.props as RackProps;
  const units = p.units;
  const devices = useMemo(
    () => data.devices.filter((d) => d.rack_id === obj.id),
    [data.devices, obj.id],
  );
  const [face, setFace] = useState<"front" | "rear">("front");
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState<DeviceFields | null>(null);
  const selectedDevice =
    selection?.type === "device"
      ? (devices.find((d) => d.id === selection.id) ?? null)
      : null;
  const stats = rackStats(devices, units, obj.contents_known);

  // A device picked in the 3D view shows on its own face.
  useEffect(() => {
    if (selectedDevice && selectedDevice.face !== "both")
      setFace(selectedDevice.face);
  }, [selectedDevice]);

  // The capacity finder's pick pre-fills the add form.
  useEffect(() => {
    if (prefill && prefill.rackId === obj.id) {
      setDraft(
        blank(obj.id, prefill.u, prefill.height, prefill.face, prefill.power),
      );
      if (prefill.face !== "both") setFace(prefill.face);
      onPrefillUsed();
    }
  }, [prefill, obj.id, onPrefillUsed]);

  const visible = devices.filter((d) => facesConflict(d.face, face));
  const otherRacks = data.objects.filter(
    (o) =>
      o.id !== obj.id &&
      data.catalog.find((c) => c.id === o.catalog_id)?.kind === "rack",
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          {stats.known ? (
            <span>
              {t("dc.rack.unitsUsed", { used: stats.used, total: units })} ·{" "}
              {stats.powerW ? fmt.w(stats.powerW) : fmt.w(0)}
              {stats.unknownPower > 0 && (
                <span className="text-tag-3">
                  {" "}
                  ·{" "}
                  {t("dc.rack.unknownPowerCount", {
                    count: stats.unknownPower,
                  })}
                </span>
              )}
            </span>
          ) : (
            <span className="font-medium text-tag-3">
              {t("dc.rack.notRecordedLong")}
            </span>
          )}
        </div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["front", "rear"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={cn(
                "rounded px-2 py-0.5",
                face === f
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent",
              )}
              onClick={() => setFace(f)}
            >
              {t(`dc.face.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {textMode ? (
        <TextEditor
          obj={obj}
          units={units}
          face={face}
          devices={devices}
          run={run}
          onDone={() => setTextMode(false)}
        />
      ) : (
        <Elevation
          units={units}
          face={face}
          devices={visible}
          allDevices={devices}
          selectedId={selectedDevice?.id ?? null}
          draft={draft && draft.rack_id === obj.id ? draft : null}
          canEdit={canEdit}
          otherRacks={otherRacks}
          onPickFree={(u) =>
            canEdit && setDraft(blank(obj.id, u, 1, face, null))
          }
          onPickDevice={(d) => {
            setDraft(null);
            onSelect({ type: "device", id: d.id, rackId: d.rack_id }, false);
          }}
          onMove={(d, u, h, rackId) => {
            const target = data.objects.find((o) => o.id === rackId)!;
            const next = {
              ...stripId(d),
              rack_id: rackId,
              u_bottom: u,
              u_height: h,
            };
            void run(
              withRecorded(target, [
                { op: "device_update", id: d.id, device: next },
              ]),
              t("dc.change.deviceMove", { name: d.name }),
            );
          }}
        />
      )}

      {canEdit && !textMode && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDraft(
                blank(
                  obj.id,
                  firstFree(devices, units, face) ?? 1,
                  1,
                  face,
                  null,
                ),
              )
            }
          >
            {t("dc.device.add")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTextMode(true)}>
            {t("dc.text.button")}
          </Button>
        </div>
      )}

      {draft && draft.rack_id === obj.id && (
        <DeviceForm
          key={`new-${draft.u_bottom}-${draft.face}`}
          title={t("dc.device.newTitle")}
          initial={draft}
          rack={obj}
          units={units}
          devices={devices}
          racks={data.objects.filter(
            (o) =>
              data.catalog.find((c) => c.id === o.catalog_id)?.kind === "rack",
          )}
          canEdit={canEdit}
          onCancel={() => setDraft(null)}
          onSave={async (fields) => {
            const target = data.objects.find((o) => o.id === fields.rack_id)!;
            const ok = await run(
              withRecorded(target, [{ op: "device_create", device: fields }]),
              t("dc.change.deviceAdd", { name: fields.name }),
            );
            if (ok) setDraft(null);
            return ok;
          }}
        />
      )}
      {selectedDevice && !draft && (
        <DeviceForm
          key={`dev-${selectedDevice.id}-${data.room.revision}`}
          title={selectedDevice.name}
          initial={stripId(selectedDevice)}
          deviceId={selectedDevice.id}
          rack={obj}
          units={units}
          devices={devices}
          racks={data.objects.filter(
            (o) =>
              data.catalog.find((c) => c.id === o.catalog_id)?.kind === "rack",
          )}
          canEdit={canEdit}
          onCancel={() => onSelect({ type: "object", id: obj.id }, false)}
          onDelete={async () => {
            const ok = await run(
              [{ op: "device_delete", id: selectedDevice.id }],
              t("dc.change.deviceDelete", { name: selectedDevice.name }),
            );
            if (ok) onSelect({ type: "object", id: obj.id }, false);
          }}
          onSave={async (fields) => {
            const target = data.objects.find((o) => o.id === fields.rack_id)!;
            return run(
              withRecorded(target, [
                { op: "device_update", id: selectedDevice.id, device: fields },
              ]),
              t("dc.change.deviceEdit", { name: fields.name }),
            );
          }}
        />
      )}
    </div>
  );
}

function stripId(d: Device): DeviceFields {
  const { id: _id, ...rest } = d;
  void _id;
  return rest;
}

function blank(
  rackId: number,
  u: number,
  h: number,
  face: Face,
  power: number | null,
): DeviceFields {
  return {
    rack_id: rackId,
    u_bottom: u,
    u_height: h,
    face,
    depth_mm: null,
    kind: "server",
    name: "",
    owner: "",
    serial: "",
    power_w: power,
    power_src: null,
    status: "active",
    note: "",
  };
}

function firstFree(
  devices: Device[],
  units: number,
  face: Face,
): number | null {
  for (let u = 1; u <= units; u++)
    if (unitsFree(devices, units, u, 1, face)) return u;
  return null;
}

interface ElevationProps {
  units: number;
  face: Face;
  devices: Device[];
  allDevices: Device[];
  selectedId: number | null;
  draft: DeviceFields | null;
  canEdit: boolean;
  otherRacks: DcObject[];
  onPickFree: (u: number) => void;
  onPickDevice: (d: Device) => void;
  onMove: (d: Device, u: number, h: number, rackId: number) => void;
}

function Elevation({
  units,
  face,
  devices,
  allDevices,
  selectedId,
  draft,
  canEdit,
  otherRacks,
  onPickFree,
  onPickDevice,
  onMove,
}: ElevationProps) {
  const { t } = useTranslation();
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | {
    d: Device;
    mode: "move" | "resize";
    startY: number;
    u: number;
    h: number;
    overRack: number | null;
  }>(null);
  const H = units * ROW;
  const W = 300;
  const yOf = (u: number) => H - u * ROW;
  const unitAt = (clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return Math.max(
      1,
      Math.min(units, Math.floor((H - (clientY - r.top)) / ROW) + 1),
    );
  };
  const ok = drag
    ? unitsFree(allDevices, units, drag.u, drag.h, drag.d.face, drag.d.id)
    : true;

  return (
    <div>
      <svg
        ref={svg}
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="rounded border bg-muted/30 select-none"
        role="grid"
        aria-label={t("dc.rack.elevation", { face: t(`dc.face.${face}`) })}
        onPointerMove={(e) => {
          if (!drag) return;
          if (drag.mode === "move") {
            const top = unitAt(e.clientY);
            setDrag({
              ...drag,
              u: Math.max(
                1,
                Math.min(
                  units - drag.h + 1,
                  top - drag.h + 1 + Math.floor(drag.h / 2),
                ),
              ),
            });
          } else {
            const top = unitAt(e.clientY);
            setDrag({ ...drag, h: Math.max(1, top - drag.d.u_bottom + 1) });
          }
        }}
        onPointerUp={() => {
          if (!drag) return;
          const d = drag;
          setDrag(null);
          if ((d.u !== d.d.u_bottom || d.h !== d.d.u_height) && ok)
            onMove(d.d, d.u, d.h, d.d.rack_id);
        }}
        onPointerLeave={() => drag?.overRack === null && setDrag(null)}
      >
        {Array.from({ length: units }, (_, i) => {
          const u = i + 1;
          const free = unitsFree(allDevices, units, u, 1, face);
          return (
            <g key={u}>
              <rect
                x={24}
                y={yOf(u)}
                width={W - 28}
                height={ROW}
                className={cn(
                  "stroke-border",
                  free && canEdit
                    ? "cursor-pointer fill-transparent hover:fill-primary/10"
                    : "fill-transparent",
                )}
                strokeWidth={0.5}
                onClick={() => free && onPickFree(u)}
              >
                <title>{free ? t("dc.rack.freeUnit", { u }) : `U${u}`}</title>
              </rect>
              <text
                x={20}
                y={yOf(u) + ROW - 4}
                textAnchor="end"
                className="fill-muted-foreground text-[9px]"
              >
                {u}
              </text>
            </g>
          );
        })}
        {devices.map((d) => {
          const moving = drag?.d.id === d.id;
          const u = moving ? drag!.u : d.u_bottom;
          const h = moving ? drag!.h : d.u_height;
          return (
            <g key={d.id} opacity={moving && !ok ? 0.5 : 1}>
              <rect
                x={26}
                y={yOf(u + h - 1) + 1}
                width={W - 32}
                height={h * ROW - 2}
                rx={2}
                fill={DEVICE_COLOR[d.kind]}
                className={cn(
                  canEdit && "cursor-grab",
                  selectedId === d.id && "stroke-primary",
                  moving && !ok && "stroke-destructive",
                )}
                strokeWidth={selectedId === d.id || moving ? 2 : 0}
                onPointerDown={(e) => {
                  onPickDevice(d);
                  if (!canEdit) return;
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setDrag({
                    d,
                    mode: "move",
                    startY: e.clientY,
                    u: d.u_bottom,
                    h: d.u_height,
                    overRack: null,
                  });
                }}
              />
              <text
                x={34}
                y={yOf(u + h - 1) + Math.min(h * ROW, 30) / 2 + 4}
                className="pointer-events-none fill-white text-[10px]"
              >
                {d.name}
                {d.face === "both" ? ` (${t("dc.face.both")})` : ""}
                {d.power_w === null
                  ? ` · ${t("dc.unknownPowerShort")}`
                  : ` · ${d.power_w} W`}
              </text>
              {canEdit && (
                <rect
                  x={W / 2 - 20}
                  y={yOf(u + h - 1)}
                  width={40}
                  height={4}
                  className="cursor-ns-resize fill-white/60"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    setDrag({
                      d,
                      mode: "resize",
                      startY: e.clientY,
                      u: d.u_bottom,
                      h: d.u_height,
                      overRack: null,
                    });
                  }}
                >
                  <title>{t("dc.device.resize")}</title>
                </rect>
              )}
            </g>
          );
        })}
        {draft && (
          <rect
            x={26}
            y={yOf(draft.u_bottom + draft.u_height - 1) + 1}
            width={W - 32}
            height={draft.u_height * ROW - 2}
            rx={2}
            className="fill-primary/25 stroke-primary"
            strokeDasharray="4 3"
          />
        )}
      </svg>
      {drag?.mode === "move" && otherRacks.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs">
          <span className="text-muted-foreground">
            {t("dc.device.dropOnRack")}
          </span>
          {otherRacks.map((r) => (
            <button
              key={r.id}
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-accent"
              onPointerUp={(e) => {
                e.stopPropagation();
                const d = drag.d;
                setDrag(null);
                onMove(d, d.u_bottom, d.u_height, r.id);
              }}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextEditor({
  obj,
  units,
  face,
  devices,
  run,
  onDone,
}: {
  obj: DcObject;
  units: number;
  face: "front" | "rear";
  devices: Device[];
  run: Props["run"];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const mine = devices.filter((d) => d.face === face);
  const [text, setText] = useState(() => devicesToText(mine));
  const parsed = parseDevices(text, units);
  // Devices on the other face (and full-depth ones) are not in this text but
  // still take units.
  const others = devices.filter((d) => d.face !== face);
  const clashes = parsed.devices.filter(
    (p) => !unitsFree(others, units, p.u_bottom, p.u_height, face),
  );
  const errors = [
    ...parsed.errors.map((e) =>
      t(`dc.text.${e.code}`, {
        line: e.line,
        units: e.units,
        a: e.names?.[0],
        b: e.names?.[1],
      }),
    ),
    ...clashes.map((c) =>
      t("dc.text.otherFace", { line: c.line, name: c.name }),
    ),
  ];

  async function save() {
    // Match lines to devices by bottom unit; what is left over is new or gone.
    const ops: Op[] = [];
    const byU = new Map(mine.map((d) => [d.u_bottom, d]));
    const kept = new Set<number>();
    for (const p of parsed.devices) {
      const d = byU.get(p.u_bottom);
      const fields: DeviceFields = {
        rack_id: obj.id,
        u_bottom: p.u_bottom,
        u_height: p.u_height,
        face,
        depth_mm: d?.depth_mm ?? null,
        kind: p.kind,
        name: p.name,
        owner: p.owner,
        serial: d?.serial ?? "",
        power_w: p.power_w,
        power_src: p.power_w === null ? null : (d?.power_src ?? null),
        status: d?.status ?? "active",
        note: p.note,
      };
      if (d) {
        kept.add(d.id);
        const { id: _id, ...old } = d;
        void _id;
        if (JSON.stringify(old) !== JSON.stringify(fields))
          ops.push({ op: "device_update", id: d.id, device: fields });
      } else ops.push({ op: "device_create", device: fields });
    }
    // Removals first, so a device can move into units another one left.
    const removals: Op[] = mine
      .filter((d) => !kept.has(d.id))
      .map((d) => ({ op: "device_delete", id: d.id }));
    const all = [...removals, ...ops];
    if (!all.length) return onDone();
    if (
      await run(withRecorded(obj, all), t("dc.change.text", { name: obj.name }))
    )
      onDone();
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("dc.text.help")}</p>
      <textarea
        className="h-64 w-full rounded-md border bg-background p-2 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label={t("dc.text.label", { face: t(`dc.face.${face}`) })}
        placeholder={t("dc.text.placeholder")}
      />
      {errors.length > 0 && (
        <ul className="text-xs text-destructive">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={errors.length > 0}
          onClick={() => void save()}
        >
          {t("common.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
