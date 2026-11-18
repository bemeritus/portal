/**
 * The inspector (mockups `design/Main.png`, `Light.png`, `Drawing.png`): a
 * floating card in the studio and light themes, a docked column in drawing.
 * The selected object's name and KPIs, its dimensions — tape against model —
 * and the open-rack / find-space buttons; then the tabs that were the side
 * panel: capacity, measurements, views and the ruler.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import type { SelRef } from "../engine/DcEngine";
import { rackStats } from "../model/devices";
import type { Problem } from "../model/geometry";
import { disagrees, isRange } from "../model/measure";
import { useFmt } from "../settings";
import type {
  CapacityCandidate,
  CatalogItem,
  Clearance,
  Op,
  RoomData,
  ViewPayload,
} from "../types";
import { CapacityPanel, type CapacityRequest } from "./CapacityPanel";
import { InspectorTabs, TABPANEL_ID, tabId } from "./InspectorTabs";
import { assumedByObject } from "../model/objects";
import { MeasurementsPanel } from "./MeasurementsPanel";
import { measureLabel } from "./measureLabel";
import type { RulerProps } from "./RulerPanel";
import { RulerPanel } from "./RulerPanel";
import type { Prefill } from "./RackPanel";
import { SelectionPanel } from "./SelectionPanel";
import { ViewsPanel } from "./ViewsPanel";

export type InspectorTab =
  "object" | "capacity" | "measure" | "views" | "ruler";
const TABS: readonly InspectorTab[] = [
  "object",
  "capacity",
  "measure",
  "views",
  "ruler",
];

interface Props {
  docked: boolean;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  onClose: () => void;
  data: RoomData;
  catalog: Map<number, CatalogItem>;
  selection: SelRef;
  canEdit: boolean;
  editTool: boolean;
  warnings: Clearance[];
  prefill: Prefill | null;
  onPrefillUsed: () => void;
  onSelect: (ref: SelRef, fly?: boolean) => void;
  onClearance: (c: Clearance) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
  problemsOf: (id: number) => Problem[];
  capacity: CapacityRequest | null;
  onCapacityPick: (c: CapacityCandidate, req: CapacityRequest) => void;
  onFindSpace: () => void;
  saveView: (name: string, shared: boolean) => Promise<boolean>;
  openView: (v: ViewPayload) => void;
  copyLink: () => void;
  ruler: RulerProps;
}

export function Inspector(p: Props) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { data, catalog, selection } = p;
  const objId = selection
    ? selection.type === "object"
      ? selection.id
      : selection.type === "device"
        ? selection.rackId
        : selection.shelfId
    : null;
  const obj =
    objId !== null ? data.objects.find((o) => o.id === objId) : undefined;
  const item = obj ? catalog.get(obj.catalog_id) : undefined;
  const assumed = assumedByObject(data).size;

  const title = p.tab === "object" && obj ? obj.name : t(`dc.tab.${p.tab}`);
  const subtitle =
    p.tab === "object" && item
      ? `${t(`dc.kind.${item.kind}`)} · ${item.model}`
      : p.tab === "object"
        ? data.room.name
        : null;

  const stats =
    item?.kind === "rack" && obj
      ? rackStats(
          data.devices.filter((d) => d.rack_id === obj.id),
          item.props.units,
          obj.contents_known,
        )
      : null;
  const dims = obj
    ? data.room.measurements.entries.filter(
        (m) => m.objects.includes(obj.name) && m.line,
      )
    : [];

  return (
    <aside
      className="dc-inspector dc-panel"
      data-docked={p.docked}
      aria-label={t("dc.inspector.label")}
    >
      <div className="dc-insp-head">
        <h2 className="dc-heading">
          {title}
          {subtitle && <small>{subtitle}</small>}
        </h2>
        <button
          type="button"
          className="dc-icon-btn"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={p.onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <InspectorTabs
        tabs={TABS}
        active={p.tab}
        onTab={p.onTab}
        label={(tab) => t(`dc.tab.${tab}`)}
        badge={(tab) =>
          tab === "measure" && assumed > 0 ? (
            <span className="dc-badge">{assumed}</span>
          ) : null
        }
      />
      <div
        className="dc-inspector-body"
        id={TABPANEL_ID}
        role="tabpanel"
        aria-labelledby={tabId(p.tab)}
      >
        {p.tab === "object" && (
          <>
            {stats && obj && (
              <>
                <div className="dc-kpis">
                  <div className="dc-kpi">
                    <b className="dc-num">
                      {stats.known ? `${stats.used}/${stats.units}` : "—"}
                    </b>
                    <span>{t("dc.inspector.unitsUsed")}</span>
                  </div>
                  <div className="dc-kpi">
                    <b className="dc-num">
                      {stats.known ? stats.units - stats.used : "—"}
                    </b>
                    <span>{t("dc.inspector.unitsFree")}</span>
                  </div>
                  <div className="dc-kpi">
                    <b className="dc-num">
                      {stats.known ? fmt.kw(stats.powerW) : "—"}
                    </b>
                    <span>
                      {stats.unknownPower > 0
                        ? t("dc.inspector.powerPartial", {
                            n: stats.unknownPower,
                          })
                        : t("dc.inspector.power")}
                    </span>
                  </div>
                  <div className="dc-kpi">
                    <b className="dc-num">{stats.known ? stats.count : "—"}</b>
                    <span>{t("dc.inspector.devices")}</span>
                  </div>
                </div>
                <div className="dc-actions">
                  <Link
                    className="dc-btn dc-btn-primary grid place-items-center"
                    to={`/dc/${data.room.id}/racks#obj-${obj.id}`}
                  >
                    {t("dc.inspector.openRack")}
                  </Link>
                  <button
                    type="button"
                    className="dc-btn"
                    onClick={p.onFindSpace}
                  >
                    {t("dc.inspector.findSpace")}
                  </button>
                </div>
              </>
            )}
            {dims.length > 0 && (
              <>
                <div className="dc-section-title">{t("dc.inspector.dims")}</div>
                <div className="dc-rows">
                  {dims.map((m) => (
                    <div key={m.key} title={m.note}>
                      <span>{measureLabel(m.key, t)}</span>
                      <span className="dc-num">
                        {isRange(m)
                          ? fmt.range(m.min!, m.max!)
                          : fmt.mm(m.value)}
                      </span>
                      {disagrees(m) && m.model != null && (
                        <span
                          className="dc-model"
                          title={t("dc.measure.modelValue", {
                            v: fmt.mm(m.model),
                          })}
                        >
                          <span className="dc-dot" aria-hidden="true" />
                          {fmt.mm(m.model)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="mt-3">
              <SelectionPanel
                data={data}
                catalog={catalog}
                selection={selection}
                canEdit={p.canEdit}
                editTool={p.editTool}
                warnings={p.warnings}
                prefill={p.prefill}
                onPrefillUsed={p.onPrefillUsed}
                onSelect={p.onSelect}
                onClearance={p.onClearance}
                run={p.run}
                problemsOf={p.problemsOf}
              />
            </div>
          </>
        )}
        {p.tab === "capacity" && (
          <div className="mt-3">
            <CapacityPanel
              roomId={data.room.id}
              revision={data.room.revision}
              canEdit={p.canEdit}
              initial={p.capacity}
              onPick={p.onCapacityPick}
            />
          </div>
        )}
        {p.tab === "measure" && (
          <div className="mt-3">
            <MeasurementsPanel
              data={data}
              catalog={catalog}
              onSelect={(id) => p.onSelect({ type: "object", id })}
            />
          </div>
        )}
        {p.tab === "views" && (
          <div className="mt-3">
            <ViewsPanel
              data={data}
              canEdit={p.canEdit}
              run={p.run}
              saveView={p.saveView}
              openView={p.openView}
              copyLink={p.copyLink}
            />
          </div>
        )}
        {p.tab === "ruler" && (
          <div className="mt-3">
            <RulerPanel {...p.ruler} />
          </div>
        )}
      </div>
    </aside>
  );
}
