/**
 * `/dc/:roomId` — the room in 3D with its panels.
 *
 * React owns the toolbar, panels, forms and routing; the 3D view is a
 * `DcEngine` created once per mount and fed through its narrow interface
 * (`setModel`, `select`, `setMode`, `setTool`). Selection is mirrored in the
 * URL hash (`#obj-12`, `#device-7`, `#cell-5-16`) so a link opens the room
 * with the thing selected and in view.
 */

import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Box,
  Download,
  Eye,
  Footprints,
  History,
  LayoutGrid,
  Library,
  MapPin,
  Move,
  Redo2,
  Ruler,
  Undo2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/client";
import { useToolAccess } from "../../auth/useToolAccess";
import { ErrorFlash, Flash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import { DcEngine, type EngineModel, type Mode, type SelRef, type Tool } from "../engine/DcEngine";
import type { Preset } from "../engine/camera";
import { makeFmt } from "../format";
import { useChanges, useRoom } from "../hooks";
import type { CatalogItem, DcObject, Op, RoomData } from "../types";
import { CapacityPanel } from "./CapacityPanel";
import { ImportDialog } from "./ImportDialog";
import { MeasurementsPanel, assumedByObject } from "./MeasurementsPanel";
import { SelectionPanel } from "./SelectionPanel";
import { SearchBox } from "./SearchBox";
import { ViewsPanel } from "./ViewsPanel";

const MODES: Mode[] = ["schema", "realistic", "fill", "power"];
const TOOLS: { tool: Tool; icon: typeof Eye }[] = [
  { tool: "view", icon: Eye },
  { tool: "edit", icon: Move },
  { tool: "ruler", icon: Ruler },
  { tool: "note", icon: MapPin },
];
const GRIDS = [5, 10, 50, 100];
const PRESETS: Preset[] = ["iso", "top", "front", "back", "left", "right"];

function parseHash(hash: string): SelRef {
  let m = hash.match(/^#obj-(\d+)$/);
  if (m) return { type: "object", id: Number(m[1]) };
  m = hash.match(/^#device-(\d+)$/);
  if (m) return { type: "device", id: Number(m[1]), rackId: -1 };
  m = hash.match(/^#cell-(\d+)-(\d+)$/);
  if (m) return { type: "cell", shelfId: Number(m[1]), cellNo: Number(m[2]) };
  return null;
}

function hashOf(ref: SelRef): string {
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

export function objectFields(o: DcObject): Omit<DcObject, "id"> {
  const { id: _id, ...rest } = o;
  void _id;
  return rest;
}

export function DcRoomPage() {
  const { roomId: param } = useParams();
  const roomId = Number(param);
  const { t, i18n } = useTranslation();
  const fmt = useMemo(() => makeFmt(t, i18n.language), [t, i18n.language]);
  const tools = useToolAccess();
  const canEdit = tools.can("dc_room", "edit");
  const room = useRoom(roomId);
  const data = room.data;
  const changes = useChanges(roomId, data);

  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<DcEngine | null>(null);
  const [mode, setMode] = useState<Mode>("schema");
  const [tool, setTool] = useState<Tool>("view");
  const [grid, setGrid] = useState(10);
  const [ortho, setOrtho] = useState(false);
  const [walking, setWalking] = useState(false);
  const [selection, setSelection] = useState<SelRef>(() => parseHash(window.location.hash));
  const [hover, setHover] = useState<{ ref: SelRef; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [tab, setTab] = useState("selection");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [notePos, setNotePos] = useState<[number, number, number] | null>(null);
  const [prefill, setPrefill] = useState<{ rackId: number; u: number; height: number; face: "front" | "rear" | "both"; power: number | null } | null>(null);
  const flewTo = useRef(false);

  const catalog = useMemo(() => new Map<number, CatalogItem>((data?.catalog ?? []).map((c) => [c.id, c])), [data]);

  useEffect(() => {
    document.title = t("docTitle", { page: data?.room.name ?? t("dc.title"), app: t("app.name") });
  }, [t, data?.room.name]);

  // --- The engine: created once the canvas host exists (after the room has
  // loaded), then fed through its interface ---
  const loaded = !!data;
  useEffect(() => {
    if (!loaded || !host.current) return;
    const e = new DcEngine(host.current, {
      notRecorded: "",
      assumed: "",
      units: () => "",
      powerW: () => "",
      unknownPower: "",
      mm: (v) => String(v),
      range: (a, b) => `${a}–${b}`,
    });
    engine.current = e;
    e.onSelect = (ref) => {
      setSelection(ref);
      if (ref) setTab("selection");
    };
    e.onHover = (ref, x, y) => setHover(ref ? { ref, x, y } : null);
    e.onCursor = setCursor;
    e.onWalk = setWalking;
    e.onProjection = setOrtho;
    e.onPlaceNote = (p) => setNotePos(p);
    return () => {
      e.dispose();
      engine.current = null;
    };
  }, [loaded]);

  // Words the engine draws, in the current language.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.text = {
      notRecorded: t("dc.rack.notRecorded"),
      assumed: t("dc.measure.assumedShort"),
      units: (used, total) => t("dc.rack.unitsUsed", { used, total }),
      powerW: (w) => fmt.w(w),
      unknownPower: t("dc.rack.someUnknown"),
      mm: fmt.mm,
      range: fmt.range,
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

  // Selection → engine, URL hash.
  useEffect(() => {
    if (!data) return;
    const full = complete(selection, data);
    engine.current?.select(full, false);
    const h = hashOf(full);
    if (h !== window.location.hash) history.replaceState(null, "", h || window.location.pathname);
    // A deep link: fly there once the room has loaded.
    if (!flewTo.current && full) {
      flewTo.current = true;
      setTimeout(() => engine.current?.flyTo(full), 50);
    }
  }, [selection, data]);

  const select = useCallback((ref: SelRef, fly = true) => {
    setSelection(ref);
    setTab("selection");
    if (ref && fly) setTimeout(() => engine.current?.flyTo(ref), 0);
  }, []);

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

  const moveObject = useCallback(
    (id: number, x0: number, z0: number, rotation: number) => {
      const o = data?.objects.find((x) => x.id === id);
      if (!o) return;
      void run(
        [{ op: "object_update", id, object: { ...objectFields(o), x0_mm: Math.round(x0), z0_mm: Math.round(z0), rotation_deg: rotation as DcObject["rotation_deg"] } }],
        t("dc.change.move", { name: o.name }),
      );
    },
    [data, run, t],
  );

  useEffect(() => {
    if (engine.current) engine.current.onMoveCommit = canEdit ? moveObject : () => {};
  }, [moveObject, canEdit]);

  // Keyboard: undo/redo; in edit mode, arrows nudge and R rotates.
  const nudge = useRef<{ id: number; x0: number; z0: number; rot: number; timer: number } | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        if (!canEdit) return;
        void (e.shiftKey ? changes.redo() : changes.undo()).then((r) => {
          if (r && !r.ok) setError(translateApiError(r.error, i18n.language));
        });
        return;
      }
      if (mod || tool !== "edit" || !canEdit || selection?.type !== "object" || !data) return;
      const o = data.objects.find((x) => x.id === selection.id);
      if (!o) return;
      const step = e.shiftKey ? 100 : 10;
      const cur = nudge.current?.id === o.id ? nudge.current : { id: o.id, x0: o.x0_mm, z0: o.z0_mm, rot: o.rotation_deg, timer: 0 };
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

  if (room.isPending) return <Spinner />;
  if (room.error || !data)
    return (
      <div className="p-6">
        <ErrorFlash error={errorMessage(room.error)} />
      </div>
    );

  const assumed = assumedByObject(data);
  const hoverText = hover ? describe(hover.ref, data, t) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-own-keys>
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Link to="/dc" className="text-sm text-muted-foreground hover:underline">
          {t("dc.rooms")}
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="m-0 mr-2 text-base font-semibold">{data.room.name}</h1>
        <SearchBox roomId={roomId} onPick={(ref) => select(ref)} />

        <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label={t("dc.mode.label")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={cn("rounded px-2 py-1 text-xs", mode === m ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              onClick={() => setMode(m)}
            >
              {t(`dc.mode.${m}`)}
            </button>
          ))}
        </div>

        <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label={t("dc.tool.label")}>
          {TOOLS.filter((x) => canEdit || x.tool === "view" || x.tool === "ruler").map(({ tool: tl, icon: Icon }) => (
            <button
              key={tl}
              type="button"
              role="radio"
              aria-checked={tool === tl}
              title={t(`dc.tool.${tl}Hint`)}
              className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs", tool === tl ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              onClick={() => setTool(tl)}
            >
              <Icon className="size-3.5" />
              {t(`dc.tool.${tl}`)}
            </button>
          ))}
        </div>

        {tool === "edit" && (
          <label className="flex items-center gap-1 text-xs">
            {t("dc.grid")}
            <select className="rounded border bg-background px-1 py-0.5" value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
              {GRIDS.map((g) => (
                <option key={g} value={g}>
                  {fmt.mm(g)}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool === "ruler" && (
          <Button size="sm" variant="ghost" onClick={() => engine.current?.clearMeasures()}>
            {t("dc.ruler.clear")}
          </Button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => engine.current?.setOrtho(!ortho)} title={t("dc.view.projectionHint")}>
            <Box className="size-4" />
            {ortho ? t("dc.view.ortho") : t("dc.view.persp")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <LayoutGrid className="size-4" />
                {t("dc.view.presets")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {PRESETS.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => engine.current?.preset(p)}>
                  {t(`dc.view.${p}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant={walking ? "default" : "outline"} onClick={() => engine.current?.setWalk(!walking)} title={t("dc.walk.hint")}>
            <Footprints className="size-4" />
            {t("dc.walk.label")}
          </Button>
          {canEdit && (
            <>
              <Button
                size="icon"
                variant="ghost"
                disabled={!changes.canUndo || changes.pending}
                title={changes.undoLabel ? t("dc.undo", { what: changes.undoLabel }) : t("dc.undoNothing")}
                aria-label={t("dc.undoShort")}
                onClick={() => void changes.undo().then((r) => r && !r.ok && setError(translateApiError(r.error, i18n.language)))}
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={!changes.canRedo || changes.pending}
                title={changes.redoLabel ? t("dc.redo", { what: changes.redoLabel }) : t("dc.redoNothing")}
                aria-label={t("dc.redoShort")}
                onClick={() => void changes.redo().then((r) => r && !r.ok && setError(translateApiError(r.error, i18n.language)))}
              >
                <Redo2 className="size-4" />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Download className="size-4" />
                {t("dc.export.label")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("dc.export.label")}</DropdownMenuLabel>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => savePng(engine.current, data.room.name)}>{t("dc.export.png")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" />
              {t("dc.import.button")}
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/dc/${roomId}/history`}>
              <History className="size-4" />
              {t("dc.history.button")}
            </Link>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/dc/catalog">
              <Library className="size-4" />
              {t("dc.catalog.button")}
            </Link>
          </Button>
        </div>
      </div>

      {(error || conflict || changes.notice) && (
        <div className="px-3 pt-2">
          {conflict && (
            <Flash kind="error">
              {t("dc.conflict.title")} {conflict}{" "}
              <button type="button" className="underline" onClick={() => setConflict(null)}>
                {t("common.close")}
              </button>
            </Flash>
          )}
          {changes.notice && <Flash kind="ok">{t("dc.conflict.reapplied")}</Flash>}
          <ErrorFlash error={error} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={host} className="dc-host relative min-h-[420px] flex-1 overflow-hidden" aria-label={t("dc.canvasLabel")}>
          {walking && <div className="dc-walk-help">{t("dc.walk.help")}</div>}
          <div className="dc-status">
            {cursor ? `x ${fmt.mm(cursor.x)} · z ${fmt.mm(cursor.z)}` : t("dc.statusHint")}
            {" · "}
            {t("dc.revision", { n: data.room.revision })}
          </div>
          {hover && hoverText && (
            <div className="dc-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              {hoverText}
            </div>
          )}
          {notePos && (
            <NotePrompt
              onCancel={() => setNotePos(null)}
              onSave={async (text) => {
                const ok = await run([{ op: "annotation_create", annotation: { kind: "note", payload: { position: notePos, text } } }], t("dc.change.note"));
                if (ok) setNotePos(null);
              }}
            />
          )}
        </div>

        <aside className="flex w-[380px] shrink-0 flex-col border-l">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="m-2 grid grid-cols-4">
              <TabsTrigger value="selection">{t("dc.tab.selection")}</TabsTrigger>
              <TabsTrigger value="capacity">{t("dc.tab.capacity")}</TabsTrigger>
              <TabsTrigger value="measure">
                {t("dc.tab.measure")}
                {assumed.size > 0 && <span className="ml-1 rounded bg-tag-3/30 px-1 text-[10px]">{assumed.size}</span>}
              </TabsTrigger>
              <TabsTrigger value="views">{t("dc.tab.views")}</TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
              <TabsContent value="selection">
                <SelectionPanel
                  data={data}
                  catalog={catalog}
                  selection={complete(selection, data)}
                  canEdit={canEdit}
                  editTool={tool === "edit"}
                  warnings={changes.warnings}
                  prefill={prefill}
                  onPrefillUsed={() => setPrefill(null)}
                  onSelect={select}
                  run={run}
                  problemsOf={(id) => engine.current?.problemsOf(id) ?? []}
                />
              </TabsContent>
              <TabsContent value="capacity">
                <CapacityPanel
                  roomId={roomId}
                  revision={data.room.revision}
                  canEdit={canEdit}
                  onPick={(c, req) => {
                    select({ type: "object", id: c.rack_id });
                    setPrefill({ rackId: c.rack_id, u: c.suggestion.from, height: req.u, face: req.face, power: req.power });
                  }}
                />
              </TabsContent>
              <TabsContent value="measure">
                <MeasurementsPanel data={data} catalog={catalog} onSelect={(id) => select({ type: "object", id })} />
              </TabsContent>
              <TabsContent value="views">
                <ViewsPanel data={data} canEdit={canEdit} engine={engine} run={run} />
              </TabsContent>
            </div>
          </Tabs>
        </aside>
      </div>

      {importOpen && <ImportDialog roomId={roomId} revision={data.room.revision} onClose={() => setImportOpen(false)} onDone={() => void changes.refresh()} />}
    </div>
  );
}

function NotePrompt({ onSave, onCancel }: { onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <form
      className="dc-note-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void onSave(text.trim());
      }}
    >
      <label className="text-xs font-medium" htmlFor="dc-note">
        {t("dc.note.prompt")}
      </label>
      <textarea id="dc-note" autoFocus rows={3} className="w-full rounded border bg-background p-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!text.trim()}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** The model the engine draws. */
export function toModel(data: RoomData, catalog: Map<number, CatalogItem>): EngineModel {
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
    const units = d.u_height > 1 ? `U${d.u_bottom}–${d.u_bottom + d.u_height - 1}` : `U${d.u_bottom}`;
    return `${d.name} · ${units} · ${t(`dc.face.${d.face}`)}${d.owner ? ` · ${d.owner}` : ""}`;
  }
  if (ref.type === "cell") {
    const c = data.cells.find((x) => x.shelf_id === ref.shelfId && x.cell_no === ref.cellNo);
    return c ? `${t("dc.shelf.cell", { n: ref.cellNo })}: ${c.name}${c.owner ? ` · ${c.owner}` : ""}` : t("dc.shelf.cellEmpty", { n: ref.cellNo });
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
