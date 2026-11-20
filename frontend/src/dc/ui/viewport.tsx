/**
 * The viewport's chrome from FEEDBACK-7 §4: the status bar, the keymap
 * (`?`), the section box's panel and the presentation tour.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SectionInput, SelRef, Tool } from "../engine/DcEngine";
import type { Fmt } from "../format";
import { rackStats } from "../model/devices";
import type { CatalogItem, RackProps, RoomData, ViewPayload } from "../types";
import { LengthInput } from "./LengthInput";

/**
 * One line under the bottom bar: the current tool's hint on the left, the
 * selection in the centre, the scene and the cursor's floor coordinates on
 * the right (replaces the floating «x … · z …» text).
 */
export function StatusBar({
  data,
  catalog,
  selection,
  tool,
  plan,
  walking,
  cursor,
  fmt,
}: {
  data: RoomData;
  catalog: Map<number, CatalogItem>;
  selection: SelRef;
  tool: Tool;
  plan: boolean;
  walking: boolean;
  cursor: { x: number; z: number } | null;
  fmt: Fmt;
}) {
  const { t } = useTranslation();
  const hint = walking
    ? t("dc.statusbar.walk")
    : tool !== "view"
      ? t(`dc.statusbar.${tool}`)
      : plan
        ? t("dc.statusbar.plan")
        : t("dc.statusbar.view");
  const racks = data.objects.filter(
    (o) => catalog.get(o.catalog_id)?.kind === "rack",
  );
  const known = data.devices.reduce((a, d) => a + (d.power_w ?? 0), 0);
  const scene = [
    t("dc.statusbar.racks", { count: racks.length }),
    t("dc.statusbar.devices", { count: data.devices.length }),
    ...(known ? [t("dc.statusbar.known", { kw: fmt.kw(known) })] : []),
  ].join(" · ");
  return (
    <div
      className="dc-statusbar no-print"
      role="status"
      aria-label={t("dc.statusbar.label")}
      data-testid="statusbar"
    >
      <span>{hint}</span>
      <span className="dc-status-sel">
        {selectionLine(selection, data, catalog, fmt)}
      </span>
      <span className="dc-status-scene">
        {scene}
        {cursor && (
          <span className="dc-num">
            {" "}
            · x {fmt.mm(cursor.x)} · z {fmt.mm(cursor.z)}
          </span>
        )}
      </span>
    </div>
  );
}

/** «Стойка 3 · 31/42U · 9 кВт», a device, a cell, an object. */
export function selectionLine(
  ref: SelRef,
  data: RoomData,
  catalog: Map<number, CatalogItem>,
  fmt: Fmt,
): string {
  if (!ref) return "";
  if (ref.type === "device") {
    const d = data.devices.find((x) => x.id === ref.id);
    if (!d) return "";
    const u =
      d.u_height > 1
        ? `U${d.u_bottom}–${d.u_bottom + d.u_height - 1}`
        : `U${d.u_bottom}`;
    return [d.name, u, d.power_w !== null ? fmt.w(d.power_w) : null, d.owner]
      .filter(Boolean)
      .join(" · ");
  }
  if (ref.type === "cell") {
    const c = data.cells.find(
      (x) => x.shelf_id === ref.shelfId && x.cell_no === ref.cellNo,
    );
    return `${data.objects.find((o) => o.id === ref.shelfId)?.name ?? ""} · ${ref.cellNo}${c ? ` · ${c.name}` : ""}`;
  }
  const o = data.objects.find((x) => x.id === ref.id);
  if (!o) return "";
  const item = catalog.get(o.catalog_id);
  if (item?.kind !== "rack" || !o.contents_known) return o.name;
  const s = rackStats(
    data.devices.filter((d) => d.rack_id === o.id),
    (item.props as RackProps).units,
    true,
  );
  return `${o.name} · ${s.used}/${s.units}U · ${fmt.kw(s.powerW)}`;
}

