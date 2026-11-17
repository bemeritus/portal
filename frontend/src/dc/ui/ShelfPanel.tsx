/**
 * Shelf cells as a grid map, seen from the front: boards top to bottom,
 * cells left to right. Cells a cooling unit hangs over are disabled (the
 * server's analysis says which); the unplated bottom board shows "bottom n".
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { SelRef } from "../engine/DcEngine";
import { cellCount, cellInfo, cellLabel } from "../model/geometry";
import type {
  CatalogItem,
  DcObject,
  Op,
  RoomData,
  ShelfCell,
  ShelfProps,
} from "../types";

interface Props {
  obj: DcObject;
  item: CatalogItem;
  data: RoomData;
  selection: SelRef;
  canEdit: boolean;
  onSelect: (ref: SelRef, fly?: boolean) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
}

export function ShelfPanel({
  obj,
  item,
  data,
  selection,
  canEdit,
  onSelect,
  run,
}: Props) {
  const { t } = useTranslation();
  const p = item.props as ShelfProps;
  const blocked = new Set(data.analysis.blocked_cells[String(obj.id)] ?? []);
  const cells = new Map(
    data.cells.filter((c) => c.shelf_id === obj.id).map((c) => [c.cell_no, c]),
  );
  const picked =
    selection?.type === "cell" && selection.shelfId === obj.id
      ? selection.cellNo
      : null;
  const boards = p.boards_mm.length;
  // Section boundaries, for a thicker divider in the grid.
  const dividers = new Set<number>();
  let acc = 0;
  for (const s of p.sections.slice(0, -1)) dividers.add((acc += s));

  const label = (n: number) => {
    const l = cellLabel(p, n);
    return l.plated ? String(l.n) : t("dc.shelf.bottomN", { n: l.n });
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {t("dc.shelf.summary", {
          used: cells.size,
          total: cellCount(p) - blocked.size,
          blocked: blocked.size,
        })}
      </div>
      <div className="space-y-1" role="grid" aria-label={t("dc.shelf.map")}>
        {Array.from({ length: boards }, (_, b) => (
          <div key={b} role="row" className="flex">
            {Array.from({ length: p.cells_per_board }, (_, col) => {
              const n = b * p.cells_per_board + col + 1;
              const c = cells.get(n);
              const isBlocked = blocked.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  role="gridcell"
                  disabled={isBlocked}
                  title={
                    isBlocked
                      ? t("dc.shelf.blocked", { n: label(n) })
                      : c
                        ? `${label(n)}: ${c.name}${c.owner ? ` · ${c.owner}` : ""}`
                        : t("dc.shelf.free", { n: label(n) })
                  }
                  className={cn(
                    "h-9 min-w-0 flex-1 truncate border px-0.5 text-[10px] leading-tight",
                    dividers.has(col) && "ml-1",
                    isBlocked
                      ? "dc-hatch cursor-not-allowed text-muted-foreground"
                      : c
                        ? "bg-primary/15"
                        : "hover:bg-accent",
                    picked === n && "ring-2 ring-primary",
                  )}
                  onClick={() =>
                    onSelect(
                      { type: "cell", shelfId: obj.id, cellNo: n },
                      false,
                    )
                  }
                >
                  <div className="text-muted-foreground">{label(n)}</div>
                  {c && <div className="truncate">{c.name}</div>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {picked !== null && cellInfo(p, picked) && (
        <CellForm
          key={`${picked}-${data.room.revision}`}
          shelf={obj}
          cellNo={picked}
          label={label(picked)}
          cell={cells.get(picked) ?? null}
          canEdit={canEdit}
          run={run}
        />
      )}
    </div>
  );
}

function CellForm({
  shelf,
  cellNo,
  label,
  cell,
  canEdit,
  run,
}: {
  shelf: DcObject;
  cellNo: number;
  label: string;
  cell: ShelfCell | null;
  canEdit: boolean;
  run: Props["run"];
}) {
  const { t } = useTranslation();
  const [f, setF] = useState<ShelfCell>(
    cell ?? {
      shelf_id: shelf.id,
      cell_no: cellNo,
      name: "",
      owner: "",
      power_w: null,
      note: "",
    },
  );
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2 rounded-md border p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await run(
          [{ op: "cell_set", cell: { ...f, name: f.name.trim() } }],
          t("dc.change.cell", { n: label }),
        );
        setBusy(false);
      }}
    >
      <div className="font-medium">{t("dc.shelf.cell", { n: label })}</div>
      <div>
        <Label htmlFor="c-name">{t("dc.shelf.what")}</Label>
        <Input
          id="c-name"
          value={f.name}
          disabled={!canEdit}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="c-owner">{t("dc.device.owner")}</Label>
          <Input
            id="c-owner"
            value={f.owner}
            disabled={!canEdit}
            onChange={(e) => setF({ ...f, owner: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="c-power">{t("dc.device.power")}</Label>
          <Input
            id="c-power"
            type="number"
            min={0}
            placeholder={t("dc.device.powerUnknown")}
            value={f.power_w ?? ""}
            disabled={!canEdit}
            onChange={(e) =>
              setF({
                ...f,
                power_w:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value)),
              })
            }
          />
        </div>
      </div>
      <div>
        <Label htmlFor="c-note">{t("dc.device.note")}</Label>
        <Input
          id="c-note"
          value={f.note}
          disabled={!canEdit}
          onChange={(e) => setF({ ...f, note: e.target.value })}
        />
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !f.name.trim()}>
            {t("common.save")}
          </Button>
          {cell && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  [{ op: "cell_delete", shelf_id: shelf.id, cell_no: cellNo }],
                  t("dc.change.cellClear", { n: label }),
                )
              }
            >
              {t("dc.shelf.clear")}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
