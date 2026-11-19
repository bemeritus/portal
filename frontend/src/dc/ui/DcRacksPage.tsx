/**
 * `/dc/:roomId/racks` (FEEDBACK-6 §4, `Racks.png`): every rack on one screen
 * — the columns shrink and the elevations scale, so four racks fit 1440 px
 * without scrolling. Each card: name and «35/42U», bars for the units used
 * and the power, the clearance warning, the elevation with U numbers,
 * devices coloured by kind and free runs of 2U or more. The toolbar: front
 * or rear, the owner highlight, find space, import, add a device. On the
 * right, the selected device (or its form, or the space finder). A room
 * whose racks have no recorded contents shows one message and the import.
 * The rack in the hash (`#obj-12`) is selected and scrolled into view.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { errorMessage } from "../../api/client";
import { useToolAccess } from "../../auth/useToolAccess";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { tDyn } from "../../i18n";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import { useChanges, useRoom } from "../hooks";
import { facesConflict } from "../model/devices";
import { percent, roomFigures, type RackFigure } from "../model/summary";
import { useFmt } from "../settings";
import type {
  CatalogItem,
  DcObject,
  Device,
  DeviceFields,
  Op,
  RackProps,
  RoomData,
} from "../types";
import { clearanceGap } from "../types";
import { CapacityPanel } from "./CapacityPanel";
import { DeviceForm } from "./DeviceForm";
import { ImportDialog } from "./ImportDialog";
import { DevicePanel, unitsOf } from "./DevicePanel";
import { Elevation, GROUPS, withRecorded } from "./RackPanel";

type Side =
  | { kind: "device"; id: number }
  | { kind: "new"; draft: DeviceFields }
  | { kind: "space" }
  | null;

export function DcRacksPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const roomId = Number(useParams().roomId);
  const canEdit = useToolAccess().can("dc_room", "edit");
  const [search, setSearch] = useSearchParams();
  const room = useRoom(roomId);
  const data = room.data;
  const changes = useChanges(roomId, data);
  const revisions = useQuery({
    queryKey: ["dc", "revisions", roomId],
    queryFn: ({ signal }) => dcApi.revisions(roomId, signal),
  });
  const [face, setFace] = useState<"front" | "rear">("front");
  const [side, setSide] = useState<Side>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = search.get("owner");
  const catalog = useMemo(
    () =>
      new Map<number, CatalogItem>((data?.catalog ?? []).map((c) => [c.id, c])),
    [data],
  );
  const racks = useMemo(
    () =>
      (data?.objects ?? [])
        .filter((o) => catalog.get(o.catalog_id)?.kind === "rack")
        .sort((a, b) => a.x0_mm - b.x0_mm),
    [data, catalog],
  );
  const figures = data ? roomFigures(data) : null;

  useEffect(() => {
    document.title = t("docTitle", {
      page: t("dc.shell.racks"),
      app: t("app.name"),
    });
  }, [t]);
  // The rack in the hash: scrolled to (the 3D view's «Открыть стойку»).
  useEffect(() => {
    if (!data) return;
    const id = window.location.hash.slice(1);
    if (id)
      document
        .getElementById(id)
        ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [data]);

  const run = useCallback(
    async (ops: Op[], label: string) => {
      setError(null);
      const r = await changes.apply(ops, label);
      if (!r.ok) {
        setError(translateApiError(r.error, i18n.language));
        await changes.refresh();
      }
      return r.ok;
    },
    [changes, i18n.language],
  );
  const setOwner = (o: string | null) => {
    const q = new URLSearchParams(search);
    if (o) q.set("owner", o);
    else q.delete("owner");
    setSearch(q, { replace: true });
  };

  if (room.isPending) return <Spinner />;
  if (!data || !figures) return <ErrorFlash error={errorMessage(room.error)} />;
  const selected =
    side?.kind === "device"
      ? (data.devices.find((d) => d.id === side.id) ?? null)
      : null;
  const ownerCount = owner
    ? data.devices.filter((d) => d.owner === owner).length
    : 0;
  const hashRack = Number(window.location.hash.match(/^#obj-(\d+)$/)?.[1]);
  const maxPower = Math.max(
    data.room.settings.rack_power_budget_w ?? 0,
    ...figures.racks.map((r) => r.stats.powerW),
  );
  const firstRack = racks[0];
  const addNew = () =>
    firstRack &&
    setSide({
      kind: "new",
      draft: blank(firstRack.id, 1, face),
    });

  return (
    <div className="dc-racks-page">
      <header className="dc-racks-head">
        <div>
          <h1>{t("dc.shell.racks")}</h1>
          <p className="dc-muted">
            {t("dc.racks.count", { count: racks.length })}
            {!figures.empty && (
              <>
                {" · "}
                {t("dc.racks.unitsOf", {
                  used: figures.used,
                  units: figures.units,
                })}
                {figures.powerKnown > 0 &&
                  ` · ${t("dc.racks.powerKnown", { kw: fmt.kw(figures.powerW) })}`}
              </>
            )}
          </p>
        </div>
      </header>
      <ErrorFlash error={error} />

      {figures.empty && racks.every((r) => !r.contents_known) ? (
        <div className="dc-card dc-racks-empty" data-testid="racks-empty">
          <p>{t("dc.racks.empty")}</p>
          <div className="dc-room-actions">
            <a className="dc-btn" href={dcApi.importTemplate(roomId)} download>
              {t("dc.racks.template")}
            </a>
            {canEdit && (
              <button
                type="button"
                className="dc-btn dc-btn-primary"
                onClick={() => setImporting(true)}
              >
                {t("dc.racks.importCsv")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="dc-racks-tools">
            <div
              className="dc-seg"
              role="radiogroup"
              aria-label={t("dc.device.face")}
            >
              {(["front", "rear"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={face === f}
                  onClick={() => setFace(f)}
                >
                  {t(`dc.racks.face.${f}`)}
                </button>
              ))}
            </div>
            {owner && (
              <span className="dc-chip dc-owner-chip" role="status">
                {t("dc.highlight.label")} {owner} ·{" "}
                {t("dc.racks.devices", { count: ownerCount })}
                <button
                  type="button"
                  aria-label={t("dc.highlight.clear")}
                  title={t("dc.highlight.clear")}
                  onClick={() => setOwner(null)}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            )}
            <span className="dc-grow" />
            <button
              type="button"
              className="dc-btn"
              onClick={() => setSide({ kind: "space" })}
            >
              {t("dc.racks.findSpace")}
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  className="dc-btn"
                  onClick={() => setImporting(true)}
                >
                  {t("dc.racks.importCsv")}
                </button>
                <button
                  type="button"
                  className="dc-btn dc-btn-primary"
                  onClick={addNew}
                >
                  {t("dc.racks.addDevice")}
                </button>
              </>
            )}
          </div>

          <div
            className="dc-racks-grid"
            style={{ "--racks": racks.length } as React.CSSProperties}
          >
            {racks.map((o) => (
              <RackCard
                key={o.id}
                obj={o}
                item={catalog.get(o.catalog_id)!}
                fig={figures.racks.find((r) => r.id === o.id)!}
                data={data}
                face={face}
                owner={owner}
                maxPower={maxPower}
                selectedId={selected?.id ?? null}
                current={o.id === hashRack}
                canEdit={canEdit}
                draft={side?.kind === "new" ? side.draft : null}
                onPickFree={(u) =>
                  canEdit &&
                  setSide({ kind: "new", draft: blank(o.id, u, face) })
                }
                onPick={(d) => setSide({ kind: "device", id: d.id })}
                run={run}
              />
            ))}
            <aside className="dc-card dc-racks-side">
              {side?.kind === "space" ? (
                <CapacityPanel
                  roomId={roomId}
                  revision={data.room.revision}
                  canEdit={canEdit}
                  onPick={(c, req) =>
                    setSide({
                      kind: "new",
                      draft: {
                        ...blank(c.rack_id, c.suggestion.from, face),
                        u_height: req.u,
                        face: req.face,
                        power_w: req.power,
                      },
                    })
                  }
                />
              ) : side?.kind === "new" ? (
                <DeviceForm
                  key={`new-${side.draft.rack_id}-${side.draft.u_bottom}`}
                  title={t("dc.device.newTitle")}
                  initial={side.draft}
                  rack={racks.find((r) => r.id === side.draft.rack_id)!}
                  units={unitsOf(catalog, racks, side.draft.rack_id)}
                  devices={data.devices.filter(
                    (d) => d.rack_id === side.draft.rack_id,
                  )}
                  racks={racks}
                  canEdit={canEdit}
                  onCancel={() => setSide(null)}
                  onSave={async (fields) => {
                    const target = racks.find((r) => r.id === fields.rack_id)!;
                    const ok = await run(
                      withRecorded(target, [
                        { op: "device_create", device: fields },
                      ]),
                      t("dc.change.deviceAdd", { name: fields.name }),
                    );
                    if (ok) setSide(null);
                    return ok;
                  }}
                />
              ) : selected ? (
                <DevicePanel
                  key={selected.id}
                  device={selected}
                  data={data}
                  racks={racks}
                  catalog={catalog}
                  revisions={revisions.data}
                  canEdit={canEdit}
                  onOwner={setOwner}
                  onDone={() => setSide(null)}
                  run={run}
                />
              ) : (
                <p className="dc-muted">{t("dc.racks.pick")}</p>
              )}
            </aside>
          </div>

          <ul className="dc-racks-legend" aria-label={t("dc.racks.legend")}>
            {GROUPS.map((g) => (
              <li key={g}>
                <i data-group={g} />
                {tDyn(t, `dc.racks.group.${g}`)}
              </li>
            ))}
            <li>
              <i data-group="free" />
              {t("dc.racks.group.free")}
            </li>
          </ul>
        </>
      )}
      {importing && (
        <ImportDialog
          roomId={roomId}
          revision={data.room.revision}
          onClose={() => setImporting(false)}
          onDone={() => void changes.refresh()}
        />
      )}
    </div>
  );
}

function RackCard({
  obj,
  item,
  fig,
  data,
  face,
  owner,
  maxPower,
  selectedId,
  current,
  canEdit,
  draft,
  onPickFree,
  onPick,
  run,
}: {
  obj: DcObject;
  item: CatalogItem;
  fig: RackFigure;
  data: RoomData;
  face: "front" | "rear";
  owner: string | null;
  maxPower: number;
  selectedId: number | null;
  current: boolean;
  canEdit: boolean;
  draft: DeviceFields | null;
  onPickFree: (u: number) => void;
  onPick: (d: Device) => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const units = (item.props as RackProps).units;
  const devices = data.devices.filter((d) => d.rack_id === obj.id);
  const visible = devices.filter((d) => facesConflict(d.face, face));
  const used = percent(fig.stats.used, units) ?? 0;
  const others = data.objects.filter(
    (o) =>
      o.id !== obj.id &&
      data.catalog.find((c) => c.id === o.catalog_id)?.kind === "rack",
  );
  return (
    <section
      id={`obj-${obj.id}`}
      className="dc-card dc-rack-card"
      data-current={current || undefined}
      data-testid="rack-card"
    >
      <header>
        <h2>{obj.name}</h2>
        <span className="dc-num">
          {fig.stats.known ? `${fig.stats.used}/${units}U` : `—/${units}U`}
        </span>
      </header>
      <div className="dc-rack-bars">
        <Bar
          label={t("dc.racks.used")}
          value={`${used} %`}
          share={used / 100}
          tone="used"
        />
        <Bar
          label={t("dc.racks.power")}
          value={fig.stats.powerW ? fmt.kw(fig.stats.powerW) : "—"}
          share={maxPower ? fig.stats.powerW / maxPower : 0}
          tone="power"
        />
      </div>
      <div className="dc-rack-pills">
        {fig.short.map((c) => (
          <span key={c.side} className="dc-pill" data-tone="warn">
            {t(
              c.side === "front" ? "dc.racks.shortFront" : "dc.racks.shortRear",
              {
                gap: fmt.mm(clearanceGap(c)),
                need: fmt.len(c.required_mm),
              },
            )}
          </span>
        ))}
        {!fig.stats.known && (
          <span className="dc-pill">{t("dc.rack.notRecorded")}</span>
        )}
      </div>
      <Elevation
        units={units}
        face={face}
        highlight={owner}
        showFree
        devices={visible}
        allDevices={devices}
        selectedId={selectedId}
        draft={draft && draft.rack_id === obj.id ? draft : null}
        canEdit={canEdit}
        otherRacks={others}
        onPickFree={onPickFree}
        onPickDevice={onPick}
        onMove={(d, u, h, rackId) => {
          const target = data.objects.find((o) => o.id === rackId)!;
          const { id: _id, ...rest } = d;
          void _id;
          void run(
            withRecorded(target, [
              {
                op: "device_update",
                id: d.id,
                device: { ...rest, rack_id: rackId, u_bottom: u, u_height: h },
              },
            ]),
            t("dc.change.deviceMove", { name: d.name }),
          );
        }}
      />
    </section>
  );
}

function Bar({
  label,
  value,
  share,
  tone,
}: {
  label: string;
  value: string;
  share: number;
  tone: "used" | "power";
}) {
  return (
    <div className="dc-bar" data-tone={tone}>
      <span>{label}</span>
      <b className="dc-num">{value}</b>
      <i>
        <i style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }} />
      </i>
    </div>
  );
}

function blank(
  rackId: number,
  u: number,
  face: "front" | "rear",
): DeviceFields {
  return {
    rack_id: rackId,
    u_bottom: u,
    u_height: 1,
    face,
    depth_mm: null,
    kind: "server",
    name: "",
    owner: "",
    serial: "",
    power_w: null,
    power_src: null,
    status: "active",
    note: "",
  };
}
