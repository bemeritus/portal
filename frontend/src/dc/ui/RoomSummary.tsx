/**
 * The inspector when nothing is selected, and when a rack is (FEEDBACK-6
 * §1–2, `RoomOverview.png`, `Main.png`).
 *
 * - `RoomSummary`: the room's figures — devices, units used, known power and
 *   for how many devices — one row per rack with its fill and a warning
 *   mark, and the warnings as compact cards that open the explanation. An
 *   empty room says so and offers the import.
 * - `RackSummary`: the rack's four figures (used, power, longest free run,
 *   devices without power — «нет данных» when unknown) beside a mini
 *   elevation; its own measurements («модель X» only where it differs); open
 *   the rack, find space.
 * - `OwnDims`: an object's own measurements, compactly.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import { freeRuns, rackStats } from "../model/devices";
import { disagrees, isRange } from "../model/measure";
import { percent, roomFigures } from "../model/summary";
import { useFmt } from "../settings";
import type {
  CatalogItem,
  Clearance,
  DcObject,
  Op,
  Device,
  RackProps,
  RoomData,
} from "../types";
import { clearanceGap, localText } from "../types";
import { Input } from "@/components/ui/input";
import { LengthInput } from "./LengthInput";
import { measureLabel } from "./measureLabel";
import { KIND_GROUP } from "./RackPanel";

export function RoomSummary({
  data,
  canEdit,
  onObject,
  onClearance,
  onImport,
  run,
  settingsOpen,
  onSettingsOpen,
}: {
  data: RoomData;
  canEdit: boolean;
  onObject: (id: number) => void;
  onClearance: (c: Clearance) => void;
  onImport: () => void;
  run: (ops: Op[], label: string) => Promise<boolean>;
  settingsOpen: boolean;
  onSettingsOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const f = roomFigures(data);
  const used = percent(f.used, f.units);
  return (
    <div className="dc-summary" data-testid="room-summary">
      <div className="dc-figures" data-cols="3">
        <Figure value={f.devices} label={t("dc.roomsPage.devices")} />
        <Figure
          value={used === null ? null : `${used} %`}
          label={t("dc.roomsPage.used")}
        />
        <Figure
          value={f.powerKnown > 0 ? fmt.kw(f.powerW) : null}
          label={t("dc.roomsPage.power")}
          sub={
            f.powerKnown > 0
              ? t("dc.roomsPage.powerOf", {
                  known: f.powerKnown,
                  total: f.devices,
                })
              : undefined
          }
        />
      </div>
      {f.empty ? (
        <div className="dc-summary-empty">
          <p>{t("dc.roomsPage.noDevices")}</p>
          {canEdit && (
            <button
              type="button"
              className="dc-btn dc-btn-primary"
              onClick={onImport}
            >
              {t("dc.racks.importCsv")}
            </button>
          )}
        </div>
      ) : (
        <ul className="dc-summary-racks">
          {f.racks.map((r) => {
            const share = r.stats.known ? r.stats.used / r.stats.units : 0;
            return (
              <li key={r.id}>
                <button type="button" onClick={() => onObject(r.id)}>
                  <b>{r.name}</b>
                  <i className="dc-fill">
                    <i style={{ width: `${share * 100}%` }} />
                  </i>
                  <span className="dc-num">
                    {r.stats.known ? `${r.stats.used}/${r.stats.units}U` : "—"}
                  </span>
                  <span className="dc-warnmark" aria-hidden={!r.short.length}>
                    {r.short.length > 0 && (
                      <AlertTriangle
                        className="size-3.5"
                        aria-label={t("dc.clearance.title")}
                      />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {(f.short.length > 0 || data.analysis.cooling_over_cells.length > 0) && (
        <ul className="dc-summary-warnings" data-testid="summary-warnings">
          {data.analysis.cooling_over_cells.map((c) => (
            <li key={`cool-${c.object_id}-${c.shelf_id}`}>
              <button type="button" onClick={() => onObject(c.object_id)}>
                <AlertTriangle className="size-4" />
                <span>
                  <b>{t("dc.condensate.title")}</b>
                  {c.object}:{" "}
                  {t("dc.condensate.text", { cells: c.cells.join(", ") })}{" "}
                  <u>{t("dc.summary.show")}</u>
                </span>
              </button>
            </li>
          ))}
          {f.short.map((c) => (
            <li key={`${c.object_id}-${c.side}`}>
              <button type="button" onClick={() => onClearance(c)}>
                <AlertTriangle className="size-4" />
                <span>
                  <b>{t("dc.clearance.title")}</b>
                  {t(
                    c.side === "front"
                      ? "dc.summary.shortFront"
                      : "dc.summary.shortRear",
                    {
                      name: c.object,
                      gap: fmt.mm(clearanceGap(c)),
                      basis: t(`dc.clearance.basis.${c.basis}`),
                      need: fmt.len(c.required_mm),
                    },
                  )}{" "}
                  <u>{t("dc.summary.show")}</u>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <RoomSettingsForm
          data={data}
          run={run}
          open={settingsOpen}
          onOpen={onSettingsOpen}
        />
      )}
    </div>
  );
}

/** The longest run of free units on the rack's front. */
function longestFree(devices: Device[], units: number): number {
  return Math.max(
    0,
    ...freeRuns(devices, units, "front").map((r) => r.to - r.from + 1),
  );
}

