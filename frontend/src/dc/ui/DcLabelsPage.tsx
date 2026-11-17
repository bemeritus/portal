/**
 * `/dc/:roomId/labels[?object=12]` — QR stickers on an A4 sheet (§11.4):
 * one per rack, device, shelf and occupied cell (or for one rack / shelf).
 * Printing it — «Печать» or Ctrl+P — gives the PDF through the browser.
 */

import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { encode } from "uqr";

import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { useRoom } from "../hooks";
import { labelsFor } from "../model/qr";
import type { CatalogItem } from "../types";

export function DcLabelsPage() {
  const { t } = useTranslation();
  const roomId = Number(useParams().roomId);
  const only = useSearchParams()[0].get("object");
  const room = useRoom(roomId);
  const data = room.data;
  const labels = useMemo(() => {
    if (!data) return [];
    const catalog = new Map<number, CatalogItem>(data.catalog.map((c) => [c.id, c]));
    return labelsFor(window.location.origin, roomId, data.objects, catalog, data.devices, data.cells, (n) => t("dc.shelf.cell", { n }), only ? Number(only) : null);
  }, [data, roomId, only, t]);

  if (room.isPending) return <Spinner />;
  if (!data) return <ErrorFlash error={errorMessage(room.error)} />;
  return (
    <div className="dc-page">
      <div className="no-print mb-4 flex items-center gap-3">
        <h1 className="dc-heading m-0 text-xl">{t("dc.qr.title")}</h1>
        <span style={{ color: "var(--dc-muted)" }}>{t("dc.qr.count", { count: labels.length })}</span>
        <button type="button" className="dc-btn dc-btn-primary ml-auto" onClick={() => window.print()}>
          {t("dc.qr.print")}
        </button>
        <Link className="dc-btn grid place-items-center" to={`/dc/${roomId}`}>
          {t("dc.qr.back")}
        </Link>
      </div>
      <p className="no-print mb-4 text-xs" style={{ color: "var(--dc-muted)" }}>
        {t("dc.qr.hint")}
      </p>
      <div className="dc-qr-sheet">
        {labels.map((l) => (
          <div key={l.key} className="dc-qr">
            <Qr text={l.url} />
            <div>
              <b>{l.title}</b>
              {l.detail}
              <small>{l.url.replace(/^https?:\/\//, "")}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const q = useMemo(() => encode(text, { ecc: "M", border: 1 }), [text]);
  const path = q.data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
  return (
    <svg viewBox={`0 0 ${q.size} ${q.size}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect width={q.size} height={q.size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
