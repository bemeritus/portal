/**
 * The capacity finder: "where can a 2U, 450 W server go?" → racks with a free
 * contiguous range on that face, ranked by the server (see
 * `backend/src/dc/capacity.rs`). Picking one selects the rack, marks the range
 * and pre-fills the add form.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { dcApi } from "../api";
import { useFmt } from "../settings";
import type { CapacityCandidate, Face } from "../types";

export interface CapacityRequest {
  u: number;
  face: Face;
  power: number | null;
}

export function CapacityPanel({
  roomId,
  revision,
  canEdit,
  initial,
  onPick,
}: {
  roomId: number;
  revision: number;
  canEdit: boolean;
  /** A request from the command palette: fill the form and ask at once. */
  initial?: CapacityRequest | null;
  onPick: (c: CapacityCandidate, req: CapacityRequest) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [u, setU] = useState(2);
  const [power, setPower] = useState<string>("");
  const [face, setFace] = useState<Face>("front");
  const [asked, setAsked] = useState<CapacityRequest | null>(initial ?? null);
  useEffect(() => {
    if (!initial) return;
    setU(initial.u);
    setPower(initial.power === null ? "" : String(initial.power));
    setFace(initial.face);
    setAsked(initial);
  }, [initial]);
  const q = useQuery({
    queryKey: ["dc", "capacity", roomId, revision, asked],
    queryFn: ({ signal }) =>
      dcApi.capacity(roomId, asked!.u, asked!.face, asked!.power, signal),
    enabled: asked !== null,
  });
  return (
    <div className="space-y-3 text-sm">
      <form
        className="grid grid-cols-3 items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked({
            u,
            face,
            power: power === "" ? null : Math.max(0, Math.round(Number(power))),
          });
        }}
      >
        <div>
          <Label htmlFor="cap-u">{t("dc.capacity.units")}</Label>
          <Input
            id="cap-u"
            type="number"
            min={1}
            max={60}
            value={u}
            onChange={(e) =>
              setU(Math.max(1, Math.round(Number(e.target.value) || 1)))
            }
          />
        </div>
        <div>
          <Label htmlFor="cap-p">{t("dc.capacity.power")}</Label>
          <Input
            id="cap-p"
            type="number"
            min={0}
            placeholder={t("dc.device.powerUnknown")}
            value={power}
            onChange={(e) => setPower(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="cap-f">{t("dc.device.face")}</Label>
          <select
            id="cap-f"
            className="w-full rounded-md border bg-background px-2 py-1.5"
            value={face}
            onChange={(e) => setFace(e.target.value as Face)}
          >
            {(["front", "rear", "both"] as Face[]).map((f) => (
              <option key={f} value={f}>
                {t(`dc.face.${f}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" className="col-span-3">
          {t("dc.capacity.find")}
        </Button>
      </form>
      {asked && q.isPending && <Spinner />}
      <ErrorFlash error={q.error ? errorMessage(q.error) : null} />
      {q.data && (
        <>
          {q.data.candidates.length === 0 && (
            <p className="text-muted-foreground">{t("dc.capacity.none")}</p>
          )}
          <ol className="space-y-2">
            {q.data.candidates.map((c, i) => (
              <li key={c.rack_id} className="rounded-md border p-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {i + 1}. {c.rack_name}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPick(c, asked!)}
                  >
                    {canEdit ? t("dc.capacity.pickAdd") : t("dc.capacity.pick")}
                  </Button>
                </div>
                <div>
                  {t("dc.capacity.suggest", {
                    from: c.suggestion.from,
                    to: c.suggestion.to,
                  })}{" "}
                  · {t("dc.capacity.free", { n: c.free_units })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("dc.capacity.runs")}:{" "}
                  {c.ranges
                    .map((r) =>
                      r.from === r.to ? `U${r.from}` : `U${r.from}–${r.to}`,
                    )
                    .join(", ")}
                </div>
                <div className="text-xs">
                  {t("dc.capacity.load", { w: fmt.w(c.used_power_w) })}
                  {c.unknown_power > 0 && (
                    <span className="text-tag-3">
                      {" "}
                      ·{" "}
                      {t("dc.rack.unknownPowerCount", {
                        count: c.unknown_power,
                      })}
                    </span>
                  )}
                  {c.budget_w !== null && (
                    <>
                      {" "}
                      ·{" "}
                      {t("dc.capacity.headroom", {
                        w: fmt.w(c.headroom_w ?? 0),
                      })}
                    </>
                  )}
                  {c.fits_power === false && (
                    <span className="text-destructive">
                      {" "}
                      · {t("dc.capacity.overBudget")}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {q.data.not_recorded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("dc.capacity.notRecorded", {
                racks: q.data.not_recorded.join(", "),
              })}
            </p>
          )}
          {q.data.no_space.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("dc.capacity.noSpace", { racks: q.data.no_space.join(", ") })}
            </p>
          )}
          {q.data.candidates.some((c) => c.budget_w === null) && (
            <p className="text-xs text-muted-foreground">
              {t("dc.capacity.noBudget")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
