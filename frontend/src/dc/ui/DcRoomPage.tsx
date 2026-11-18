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
 * opens exactly what the sender saw (§11.4).
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
import {
  Box,
  Download,
  Eye,
  EyeOff,
  Footprints,
  History,
  MapPin,
  MousePointer2,
  Move,
  Redo2,
  RotateCcw,
  Ruler,
  Tag,
  Undo2,
  Upload,
  X,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  type EngineModel,
  type Measure,
  type Mode,
  type RulerMode,
  type SelRef,
  type Tool,
} from "../engine/DcEngine";
import type { Preset, View } from "../engine/camera";
import type { Fmt } from "../format";
import { useChanges, useRoom } from "../hooks";
import { rackStats } from "../model/devices";
import { difference, disagrees, isRange } from "../model/measure";
import type { SnapKind } from "../model/ruler";
import { useDcSettings, useFmt } from "../settings";
import { TOKENS } from "../theme/tokens";
import type {
  CatalogItem,
  DcObject,
  Measurement,
  Op,
  RoomData,
  ViewPayload,
} from "../types";
import type { CapacityRequest } from "./CapacityPanel";
import type { PaletteObject } from "./CommandPalette";
import { useShell } from "./DcShell";
import { ImportDialog } from "./ImportDialog";
import { Inspector, type InspectorTab } from "./Inspector";
import { planByDefault } from "./landing";
import { assumedByObject, objectFields } from "../model/objects";
import { measureLabel } from "./measureLabel";

