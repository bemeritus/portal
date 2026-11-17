/**
 * The selection tab: what is selected, its exact numbers, and — for editors —
 * the forms to change it. Racks get the elevation editor, shelves the cell
 * map; anything else its position, rotation and note.
 */

import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import i18n from "i18next";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { tDyn } from "../../i18n";
import type { SelRef } from "../engine/DcEngine";
import { makeFmt } from "../format";
import { objectDims, type Problem } from "../model/geometry";
import type { CatalogItem, Clearance, DcObject, DoorType, Op, RoomData } from "../types";
import { objectFields } from "./DcRoomPage";
import { assumedByObject } from "./MeasurementsPanel";
import { RackPanel } from "./RackPanel";
import { ShelfPanel } from "./ShelfPanel";

export interface Prefill {
  rackId: number;
  u: number;
  height: number;
  face: "front" | "rear" | "both";
  power: number | null;
}

interface Props {
  data: RoomData;
  catalog: Map<number, CatalogItem>;
  selection: SelRef;
  canEdit: boolean;
  editTool: boolean;
  warnings: Clearance[];
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onSelect: (ref: SelRef, fly?: boolean) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
  problemsOf: (id: number) => Problem[];
}

export function SelectionPanel(props: Props) {
  const { t, i18n } = useTranslation();
  const fmt = makeFmt(t, i18n.language);
  const { data, catalog, selection } = props;
  if (!selection) {
    const short = data.analysis.clearances.filter((c) => c.gap_mm < c.required_mm);
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("dc.selection.none")}</p>
        <ClearanceList list={short} fmt={fmt} onSelect={(id) => props.onSelect({ type: "object", id })} />
      </div>
    );
  }
  const objId = selection.type === "object" ? selection.id : selection.type === "device" ? selection.rackId : selection.shelfId;
  const obj = data.objects.find((o) => o.id === objId);
  const item = obj ? catalog.get(obj.catalog_id) : undefined;
  if (!obj || !item) return <p className="text-sm text-muted-foreground">{t("dc.selection.gone")}</p>;
  return (
    <div className="space-y-4 text-sm">
      <ObjectSummary obj={obj} item={item} {...props} />
      {item.kind === "rack" && <RackPanel obj={obj} item={item} {...props} />}
      {item.kind === "shelf" && <ShelfPanel obj={obj} item={item} {...props} />}
      {props.canEdit && <ObjectEditor key={obj.id + ":" + data.room.revision} obj={obj} item={item} run={props.run} />}
    </div>
  );
}

