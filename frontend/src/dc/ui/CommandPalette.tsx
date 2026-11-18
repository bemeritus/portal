/**
 * ⌘K / Ctrl+K (SPEC §11.4, `design/Meta.png`): one input for objects — racks,
 * devices by name/serial/owner, cells — and actions: find free space,
 * highlight a client, compare with a revision, save the view, print QR
 * labels, switch mode / theme / unit. Fuzzy search, keyboard only.
 *
 * Actions with parameters show their current values in the row
 * («2U · 0,8 кВт»). Tab, or → at the end of the query, opens them: fields for
 * «Найти свободное место» (units, kW), the owner list for «Подсветить
 * клиента». Enter runs, Esc goes back to the list with the values kept
 * (FEEDBACK-2 §4).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Box,
  Eye,
  History,
  LayoutGrid,
  Maximize,
  Palette,
  QrCode,
  Ruler,
  Server,
  Square,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fuzzyFilter, parseSpaceQuery } from "../model/fuzzy";
import { kwText, MAX_U, parseKw, parseUnits } from "../model/spaceParams";
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

type Param = null | "owner" | "space";

interface SpaceParams {
  u: number;
  powerW: number | null;
}
const NO_SPACE: SpaceParams = { u: 1, powerW: null };

/** What a query's `2U` / `0,8 кВт` changes in the current values. */
function fromQuery(q: string, cur: SpaceParams): SpaceParams {
  const p = parseSpaceQuery(q);
  return { u: p.u ?? cur.u, powerW: p.powerW ?? cur.powerW };
}

const MODES = ["schema", "realistic", "fill", "power"] as const;

