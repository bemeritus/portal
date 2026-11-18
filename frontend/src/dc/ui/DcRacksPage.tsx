/**
 * `/dc/:roomId/racks` — every rack's elevation side by side, the racks tab
 * of the module. The rack in the hash (`#obj-12`) is scrolled to.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { useToolAccess } from "../../auth/useToolAccess";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { translateApiError } from "../../i18n/errors";
import type { SelRef } from "../engine/DcEngine";
import { useChanges, useRoom } from "../hooks";
import type { CatalogItem, Op } from "../types";
import { RackPanel } from "./RackPanel";

export function DcRacksPage() {
  const { t, i18n } = useTranslation();
  const roomId = Number(useParams().roomId);
  const canEdit = useToolAccess().can("dc_room", "edit");
  const room = useRoom(roomId);
  const data = room.data;
  const changes = useChanges(roomId, data);
  const [selection, setSelection] = useState<SelRef>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useMemo(
    () =>
      new Map<number, CatalogItem>((data?.catalog ?? []).map((c) => [c.id, c])),
    [data],
  );
  const racks = (data?.objects ?? [])
    .filter((o) => catalog.get(o.catalog_id)?.kind === "rack")
    .sort((a, b) => a.x0_mm - b.x0_mm);

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

  if (room.isPending) return <Spinner />;
  if (!data) return <ErrorFlash error={errorMessage(room.error)} />;
  return (
    <div>
      <h1 className="dc-heading mb-4 text-xl">{t("dc.shell.racks")}</h1>
      <ErrorFlash error={error} />
      <div className="dc-racks">
        {racks.map((o) => (
          <section key={o.id} id={`obj-${o.id}`} className="dc-panel">
            <h2 className="dc-heading mb-2 text-base">{o.name}</h2>
            <RackPanel
              obj={o}
              item={catalog.get(o.catalog_id)!}
              data={data}
              selection={selection}
              canEdit={canEdit}
              prefill={null}
              onPrefillUsed={() => {}}
              onSelect={(ref) => setSelection(ref)}
              run={run}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
