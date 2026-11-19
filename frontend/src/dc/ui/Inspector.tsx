/**
 * The inspector (mockups `design/Main.png`, `Light.png`, `Drawing.png`,
 * `RoomOverview.png`): a floating card in the studio and light themes, a
 * docked column in drawing. With nothing selected, the room's summary
 * (FEEDBACK-6 §1); with a rack, its figures, mini elevation, own
 * dimensions and the open-rack / find-space buttons (§2); with a device,
 * its card too. Then the tabs: capacity, measurements, views and the ruler.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { dcApi } from "../api";
import { whenText } from "../format";
import { objectDims } from "../model/geometry";

import type { SelRef } from "../engine/DcEngine";
import type { Problem } from "../model/geometry";
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
import { DevicePanel } from "./DevicePanel";
import { OwnDims, RackSummary, RoomSummary } from "./RoomSummary";
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
  onImport: () => void;
  /** Read-only: the room at an older revision. */
  past: boolean;
  saveView: (name: string, shared: boolean) => Promise<boolean>;
  openView: (v: ViewPayload) => void;
  copyLink: () => void;
  ruler: RulerProps;
}

export function Inspector(p: Props) {
  const { t, i18n } = useTranslation();
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

  const revisions = useQuery({
    queryKey: ["dc", "revisions", data.room.id],
    queryFn: ({ signal }) => dcApi.revisions(data.room.id, signal),
  });
  const racks = data.objects.filter(
    (o) => catalog.get(o.catalog_id)?.kind === "rack",
  );
  const device =
    selection?.type === "device"
      ? data.devices.find((d) => d.id === selection.id)
      : undefined;

  // The heading: what is shown, with a line above it saying what it is.
  const room = p.tab === "object" && !obj;
  const title =
    p.tab === "object" ? (obj?.name ?? data.room.name) : t(`dc.tab.${p.tab}`);
  let eyebrow: string | null = null;
  if (room)
    eyebrow = t("dc.summary.roomLine", {
      n: data.room.revision,
      when: whenText(data.room.updated_at, i18n.language, t),
    });
  else if (p.tab === "object" && obj && item?.kind === "rack") {
    const [w, d, h] = objectDims(item, obj.instance);
    eyebrow = t("dc.summary.rackLine", {
      dims: `${fmt.len(w)} × ${fmt.len(d)} × ${fmt.len(h)}`,
      units: item.props.units,
    });
  } else if (p.tab === "object" && item)
    eyebrow = `${t(`dc.kind.${item.kind}`)} · ${item.model}`;
  const size = room
    ? fmt.dims(
        ...(() => {
          const xs = data.room.floor_plan.map((q) => q[0]),
            zs = data.room.floor_plan.map((q) => q[1]);
          return [
            Math.max(...xs) - Math.min(...xs),
            Math.max(...zs) - Math.min(...zs),
            data.room.height_mm,
          ] as [number, number, number];
        })(),
      )
    : null;

  return (
    <aside
      className="dc-inspector dc-panel"
      data-docked={p.docked}
      aria-label={t("dc.inspector.label")}
    >
      <div className="dc-insp-head">
        <div>
          {eyebrow && <small className="dc-eyebrow">{eyebrow}</small>}
          <h2 className="dc-heading">{title}</h2>
          {size && <small className="dc-eyebrow dc-num">{size}</small>}
        </div>
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
            {!obj && (
              <RoomSummary
                data={data}
                canEdit={p.canEdit && !p.past}
                onRack={(id) => p.onSelect({ type: "object", id })}
                onClearance={p.onClearance}
                onImport={p.onImport}
              />
            )}
            {obj && item?.kind === "rack" && (
              <RackSummary
                obj={obj}
                item={item}
                data={data}
                onFindSpace={p.onFindSpace}
              />
            )}
            {obj && item && item.kind !== "rack" && (
              <OwnDims obj={obj} data={data} />
            )}
            {device && (
              <div className="dc-insp-device">
                <DevicePanel
                  key={device.id}
                  device={device}
                  data={data}
                  racks={racks}
                  catalog={catalog}
                  revisions={revisions.data}
                  canEdit={p.canEdit && !p.past}
                  onOwner={() => {}}
                  onDone={() =>
                    p.onSelect({ type: "object", id: device.rack_id }, false)
                  }
                  run={p.run}
                  in3d
                />
              </div>
            )}
            {obj && (
              <div className="mt-3">
                <SelectionPanel
                  data={data}
                  catalog={catalog}
                  selection={selection}
                  canEdit={p.canEdit && !p.past}
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
            )}
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
