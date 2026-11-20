/**
 * The outliner (FEEDBACK-7 §4.2): every object of the room as a tree —
 * the room; racks with their devices by unit, top down; the shelf with its
 * occupied cells; cooling; cable trays; the rest. Each object row has an
 * icon by kind, a warning mark, and an eye and a lock: hidden in the
 * viewport, or not selectable there, for this viewer only (view state,
 * saved in saved views, never in revisions).
 *
 * Selection is shared both ways: a row selects and frames its object; a
 * selection made in 3D opens and highlights its row. The search filters by
 * name, model, owner and serial and keeps the parents of what it finds.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Archive,
  Box,
  Cable,
  ChevronRight,
  Eye,
  EyeOff,
  HardDrive,
  Highlighter,
  House,
  Lock,
  LockOpen,
  Package,
  Server,
  Snowflake,
  X,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import type { SelRef } from "../engine/DcEngine";
import type { CatalogItem, DcObject, Device, RoomData } from "../types";
import { clearanceGap } from "../types";

interface Props {
  data: RoomData;
  catalog: Map<number, CatalogItem>;
  selection: SelRef;
  hidden: Set<number>;
  locked: Set<number>;
  onSelect: (ref: SelRef) => void;
  onHidden: (id: number) => void;
  onLocked: (id: number) => void;
  onHighlight: (owner: string) => void;
  onClose: () => void;
}

type Group = "racks" | "shelf" | "cooling" | "trays" | "other";

const GROUP_OF: Record<CatalogItem["kind"], Group> = {
  rack: "racks",
  shelf: "shelf",
  cooling: "cooling",
  cable_tray: "trays",
  structure: "other",
};
const GROUP_ICON: Record<Group, typeof Server> = {
  racks: Server,
  shelf: Archive,
  cooling: Snowflake,
  trays: Cable,
  other: Box,
};

const units = (d: Device) =>
  d.u_height > 1
    ? `U${d.u_bottom + d.u_height - 1}–${d.u_bottom}`
    : `U${d.u_bottom}`;

export function Outliner(p: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(["racks", "shelf", "cooling", "trays", "other"]),
  );
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const hit = (...xs: (string | undefined | null)[]) =>
    !q || xs.some((x) => x?.toLowerCase().includes(q));

  // Objects with a warning: a clearance shortfall, a cooling unit over
  // equipment, a placement problem.
  const warned = useMemo(() => {
    const s = new Set<number>();
    for (const c of p.data.analysis.clearances)
      if (clearanceGap(c) < c.required_mm) s.add(c.object_id);
    for (const c of p.data.analysis.cooling_over_cells) s.add(c.object_id);
    for (const x of p.data.analysis.problems) s.add(x.object_id);
    return s;
  }, [p.data]);

  const sel = p.selection;
  const selObj = !sel
    ? null
    : sel.type === "object"
      ? sel.id
      : sel.type === "device"
        ? sel.rackId
        : sel.shelfId;
  const selKey = !sel
    ? null
    : sel.type === "object"
      ? `o${sel.id}`
      : sel.type === "device"
        ? `d${sel.id}`
        : `c${sel.shelfId}-${sel.cellNo}`;

  // A selection made in the view: open its group and object, show its row.
  useEffect(() => {
    if (selObj === null) return;
    const o = p.data.objects.find((x) => x.id === selObj);
    const item = o && p.catalog.get(o.catalog_id);
    if (!o || !item) return;
    setOpen((s) => {
      const n = new Set(s);
      n.add(GROUP_OF[item.kind]);
      if (sel?.type !== "object") n.add(`o${o.id}`);
      return n;
    });
    requestAnimationFrame(() =>
      list.current
        ?.querySelector(`[data-key="${selKey}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
    // The selection decides; the data only names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  /** An object and what it holds, if it or anything in it matches. */
  const objectRow = (o: DcObject, item: CatalogItem): ReactNode => {
    const kids: ReactNode[] = [];
    if (item.kind === "rack")
      for (const d of p.data.devices
        .filter((x) => x.rack_id === o.id)
        .sort((a, b) => b.u_bottom - a.u_bottom))
        if (hit(d.name, d.owner, d.serial, o.name))
          kids.push(
            <Row
              key={`d${d.id}`}
              k={`d${d.id}`}
              depth={2}
              icon={<HardDrive className="size-3.5" />}
              label={d.name}
              detail={units(d)}
              selected={selKey === `d${d.id}`}
              onClick={() =>
                p.onSelect({ type: "device", id: d.id, rackId: d.rack_id })
              }
              actions={
                d.owner ? (
                  <button
                    type="button"
                    title={`${t("dc.outliner.highlight")}: ${d.owner}`}
                    aria-label={`${t("dc.outliner.highlight")}: ${d.owner}`}
                    onClick={() => p.onHighlight(d.owner)}
                  >
                    <Highlighter className="size-3.5" />
                  </button>
                ) : null
              }
            />,
          );
    if (item.kind === "shelf")
      for (const c of p.data.cells
        .filter((x) => x.shelf_id === o.id)
        .sort((a, b) => a.cell_no - b.cell_no))
        if (hit(c.name, c.owner, o.name))
          kids.push(
            <Row
              key={`c${o.id}-${c.cell_no}`}
              k={`c${o.id}-${c.cell_no}`}
              depth={2}
              icon={<Package className="size-3.5" />}
              label={c.name}
              detail={String(c.cell_no)}
              selected={selKey === `c${o.id}-${c.cell_no}`}
              onClick={() =>
                p.onSelect({ type: "cell", shelfId: o.id, cellNo: c.cell_no })
              }
            />,
          );
    const self = hit(o.name, item.model, item.manufacturer);
    if (!self && !kids.length) return null;
    const Icon = GROUP_ICON[GROUP_OF[item.kind]];
    const key = `o${o.id}`;
    const isOpen = open.has(key) || (!!q && kids.length > 0);
    const hidden = p.hidden.has(o.id);
    const locked = p.locked.has(o.id);
    return (
      <div key={key}>
        <Row
          k={key}
          depth={1}
          icon={<Icon className="size-3.5" />}
          label={o.name}

          selected={selKey === key}
          dimmed={hidden}
          expand={
            kids.length
              ? { open: isOpen, toggle: () => toggle(key) }
              : undefined
          }
          warn={warned.has(o.id)}
          onClick={() => p.onSelect({ type: "object", id: o.id })}
          actions={
            <>
              <button
                type="button"
                aria-pressed={hidden}
                title={hidden ? t("dc.outliner.show") : t("dc.outliner.hide")}
                aria-label={`${hidden ? t("dc.outliner.show") : t("dc.outliner.hide")}: ${o.name}`}
                onClick={() => p.onHidden(o.id)}
              >
                {hidden ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-pressed={locked}
                title={locked ? t("dc.outliner.unlock") : t("dc.outliner.lock")}
                aria-label={`${locked ? t("dc.outliner.unlock") : t("dc.outliner.lock")}: ${o.name}`}
                onClick={() => p.onLocked(o.id)}
              >
                {locked ? (
                  <Lock className="size-3.5" />
                ) : (
                  <LockOpen className="size-3.5" />
                )}
              </button>
            </>
          }
        />
        {isOpen && kids}
      </div>
    );
  };

  const groups: Group[] = ["racks", "shelf", "cooling", "trays", "other"];
  const tree = groups.map((g) => {
    const rows = p.data.objects
      .flatMap((o) => {
        const item = p.catalog.get(o.catalog_id);
        return item && GROUP_OF[item.kind] === g ? [{ o, item }] : [];
      })
      .sort((a, b) =>
        a.o.name.localeCompare(b.o.name, undefined, { numeric: true }),
      )
      .map(({ o, item }) => objectRow(o, item))
      .filter(Boolean);
    if (!rows.length) return null;
    const Icon = GROUP_ICON[g];
    const isOpen = open.has(g) || !!q;
    return (
      <div key={g}>
        <Row
          k={g}
          depth={0}
          icon={<Icon className="size-3.5" />}
          label={t(`dc.outliner.${g}`)}
          detail={String(rows.length)}
          expand={{ open: isOpen, toggle: () => toggle(g) }}
          onClick={() => toggle(g)}
        />
        {isOpen && rows}
      </div>
    );
  });
  const found = tree.some(Boolean);

  return (
    <aside
      className="dc-outliner dc-panel"
      aria-label={t("dc.outliner.title")}
      data-testid="outliner"
    >
      <div className="dc-outliner-head">
        <b>{t("dc.outliner.title")}</b>
        <button
          type="button"
          aria-label={t("dc.outliner.close")}
          title={`${t("dc.outliner.close")} (O)`}
          onClick={p.onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <Input
        value={query}
        placeholder={t("dc.outliner.search")}
        aria-label={t("dc.outliner.search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="dc-outliner-tree" ref={list} role="tree">
        <Row
          k="room"
          depth={0}
          icon={<House className="size-3.5" />}
          label={`${t("dc.outliner.room")} · ${p.data.room.name}`}
          selected={sel === null}
          onClick={() => p.onSelect(null)}
        />
        {tree}
        {!found && <p className="dc-outliner-none">{t("dc.outliner.none")}</p>}
      </div>
    </aside>
  );
}

function Row({
  k,
  depth,
  icon,
  label,
  detail,
  selected,
  dimmed,
  warn,
  expand,
  onClick,
  actions,
}: {
  k: string;
  depth: number;
  icon: ReactNode;
  label: string;
  detail?: string;
  selected?: boolean;
  dimmed?: boolean;
  warn?: boolean;
  expand?: { open: boolean; toggle: () => void };
  onClick: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="dc-outliner-row"
      role="treeitem"
      aria-selected={!!selected}
      aria-expanded={expand ? expand.open : undefined}
      data-key={k}
      data-dimmed={dimmed || undefined}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expand ? (
        <button
          type="button"
          className="dc-outliner-twist"
          aria-hidden
          tabIndex={-1}
          data-open={expand.open}
          onClick={expand.toggle}
        >
          <ChevronRight className="size-3" />
        </button>
      ) : (
        <span className="dc-outliner-twist" />
      )}
      <button type="button" className="dc-outliner-name" onClick={onClick}>
        {icon}
        <span>{label}</span>
        {warn && (
          <AlertTriangle
            className="size-3.5 text-[var(--dc-warn)]"
            aria-label={t("dc.outliner.warning")}
          />
        )}
        {detail && <small className="dc-num">{detail}</small>}
      </button>
      {actions && <span className="dc-outliner-actions">{actions}</span>}
    </div>
  );
}
