/**
 * ⌘K / Ctrl+K (SPEC §11.4, `design/Meta.png`): one input for objects — racks,
 * devices by name/serial/owner, cells — and actions: find free space,
 * highlight a client, compare with a revision, save the view, print QR
 * labels, switch mode / theme / unit. Fuzzy search, keyboard only; an action
 * that takes a parameter opens its list with Tab (or Enter).
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Box, Eye, History, LayoutGrid, Maximize, Palette, QrCode, Ruler, Server, Square } from "lucide-react";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { fuzzyFilter, parseSpaceQuery } from "../model/fuzzy";
import { UNITS } from "../model/units";
import { useDcSettings } from "../settings";
import { THEMES } from "../theme/tokens";

export interface PaletteObject {
  key: string;
  kind: "rack" | "device" | "cell" | "object";
  label: string;
  /** Searchable extra text: serial, owner. */
  extra: string;
  detail: string;
  run: () => void;
}

/** What the open room offers the palette. */
export interface RoomPalette {
  roomId: number;
  objects: PaletteObject[];
  owners: { name: string; count: number }[];
  findSpace: (u: number, powerW: number | null) => void;
  highlight: (owner: string | null) => void;
  saveView: () => void;
  /** QR labels for the selected rack or shelf, if one is selected. */
  qr: { label: string; run: () => void } | null;
  setMode: (m: "schema" | "realistic" | "fill" | "power") => void;
}

type Param = null | "owner";

const MODES = ["schema", "realistic", "fill", "power"] as const;