const MODES: Mode[] = ["schema", "realistic", "fill", "power"];
const TOOLS: { tool: Tool; icon: typeof Eye }[] = [
  { tool: "view", icon: MousePointer2 },
  { tool: "edit", icon: Move },
  { tool: "ruler", icon: Ruler },
  { tool: "note", icon: MapPin },
];
const GRIDS = [5, 10, 50, 100];
const VIEWS: Preset[] = ["iso", "top", "aisle", "racks"];

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
  if (m.note) lines.push(m.note);
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
  const canEdit = tools.can("dc_room", "edit");
  const room = useRoom(roomId);
  const data = room.data;
  const changes = useChanges(roomId, data);

  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<DcEngine | null>(null);
  const initial = useRef({
    mode: search.get("mode"),
    owner: search.get("owner"),
    cam: parseCam(search.get("cam")),
    tool: search.get("tool"),
  });
  const [mode, setMode] = useState<Mode>(() =>
    MODES.includes(initial.current.mode as Mode)
      ? (initial.current.mode as Mode)
      : "schema",
  );
  const [tool, setTool] = useState<Tool>(() =>
    initial.current.tool === "ruler" ? "ruler" : "view",
  );
  const [rulerMode, setRulerMode] = useState<RulerMode>("points");
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [grid, setGrid] = useState(10);
  const [ortho, setOrtho] = useState(false);
  const [walking, setWalking] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
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
  const [notePos, setNotePos] = useState<[number, number, number] | null>(null);
  const [prefill, setPrefill] = useState<{
    rackId: number;
    u: number;
    height: number;
    face: "front" | "rear" | "both";
    power: number | null;
  } | null>(null);
  const flewTo = useRef(false);

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
        notRecorded: "",
        assumed: "",
        units: () => "",
        powerW: () => "",
        unknownPower: "",
        mm: String,
        range: (a, b) => `${a}–${b}`,
        measurement: (m) => ({ text: String(m.value), title: "", mark: false }),
        ruler: (r) => String(r.distance),
        snap: (k) => k,
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
      notRecorded: t("dc.rack.notRecorded"),
      assumed: t("dc.measure.assumedShort"),
      units: (used, total) => t("dc.rack.unitsUsed", { used, total }),
      powerW: (w) => fmt.w(w),
      unknownPower: t("dc.rack.someUnknown"),
      mm: fmt.mm,
      range: fmt.range,
      measurement: (m) => measurementText(m, fmt, t),
      ruler: (r) => rulerText(r, fmt, t, snapWord),
      snap: snapWord,
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
  }, [t, fmt, data, catalog]);

  useEffect(() => engine.current?.setMode(mode), [mode, loaded]);
  useEffect(() => engine.current?.setTool(tool), [tool, loaded]);
  useEffect(() => engine.current?.setGrid(grid), [grid, loaded]);
  useEffect(
    () => engine.current?.setShowAssumptions(showAssumptions),
    [showAssumptions, loaded],
  );
  useEffect(
    () => engine.current?.setLabelsVisible(showLabels),
    [showLabels, loaded],
  );
  useEffect(() => engine.current?.setRulerMode(rulerMode), [rulerMode, loaded]);
  useEffect(() => engine.current?.setHighlight(owner), [owner, loaded, data]);

  // Where the room opens: in Чертёж on the plan, unless the link says what
  // to show (FEEDBACK-2 §3). Once, as soon as the theme is known; a theme
  // switched later moves nothing.
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

  // The plan: orthographic from above; 3D again when leaving it.
  useEffect(() => {
    const e = engine.current;
    if (!e || !settings.ready) return;
    // On its way to the plan: no 3D view first.
    if (!plan && toPlan.current) return;
    toPlan.current = false;
    if (plan) e.preset("top", 0);
    else if (initial.current.cam) {
      e.goView(initial.current.cam);
      initial.current.cam = null;
    } else e.preset("iso", 0);
  }, [plan, loaded, settings.ready]);

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

  /** The link to exactly this screen. */
  const shareLink = useCallback(() => {
    const e = engine.current;
    const q = new URLSearchParams();
    if (plan) q.set("view", "plan");
    if (mode !== "schema") q.set("mode", mode);
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

  /** Save what is on screen — camera, mode, highlight, selection. */
  const saveView = useCallback(
    async (name: string, shared: boolean) => {
      const e = engine.current;
      if (!e) return false;
      const v = e.view();
      const r = (a: number[]) => a.map(Math.round) as [number, number, number];
      const sel = hashOf(data ? complete(selection, data) : null).slice(1);
      const payload: ViewPayload = {
        name,
        position: r(v.position),
        target: r(v.target),
        fov: Math.round(v.fov),
        ortho: v.ortho,
        mode,
        shared,
        ...(owner ? { owner } : {}),
        ...(sel ? { selection: sel } : {}),
      };
      return run(
        [{ op: "annotation_create", annotation: { kind: "view", payload } }],
        t("dc.change.view", { name }),
      );
    },
    [run, mode, owner, selection, data, t],
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

  const openView = useCallback((v: ViewPayload) => {
    if (v.mode) setMode(v.mode);
    setOwner(v.owner ?? null);
    if (v.selection) setSelection(parseHash(`#${v.selection}`));
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
    } else engine.current?.goView(view);
  }, [plan, search, navigate]);

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
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        )
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
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
  }, [canEdit, changes, data, i18n.language, moveObject, selection, tool]);

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
        extra: o.note,
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
        (x) => canEdit || x.tool === "view" || x.tool === "ruler",
      ).map(({ tool: tl, icon: Icon }) => (
        <button
          key={tl}
          type="button"
          aria-pressed={tool === tl}
          title={`${t(`dc.tool.${tl}`)} — ${t(`dc.tool.${tl}Hint`)}`}
          aria-label={t(`dc.tool.${tl}`)}
          onClick={() => {
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
        aria-pressed={showLabels}
        title={t("dc.labels.toggle")}
        aria-label={t("dc.labels.toggle")}
        onClick={() => setShowLabels((v) => !v)}
      >
        <Tag className="size-[18px]" />
      </button>
      <button
        type="button"
        aria-pressed={showAssumptions}
        title={`${t("dc.assumptions.toggle")} (${assumedCount})`}
        aria-label={t("dc.assumptions.toggle")}
        onClick={() => setShowAssumptions((v) => !v)}
      >
        {showAssumptions ? (
          <Eye className="size-[18px]" />
        ) : (
          <EyeOff className="size-[18px]" />
        )}
      </button>
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
      saveView={saveView}
      openView={openView}
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
    <div className="dc-body" data-plan={plan}>
      {docked && rail}
      <div ref={host} className="dc-viewport" aria-label={t("dc.canvasLabel")}>
        {!docked && rail}
        <div className="dc-chips no-print">
          <div className="dc-chip dc-panel">
            <button type="button" onClick={() => select(null, false)}>
              {data.room.name}
            </button>
            {selName && (
              <>
                <span style={{ color: "var(--dc-muted)" }}>›</span>
                <b>{selName}</b>
              </>
            )}
          </div>
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
          {walking && (
            <div className="dc-chip dc-panel">{t("dc.walk.help")}</div>
          )}
          {(mode === "fill" || mode === "power") && (
            <div className="dc-chip dc-panel">
              {mode === "fill"
                ? t("dc.legend.fill")
                : data.room.settings.rack_power_budget_w === null
                  ? t("dc.legend.powerNoBudget")
                  : t("dc.legend.power", {
                      w: fmt.w(data.room.settings.rack_power_budget_w),
                    })}
            </div>
          )}
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
            <div className="dc-legend-sheet dc-panel">
              <div>— — — {t("dc.plan.overhead")}</div>
              <div>
                <span
                  className="mr-1 inline-block size-1.5 rounded-full align-middle"
                  style={{ background: "var(--dc-warn)" }}
                />{" "}
                {t("dc.plan.tapeDiffers")}
              </div>
              <div>
                <span
                  className="mr-1 inline-block h-1.5 w-3 align-middle"
                  style={{ background: "var(--dc-warn)", opacity: 0.4 }}
                />{" "}
                {t("dc.plan.clearance")}
              </div>
            </div>
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
          </>
        )}

        <div className="dc-coords">
          {cursor
            ? `x ${fmt.mm(cursor.x)} · z ${fmt.mm(cursor.z)}`
            : t("dc.revision", { n: data.room.revision })}
        </div>

        {hover && hoverText && (
          <div
            className="dc-tooltip"
            style={{ left: hover.x + 14, top: hover.y + 14 }}
          >
            {hoverText}
          </div>
        )}
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
                onClick={() => engine.current?.preset(p)}
              >
                {t(`dc.view.${p}`)}
              </button>
            ))}
          </div>
          <span className="sep" />
          <IconButton
            label={`${ortho ? t("dc.view.ortho") : t("dc.view.persp")} — ${t("dc.view.projectionHint")}`}
            pressed={ortho}
            onClick={() => engine.current?.setOrtho(!ortho)}
          >
            <Box className="size-4" />
          </IconButton>
          <IconButton
            label={`${t("dc.walk.label")} — ${t("dc.walk.hint")}`}
            pressed={walking}
            onClick={() => engine.current?.setWalk(!walking)}
          >
            <Footprints className="size-4" />
          </IconButton>
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
              <IconButton
                label={
                  changes.undoLabel
                    ? t("dc.undo", { what: changes.undoLabel })
                    : t("dc.undoNothing")
                }
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
                label={
                  changes.redoLabel
                    ? t("dc.redo", { what: changes.redoLabel })
                    : t("dc.redoNothing")
                }
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="grid size-8 place-items-center"
                title={t("dc.export.label")}
                aria-label={t("dc.export.label")}
              >
                <Download className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
              <DropdownMenuItem
                onSelect={() => savePng(engine.current, data.room.name)}
              >
                {t("dc.export.png")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to={`/dc/${roomId}/labels`}>{t("dc.qr.all")}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canEdit && (
            <IconButton
              label={t("dc.layout.reset")}
              disabled={changes.pending}
              onClick={() => void resetLayout()}
            >
              <RotateCcw className="size-4" />
            </IconButton>
          )}
          {canEdit && (
            <IconButton
              label={t("dc.import.button")}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
            </IconButton>
          )}
          <Link
            to={`/dc/${roomId}/history`}
            className="grid size-8 place-items-center"
            title={t("dc.history.button")}
            aria-label={t("dc.history.button")}
          >
            <History className="size-4" />
          </Link>
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

/** `face ⟂ face · 59,5 см (z)`. */
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