export function RackSummary({
  obj,
  item,
  data,
  onFindSpace,
}: {
  obj: DcObject;
  item: CatalogItem;
  data: RoomData;
  onFindSpace: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const units = (item.props as RackProps).units;
  const devices = data.devices.filter((d) => d.rack_id === obj.id);
  const s = rackStats(devices, units, obj.contents_known);
  return (
    <div className="dc-summary" data-testid="rack-summary">
      <div className="dc-rack-figs">
        <div className="dc-figures" data-cols="2">
          <Figure
            value={s.known ? `${s.used} / ${units}U` : null}
            label={t("dc.summary.used")}
          />
          <Figure
            value={
              s.known && s.count - s.unknownPower > 0 ? fmt.kw(s.powerW) : null
            }
            label={t("dc.summary.power")}
          />
          <Figure
            value={s.known ? `${longestFree(devices, units)}U` : null}
            label={t("dc.summary.freeRun")}
          />
          <Figure
            value={s.known ? s.unknownPower : null}
            label={t("dc.summary.noPower")}
          />
        </div>
        <MiniElevation units={units} devices={devices} known={s.known} />
      </div>
      <OwnDims obj={obj} data={data} />
      <div className="dc-actions">
        <Link
          className="dc-btn dc-btn-primary grid place-items-center"
          to={`/dc/${data.room.id}/racks#obj-${obj.id}`}
        >
          {t("dc.inspector.openRack")}
        </Link>
        <button type="button" className="dc-btn" onClick={onFindSpace}>
          {t("dc.inspector.findSpace")}
        </button>
      </div>
      {!s.known && (
        <p className="dc-muted text-xs">{t("dc.rack.notRecordedLong")}</p>
      )}
    </div>
  );
}

/**
 * The rack's elevation beside its figures (FEEDBACK-7 §3): wide enough to
 * read — U ticks every 5U, devices by kind with their name on hover, the
 * free runs dashed.
 */
function MiniElevation({
  units,
  devices,
  known,
}: {
  units: number;
  devices: Device[];
  known: boolean;
}) {
  const { t } = useTranslation();
  const U = 4;
  const H = units * U;
  const [x0, w] = [16, 54];
  const front = devices.filter((d) => d.face !== "rear");
  const y = (u: number) => H - u * U;
  return (
    <svg
      className="dc-mini-elev"
      viewBox={`0 0 ${x0 + w + 1} ${H + 1}`}
      width={x0 + w + 1}
      height={H + 1}
      role="img"
      aria-label={t("dc.rack.elevation", { face: t("dc.face.front") })}
      data-known={known || undefined}
      data-testid="mini-elevation"
    >
      <rect className="dc-mini-elev-bg" x={x0} y={0.5} width={w} height={H} />
      {Array.from({ length: Math.floor(units / 5) }, (_, i) => (i + 1) * 5).map(
        (u) => (
          <g key={u} className="dc-mini-elev-tick">
            <line x1={x0 - 3} x2={x0} y1={y(u) + 0.5} y2={y(u) + 0.5} />
            <text x={x0 - 4} y={y(u) + 3}>
              {u}
            </text>
          </g>
        ),
      )}
      {known &&
        freeRuns(devices, units, "front").map((r) => (
          <rect
            key={`free-${r.from}`}
            className="dc-mini-elev-free"
            x={x0 + 2}
            y={y(r.to) + 1.5}
            width={w - 4}
            height={(r.to - r.from + 1) * U - 2}
          />
        ))}
      {front.map((d) => (
        <g key={d.id} className="dc-elev-dev" data-group={KIND_GROUP[d.kind]}>
          <rect
            x={x0 + 1.5}
            y={y(d.u_bottom + d.u_height - 1) + 1}
            width={w - 3}
            height={d.u_height * U - 1}
          >
            <title>{`${d.name} · U${d.u_bottom}${d.u_height > 1 ? `–${d.u_bottom + d.u_height - 1}` : ""}`}</title>
          </rect>
        </g>
      ))}
    </svg>
  );
}

/** «Стойка 3: ширина» → «Ширина»: the object is the heading already. */
function ownLabel(label: string, name: string): string {
  const rest = label.startsWith(`${name}: `)
    ? label.slice(name.length + 2)
    : label;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The object's own measurements: tape, and the model only where it differs. */
export function OwnDims({ obj, data }: { obj: DcObject; data: RoomData }) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const dims = data.room.measurements.entries.filter(
    (m) => m.objects.includes(obj.name) && m.line,
  );
  if (!dims.length) return null;
  return (
    <dl className="dc-kv dc-own-dims" data-testid="own-dims">
      {dims.map((m) => (
        <div key={m.key} title={m.note && localText(m.note, i18n.language)}>
          <dt>{ownLabel(measureLabel(m.key, t), obj.name)}</dt>
          <dd>
            {disagrees(m) && m.model != null && (
              <small className="dc-model">
                {t("dc.summary.model", { v: fmt.len(m.model) })}
              </small>
            )}
            <b className="dc-num">
              {isRange(m) ? fmt.range(m.min!, m.max!) : fmt.mm(m.value)}
            </b>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One of a room's figures: a number, or «нет данных» when unknown. */
export function Figure({
  value,
  label,
  sub,
}: {
  value: string | number | null;
  label: string;
  sub?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="dc-figure">
      {value === null ? (
        <b className="dc-figure-none">{t("dc.roomsPage.noData")}</b>
      ) : (
        <b className="dc-num">{value}</b>
      )}
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/**
 * The room's settings (FEEDBACK-7 §1.7): the per-rack power budget the power
 * mode judges against, and the service clearances. Saved as a change set,
 * so it has a revision and can be undone.
 */
function RoomSettingsForm({
  data,
  run,
  open,
  onOpen,
}: {
  data: RoomData;
  run: (ops: Op[], label: string) => Promise<boolean>;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const s = data.room.settings;
  const [budget, setBudget] = useState(
    s.rack_power_budget_w === null ? "" : String(s.rack_power_budget_w / 1000),
  );
  const [front, setFront] = useState<number | null>(s.clearance_front_mm);
  const [rear, setRear] = useState<number | null>(s.clearance_rear_mm);
  const kw = Number(budget.replace(",", "."));
  const budgetOk = budget.trim() === "" || (Number.isFinite(kw) && kw > 0);
  return (
    <details
      className="dc-more"
      open={open}
      onToggle={(e) => onOpen((e.target as HTMLDetailsElement).open)}
      data-testid="room-settings"
    >
      <summary>{t("dc.roomSettings.title")}</summary>
      <form
        className="space-y-2 pt-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!budgetOk || front === null || rear === null) return;
          void run(
            [
              {
                op: "room_settings",
                settings: {
                  ...s,
                  rack_power_budget_w:
                    budget.trim() === "" ? null : Math.round(kw * 1000),
                  clearance_front_mm: front,
                  clearance_rear_mm: rear,
                },
              },
            ],
            t("dc.roomSettings.change"),
          );
        }}
      >
        <label className="block">
          <span className="text-xs">{t("dc.roomSettings.budget")}</span>
          <Input
            id="room-budget"
            inputMode="decimal"
            placeholder={t("dc.roomSettings.budgetHint")}
            value={budget}
            aria-invalid={!budgetOk || undefined}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs">
              {t("dc.roomSettings.front", { unit: fmt.unitWord })}
            </span>
            <LengthInput id="room-front" value={front} onChange={setFront} />
          </label>
          <label className="block">
            <span className="text-xs">
              {t("dc.roomSettings.rear", { unit: fmt.unitWord })}
            </span>
            <LengthInput id="room-rear" value={rear} onChange={setRear} />
          </label>
        </div>
        <button
          type="submit"
          className="dc-btn dc-btn-primary"
          disabled={!budgetOk || front === null || rear === null}
        >
          {t("dc.roomSettings.save")}
        </button>
      </form>
    </details>
  );
}
