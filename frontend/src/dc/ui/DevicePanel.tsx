/**
 * The selected device (FEEDBACK-6 §2, §4): name, kind, owner and status
 * pills, power and its source, serial, depth, its last change; «Показать в
 * 3D» and «Изменить». On the racks page and in the room's inspector.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { tDyn } from "../../i18n";
import { whenText } from "../format";
import { useFmt } from "../settings";
import type {
  CatalogItem,
  DcObject,
  Device,
  Op,
  RackProps,
  RevisionSummary,
  RoomData,
} from "../types";
import { DeviceForm } from "./DeviceForm";
import { withRecorded } from "./RackPanel";

/** The selected device: what it is, whose, its figures and its last change. */
export function DevicePanel({
  device,
  data,
  racks,
  catalog,
  revisions,
  canEdit,
  onOwner,
  onDone,
  run,
  in3d = false,
}: {
  device: Device;
  data: RoomData;
  racks: DcObject[];
  catalog: Map<number, CatalogItem>;
  revisions?: RevisionSummary[];
  canEdit: boolean;
  onOwner: (o: string) => void;
  onDone: () => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
  /** Already in the 3D view: no «Показать в 3D». */
  in3d?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const [editing, setEditing] = useState(false);
  const rack = racks.find((r) => r.id === device.rack_id)!;
  const top = device.u_bottom + device.u_height - 1;
  const last = revisions?.find((r) => {
    const d = r.digest;
    return [
      ...d.devices_added.map((x) => x.name),
      ...d.devices_moved.map((x) => x.name),
      ...d.owners.map((x) => x.name),
      ...d.devices_changed,
    ].includes(device.name);
  });
  if (editing) {
    const { id: _id, ...fields } = device;
    void _id;
    return (
      <DeviceForm
        key={`dev-${device.id}-${data.room.revision}`}
        title={device.name}
        initial={fields}
        deviceId={device.id}
        rack={rack}
        units={unitsOf(catalog, racks, device.rack_id)}
        devices={data.devices.filter((d) => d.rack_id === device.rack_id)}
        racks={racks}
        canEdit={canEdit}
        onCancel={() => setEditing(false)}
        onDelete={async () => {
          const ok = await run(
            [{ op: "device_delete", id: device.id }],
            t("dc.change.deviceDelete", { name: device.name }),
          );
          if (ok) onDone();
        }}
        onSave={async (f) => {
          const target = racks.find((r) => r.id === f.rack_id)!;
          const ok = await run(
            withRecorded(target, [
              { op: "device_update", id: device.id, device: f },
            ]),
            t("dc.change.deviceEdit", { name: f.name }),
          );
          if (ok) setEditing(false);
          return ok;
        }}
      />
    );
  }
  return (
    <div className="dc-device-panel" data-testid="device-panel">
      <small className="dc-muted">
        {rack.name} ·{" "}
        {top === device.u_bottom ? `U${top}` : `U${device.u_bottom}–U${top}`} ·{" "}
        {t(`dc.face.${device.face}`)}
      </small>
      <h2>{device.name}</h2>
      <div className="dc-muted">{tDyn(t, `dc.deviceKind.${device.kind}`)}</div>
      <div className="dc-rack-pills">
        {device.owner && (
          <button
            type="button"
            className="dc-pill"
            data-tone="owner"
            title={t("dc.racks.highlightOwner")}
            onClick={() => onOwner(device.owner)}
          >
            {device.owner}
          </button>
        )}
        <span
          className="dc-pill"
          data-tone={device.status === "active" ? "ok" : undefined}
        >
          {tDyn(t, `dc.status.${device.status}`)}
        </span>
      </div>
      <dl className="dc-kv">
        <dt>{t("dc.racks.powerRow")}</dt>
        <dd className="dc-num">
          {device.power_w === null
            ? t("dc.roomsPage.noData")
            : fmt.w(device.power_w)}
        </dd>
        <dt>{t("dc.racks.powerSrc")}</dt>
        <dd>
          {device.power_src ? tDyn(t, `dc.powerSrc.${device.power_src}`) : "—"}
        </dd>
        <dt>{t("dc.racks.serial")}</dt>
        <dd className="dc-num">{device.serial || "—"}</dd>
        <dt>{t("dc.racks.depth")}</dt>
        <dd className="dc-num">
          {device.depth_mm ? fmt.mm(device.depth_mm) : "—"}
        </dd>
        {last && (
          <>
            <dt>{t("dc.racks.changed")}</dt>
            <dd>
              {whenText(last.created_at, i18n.language, t, false)}
              {last.digest.kind !== "created" && `, ${last.author_name}`}
            </dd>
          </>
        )}
      </dl>
      <div className="dc-room-actions">
        {!in3d && (
          <Link
            className="dc-btn dc-btn-primary"
            to={`/dc/${data.room.id}?view=3d#device-${device.id}`}
          >
            {t("dc.racks.show3d")}
          </Link>
        )}
        {canEdit && (
          <button
            type="button"
            className="dc-btn"
            onClick={() => setEditing(true)}
          >
            {t("dc.racks.edit")}
          </button>
        )}
      </div>
    </div>
  );
}

/** A rack's units, by its id among `racks`. */
export function unitsOf(
  catalog: Map<number, CatalogItem>,
  racks: DcObject[],
  id: number,
): number {
  const r = racks.find((x) => x.id === id);
  return r ? (catalog.get(r.catalog_id)?.props as RackProps).units : 42;
}
