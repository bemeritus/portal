/**
 * `/dc/:roomId` — the room (mockups `design/Main.png`, `Light.png`,
 * `Drawing.png`).
 *
 * React owns the chrome — tool rail, chips, inspector, mode bar — and the 3D
 * view is a `DcEngine` created once the room has loaded and fed through its
 * narrow interface. `?view=plan` is the plan: orthographic from above, with a
 * legend and a title block.
 *
 * The URL carries what is on screen — `?mode=`, `?owner=`, `?cam=` and the
 * selection in the hash (`#obj-12`, `#device-7`, `#cell-5-16`) — so a link
 * opens exactly what the sender saw (§11.4). `?rev=N` shows the room at an
 * older revision, read only (history's «Открыть в 3D на этой ревизии»).
 *
 * Calm by default (FEEDBACK-6 §1): realistic in studio and light, the plan
 * in drawing, then the user's last mode; what is drawn besides the room
 * comes from the rail's layers list; warnings are pins in the scene; the
 * bottom bar is grouped — modes, views, undo / redo, export, «⋯».
 */

import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Layers as LayersIcon,
  ListTree,
  MapPin,
  MoreHorizontal,
  MousePointer2,
  Move,
  Redo2,
  Ruler,
  ScanEye,
  Scissors,
  Undo2,
  X,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "../../api/client";
import { useToolAccess } from "../../auth/useToolAccess";
import { ErrorFlash, Flash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import {
  DcEngine,
  DEFAULT_LAYERS,
  type EngineModel,
  type Layers,
  type LegendMarks,
  type Measure,
  type Mode,
  type RulerMode,
  type SelRef,
  type Tool,
} from "../engine/DcEngine";
import type { Preset, View } from "../engine/camera";
import type { Fmt } from "../format";
import { useChanges, useRoom } from "../hooks";
import { rackStats, type RackStats } from "../model/devices";
import { difference, disagrees, isRange } from "../model/measure";
import type { SnapKind } from "../model/ruler";
import { useDcSettings, useFmt } from "../settings";
import { TOKENS } from "../theme/tokens";
import type {
  CatalogItem,
  Clearance,
  DcObject,
  Measurement,
  Op,
  RoomData,
  ViewPayload,
} from "../types";
import { localText } from "../types";
import type { CapacityRequest } from "./CapacityPanel";
import type { PaletteObject } from "./CommandPalette";
import { useShell } from "./DcShell";
import { ImportDialog } from "./ImportDialog";
import { ModeLegend } from "./ModeLegend";
import { Outliner } from "./Outliner";
import { KeymapHelp, SectionPanel, StatusBar, Tour } from "./viewport";
import { viewsInOrder } from "./ViewsPanel";
import { Inspector, type InspectorTab } from "./Inspector";
import { planByDefault } from "./landing";
import { assumedByObject, objectFields } from "../model/objects";
import { measureLabel } from "./measureLabel";
import { clearanceSplitText } from "./SelectionPanel";
import { hasLegend, PlanLegend } from "./PlanLegend";

const MODES: Mode[] = ["schema", "realistic", "fill", "power", "owners"];
const TOOLS: { tool: Tool; icon: typeof MousePointer2; key?: string }[] = [
  { tool: "view", icon: MousePointer2 },
  { tool: "edit", icon: Move },
  { tool: "ruler", icon: Ruler, key: "M" },
  { tool: "note", icon: MapPin },
  { tool: "section", icon: Scissors, key: "Shift+B" },
];
const GRIDS = [5, 10, 50, 100];
const VIEWS: Preset[] = ["iso", "top", "aisle", "racks"];
const LAYER_KEYS: (keyof Layers)[] = [
  "room",
  "chains",
  "gaps",
  "tape",
  "selection",
  "zones",
  "names",
  "lights",
  "assumptions",
];

/** The layers this viewer chose last time (a convenience; may be absent). */
function loadLayers(): Layers {
  try {
    const v = JSON.parse(localStorage.getItem("dc.layers") ?? "null");
    return { ...DEFAULT_LAYERS, ...(v ?? {}) };
  } catch {
    return { ...DEFAULT_LAYERS };
  }
}
function saveLayers(l: Layers) {
  try {
    localStorage.setItem("dc.layers", JSON.stringify(l));
  } catch {
    // Private windows and blocked storage: the layers just reset.
  }
}

/** Object ids this viewer hid or locked in a room (a convenience). */
function loadIds(key: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}
function saveIds(key: string, ids: Set<number>) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Private windows and blocked storage: they just reset.
  }
}

/** Where the room opens: the user's last mode, else the theme's default. */
function defaultMode(s: ReturnType<typeof useDcSettings>): Mode {
  return s.settings.dc_mode ?? (s.theme === "drawing" ? "schema" : "realistic");
}