/** The navigation keys, shown by `?`. */
export function KeymapHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const rows: [string[], string][] = [
    [["F", "."], t("dc.keymap.frameSel")],
    [["Home"], t("dc.keymap.frameAll")],
    [["1"], t("dc.keymap.front")],
    [["3"], t("dc.keymap.right")],
    [["7"], t("dc.keymap.top")],
    [["Ctrl+1", "Ctrl+3", "Ctrl+7"], t("dc.keymap.opposite")],
    [["5"], t("dc.keymap.ortho")],
    [["Alt+Z"], t("dc.keymap.xray")],
    [["/"], t("dc.keymap.isolate")],
    [["O"], t("dc.keymap.outliner")],
    [["L"], t("dc.keymap.layers")],
    [["M"], t("dc.keymap.ruler")],
    [["Shift+B"], t("dc.keymap.section")],
    [["H"], t("dc.keymap.highlight")],
    [["Esc"], t("dc.keymap.esc")],
    [["?"], t("dc.keymap.help")],
  ];
  return (
    <div
      className="dc-keymap dc-panel"
      role="dialog"
      aria-label={t("dc.keymap.title")}
      data-testid="keymap"
    >
      <div className="mb-2 flex items-center justify-between">
        <b>{t("dc.keymap.title")}</b>
        <button type="button" className="dc-btn" onClick={onClose}>
          Esc
        </button>
      </div>
      <table>
        <tbody>
          {rows.map(([keys, label]) => (
            <tr key={label}>
              <td>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </td>
              <td>{label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{t("dc.keymap.numpad")}</p>
    </div>
  );
}

/** The section box's presets (FEEDBACK-7 §4.4). */
export function SectionPanel({
  fmt,
  on,
  onSection,
}: {
  fmt: Fmt;
  on: boolean;
  onSection: (s: SectionInput | null) => void;
}) {
  const { t } = useTranslation();
  const [height, setHeight] = useState<number | null>(1000);
  return (
    <div
      className="dc-chip dc-panel dc-section-panel"
      data-testid="section-panel"
    >
      <b>{t("dc.cut.title")}</b>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (height !== null && height > 0)
            onSection({ kind: "horizontal", height });
        }}
      >
        <label className="grid gap-0.5">
          <span>{t("dc.cut.horizontal")}</span>
          <LengthInput
            id="section-height"
            value={height}
            onChange={setHeight}
          />
        </label>
        <button type="submit" className="dc-btn" aria-label={t("dc.cut.apply")}>
          {t("dc.cut.apply")}
        </button>
      </form>
      <div className="row">
        <button
          type="button"
          className="dc-btn"
          onClick={() => onSection({ kind: "rackRow" })}
        >
          {t("dc.cut.rackRow")}
        </button>
        <button
          type="button"
          className="dc-btn"
          onClick={() => onSection({ kind: "room" })}
        >
          {t("dc.cut.room")}
        </button>
        {on && (
          <button
            type="button"
            className="dc-btn"
            onClick={() => onSection(null)}
          >
            {t("dc.cut.off")}
          </button>
        )}
      </div>
      <small style={{ color: "var(--dc-muted)" }}>
        {t("dc.cut.height", { unit: fmt.unitWord })}
      </small>
    </div>
  );
}

/**
 * The presentation tour (FEEDBACK-7 §4.8): full screen, every panel hidden,
 * the camera flying between the saved views in their order (1.2 s,
 * ease-in-out) and holding each for its time (6 s by default), its name and
 * caption in the lower third. → / ← move, Space pauses, Esc ends. A
 * playback of saved state: each view's mode, layers, section, hidden
 * objects and X-ray come with it.
 */
export function Tour({
  views,
  show,
  onEnd,
}: {
  views: ViewPayload[];
  show: (v: ViewPayload) => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const end = useRef(onEnd);
  end.current = onEnd;
  const v = views[i];

  useEffect(() => {
    if (v) show(v);
    // Each step shows its view once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useEffect(() => {
    if (paused || !v) return;
    const id = window.setTimeout(
      () => setI((n) => (n + 1 < views.length ? n + 1 : n)),
      1200 + (v.hold_s ?? 6) * 1000,
    );
    return () => window.clearTimeout(id);
  }, [i, paused, v, views.length]);

  useEffect(() => {
    void document.documentElement.requestFullscreen?.().catch(() => {});
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        end.current();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setI((n) => Math.min(views.length - 1, n + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setI((n) => Math.max(0, n - 1));
      } else if (e.key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPaused((p) => !p);
      }
    };
    // Leaving full screen (Esc there) ends the tour too.
    const fs = () => {
      if (!document.fullscreenElement) end.current();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("fullscreenchange", fs);
      if (document.fullscreenElement)
        void document.exitFullscreen?.().catch(() => {});
    };
  }, [views.length]);

  if (!v) return null;
  return (
    <div className="dc-tour dc-panel" role="status" data-testid="tour">
      <h2>{v.name}</h2>
      {v.caption && <p>{v.caption}</p>}
      <small>
        {t("dc.views.tourOf", { n: i + 1, total: views.length })}
        {paused && ` · ${t("dc.views.paused")}`} · {t("dc.views.tourHelp")}
      </small>
    </div>
  );
}
