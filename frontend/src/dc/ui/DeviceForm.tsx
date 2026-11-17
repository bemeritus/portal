/**
 * Add or edit one device. Units are checked against the rack as you type;
 * power left empty means *unknown*, which is not the same as 0 and is never
 * shown as 0.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmButton } from "../../components/ConfirmButton";
import { guessKind, unitsFree } from "../model/devices";
import { DEVICE_KINDS, DEVICE_STATUSES, type DcObject, type Device, type DeviceFields, type Face, type PowerSrc } from "../types";

interface Props {
  title: string;
  initial: DeviceFields;
  deviceId?: number;
  rack: DcObject;
  units: number;
  devices: Device[];
  racks: DcObject[];
  canEdit: boolean;
  onSave: (f: DeviceFields) => Promise<boolean>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}

const sel = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

export function DeviceForm({ title, initial, deviceId, rack, units, devices, racks, canEdit, onSave, onCancel, onDelete }: Props) {
  const { t } = useTranslation();
  const [f, setF] = useState<DeviceFields>(initial);
  const [kindTouched, setKindTouched] = useState(deviceId !== undefined);
  const [busy, setBusy] = useState(false);
  const sameRack = f.rack_id === rack.id;
  const free = !sameRack || unitsFree(devices, units, f.u_bottom, f.u_height, f.face, deviceId);
  const fits = f.u_bottom >= 1 && f.u_bottom + f.u_height - 1 <= units && f.u_height >= 1;
  const valid = f.name.trim() !== "" && fits && free && (f.power_w === null || f.power_w >= 0);
  const ro = !canEdit;
  const int = (v: string) => (v === "" ? 0 : Math.round(Number(v)));

  return (
    <form
      className="space-y-2 rounded-md border p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || ro) return;
        setBusy(true);
        // Kept on failure: the form is not reset, so nothing typed is lost.
        await onSave({ ...f, name: f.name.trim(), power_src: f.power_w === null ? null : f.power_src });
        setBusy(false);
      }}
    >
      <div className="font-medium">{title}</div>
      <div>
        <Label htmlFor="d-name">{t("dc.device.name")}</Label>
        <Input
          id="d-name"
          value={f.name}
          disabled={ro}
          autoFocus={deviceId === undefined}
          onChange={(e) => setF({ ...f, name: e.target.value, kind: kindTouched ? f.kind : guessKind(e.target.value) })}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor="d-u">{t("dc.device.uBottom")}</Label>
          <Input id="d-u" type="number" min={1} max={units} value={f.u_bottom} disabled={ro} onChange={(e) => setF({ ...f, u_bottom: int(e.target.value) })} />
        </div>
        <div>
          <Label htmlFor="d-h">{t("dc.device.uHeight")}</Label>
          <Input id="d-h" type="number" min={1} max={units} value={f.u_height} disabled={ro} onChange={(e) => setF({ ...f, u_height: int(e.target.value) })} />
        </div>
        <div>
          <Label htmlFor="d-face">{t("dc.device.face")}</Label>
          <select id="d-face" className={sel} value={f.face} disabled={ro} onChange={(e) => setF({ ...f, face: e.target.value as Face })}>
            {(["front", "rear", "both"] as Face[]).map((x) => (
              <option key={x} value={x}>
                {t(`dc.face.${x}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!fits && <p className="text-xs text-destructive">{t("dc.device.notFit", { units })}</p>}
      {fits && !free && <p className="text-xs text-destructive">{t("dc.device.taken")}</p>}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="d-kind">{t("dc.device.kind")}</Label>
          <select
            id="d-kind"
            className={sel}
            value={f.kind}
            disabled={ro}
            onChange={(e) => {
              setKindTouched(true);
              setF({ ...f, kind: e.target.value as DeviceFields["kind"] });
            }}
          >
            {DEVICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`dc.deviceKind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="d-status">{t("dc.device.status")}</Label>
          <select id="d-status" className={sel} value={f.status} disabled={ro} onChange={(e) => setF({ ...f, status: e.target.value as DeviceFields["status"] })}>
            {DEVICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`dc.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="d-power">{t("dc.device.power")}</Label>
          <Input
            id="d-power"
            type="number"
            min={0}
            placeholder={t("dc.device.powerUnknown")}
            value={f.power_w ?? ""}
            disabled={ro}
            onChange={(e) => setF({ ...f, power_w: e.target.value === "" ? null : int(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="d-psrc">{t("dc.device.powerSrc")}</Label>
          <select id="d-psrc" className={sel} value={f.power_src ?? ""} disabled={ro || f.power_w === null} onChange={(e) => setF({ ...f, power_src: (e.target.value || null) as PowerSrc | null })}>
            <option value="">—</option>
            {(["nameplate", "measured", "estimated"] as PowerSrc[]).map((s) => (
              <option key={s} value={s}>
                {t(`dc.powerSrc.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="d-owner">{t("dc.device.owner")}</Label>
          <Input id="d-owner" value={f.owner} disabled={ro} onChange={(e) => setF({ ...f, owner: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="d-serial">{t("dc.device.serial")}</Label>
          <Input id="d-serial" value={f.serial} disabled={ro} onChange={(e) => setF({ ...f, serial: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="d-depth">{t("dc.device.depth")}</Label>
          <Input
            id="d-depth"
            type="number"
            min={1}
            placeholder={t("dc.device.depthTypical")}
            value={f.depth_mm ?? ""}
            disabled={ro}
            onChange={(e) => setF({ ...f, depth_mm: e.target.value === "" ? null : int(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="d-rack">{t("dc.device.rack")}</Label>
          <select id="d-rack" className={sel} value={f.rack_id} disabled={ro} onChange={(e) => setF({ ...f, rack_id: Number(e.target.value) })}>
            {racks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor="d-note">{t("dc.device.note")}</Label>
        <textarea id="d-note" rows={2} className="w-full rounded-md border bg-background p-1.5 text-sm" value={f.note} disabled={ro} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!valid || busy}>
            {t("common.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          {onDelete && <ConfirmButton label={t("dc.device.remove")} confirmLabel={t("dc.device.remove")} onConfirm={() => void onDelete()} />}
        </div>
      )}
    </form>
  );
}
