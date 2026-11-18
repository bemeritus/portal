/**
 * The selection tab: what is selected, its exact numbers, and — for editors —
 * the forms to change it. Racks get the elevation editor, shelves the cell
 * map; anything else its position, rotation and note.
 */

import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { measureLabel } from "./measureLabel";
import type { SelRef } from "../engine/DcEngine";
import type { Fmt } from "../format";
import { useFmt } from "../settings";
import { objectDims, type Problem } from "../model/geometry";
import type {
  CatalogItem,
  Clearance,
  DcObject,
  DoorType,
  Op,
  RoomData,
} from "../types";
import { assumedByObject, objectFields } from "../model/objects";
import { LengthInput } from "./LengthInput";
import { RackPanel, type Prefill } from "./RackPanel";
import { ShelfPanel } from "./ShelfPanel";

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
  /** A clearance warning clicked: select the rack, draw the gap. */
  onClearance: (c: Clearance) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
  problemsOf: (id: number) => Problem[];
}

export function SelectionPanel(props: Props) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { data, catalog, selection } = props;
  if (!selection) {
    const short = data.analysis.clearances.filter(
      (c) => c.gap_mm < c.required_mm,
    );
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("dc.selection.none")}</p>
        <ClearanceList list={short} fmt={fmt} onClearance={props.onClearance} />
      </div>
    );
  }
  const objId =
    selection.type === "object"
      ? selection.id
      : selection.type === "device"
        ? selection.rackId
        : selection.shelfId;
  const obj = data.objects.find((o) => o.id === objId);
  const item = obj ? catalog.get(obj.catalog_id) : undefined;
  if (!obj || !item)
    return (
      <p className="text-sm text-muted-foreground">{t("dc.selection.gone")}</p>
    );
  return (
    <div className="space-y-4 text-sm">
      <ObjectSummary obj={obj} item={item} {...props} />
      {item.kind === "rack" && <RackPanel obj={obj} item={item} {...props} />}
      {item.kind === "shelf" && <ShelfPanel obj={obj} item={item} {...props} />}
      {props.canEdit && (
        <ObjectEditor
          key={obj.id + ":" + data.room.revision}
          obj={obj}
          item={item}
          run={props.run}
        />
      )}
    </div>
  );
}

/**
 * What a clearance shortfall means for the people working there
 * (FEEDBACK-3 §3): how much room there is, to what, how much servicing
 * needs, and what will not work. The numbers stay the measured ones.
 */
export function clearanceText(c: Clearance, fmt: Fmt, t: TFunction): string {
  return t(c.side === "front" ? "dc.clearance.front" : "dc.clearance.rear", {
    name: c.object,
    gap: fmt.mm(c.gap_mm),
    need: fmt.mm(c.required_mm),
    what: c.obstacle
      ? t("dc.clearance.object", { name: c.obstacle })
      : t("dc.clearance.wall"),
  });
}