export function CommandPalette({
  open,
  initialQuery,
  onClose,
  room,
}: {
  open: boolean;
  initialQuery: string;
  onClose: () => void;
  room: RoomPalette | null;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const settings = useDcSettings();
  const lang = i18n.language;
  const [query, setQuery] = useState(initialQuery);
  const [param, setParam] = useState<Param>(null);
  // Free-space parameters: set by the query as it is typed, or in their
  // fields (Tab / →); kept while the palette is open.
  const [space, setSpace] = useState<SpaceParams>(() =>
    fromQuery(initialQuery, NO_SPACE),
  );
  const [fields, setFields] = useState({ u: "1", kw: "" });
  // The list's query, given back when a parameter's view is left with Esc.
  const listQuery = useRef("");

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setParam(null);
      setSpace(fromQuery(initialQuery, NO_SPACE));
    }
  }, [open, initialQuery]);

  const run = (f: () => void) => {
    onClose();
    f();
  };

  const spaceText = t("dc.palette.spaceParams", {
    u: space.u,
    power:
      space.powerW === null
        ? t("dc.palette.anyPower")
        : t("dc.unit.kw", { v: kwText(space.powerW, lang) }),
  });

  interface Action {
    key: string;
    label: string;
    /** The parameters' current values, shown in the row. */
    values?: string;
    hint: string;
    icon: typeof Box;
    run?: () => void;
    /** Tab (or →) opens this; Enter runs `run` if there is one. */
    param?: Param;
    keywords: string;
  }
  const actions = useMemo<Action[]>(() => {
    const out: Action[] = [];
    if (room) {
      out.push({
        key: "space",
        label: t("dc.palette.findSpace"),
        values: spaceText,
        hint: t("dc.palette.findSpaceHint"),
        icon: Server,
        run: () => room.findSpace(space.u, space.powerW),
        param: "space",
        keywords: `${t("dc.palette.kwSpace")} free space место U`,
      });
      out.push({
        key: "owner",
        label: t("dc.palette.highlight"),
        hint: t("dc.palette.highlightHint"),
        icon: Eye,
        param: "owner",
        keywords: `${t("dc.palette.kwOwner")} client owner`,
      });
      out.push({
        key: "compare",
        label: t("dc.palette.compare"),
        hint: t("dc.palette.compareHint"),
        icon: History,
        run: () => navigate(`/dc/${room.roomId}/history`),
        keywords: "revision history ревизия история",
      });
      out.push({
        key: "view",
        label: t("dc.palette.saveView"),
        hint: t("dc.palette.saveViewHint"),
        icon: Maximize,
        run: room.saveView,
        keywords: "view link вид ссылка",
      });
      if (room.qr)
        out.push({
          key: "qr",
          label: room.qr.label,
          hint: "PDF, A4",
          icon: QrCode,
          run: room.qr.run,
          keywords: "qr labels наклейки",
        });
      for (const m of MODES)
        out.push({
          key: `mode-${m}`,
          label: t("dc.palette.mode", { mode: t(`dc.mode.${m}`) }),
          hint: "",
          icon: Box,
          run: () => room.setMode(m),
          keywords: "mode режим",
        });
      out.push({
        key: "ruler",
        label: t("dc.palette.ruler"),
        hint: "",
        icon: Ruler,
        run: () => navigate(`/dc/${room.roomId}?tool=ruler`),
        keywords: "ruler линейка",
      });
    }
    for (const th of THEMES)
      out.push({
        key: `theme-${th}`,
        label: t("dc.palette.theme", { theme: t(`dc.theme.${th}`) }),
        hint: "",
        icon: Palette,
        run: () => settings.setTheme(th),
        keywords: "theme тема",
      });
    for (const u of UNITS)
      out.push({
        key: `unit-${u}`,
        label: t("dc.palette.unit", { unit: t(`dc.unitWord.${u}`) }),
        hint: "",
        icon: Square,
        run: () => settings.setUnit(u),
        keywords: "unit единицы",
      });
    out.push({
      key: "catalog",
      label: t("dc.palette.catalog"),
      hint: "",
      icon: LayoutGrid,
      run: () => navigate("/dc/catalog"),
      keywords: "catalog каталог",
    });
    return out;
  }, [room, t, spaceText, space.u, space.powerW, navigate, settings]);

  // A query with "2U" or "кВт" in it is a free-space search first.
  const words = query
    .replace(/(\d+(?:[.,]\d+)?)\s*(u|квт|kw|вт|w)\b/gi, " ")
    .trim();
  const shownActions = param
    ? []
    : words
      ? fuzzyFilter(words, actions, (a) => `${a.label} ${a.keywords}`)
      : actions.slice(0, 6);
  const typed = parseSpaceQuery(query);
  if (!param && (typed.u !== null || typed.powerW !== null) && room) {
    const sp = actions.find((a) => a.key === "space")!;
    if (!shownActions.includes(sp)) shownActions.unshift(sp);
  }
  const shownObjects =
    param || !room
      ? []
      : query.trim()
        ? fuzzyFilter(
            query,
            room.objects,
            (o) => `${o.label} ${o.extra}`,
          ).slice(0, 8)
        : room.objects.filter((o) => o.kind === "rack");
  const shownOwners =
    param === "owner" && room
      ? fuzzyFilter(query, room.owners, (o) => o.name)
      : [];

  const unitsOk = parseUnits(fields.u) !== undefined;
  const powerOk = parseKw(fields.kw) !== undefined;

  const enterParam = (p: Param) => {
    listQuery.current = query;
    setParam(p);
    if (p === "space")
      setFields({
        u: String(space.u),
        kw: space.powerW === null ? "" : kwText(space.powerW, lang),
      });
    else setQuery("");
  };

  /** Esc in a parameter's view: back to the list, values kept. */
  const back = () => {
    setParam(null);
    setQuery(listQuery.current);
  };

  /** A field edited: the row's values follow while they read. */
  const editField = (k: "u" | "kw", text: string) => {
    const next = { ...fields, [k]: text };
    setFields(next);
    const u = parseUnits(next.u);
    const powerW = parseKw(next.kw);
    if (u !== undefined && powerW !== undefined) setSpace({ u, powerW });
  };

  /** The highlighted action, if it takes parameters (cmdk marks it). */
  const highlightedParam = (): Param => {
    const key = document.querySelector<HTMLElement>(
      "[cmdk-item][data-selected=true]",
    )?.dataset.key;
    return shownActions.find((x) => x.key === key)?.param ?? null;
  };

  const fieldKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    // The list's keys (cmdk) do not apply here.
    if (["Enter", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
      e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const u = parseUnits(fields.u);
    const powerW = parseKw(fields.kw);
    if (u === undefined || powerW === undefined || !room) return;
    run(() => room.findSpace(u, powerW));
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      onEscapeKeyDown={(e) => {
        if (!param) return;
        e.preventDefault();
        back();
      }}
      title={t("dc.palette.title")}
      description={t("dc.palette.description")}
      className="sm:max-w-2xl"
    >
      {param === "space" ? (
        <div className="space-y-3 px-4 pt-3 pb-4" data-testid="palette-params">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-muted-foreground" />
            <span className="flex-1">{t("dc.palette.findSpace")}</span>
            <span className="dc-num" data-testid="palette-space-values">
              {spaceText}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="pal-u">{t("dc.palette.fieldUnits")}</Label>
              <Input
                id="pal-u"
                autoFocus
                inputMode="numeric"
                className="dc-num"
                value={fields.u}
                aria-invalid={!unitsOk}
                aria-describedby={unitsOk ? undefined : "pal-u-err"}
                onChange={(e) => editField("u", e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={fieldKeys}
              />
              {!unitsOk && (
                <p id="pal-u-err" className="mt-1 text-xs text-destructive">
                  {t("dc.palette.badUnits", { max: MAX_U })}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="pal-kw">{t("dc.palette.fieldPower")}</Label>
              <Input
                id="pal-kw"
                inputMode="decimal"
                className="dc-num"
                placeholder={t("dc.palette.fieldPowerEmpty")}
                value={fields.kw}
                aria-invalid={!powerOk}
                aria-describedby={powerOk ? undefined : "pal-kw-err"}
                onChange={(e) => editField("kw", e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={fieldKeys}
              />
              {!powerOk && (
                <p id="pal-kw-err" className="mt-1 text-xs text-destructive">
                  {t("dc.palette.badPower")}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={(v) => {
              setQuery(v);
              if (!param) setSpace((s) => fromQuery(v, s));
            }}
            placeholder={
              param === "owner"
                ? t("dc.palette.ownerPlaceholder")
                : t("dc.palette.placeholder")
            }
            onKeyDown={(e) => {
              const input = e.currentTarget;
              const atEnd =
                input.selectionStart === input.value.length &&
                input.selectionEnd === input.value.length;
              if (
                !param &&
                (e.key === "Tab" || (e.key === "ArrowRight" && atEnd))
              ) {
                const p = highlightedParam();
                if (p) {
                  e.preventDefault();
                  enterParam(p);
                }
              }
              if (e.key === "Backspace" && param && !query) back();
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
                    onSelect={() =>
                      a.run ? run(a.run) : a.param && enterParam(a.param)
                    }
                    data-key={a.key}
                  >
                    <a.icon className="size-4" />
                    <span className="flex-1">
                      {a.label}
                      {a.values && (
                        <span
                          className="dc-num ml-2"
                          data-testid={`palette-values-${a.key}`}
                        >
                          {a.values}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {a.param ? `${a.hint} ⇥` : a.hint}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {shownObjects.length > 0 && (
              <CommandGroup heading={t("dc.palette.objects")}>
                {shownObjects.map((o) => (
                  <CommandItem
                    key={o.key}
                    value={o.key}
                    onSelect={() => run(o.run)}
                  >
                    {o.kind === "rack" ? (
                      <Server className="size-4" />
                    ) : (
                      <Box className="size-4" />
                    )}
                    <span className="flex-1">{o.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {o.detail}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {param === "owner" && room && (
              <CommandGroup heading={t("dc.palette.owners")}>
                <CommandItem
                  value="__none"
                  onSelect={() => run(() => room.highlight(null))}
                >
                  <span className="flex-1">
                    {t("dc.palette.noHighlight")}
                  </span>
                </CommandItem>
                {shownOwners.map((o) => (
                  <CommandItem
                    key={o.name}
                    value={`owner-${o.name}`}
                    onSelect={() => run(() => room.highlight(o.name))}
                  >
                    <Eye className="size-4" />
                    <span className="flex-1">{o.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("dc.palette.ownerCount", { count: o.count })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </>
      )}
      <div className="flex gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        {param === "space" ? (
          <>
            <span>⇥ {t("dc.palette.keyNextField")}</span>
            <span>↵ {t("dc.palette.keyRun")}</span>
            <span>Esc {t("dc.palette.keyBack")}</span>
          </>
        ) : (
          <>
            <span>↑ ↓ {t("dc.palette.keySelect")}</span>
            <span>↵ {t("dc.palette.keyRun")}</span>
            <span>
              {param
                ? `Esc ${t("dc.palette.keyBack")}`
                : `⇥ → ${t("dc.palette.keyParams")}`}
            </span>
          </>
        )}
      </div>
    </CommandDialog>
  );
}