export function ClearanceList({ list, fmt, onSelect }: { list: Clearance[]; fmt: ReturnType<typeof makeFmt>; onSelect: (id: number) => void }) {
  const { t } = useTranslation();
  if (!list.length) return null;
  return (
    <div className="rounded-md border border-destructive/40 p-2">
      <div className="mb-1 font-medium">{t("dc.clearance.title")}</div>
      <ul className="space-y-1">
        {list.map((c) => (
          <li key={`${c.object_id}-${c.side}`}>
            <button type="button" className="text-left hover:underline" onClick={() => onSelect(c.object_id)}>
              {t(c.side === "front" ? "dc.clearance.front" : "dc.clearance.rear", {
                name: c.object,
                gap: fmt.mm(c.gap_mm),
                need: fmt.mm(c.required_mm),
              })}
              {c.obstacle ? ` (${t("dc.clearance.until", { what: c.obstacle })})` : ` (${t("dc.clearance.untilWall")})`}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">{t("dc.clearance.note")}</p>
    </div>
  );
}

function ObjectSummary({ obj, item, data, problemsOf, onSelect }: Props & { obj: DcObject; item: CatalogItem }) {
  const { t, i18n } = useTranslation();
  const fmt = makeFmt(t, i18n.language);
  const [w, d, h] = objectDims(item, obj.instance);
  const assumed = assumedByObject(data).get(obj.name) ?? [];
  const clear = data.analysis.clearances.filter((c) => c.object_id === obj.id);
  const problems = problemsOf(obj.id);
  return (
    <div className="space-y-2">
      <div>
        <h2 className="m-0 text-lg">{obj.name}</h2>
        <div className="text-xs text-muted-foreground">
          {t(`dc.kind.${item.kind}`)} · {item.manufacturer ? `${item.manufacturer} ` : ""}
          {item.model}
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">{t("dc.dims.wdh")}</dt>
        <dd>
          {fmt.n(w)} × {fmt.n(d)} × {fmt.mm(h)}
        </dd>
        <dt className="text-muted-foreground">{t("dc.dims.position")}</dt>
        <dd>
          x {fmt.mm(obj.x0_mm)} · z {fmt.mm(obj.z0_mm)}
          {obj.y0_mm ? ` · y ${fmt.mm(obj.y0_mm)}` : ""}
        </dd>
        <dt className="text-muted-foreground">{t("dc.dims.rotation")}</dt>
        <dd>{obj.rotation_deg}°</dd>
      </dl>
      {problems.length > 0 && (
        <ul className="rounded-md border border-destructive/50 p-2 text-destructive">
          {problems.map((p, i) => (
            <li key={i}>{problemText(p, t)}</li>
          ))}
        </ul>
      )}
      {clear.length > 0 && (
        <ul className="space-y-0.5">
          {clear.map((c) => (
            <li key={c.side} className={c.gap_mm < c.required_mm ? "text-destructive" : "text-muted-foreground"}>
              {t(c.side === "front" ? "dc.clearance.frontShort" : "dc.clearance.rearShort", { gap: fmt.mm(c.gap_mm), need: fmt.mm(c.required_mm) })}
            </li>
          ))}
        </ul>
      )}
      {assumed.length > 0 && (
        <div className="rounded-md border border-tag-3/60 bg-tag-3/10 p-2">
          <div className="font-medium">≈ {t("dc.measure.assumedHere")}</div>
          <ul className="text-xs">
            {assumed.map((k) => (
              <li key={k}>{measureLabel(k, t)}</li>
            ))}
          </ul>
        </div>
      )}
      {obj.note && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{obj.note}</p>}
      <Button size="sm" variant="ghost" onClick={() => onSelect({ type: "object", id: obj.id }, true)}>
        {t("dc.selection.show")}
      </Button>
    </div>
  );
}

export function problemText(p: Problem, t: TFunction): string {
  switch (p.type) {
    case "outside_room":
      return t("dc.problem.outside");
    case "above_ceiling":
      return t("dc.problem.ceiling");
    case "overlaps":
      return t("dc.problem.overlaps", { other: p.other });
    case "blocks_door":
      return t("dc.problem.door", { door: p.door });
  }
}

/**
 * A measurement or catalog property key in words. Rack and unit numbers fold
 * into one key with `{{n}}` (`racks.back.r2` → `racks_back_n`, n = 2); gaps
 * name both ends. A key with no translation is shown as it is.
 */
export function measureLabel(key: string, t: TFunction): string {
  const gapM = key.match(/^racks\.gap\.(.+)-(.+)$/);
  if (gapM) {
    const end = (x: string) =>
      x === "left_wall" ? t("dc.measureKey.leftWall") : x === "right_wall" ? t("dc.measureKey.rightWall") : t("dc.measureKey.rack", { n: x.replace(/\D/g, "") });
    return t("dc.measureKey.gap", { a: end(gapM[1]), b: end(gapM[2]) });
  }
  let n = "";
  const generic = key.replace(/\b(?:r|ac)(\d+)\b|board_(\d+)/g, (_m, a?: string, b?: string) => {
    n = a ?? b ?? "";
    return b ? "board_n" : "n";
  });
  const tk = `dc.measureKey.${generic.replace(/\./g, "_")}`;
  return i18n.exists(tk) ? tDyn(t, tk, { n }) : key;
}

function ObjectEditor({ obj, item, run }: { obj: DcObject; item: CatalogItem; run: Props["run"] }) {
  const { t } = useTranslation();
  const [f, setF] = useState(() => objectFields(obj));
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(objectFields(obj)), [obj]);
  const dirty = JSON.stringify(f) !== JSON.stringify(objectFields(obj));
  const num = (v: string) => (v === "" ? 0 : Math.round(Number(v)));
  const door = (k: "door_front" | "door_rear", v: string) =>
    setF((x) => {
      const inst = { ...x.instance };
      if (v === "") delete inst[k];
      else inst[k] = v as DoorType;
      return { ...x, instance: inst };
    });
  return (
    <form
      className="space-y-2 rounded-md border p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await run([{ op: "object_update", id: obj.id, object: f }], t("dc.change.edit", { name: obj.name }));
        setBusy(false);
      }}
    >
      <div className="font-medium">{t("dc.edit.title")}</div>
      <div>
        <Label htmlFor="o-name">{t("dc.edit.name")}</Label>
        <Input id="o-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["x0_mm", "z0_mm", "y0_mm"] as const).map((k) => (
          <div key={k}>
            <Label htmlFor={`o-${k}`}>{t(`dc.edit.${k}`)}</Label>
            <Input id={`o-${k}`} type="number" step={1} value={f[k]} onChange={(e) => setF({ ...f, [k]: num(e.target.value) })} />
          </div>
        ))}
      </div>
      <div>
        <Label htmlFor="o-rot">{t("dc.dims.rotation")}</Label>
        <select id="o-rot" className="w-full rounded-md border bg-background px-2 py-1.5" value={f.rotation_deg} onChange={(e) => setF({ ...f, rotation_deg: Number(e.target.value) as DcObject["rotation_deg"] })}>
          {[0, 90, 180, 270].map((r) => (
            <option key={r} value={r}>
              {r}°
            </option>
          ))}
        </select>
      </div>
      {item.kind === "rack" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(["door_front", "door_rear"] as const).map((k) => (
              <div key={k}>
                <Label htmlFor={`o-${k}`}>{t(`dc.edit.${k}`)}</Label>
                <select id={`o-${k}`} className="w-full rounded-md border bg-background px-2 py-1.5" value={f.instance[k] ?? ""} onChange={(e) => door(k, e.target.value)}>
                  <option value="">{t("dc.edit.doorAsType")}</option>
                  {(["glass", "perforated", "solid", "none"] as DoorType[]).map((d) => (
                    <option key={d} value={d}>
                      {t(`dc.door.${d}`)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={f.contents_known} onCheckedChange={(v) => setF({ ...f, contents_known: v === true })} />
            {t("dc.rack.contentsKnown")}
          </label>
        </>
      )}
      <div>
        <Label htmlFor="o-note">{t("dc.edit.note")}</Label>
        <textarea id="o-note" rows={2} className="w-full rounded-md border bg-background p-1.5" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!dirty || busy}>
          {t("common.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!dirty} onClick={() => setF(objectFields(obj))}>
          {t("common.reset")}
        </Button>
        {item.kind === "rack" && <Badge variant="secondary">{t("dc.edit.dragHint")}</Badge>}
      </div>
    </form>
  );
}