/** Shortfalls, each a button that selects the rack and draws its gap. */
export function ClearanceList({
  list,
  fmt,
  onClearance,
}: {
  list: Clearance[];
  fmt: Fmt;
  onClearance: (c: Clearance) => void;
}) {
  const { t } = useTranslation();
  if (!list.length) return null;
  return (
    <div
      className="rounded-md border border-destructive/40 p-2"
      data-testid="clearance-warning"
    >
      <div className="mb-1 font-medium">{t("dc.clearance.title")}</div>
      <ul className="space-y-1">
        {list.map((c) => (
          <li key={`${c.object_id}-${c.side}`}>
            <button
              type="button"
              className="text-left hover:underline"
              onClick={() => onClearance(c)}
            >
              {clearanceText(c, fmt, t)}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("dc.clearance.note")}
      </p>
    </div>
  );
}

function ObjectSummary({
  obj,
  item,
  data,
  problemsOf,
  onSelect,
  onClearance,
}: Props & { obj: DcObject; item: CatalogItem }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [w, d, h] = objectDims(item, obj.instance);
  const assumed = assumedByObject(data).get(obj.name) ?? [];
  const clear = data.analysis.clearances.filter((c) => c.object_id === obj.id);
  const fine = clear.filter((c) => c.gap_mm >= c.required_mm);
  const problems = problemsOf(obj.id);
  return (
    <div className="space-y-2">
      {/* The name and model are the inspector's heading. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">{t("dc.dims.wdh")}</dt>
        <dd>{fmt.dims(w, d, h)}</dd>
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
      <ClearanceList
        list={clear.filter((c) => !fine.includes(c))}
        fmt={fmt}
        onClearance={onClearance}
      />
      {fine.length > 0 && (
        <ul className="space-y-0.5">
          {fine.map((c) => (
            <li key={c.side} className="text-muted-foreground">
              {t(
                c.side === "front"
                  ? "dc.clearance.frontShort"
                  : "dc.clearance.rearShort",
                { gap: fmt.mm(c.gap_mm), need: fmt.mm(c.required_mm) },
              )}
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
      {obj.note && (
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">
          {obj.note}
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onSelect({ type: "object", id: obj.id }, true)}
      >
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

function ObjectEditor({
  obj,
  item,
  run,
}: {
  obj: DcObject;
  item: CatalogItem;
  run: Props["run"];
}) {
  const { t } = useTranslation();
  const [f, setF] = useState(() => objectFields(obj));
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(objectFields(obj)), [obj]);
  const dirty = JSON.stringify(f) !== JSON.stringify(objectFields(obj));
  const fmt = useFmt();
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
        await run(
          [{ op: "object_update", id: obj.id, object: f }],
          t("dc.change.edit", { name: obj.name }),
        );
        setBusy(false);
      }}
    >
      <div className="font-medium">{t("dc.edit.title")}</div>
      <div>
        <Label htmlFor="o-name">{t("dc.edit.name")}</Label>
        <Input
          id="o-name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["x0_mm", "z0_mm", "y0_mm"] as const).map((k) => (
          <div key={k}>
            <Label htmlFor={`o-${k}`}>
              {t(`dc.edit.${k}`, { unit: fmt.unitWord })}
            </Label>
            <LengthInput
              id={`o-${k}`}
              value={f[k]}
              onChange={(mm) => setF({ ...f, [k]: mm ?? 0 })}
            />
          </div>
        ))}
      </div>
      <div>
        <Label htmlFor="o-rot">{t("dc.dims.rotation")}</Label>
        <select
          id="o-rot"
          className="w-full rounded-md border bg-background px-2 py-1.5"
          value={f.rotation_deg}
          onChange={(e) =>
            setF({
              ...f,
              rotation_deg: Number(e.target.value) as DcObject["rotation_deg"],
            })
          }
        >
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
                <select
                  id={`o-${k}`}
                  className="w-full rounded-md border bg-background px-2 py-1.5"
                  value={f.instance[k] ?? ""}
                  onChange={(e) => door(k, e.target.value)}
                >
                  <option value="">{t("dc.edit.doorAsType")}</option>
                  {(["glass", "perforated", "solid", "none"] as DoorType[]).map(
                    (d) => (
                      <option key={d} value={d}>
                        {t(`dc.door.${d}`)}
                      </option>
                    ),
                  )}
                </select>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={f.contents_known}
              onCheckedChange={(v) =>
                setF({ ...f, contents_known: v === true })
              }
            />
            {t("dc.rack.contentsKnown")}
          </label>
        </>
      )}
      <div>
        <Label htmlFor="o-note">{t("dc.edit.note")}</Label>
        <textarea
          id="o-note"
          rows={2}
          className="w-full rounded-md border bg-background p-1.5"
          value={f.note}
          onChange={(e) => setF({ ...f, note: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!dirty || busy}>
          {t("common.save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty}
          onClick={() => setF(objectFields(obj))}
        >
          {t("common.reset")}
        </Button>
        {item.kind === "rack" && (
          <Badge variant="secondary">{t("dc.edit.dragHint")}</Badge>
        )}
      </div>
    </form>
  );
}