export function CommandPalette({ open, initialQuery, onClose, room }: { open: boolean; initialQuery: string; onClose: () => void; room: RoomPalette | null }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const settings = useDcSettings();
  const [query, setQuery] = useState(initialQuery);
  const [param, setParam] = useState<Param>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setParam(null);
    }
  }, [open, initialQuery]);

  const run = (f: () => void) => {
    onClose();
    f();
  };

  const space = parseSpaceQuery(query);
  const spaceU = space.u ?? 1;

  interface Action {
    key: string;
    label: string;
    hint: string;
    icon: typeof Box;
    run?: () => void;
    param?: Param;
    keywords: string;
  }
  const actions = useMemo<Action[]>(() => {
    const out: Action[] = [];
    if (room) {
      out.push({
        key: "space",
        label: t("dc.palette.findSpace", {
          u: spaceU,
          power: space.powerW !== null ? `, ${t("dc.unit.kw", { v: (space.powerW / 1000).toLocaleString(i18n.language, { maximumFractionDigits: 2 }) })}` : "",
        }),
        hint: t("dc.palette.findSpaceHint"),
        icon: Server,
        run: () => room.findSpace(spaceU, space.powerW),
        keywords: `${t("dc.palette.kwSpace")} free space место U`,
      });
      out.push({ key: "owner", label: t("dc.palette.highlight"), hint: t("dc.palette.highlightHint"), icon: Eye, param: "owner", keywords: `${t("dc.palette.kwOwner")} client owner` });
      out.push({ key: "compare", label: t("dc.palette.compare"), hint: t("dc.palette.compareHint"), icon: History, run: () => navigate(`/dc/${room.roomId}/history`), keywords: "revision history ревизия история" });
      out.push({ key: "view", label: t("dc.palette.saveView"), hint: t("dc.palette.saveViewHint"), icon: Maximize, run: room.saveView, keywords: "view link вид ссылка" });
      if (room.qr) out.push({ key: "qr", label: room.qr.label, hint: "PDF, A4", icon: QrCode, run: room.qr.run, keywords: "qr labels наклейки" });
      for (const m of MODES) out.push({ key: `mode-${m}`, label: t("dc.palette.mode", { mode: t(`dc.mode.${m}`) }), hint: "", icon: Box, run: () => room.setMode(m), keywords: "mode режим" });
      out.push({ key: "ruler", label: t("dc.palette.ruler"), hint: "", icon: Ruler, run: () => navigate(`/dc/${room.roomId}?tool=ruler`), keywords: "ruler линейка" });
    }
    for (const th of THEMES) out.push({ key: `theme-${th}`, label: t("dc.palette.theme", { theme: t(`dc.theme.${th}`) }), hint: "", icon: Palette, run: () => settings.setTheme(th), keywords: "theme тема" });
    for (const u of UNITS) out.push({ key: `unit-${u}`, label: t("dc.palette.unit", { unit: t(`dc.unitWord.${u}`) }), hint: "", icon: Square, run: () => settings.setUnit(u), keywords: "unit единицы" });
    out.push({ key: "catalog", label: t("dc.palette.catalog"), hint: "", icon: LayoutGrid, run: () => navigate("/dc/catalog"), keywords: "catalog каталог" });
    return out;
  }, [room, t, i18n.language, spaceU, space.powerW, navigate, settings]);

  // A query with "2U" or "кВт" in it is a free-space search first.
  const words = query.replace(/(\d+(?:[.,]\d+)?)\s*(u|квт|kw|вт|w)\b/gi, " ").trim();
  const shownActions = param ? [] : words ? fuzzyFilter(words, actions, (a) => `${a.label} ${a.keywords}`) : actions.slice(0, 6);
  if (!param && (space.u !== null || space.powerW !== null) && room) {
    const sp = actions.find((a) => a.key === "space")!;
    if (!shownActions.includes(sp)) shownActions.unshift(sp);
  }
  const shownObjects = param || !room ? [] : query.trim() ? fuzzyFilter(query, room.objects, (o) => `${o.label} ${o.extra}`).slice(0, 8) : room.objects.filter((o) => o.kind === "rack");
  const shownOwners = param === "owner" && room ? fuzzyFilter(query, room.owners, (o) => o.name) : [];

  const enterParam = (p: Param) => {
    setParam(p);
    setQuery("");
  };

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && onClose()} title={t("dc.palette.title")} description={t("dc.palette.description")} className="sm:max-w-2xl">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={param === "owner" ? t("dc.palette.ownerPlaceholder") : t("dc.palette.placeholder")}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            // cmdk marks the highlighted item with data-selected.
            const key = document.querySelector<HTMLElement>("[cmdk-item][data-selected=true]")?.dataset.key;
            const a = shownActions.find((x) => x.key === key);
            if (a?.param) {
              e.preventDefault();
              enterParam(a.param);
            }
          }
          if (e.key === "Backspace" && param && !query) setParam(null);
        }}
      />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>{t("dc.palette.none")}</CommandEmpty>
        {shownActions.length > 0 && (
          <CommandGroup heading={t("dc.palette.actions")}>
            {shownActions.map((a) => (
              <CommandItem
                key={a.key}
                value={a.key}
                onSelect={() => (a.param ? enterParam(a.param) : a.run && run(a.run))}
                data-key={a.key}
              >
                <a.icon className="size-4" />
                <span className="flex-1">{a.label}</span>
                <span className="text-xs text-muted-foreground">{a.param ? `${a.hint} ⇥` : a.hint}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {shownObjects.length > 0 && (
          <CommandGroup heading={t("dc.palette.objects")}>
            {shownObjects.map((o) => (
              <CommandItem key={o.key} value={o.key} onSelect={() => run(o.run)}>
                {o.kind === "rack" ? <Server className="size-4" /> : <Box className="size-4" />}
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {param === "owner" && room && (
          <CommandGroup heading={t("dc.palette.owners")}>
            <CommandItem value="__none" onSelect={() => run(() => room.highlight(null))}>
              <span className="flex-1">{t("dc.palette.noHighlight")}</span>
            </CommandItem>
            {shownOwners.map((o) => (
              <CommandItem key={o.name} value={`owner-${o.name}`} onSelect={() => run(() => room.highlight(o.name))}>
                <Eye className="size-4" />
                <span className="flex-1">{o.name}</span>
                <span className="text-xs text-muted-foreground">{t("dc.palette.ownerCount", { count: o.count })}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>↑ ↓ {t("dc.palette.keySelect")}</span>
        <span>↵ {t("dc.palette.keyRun")}</span>
        <span>⇥ {t("dc.palette.keyParams")}</span>
      </div>
    </CommandDialog>
  );
}