export function parseHash(hash: string): SelRef {
  let m = hash.match(/^#obj-(\d+)$/);
  if (m) return { type: "object", id: Number(m[1]) };
  m = hash.match(/^#device-(\d+)$/);
  if (m) return { type: "device", id: Number(m[1]), rackId: -1 };
  m = hash.match(/^#cell-(\d+)-(\d+)$/);
  if (m) return { type: "cell", shelfId: Number(m[1]), cellNo: Number(m[2]) };
  return null;
}

export function hashOf(ref: SelRef): string {
  if (!ref) return "";
  if (ref.type === "object") return `#obj-${ref.id}`;
  if (ref.type === "device") return `#device-${ref.id}`;
  return `#cell-${ref.shelfId}-${ref.cellNo}`;
}

/** Fill in a device ref's rack from the data (a hash only names the device). */
function complete(ref: SelRef, data: RoomData): SelRef {
  if (ref?.type === "device" && ref.rackId < 0) {
    const d = data.devices.find((x) => x.id === ref.id);
    return d ? { type: "device", id: d.id, rackId: d.rack_id } : null;
  }
  return ref;
}

/** `?cam=x,y,z,tx,ty,tz,fov,o` ↔ a camera view. */
function camParam(v: View): string {
  return [...v.position, ...v.target, v.fov, v.ortho ? 1 : 0]
    .map((n) => Math.round(n))
    .join(",");
}
function parseCam(s: string | null): View | null {
  const n = s?.split(",").map(Number) ?? [];
  if (n.length !== 8 || n.some((x) => !Number.isFinite(x))) return null;
  return {
    position: [n[0], n[1], n[2]],
    target: [n[3], n[4], n[5]],
    fov: n[6],
    ortho: n[7] === 1,
  };
}

/** The dimension text of a measurement, its tooltip, and its mark. */
export function measurementText(
  m: Measurement,
  fmt: Fmt,
  t: TFunction,
  lang: string,
): { text: string; title: string; mark: boolean } {
  const read = isRange(m) ? fmt.range(m.min!, m.max!) : fmt.mm(m.value);
  const mark = disagrees(m);
  const lines = [
    `${measureLabel(m.key, t)}`,
    `${t(`dc.src.${m.src}`)}: ${read}`,
  ];
  if (m.model !== undefined && m.model !== null)
    lines.push(t("dc.measure.modelValue", { v: fmt.mm(m.model) }));
  const diff = difference(m);
  if (mark && diff !== null)
    lines.push(
      t("dc.measure.diff", {
        v: `${diff > 0 ? "+" : "−"}${fmt.mm(Math.abs(diff))}`,
      }),
    );
  if (m.note) lines.push(localText(m.note, lang));
  return { text: read, title: lines.join("\n"), mark };
}

export function DcRoomPage() {
  const { roomId: param } = useParams();
  const roomId = Number(param);
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const settings = useDcSettings();
  const tokens = TOKENS[settings.theme];
  const shell = useShell();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const plan = search.get("view") === "plan";
  const tools = useToolAccess();
  // An older revision is shown read only.
  const rev = Number(search.get("rev")) || null;
  const canEdit = tools.can("dc_room", "edit") && rev === null;
  const room = useRoom(roomId);
  const past = useQuery({
    queryKey: ["dc", "revision", roomId, rev],
    queryFn: ({ signal }) => dcApi.revision(roomId, rev!, signal),
    enabled: rev !== null,
  });
  const data = useMemo(
    () =>
      rev !== null && past.data && room.data
        ? {
            ...room.data,
            objects: past.data.snapshot.objects,
            devices: past.data.snapshot.devices,
            cells: past.data.snapshot.cells,
            annotations: past.data.snapshot.annotations,
            // Today's analysis does not describe that room.
            analysis: {
              ...room.data.analysis,
              clearances: [],
              problems: [],
              cooling_over_cells: [],
            },
          }
        : room.data,
    [rev, past.data, room.data],
  );
  const changes = useChanges(roomId, data);

  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<DcEngine | null>(null);
  const initial = useRef({
    mode: search.get("mode"),
    owner: search.get("owner"),
    cam: parseCam(search.get("cam")),
    tool: search.get("tool"),
  });
  const linkedMode = MODES.includes(initial.current.mode as Mode);
  const [mode, setModeState] = useState<Mode>(() =>
    linkedMode ? (initial.current.mode as Mode) : defaultMode(settings),
  );
  // Settings arriving after the first render decide the mode once.
  const modeChosen = useRef(linkedMode || settings.ready);
  useEffect(() => {
    if (modeChosen.current || !settings.ready) return;
    modeChosen.current = true;
    setModeState(defaultMode(settings));
    // Only the first ready settings matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ready]);
  /** A mode picked by the user: remembered for them. */
  const setMode = useCallback(
    (m: Mode) => {
      modeChosen.current = true;
      setModeState(m);
      settings.setMode(m);
    },
    [settings],
  );
  const [layers, setLayers] = useState<Layers>(loadLayers);
  const [tool, setTool] = useState<Tool>(() =>
    initial.current.tool === "ruler" ? "ruler" : "view",
  );
  const [rulerMode, setRulerMode] = useState<RulerMode>("points");
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [grid, setGrid] = useState(10);
  const [ortho, setOrtho] = useState(false);
  const [walking, setWalking] = useState(false);
  const [owner, setOwner] = useState<string | null>(initial.current.owner);
  const [selection, setSelection] = useState<SelRef>(() =>
    parseHash(window.location.hash),
  );
  const [hover, setHover] = useState<{
    ref: SelRef;
    x: number;
    y: number;
  } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  // The viewport as a 3D tool (FEEDBACK-7 §4): view state for this viewer,
  // saved with views, never in the room's revisions.
  const [outliner, setOutliner] = useState(false);
  const [hidden, setHidden] = useState<Set<number>>(
    () => new Set(loadIds(`dc.hidden.${roomId}`)),
  );
  const [locked, setLocked] = useState<Set<number>>(
    () => new Set(loadIds(`dc.locked.${roomId}`)),
  );
  /** The objects shown alone («Только выбранное»), or null. */
  const [isolated, setIsolated] = useState<number[] | null>(null);
  const [xray, setXray] = useState(false);
  const [fade, setFade] = useState(true);
  const [sectionOn, setSectionOn] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  /** The device tooltip, shown after the pointer rests 300 ms. */
  const [devTip, setDevTip] = useState<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  const [inspector, setInspector] = useState<{
    open: boolean;
    tab: InspectorTab;
  }>({
    open: true,
    tab: initial.current.tool === "ruler" ? "ruler" : "object",
  });
  const [capacity, setCapacity] = useState<CapacityRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** The room settings opened from the power legend («задать»). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The presentation tour of the saved views (FEEDBACK-7 §4.8). */
  const [tour, setTour] = useState(false);
  const [notePos, setNotePos] = useState<[number, number, number] | null>(null);
  const [prefill, setPrefill] = useState<{
    rackId: number;
    u: number;
    height: number;
    face: "front" | "rear" | "both";
    power: number | null;
  } | null>(null);
  const flewTo = useRef(false);
  /** The marks drawn in the view, for the plan legend. */
  const [legend, setLegend] = useState<LegendMarks | null>(null);

  const catalog = useMemo(
    () =>
      new Map<number, CatalogItem>((data?.catalog ?? []).map((c) => [c.id, c])),
    [data],
  );

  useEffect(() => {
    document.title = t("docTitle", {
      page: data?.room.name ?? t("dc.title"),
      app: t("app.name"),
    });
  }, [t, data?.room.name]);

  // A `?tool=ruler` link (from the palette) switches the tool.
  useEffect(() => {
    if (search.get("tool") === "ruler") {
      setTool("ruler");
      setInspector({ open: true, tab: "ruler" });
    }
  }, [search]);

  // --- The engine: created once the canvas host exists ---
  const loaded = !!data;
  useEffect(() => {
    if (!loaded || !host.current) return;
    const e = new DcEngine(
      host.current,
      {
        assumed: "",
        rack: () => "",
        mm: String,
        range: (a, b) => `${a}–${b}`,
        measurement: (m) => ({ text: String(m.value), title: "", mark: false }),
        ruler: (r) => String(r.distance),
        snap: (k) => k,
        clearance: (c) => String(c.mm),
        pin: (c) => String(c.mm),
        condensate: (cells) => ({ pin: cells.join(), title: "" }),
      },
      TOKENS[settings.theme],
    );
    engine.current = e;
    // The end-to-end test drives the ruler through the engine's projection.
    if (import.meta.env.DEV) Object.assign(window, { __dcEngine: e });
    e.onSelect = (ref) => {
      setSelection(ref);
      if (ref) setInspector({ open: true, tab: "object" });
    };
    e.onHover = (ref, x, y) => setHover(ref ? { ref, x, y } : null);
    e.onCursor = setCursor;
    e.onWalk = setWalking;
    e.onProjection = setOrtho;
    e.onPlaceNote = (p) => setNotePos(p);
    e.onRuler = (m) => setMeasures([...m]);
    e.onQuality = () => setNotice(t("dc.quality.lowered"));
    e.onLegend = setLegend;
    return () => {
      e.dispose();
      engine.current = null;
    };
    // The theme is pushed separately; the engine is made once per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => engine.current?.setTheme(tokens), [tokens, loaded]);

  // Words the engine draws, in the current language and unit.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const snapWord = (k: SnapKind): string => t(`dc.snap.${k}`);
    e.text = {
      assumed: t("dc.measure.assumedShort"),
      rack: (s, m) => rackLabel(s, m, fmt, t),
      mm: fmt.mm,
      range: fmt.range,
      measurement: (m) => measurementText(m, fmt, t, i18n.language),
      ruler: (r) => rulerText(r, fmt, t, snapWord),
      snap: snapWord,
      pin: (c) =>
        t(c.side === "front" ? "dc.pin.front" : "dc.pin.rear", {
          gap: fmt.mm(c.mm),
        }),
      condensate: (cells) => ({
        pin: t("dc.condensate.pin", { cells: cells.join(", ") }),
        title: t("dc.condensate.text", { cells: cells.join(", ") }),
      }),
      clearance: (c) => {
        const head = t(
          c.side === "front"
            ? "dc.clearance.zoneFront"
            : "dc.clearance.zoneRear",
          {
            gap: fmt.mm(c.mm),
            basis: t(`dc.clearance.basis.${c.basis}`),
            need: fmt.len(c.required),
          },
        );
        return c.split
          ? `${head}\n${clearanceSplitText({ model: c.gap.mm, tape: c.mm }, fmt, t)}`
          : head;
      },
    };
    e.setCubeLabels({
      top: t("dc.view.top"),
      bottom: t("dc.view.bottom"),
      front: t("dc.view.front"),
      back: t("dc.view.back"),
      left: t("dc.view.left"),
      right: t("dc.view.right"),
    });
    if (data) e.setModel(toModel(data, catalog));
  }, [t, i18n.language, fmt, data, catalog]);

  useEffect(() => engine.current?.setMode(mode), [mode, loaded]);
  useEffect(() => engine.current?.setTool(tool), [tool, loaded]);
  useEffect(() => engine.current?.setGrid(grid), [grid, loaded]);
  useEffect(() => {
    engine.current?.setLayers(layers);
    saveLayers(layers);
  }, [layers, loaded]);

  useEffect(() => engine.current?.setRulerMode(rulerMode), [rulerMode, loaded]);
  useEffect(() => {
    engine.current?.setHidden([...hidden]);
    saveIds(`dc.hidden.${roomId}`, hidden);
  }, [hidden, roomId, loaded]);
  useEffect(() => {
    engine.current?.setLocked([...locked]);
    saveIds(`dc.locked.${roomId}`, locked);
  }, [locked, roomId, loaded]);
  useEffect(() => engine.current?.setXray(xray), [xray, loaded]);
  useEffect(() => engine.current?.setOccluderFade(fade), [fade, loaded]);
  // What the view changed itself: a door, the section box.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.onViewState = () => setSectionOn(e.sectionBox() !== null);
  }, [loaded]);
  // The device tooltip waits for the pointer to rest (FEEDBACK-7 §4.6).
  useEffect(() => {
    const ref = hover?.ref;
    if (ref?.type !== "device") {
      setDevTip(null);
      return;
    }
    const at = { id: ref.id, x: hover!.x, y: hover!.y };
    const timer = window.setTimeout(() => setDevTip(at), 300);
    return () => window.clearTimeout(timer);
  }, [hover]);
  useEffect(() => engine.current?.setHighlight(owner), [owner, loaded, data]);

  // Where the room opens: in the drawing theme on the plan, unless the link
  // says what to show (FEEDBACK-2 §3). Once, as soon as the theme is known;
  // a theme switched later moves nothing.
  const landed = useRef(false);
  const toPlan = useRef(false);
  useEffect(() => {
    if (landed.current || !settings.ready) return;
    landed.current = true;
    if (!planByDefault(settings.theme, search, window.location.hash)) return;
    toPlan.current = true;
    const q = new URLSearchParams(search);
    q.set("view", "plan");
    setSearch(q, { replace: true });
    // Only the first render's values matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ready]);

  // The plan: orthographic, straight down, orbit off — only pan and zoom
  // (FEEDBACK-5 §4). 3D again when leaving it; a turn of the view on the
  // plan leaves it too, and flies there smoothly.
  const leaveTo = useRef<Preset | null>(null);
  useEffect(() => {
    const e = engine.current;
    if (!e || !settings.ready) return;
    // On its way to the plan: no 3D view first.
    if (!plan && toPlan.current) return;
    toPlan.current = false;
    e.setPlanLock(plan);
    if (plan) e.preset("top", 0);
    else if (leaveTo.current) {
      e.preset(leaveTo.current);
      leaveTo.current = null;
    } else if (initial.current.cam) {
      e.goView(initial.current.cam);
      initial.current.cam = null;
    } else e.preset("iso", 0);
  }, [plan, loaded, settings.ready]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.onLeavePlan = (p) => {
      leaveTo.current = p;
      const q = new URLSearchParams(search);
      q.set("view", "3d");
      navigate({ search: q.toString(), hash: window.location.hash });
    };
  }, [search, navigate, loaded]);

  // The plan is framed round its sheet corner, which shows once the legend
  // knows what is drawn: frame it again then, once per visit.
  const framedWithLegend = useRef(false);
  useEffect(() => {
    if (!plan) {
      framedWithLegend.current = false;
      return;
    }
    if (!legend || framedWithLegend.current) return;
    framedWithLegend.current = true;
    requestAnimationFrame(() => engine.current?.preset("top", 0));
  }, [plan, legend]);

  // Selection → engine, URL hash.
  useEffect(() => {
    if (!data) return;
    const full = complete(selection, data);
    engine.current?.select(full, false);
    const h = hashOf(full);
    if (h !== window.location.hash)
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${h}`,
      );
    if (!flewTo.current && full) {
      flewTo.current = true;
      setTimeout(() => engine.current?.flyTo(full), 50);
    }
  }, [selection, data]);

  // A deep link followed while the room is open selects and flies, too.
  useEffect(() => {
    const onHash = () => {
      const ref = parseHash(window.location.hash);
      if (!ref) return;
      setSelection(ref);
      setInspector({ open: true, tab: "object" });
      flewTo.current = false;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((ref: SelRef, fly = true) => {
    setSelection(ref);
    setInspector({ open: true, tab: "object" });
    if (ref && fly) setTimeout(() => engine.current?.flyTo(ref), 0);
  }, []);

  /** A clearance warning clicked: the rack selected, its gap drawn. */
  const showClearance = useCallback(
    (c: Clearance) => {
      select({ type: "object", id: c.object_id }, false);
      engine.current?.showClearance(c.object_id, c.side);
    },
    [select],
  );
  // A warning pin in the scene: the same, from the room's analysis.
  useEffect(() => {
    const e = engine.current;
    if (!e || !data) return;
    e.onPin = (id, side) => {
      if (side === "cooling") {
        select({ type: "object", id }, false);
        return;
      }
      const c = data.analysis.clearances.find(
        (x) => x.object_id === id && x.side === side,
      );
      if (c) showClearance(c);
    };
  }, [data, showClearance, select, loaded]);

  /** The link to exactly this screen. */
  const shareLink = useCallback(() => {
    const e = engine.current;
    const q = new URLSearchParams();
    if (plan) q.set("view", "plan");
    q.set("mode", mode);
    if (owner) q.set("owner", owner);
    if (e) q.set("cam", camParam(e.view()));
    return `${window.location.origin}/dc/${roomId}?${q.toString()}${hashOf(data ? complete(selection, data) : null)}`;
  }, [plan, mode, owner, roomId, selection, data]);

  // --- Writing ---
  const run = useCallback(
    async (ops: Op[], label: string): Promise<boolean> => {
      setError(null);
      setConflict(null);
      const r = await changes.apply(ops, label);
      if (r.ok) return true;
      if (r.conflict) setConflict(translateApiError(r.error, i18n.language));
      else setError(translateApiError(r.error, i18n.language));
      // Put the view back where the server says things are.
      await changes.refresh();
      return false;
    },
    [changes, i18n.language],
  );

  /**
   * What is on screen as a view: camera, mode, highlight, selection, and the
   * view state — layers, X-ray, hidden and locked objects, isolation, the
   * section box, open doors (FEEDBACK-7 §4).
   */
  const currentView = useCallback((): Omit<ViewPayload, "name" | "shared"> => {
    const e = engine.current;
    const v = e?.view() ?? {
      position: [0, 0, 0] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      fov: 45,
      ortho: false,
    };
    const r = (a: number[]) => a.map(Math.round) as [number, number, number];
    const sel = hashOf(data ? complete(selection, data) : null).slice(1);
    return {
      position: r(v.position),
      target: r(v.target),
      fov: Math.round(v.fov),
      ortho: v.ortho,
      mode,
      ...(owner ? { owner } : {}),
      ...(sel ? { selection: sel } : {}),
      state: { layers: { ...layers }, ...(e?.viewState() ?? {}) },
    };
  }, [mode, owner, selection, data, layers]);

  /** Save what is on screen, last in the tour's order. */
  const saveView = useCallback(
    async (name: string, shared: boolean) => {
      if (!engine.current) return false;
      const order =
        Math.max(
          0,
          ...(data?.annotations ?? []).map((a) =>
            a.kind === "view" ? (a.payload.order ?? 0) : 0,
          ),
        ) + 1;
      const payload: ViewPayload = { ...currentView(), name, shared, order };
      return run(
        [{ op: "annotation_create", annotation: { kind: "view", payload } }],
        t("dc.change.view", { name }),
      );
    },
    [run, currentView, data, t],
  );

  /** Small renders of the saved views, by view and revision. */
  const thumbs = useRef(new Map<string, string>());
  const viewThumb = useCallback(
    (id: number, v: ViewPayload) => {
      const e = engine.current;
      if (!e || !data) return null;
      const key = `${id}:${data.room.revision}:${mode}:${JSON.stringify([v.position, v.target, v.fov, v.ortho])}`;
      let src = thumbs.current.get(key);
      if (!src) {
        src = e.thumbnail({ ...v });
        thumbs.current.set(key, src);
      }
      return src;
    },
    [data, mode],
  );

  /**
   * Put every object back where the seed (revision 1) placed it — position
   * and rotation only; devices, cells, notes and views stay. One change set,
   * so it can be undone like any other.
   */
  const resetLayout = useCallback(async () => {
    if (!data) return;
    if (!window.confirm(t("dc.layout.resetConfirm"))) return;
    setError(null);
    let first;
    try {
      first = await dcApi.revision(roomId, 1);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    const ops: Op[] = [];
    for (const o of data.objects) {
      const was =
        first.snapshot.objects.find((x) => x.id === o.id) ??
        first.snapshot.objects.find((x) => x.name === o.name);
      if (!was) continue;
      if (
        was.x0_mm === o.x0_mm &&
        was.z0_mm === o.z0_mm &&
        was.y0_mm === o.y0_mm &&
        was.rotation_deg === o.rotation_deg
      )
        continue;
      ops.push({
        op: "object_update",
        id: o.id,
        object: {
          ...objectFields(o),
          x0_mm: was.x0_mm,
          z0_mm: was.z0_mm,
          y0_mm: was.y0_mm,
          rotation_deg: was.rotation_deg,
        },
      });
    }
    if (ops.length === 0) {
      setNotice(t("dc.layout.resetNothing"));
      return;
    }
    if (await run(ops, t("dc.layout.resetChange", { count: ops.length })))
      setNotice(t("dc.layout.resetDone", { count: ops.length }));
  }, [data, roomId, run, t]);

  /**
   * Open a saved view: its camera (flown to in `dur` ms), mode, highlight,
   * selection, and its view state — layers, X-ray, hidden and locked
   * objects, isolation, the section box, open doors (FEEDBACK-7 §4).
   */
  const openView = useCallback(
    (v: ViewPayload, dur?: number) => {
      if (v.mode) setMode(v.mode);
      setOwner(v.owner ?? null);
      setSelection(v.selection ? parseHash(`#${v.selection}`) : null);
      const s = v.state;
      if (s) {
        if (s.layers) setLayers({ ...DEFAULT_LAYERS, ...s.layers });
        setXray(!!s.xray);
        setHidden(new Set(s.hidden ?? []));
        setLocked(new Set(s.locked ?? []));
        setIsolated(s.isolate?.length ? s.isolate : null);
        engine.current?.setViewState(s);
        setSectionOn(!!s.section);
      }
      const view = {
        position: v.position,
        target: v.target,
        fov: v.fov,
        ortho: v.ortho,
      };
      // A saved view wins over the plan: one that is not a plan itself
      // leaves for 3D, where the camera effect applies it.
      const fromAbove =
        v.ortho &&
        Math.hypot(v.position[0] - v.target[0], v.position[2] - v.target[2]) <
          0.05 * Math.abs(v.position[1] - v.target[1]);
      if (plan && !fromAbove) {
        initial.current.cam = view;
        const q = new URLSearchParams(search);
        q.set("view", "3d");
        navigate({ search: q.toString(), hash: window.location.hash });
      } else engine.current?.goView(view, dur);
    },
    [plan, search, navigate, setMode],
  );

  const moveObject = useCallback(
    (id: number, x0: number, z0: number, rotation: number) => {
      const o = data?.objects.find((x) => x.id === id);
      if (!o) return;
      void run(
        [
          {
            op: "object_update",
            id,
            object: {
              ...objectFields(o),
              x0_mm: Math.round(x0),
              z0_mm: Math.round(z0),
              rotation_deg: rotation as DcObject["rotation_deg"],
            },
          },
        ],
        t("dc.change.move", { name: o.name }),
      );
    },
    [data, run, t],
  );

  useEffect(() => {
    if (engine.current)
      engine.current.onMoveCommit = canEdit ? moveObject : () => {};
  }, [moveObject, canEdit, loaded]);

  useEffect(() => engine.current?.setIsolate(isolated), [isolated, loaded]);

  /** The section tool on or off; on, with the room's box if there is none. */
  const toggleSection = useCallback(() => {
    if (tool === "section") return setTool("view");
    setTool("section");
    if (!engine.current?.sectionBox())
      engine.current?.setSection({ kind: "room" });
  }, [tool]);

  /**
   * The navigation keys (FEEDBACK-7 §4.5), as `?` lists them: the number
   * row and the numpad alike. The caller has already let a focused text
   * field keep its keys. True when the key was one of these.
   */
  const navKey = useCallback(
    (e: KeyboardEvent): boolean => {
      const en = engine.current;
      if (!en || !data) return false;
      const mod = e.ctrlKey || e.metaKey;
      const done = () => {
        e.preventDefault();
        return true;
      };
      const digit = /^(?:Digit|Numpad)([1357])$/.exec(e.code)?.[1];
      if (digit && !e.altKey && !e.shiftKey) {
        if (digit === "5") {
          if (!mod) en.setOrtho(!ortho);
          return done();
        }
        const views: Record<string, [Preset, Preset]> = {
          "1": ["front", "back"],
          "3": ["right", "left"],
          "7": ["top", "bottom"],
        };
        en.preset(views[digit][mod ? 1 : 0]);
        return done();
      }
      if (mod) return false;
      if (e.altKey) {
        if (e.code !== "KeyZ") return false;
        setXray((x) => !x);
        return done();
      }
      if (e.key === "?") {
        setKeymap((k) => !k);
        return done();
      }
      if (e.key === "Escape") {
        // Walking ends in the engine; then one thing at a time.
        if (walking) return false;
        if (keymap) setKeymap(false);
        else if (isolated) setIsolated(null);
        else if (tool !== "view") setTool("view");
        else if (selection) {
          setSelection(null);
        } else return false;
        return done();
      }
      if (e.shiftKey) {
        if (e.code !== "KeyB") return false;
        toggleSection();
        return done();
      }
      const sel = complete(selection, data);
      switch (e.code) {
        case "KeyF":
        case "Period":
        case "NumpadDecimal":
          en.frameSelection();
          return done();
        case "Home":
          en.frameAll();
          return done();
        case "Slash":
        case "NumpadDivide": {
          if (isolated) setIsolated(null);
          else if (sel)
            setIsolated([
              sel.type === "object"
                ? sel.id
                : sel.type === "device"
                  ? sel.rackId
                  : sel.shelfId,
            ]);
          return done();
        }
        case "KeyO":
          setOutliner((o) => !o);
          return done();
        case "KeyL":
          setLayersOpen((o) => !o);
          return done();
        case "KeyM":
          if (tool === "ruler") setTool("view");
          else {
            setTool("ruler");
            setInspector({ open: true, tab: "ruler" });
          }
          return done();
        case "KeyH": {
          // The owner of the device under the pointer (or the selected one).
          const id =
            en.hoveredDevice() ?? (sel?.type === "device" ? sel.id : null);
          const who = data.devices.find((d) => d.id === id)?.owner;
          if (who) setOwner((o) => (o === who ? null : who));
          return done();
        }
      }
      return false;
    },
    [data, ortho, walking, keymap, isolated, tool, selection, toggleSection],
  );

  // Keyboard: undo/redo; in edit mode, arrows nudge and R rotates.
  const nudge = useRef<{
    id: number;
    x0: number;
    z0: number;
    rot: number;
    timer: number;
  } | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        target.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]:not(.dc-keymap)",
        )
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (navKey(e)) return;
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        if (!canEdit) return;
        void (e.shiftKey ? changes.redo() : changes.undo()).then((r) => {
          if (r && !r.ok) setError(translateApiError(r.error, i18n.language));
        });
        return;
      }
      if (
        mod ||
        tool !== "edit" ||
        !canEdit ||
        selection?.type !== "object" ||
        !data
      )
        return;
      const o = data.objects.find((x) => x.id === selection.id);
      if (!o) return;
      const step = e.shiftKey ? 100 : 10;
      const cur =
        nudge.current?.id === o.id
          ? nudge.current
          : {
              id: o.id,
              x0: o.x0_mm,
              z0: o.z0_mm,
              rot: o.rotation_deg,
              timer: 0,
            };
      let changed = true;
      if (e.code === "ArrowLeft") cur.x0 -= step;
      else if (e.code === "ArrowRight") cur.x0 += step;
      else if (e.code === "ArrowUp") cur.z0 -= step;
      else if (e.code === "ArrowDown") cur.z0 += step;
      else if (e.code === "KeyR") cur.rot = (cur.rot + 90) % 360;
      else changed = false;
      if (!changed) return;
      e.preventDefault();
      engine.current?.previewMove(o.id, cur.x0, cur.z0, cur.rot);
      window.clearTimeout(cur.timer);
      // One change set per burst of key presses.
      cur.timer = window.setTimeout(() => {
        nudge.current = null;
        moveObject(cur.id, cur.x0, cur.z0, cur.rot);
      }, 450);
      nudge.current = cur;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    canEdit,
    changes,
    data,
    i18n.language,
    moveObject,
    selection,
    navKey,
    tool,
  ]);

  // --- What the command palette can do here ---
  const owners = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of data?.devices ?? [])
      if (d.owner) n.set(d.owner, (n.get(d.owner) ?? 0) + 1);
    for (const c of data?.cells ?? [])
      if (c.owner) n.set(c.owner, (n.get(c.owner) ?? 0) + 1);
    return [...n.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const objects: PaletteObject[] = [];
    const nameOf = new Map(data.objects.map((o) => [o.id, o.name]));
    for (const o of data.objects) {
      const item = catalog.get(o.catalog_id);
      let detail = item ? t(`dc.kind.${item.kind}`) : "";
      if (item?.kind === "rack") {
        const st = rackStats(
          data.devices.filter((d) => d.rack_id === o.id),
          item.props.units,
          o.contents_known,
        );
        detail = st.known
          ? `${t("dc.rack.unitsUsed", { used: st.used, total: st.units })} · ${fmt.w(st.powerW)}`
          : t("dc.rack.notRecorded");
      }
      objects.push({
        key: `o${o.id}`,
        kind: item?.kind === "rack" ? "rack" : "object",
        label: o.name,
        extra: localText(o.note, i18n.language),
        detail,
        run: () => select({ type: "object", id: o.id }),
      });
    }
    for (const d of data.devices) {
      const u =
        d.u_height > 1
          ? `U${d.u_bottom}–U${d.u_bottom + d.u_height - 1}`
          : `U${d.u_bottom}`;
      objects.push({
        key: `d${d.id}`,
        kind: "device",
        label: d.name,
        extra: `${d.serial} ${d.owner}`,
        detail: `${nameOf.get(d.rack_id) ?? ""} · ${u}`,
        run: () => select({ type: "device", id: d.id, rackId: d.rack_id }),
      });
    }
    for (const c of data.cells)
      objects.push({
        key: `c${c.shelf_id}-${c.cell_no}`,
        kind: "cell",
        label: c.name,
        extra: c.owner,
        detail: `${nameOf.get(c.shelf_id) ?? ""} · ${t("dc.shelf.cell", { n: c.cell_no })}`,
        run: () =>
          select({ type: "cell", shelfId: c.shelf_id, cellNo: c.cell_no }),
      });
    const sel = complete(selection, data);
    const selObj = sel
      ? sel.type === "object"
        ? sel.id
        : sel.type === "device"
          ? sel.rackId
          : sel.shelfId
      : null;
    const selKind =
      selObj !== null
        ? catalog.get(
            data.objects.find((o) => o.id === selObj)?.catalog_id ?? -1,
          )?.kind
        : undefined;
    shell.setRoomPalette({
      roomId,
      objects,
      owners,
      findSpace: (u, power) => {
        setCapacity({ u, power, face: "front" });
        setInspector({ open: true, tab: "capacity" });
      },
      highlight: setOwner,
      saveView: () => {
        void saveView(
          t("dc.views.defaultName", {
            date: new Date().toLocaleString(i18n.language),
          }),
          true,
        ).then((ok) => {
          if (!ok) return;
          void navigator.clipboard?.writeText(shareLink()).catch(() => {});
          setNotice(t("dc.views.savedCopied"));
        });
      },
      qr:
        selObj !== null && (selKind === "rack" || selKind === "shelf")
          ? {
              label: t("dc.qr.forObject", { name: nameOf.get(selObj) ?? "" }),
              run: () => navigate(`/dc/${roomId}/labels?object=${selObj}`),
            }
          : null,
      setMode,
    });
    return () => shell.setRoomPalette(null);
  }, [
    data,
    catalog,
    owners,
    selection,
    shell,
    roomId,
    select,
    t,
    fmt,
    saveView,
    shareLink,
    navigate,
    i18n.language,
    setMode,
  ]);

  if (room.isPending) return <Spinner />;
  if (room.error || !data)
    return (
      <div className="dc-page">
        <ErrorFlash error={errorMessage(room.error)} />
      </div>
    );

  const docked = !tokens.floating;
  const selected = complete(selection, data);
  const selObjId = selected
    ? selected.type === "object"
      ? selected.id
      : selected.type === "device"
        ? selected.rackId
        : selected.shelfId
    : null;
  const selName =
    selObjId !== null
      ? data.objects.find((o) => o.id === selObjId)?.name
      : null;
  const hoverText = hover ? describe(hover.ref, data, t) : null;
  const ownerCount = owner
    ? (owners.find((o) => o.name === owner)?.count ?? 0)
    : 0;
  const assumedCount = assumedByObject(data).size;

  const rail = (
    <div
      className="dc-rail dc-panel no-print"
      data-docked={docked}
      role="toolbar"
      aria-label={t("dc.tool.label")}
    >
      {TOOLS.filter(
        (x) =>
          canEdit ||
          x.tool === "view" ||
          x.tool === "ruler" ||
          x.tool === "section",
      ).map(({ tool: tl, icon: Icon, key }) => (
        <button
          key={tl}
          type="button"
          aria-pressed={tool === tl}
          title={`${t(`dc.tool.${tl}`)}${key ? ` (${key})` : ""} — ${t(`dc.tool.${tl}Hint`)}`}
          aria-label={t(`dc.tool.${tl}`)}
          onClick={() => {
            if (tl === "section") return toggleSection();
            setTool(tl);
            if (tl === "ruler") setInspector({ open: true, tab: "ruler" });
          }}
        >
          <Icon className="size-[18px]" />
        </button>
      ))}
      <hr />
      <button
        type="button"
        aria-pressed={outliner}
        title={`${t("dc.rail.outliner")} (O)`}
        aria-label={t("dc.rail.outliner")}
        data-testid="outliner-button"
        onClick={() => setOutliner((o) => !o)}
      >
        <ListTree className="size-[18px]" />
      </button>
      <button
        type="button"
        aria-pressed={xray}
        title={`${t("dc.rail.xray")} (Alt+Z)`}
        aria-label={t("dc.rail.xray")}
        onClick={() => setXray((x) => !x)}
      >
        <ScanEye className="size-[18px]" />
      </button>
      <DropdownMenu open={layersOpen} onOpenChange={setLayersOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={`${t("dc.layer.button")} (L)`}
            aria-label={t("dc.layer.button")}
            data-testid="layers"
          >
            <LayersIcon className="size-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuLabel>{t("dc.layer.button")}</DropdownMenuLabel>
          {LAYER_KEYS.map((k) => (
            <DropdownMenuCheckboxItem
              key={k}
              checked={layers[k]}
              onCheckedChange={(v) =>
                setLayers((l) => ({ ...l, [k]: v === true }))
              }
              onSelect={(e) => e.preventDefault()}
            >
              {t(`dc.layer.${k}`)}
              {k === "assumptions" && assumedCount > 0 && ` (${assumedCount})`}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const inspectorEl = inspector.open && (
    <Inspector
      docked={docked}
      tab={inspector.tab}
      onTab={(tab) => setInspector({ open: true, tab })}
      onClose={() => setInspector((s) => ({ ...s, open: false }))}
      data={data}
      catalog={catalog}
      selection={selected}
      canEdit={canEdit}
      editTool={tool === "edit"}
      warnings={changes.warnings}
      prefill={prefill}
      onPrefillUsed={() => setPrefill(null)}
      onSelect={select}
      onClearance={showClearance}
      run={run}
      problemsOf={(id) => engine.current?.problemsOf(id) ?? []}
      capacity={capacity}
      onCapacityPick={(c, req) => {
        select({ type: "object", id: c.rack_id });
        setPrefill({
          rackId: c.rack_id,
          u: c.suggestion.from,
          height: req.u,
          face: req.face,
          power: req.power,
        });
      }}
      onFindSpace={() => setInspector({ open: true, tab: "capacity" })}
      onImport={() => setImportOpen(true)}
      settingsOpen={settingsOpen}
      onSettingsOpen={setSettingsOpen}
      past={rev !== null}
      saveView={saveView}
      openView={openView}
      currentView={currentView}
      viewThumb={viewThumb}
      startTour={() => setTour(true)}
      copyLink={() =>
        void navigator.clipboard?.writeText(shareLink()).then(
          () => setNotice(t("dc.views.linkCopied")),
          () => setNotice(shareLink()),
        )
      }
      ruler={{
        mode: rulerMode,
        setMode: setRulerMode,
        measures,
        clear: () => engine.current?.clearMeasures(),
        setEnd: (i, end, p) => engine.current?.setMeasureEnd(i, end, p),
        text: (r) => rulerText(r, fmt, t, (k): string => t(`dc.snap.${k}`)),
      }}
    />
  );

  return (
    <div
      className="dc-body"
      data-plan={plan}
      data-docked={docked}
      data-tour={tour}
    >
      {docked && rail}
      <div
        ref={host}
        className="dc-viewport"
        aria-label={t("dc.canvasLabel")}
        data-outliner={outliner}
        data-inspector={inspector.open}
      >
        {!docked && rail}
        <div className="dc-chips no-print">
          {selName && (
            <div className="dc-chip dc-panel" data-testid="breadcrumb">
              <button type="button" onClick={() => select(null, false)}>
                {data.room.name}
              </button>
              <span style={{ color: "var(--dc-muted)" }}>›</span>
              <b>{selName}</b>
            </div>
          )}
          {rev !== null && (
            <div className="dc-chip dc-panel" role="status">
              {t("dc.past.chip", { n: rev })}
              <Link className="underline" to={`/dc/${roomId}?view=3d`}>
                {t("dc.past.back")}
              </Link>
            </div>
          )}
          {owner && (
            <div className="dc-chip dc-panel" role="status">
              {t("dc.highlight.label")}
              <mark>
                {owner} · {t("dc.palette.ownerCount", { count: ownerCount })}
              </mark>
              <button
                type="button"
                aria-label={t("dc.highlight.clear")}
                title={t("dc.highlight.clear")}
                onClick={() => setOwner(null)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {isolated && (
            <div
              className="dc-chip dc-panel dc-banner"
              role="status"
              data-testid="isolate-banner"
            >
              {t("dc.isolate.banner")}
            </div>
          )}
          {(tool === "section" || sectionOn) && (
            <SectionPanel
              fmt={fmt}
              on={sectionOn}
              onSection={(s) => {
                engine.current?.setSection(s);
                if (s === null && tool === "section") setTool("view");
              }}
            />
          )}
          {walking && (
            <div className="dc-chip dc-panel">{t("dc.walk.help")}</div>
          )}
          <ModeLegend
            mode={mode}
            data={data}
            tokens={tokens}
            fmt={fmt}
            onSetBudget={
              canEdit
                ? () => {
                    select(null, false);
                    setSettingsOpen(true);
                  }
                : undefined
            }
          />
          {(error || conflict || changes.notice || notice) && (
            <div className="max-w-[460px]">
              {conflict && (
                <Flash kind="error">
                  {t("dc.conflict.title")} {conflict}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setConflict(null)}
                  >
                    {t("common.close")}
                  </button>
                </Flash>
              )}
              {changes.notice && (
                <Flash kind="ok">{t("dc.conflict.reapplied")}</Flash>
              )}
              {notice && (
                <Flash kind="ok">
                  {notice}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setNotice(null)}
                  >
                    {t("common.close")}
                  </button>
                </Flash>
              )}
              <ErrorFlash error={error} />
            </div>
          )}
        </div>

        {plan && (
          <>
            <div className="dc-plan-corner">
              {hasLegend(legend) && (
                <PlanLegend
                  marks={legend}
                  fmt={fmt}
                  collapsed={settings.settings.dc_legend_collapsed}
                  onCollapsed={settings.setLegendCollapsed}
                />
              )}
              <div className="dc-titleblock dc-panel">
                <div>{data.room.name}</div>
                <div>
                  <span>{t("dc.plan.sheet")}</span>
                  <span className="dc-num">
                    {new Date().toLocaleDateString(i18n.language)}
                  </span>
                </div>
                <div>
                  <span>{t("dc.plan.units", { unit: fmt.unitWord })}</span>
                  <span className="dc-num">
                    {t("dc.revision", { n: data.room.revision })}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {devTip ? (
          <DeviceTip
            id={devTip.id}
            x={devTip.x}
            y={devTip.y}
            data={data}
            fmt={fmt}
          />
        ) : (
          hover &&
          hover.ref?.type !== "device" &&
          hoverText && (
            <div
              className="dc-tooltip"
              style={{ left: hover.x + 14, top: hover.y + 14 }}
            >
              {hoverText}
            </div>
          )
        )}
        {outliner && (
          <Outliner
            data={data}
            catalog={catalog}
            selection={selected}
            hidden={hidden}
            locked={locked}
            onSelect={(ref) => select(ref, true)}
            onHidden={(id) =>
              setHidden((s) => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onLocked={(id) =>
              setLocked((s) => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onHighlight={(o) => setOwner((cur) => (cur === o ? null : o))}
            onClose={() => setOutliner(false)}
          />
        )}
        {keymap && <KeymapHelp onClose={() => setKeymap(false)} />}
        {tour && (
          <Tour
            views={viewsInOrder(data).map((x) => x.v)}
            show={(v) => openView(v, 1200)}
            onEnd={() => setTour(false)}
          />
        )}
        <StatusBar
          data={data}
          catalog={catalog}
          selection={selected}
          tool={tool}
          plan={plan}
          walking={walking}
          cursor={cursor}
          fmt={fmt}
        />
        {notePos && (
          <NotePrompt
            onCancel={() => setNotePos(null)}
            onSave={async (text) => {
              const ok = await run(
                [
                  {
                    op: "annotation_create",
                    annotation: {
                      kind: "note",
                      payload: { position: notePos, text },
                    },
                  },
                ],
                t("dc.change.note"),
              );
              if (ok) setNotePos(null);
            }}
          />
        )}

        {!docked && inspectorEl}
        {!inspector.open && (
          <button
            type="button"
            className="dc-panel dc-chip"
            style={{ position: "absolute", top: 14, right: 14, zIndex: 6 }}
            onClick={() => setInspector((s) => ({ ...s, open: true }))}
          >
            {t("dc.inspector.open")}
          </button>
        )}

        <div className="dc-modebar dc-panel no-print">
          <div
            className="dc-seg"
            role="radiogroup"
            aria-label={t("dc.mode.label")}
          >
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                title={t(`dc.mode.${m}`)}
                onClick={() => setMode(m)}
              >
                {t(`dc.mode.${m}`)}
              </button>
            ))}
          </div>
          <span className="sep" />
          <div
            className="dc-seg"
            role="group"
            aria-label={t("dc.view.presets")}
          >
            {VIEWS.map((p) => (
              <button
                key={p}
                type="button"
                title={
                  p === "top"
                    ? t("dc.bar.key", { label: t(`dc.view.${p}`), key: 7 })
                    : t(`dc.view.${p}`)
                }
                onClick={() => engine.current?.preset(p)}
              >
                {t(`dc.view.${p}`)}
              </button>
            ))}
          </div>
          {tool === "edit" && (
            <select
              className="rounded bg-transparent px-1 py-1 text-xs"
              value={grid}
              aria-label={t("dc.grid")}
              onChange={(e) => setGrid(Number(e.target.value))}
            >
              {GRIDS.map((g) => (
                <option key={g} value={g}>
                  {t("dc.grid")} {fmt.mm(g)}
                </option>
              ))}
            </select>
          )}
          {canEdit && (
            <>
              <span className="sep" />
              <IconButton
                label={t("dc.bar.key", {
                  label: changes.undoLabel
                    ? t("dc.undo", { what: changes.undoLabel })
                    : t("dc.undoNothing"),
                  key: "Ctrl+Z",
                })}
                disabled={!changes.canUndo || changes.pending}
                onClick={() =>
                  void changes
                    .undo()
                    .then(
                      (r) =>
                        r &&
                        !r.ok &&
                        setError(translateApiError(r.error, i18n.language)),
                    )
                }
              >
                <Undo2 className="size-4" />
              </IconButton>
              <IconButton
                label={t("dc.bar.key", {
                  label: changes.redoLabel
                    ? t("dc.redo", { what: changes.redoLabel })
                    : t("dc.redoNothing"),
                  key: "Ctrl+Shift+Z",
                })}
                disabled={!changes.canRedo || changes.pending}
                onClick={() =>
                  void changes
                    .redo()
                    .then(
                      (r) =>
                        r &&
                        !r.ok &&
                        setError(translateApiError(r.error, i18n.language)),
                    )
                }
              >
                <Redo2 className="size-4" />
              </IconButton>
            </>
          )}
          <span className="sep" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="dc-bar-btn">
                {t("dc.bar.export")} <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => savePng(engine.current, data.room.name)}
              >
                {t("dc.export.png")}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={dcApi.exportDxf(roomId)} download>
                  {t("dc.export.dxf")}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={dcApi.exportCsv(roomId)} download>
                  {t("dc.export.csv")}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={`/dc/${roomId}/labels`}>{t("dc.qr.all")}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="dc-bar-btn"
                title={t("dc.bar.more")}
                aria-label={t("dc.bar.more")}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                  {t("dc.bar.importCsv")}
                </DropdownMenuItem>
              )}
              {canEdit && (
                <DropdownMenuItem
                  disabled={changes.pending}
                  onSelect={() => void resetLayout()}
                >
                  {t("dc.bar.reset")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link to={`/dc/${roomId}/history`}>{t("dc.bar.history")}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setInspector({ open: true, tab: "views" })}
              >
                {t("dc.bar.views")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <ToggleItem
                  checked={ortho}
                  label={t("dc.bar.ortho")}
                  shortcut="5"
                  onToggle={() => engine.current?.setOrtho(!ortho)}
                />
                <ToggleItem
                  checked={walking}
                  label={t("dc.bar.walk")}
                  onToggle={() => engine.current?.setWalk(!walking)}
                />
                <ToggleItem
                  checked={xray}
                  label={t("dc.rail.xray")}
                  shortcut="Alt+Z"
                  onToggle={() => setXray((x) => !x)}
                />
                <ToggleItem
                  checked={fade}
                  label={t("dc.fade")}
                  onToggle={() => setFade((f) => !f)}
                />
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {docked && inspectorEl}

      {importOpen && (
        <ImportDialog
          roomId={roomId}
          revision={data.room.revision}
          onClose={() => setImportOpen(false)}
          onDone={() => void changes.refresh()}
        />
      )}
    </div>
  );
}

/** `face ⟂ face · 59.5 cm (z)`, in the user's language and unit. */
export function rulerText(
  r: Measure,
  fmt: Fmt,
  t: TFunction,
  snapWord: (k: SnapKind) => string,
): string {
  const how =
    r.how === "face_face"
      ? t("dc.ruler.faceFace")
      : r.how === "object_gap"
        ? t("dc.ruler.objectGap")
        : `${snapWord(r.kinds[0])} → ${snapWord(r.kinds[1])}`;
  const axis = r.axis === null ? "" : ` (${"xyz"[r.axis]})`;
  return `${how} · ${fmt.mm(Math.round(r.distance))}${axis}`;
}

function IconButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="dc-icon-btn"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NotePrompt({
  onSave,
  onCancel,
}: {
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <form
      className="dc-note-prompt dc-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void onSave(text.trim());
      }}
    >
      <label className="text-xs font-medium" htmlFor="dc-note">
        {t("dc.note.prompt")}
      </label>
      <textarea
        id="dc-note"
        autoFocus
        rows={3}
        className="w-full rounded border bg-transparent p-1 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="dc-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          className="dc-btn dc-btn-primary"
          disabled={!text.trim()}
        >
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

/** The model the engine draws. */
export function toModel(
  data: RoomData,
  catalog: Map<number, CatalogItem>,
): EngineModel {
  return {
    room: data.room,
    catalog,
    objects: data.objects,
    devices: data.devices,
    cells: data.cells,
    blocked: data.analysis.blocked_cells,
    annotations: data.annotations,
    assumed: assumedByObject(data),
  };
}

function describe(ref: SelRef, data: RoomData, t: TFunction): string | null {
  if (!ref) return null;
  if (ref.type === "device") {
    const d = data.devices.find((x) => x.id === ref.id);
    if (!d) return null;
    const units =
      d.u_height > 1
        ? `U${d.u_bottom}–${d.u_bottom + d.u_height - 1}`
        : `U${d.u_bottom}`;
    return `${d.name} · ${units} · ${t(`dc.face.${d.face}`)}${d.owner ? ` · ${d.owner}` : ""}`;
  }
  if (ref.type === "cell") {
    if (data.analysis.blocked_cells[String(ref.shelfId)]?.includes(ref.cellNo))
      return t("dc.shelf.blocked", { n: ref.cellNo });
    const c = data.cells.find(
      (x) => x.shelf_id === ref.shelfId && x.cell_no === ref.cellNo,
    );
    return c
      ? `${t("dc.shelf.cell", { n: ref.cellNo })}: ${c.name}${c.owner ? ` · ${c.owner}` : ""}`
      : t("dc.shelf.cellEmpty", { n: ref.cellNo });
  }
  return data.objects.find((o) => o.id === ref.id)?.name ?? null;
}

/** The current view as a PNG, with its labels. */
function savePng(engine: DcEngine | null, name: string) {
  if (!engine) return;
  const a = document.createElement("a");
  a.href = engine.snapshotPng();
  a.download = `${name}.png`;
  a.click();
}

/**
 * A rack's compact label in the fill and power modes (FEEDBACK-7 §1.4,
 * §1.7): «31/42U · 9 кВт»; in power the known kilowatts, and how many
 * devices have no data on a line of its own — never a sum that looks whole.
 */
export function rackLabel(
  s: RackStats,
  mode: "fill" | "power",
  fmt: Fmt,
  t: TFunction,
): string {
  if (!s.known) return t("dc.rack.notRecorded");
  const kw = fmt.kw(s.powerW);
  if (mode === "fill")
    return `${s.used}/${s.units}U${s.powerW ? ` · ${kw}` : ""}`;
  if (!s.unknownPower) return `${s.used}/${s.units}U · ${kw}`;
  return `${t("dc.rack.powerKnown", { kw })}\n${t("dc.rack.noData", { count: s.unknownPower })}`;
}

/**
 * The tooltip of a device under the pointer (FEEDBACK-7 §4.6): name, kind,
 * U range, power with its source, owner; `H` highlights the owner.
 */
function DeviceTip({
  id,
  x,
  y,
  data,
  fmt,
}: {
  id: number;
  x: number;
  y: number;
  data: RoomData;
  fmt: Fmt;
}) {
  const { t } = useTranslation();
  const d = data.devices.find((v) => v.id === id);
  if (!d) return null;
  const units =
    d.u_height > 1
      ? `U${d.u_bottom}–${d.u_bottom + d.u_height - 1}`
      : `U${d.u_bottom}`;
  return (
    <div
      className="dc-tooltip dc-devtip"
      style={{ left: x + 14, top: y + 14 }}
      data-testid="device-tip"
    >
      <b>{d.name}</b>
      <span>
        {t(`dc.deviceKind.${d.kind}`)} · {units} · {t(`dc.face.${d.face}`)}
      </span>
      <span>
        {d.power_w !== null
          ? `${fmt.w(d.power_w)}${d.power_src ? ` · ${t(`dc.powerSrc.${d.power_src}`)}` : ""}`
          : t("dc.hoverDevice.noPower")}
      </span>
      {d.owner && <span>{d.owner}</span>}
      {d.owner && <small>{t("dc.hoverDevice.highlight")}</small>}
    </div>
  );
}

/**
 * A toggle in the «⋯» menu (FEEDBACK-7 §1.6): a real check mark when on,
 * the label, and its shortcut on the right — set apart from the actions.
 */
function ToggleItem({
  checked,
  label,
  shortcut,
  onToggle,
}: {
  checked: boolean;
  label: string;
  shortcut?: string;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      className="dc-toggle-item"
      onSelect={(e) => {
        e.preventDefault();
        onToggle();
      }}
    >
      <span className="dc-toggle-check">
        {checked && <Check className="size-4" />}
      </span>
      {label}
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}
