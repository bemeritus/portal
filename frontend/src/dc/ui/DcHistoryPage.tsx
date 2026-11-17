/**
 * `/dc/:roomId/history` — the room's revisions, newest first, with who changed
 * what; the diff of any revision against the one before; and restoring an
 * older one *as a new revision*, so nothing is rewound and a mistaken restore
 * is itself undone by restoring again. Mirrors the document history page.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/client";
import { useToolAccess } from "../../auth/useToolAccess";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash, Flash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { formatUtc } from "../../format";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import type { EntityChange } from "../types";

export function DcHistoryPage() {
  const { roomId: param } = useParams();
  const roomId = Number(param);
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const canEdit = useToolAccess().can("dc_room", "edit");
  const [n, setN] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["dc", "revisions", roomId],
    queryFn: ({ signal }) => dcApi.revisions(roomId, signal),
  });
  const head = list.data?.[0]?.revision ?? null;
  const current = n ?? head;
  const detail = useQuery({
    queryKey: ["dc", "revision", roomId, current],
    queryFn: ({ signal }) => dcApi.revision(roomId, current!, signal),
    enabled: current !== null,
  });
  useEffect(() => {
    document.title = t("docTitle", {
      page: t("dc.history.title"),
      app: t("app.name"),
    });
  }, [t]);

  async function restore(rev: number) {
    setError(null);
    try {
      const r = await dcApi.restore(roomId, rev, head!);
      setNotice(t("dc.history.restored", { from: rev, to: r.revision }));
      await qc.invalidateQueries({ queryKey: ["dc"] });
      setN(null);
    } catch (e) {
      setError(translateApiError(errorMessage(e), i18n.language));
      await qc.invalidateQueries({ queryKey: ["dc", "revisions", roomId] });
    }
  }

  return (
    <>
      <p className="mb-2">
        <Link
          to={`/dc/${roomId}`}
          className="text-sm text-link hover:underline"
        >
          ← {t("dc.history.back")}
        </Link>
      </p>
      <h1>{t("dc.history.title")}</h1>
      {notice && <Flash kind="ok">{notice}</Flash>}
      <ErrorFlash error={error} />
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorFlash error={errorMessage(list.error)} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[320px_1fr]">
          <ol className="space-y-1">
            {list.data.map((r) => (
              <li key={r.revision}>
                <button
                  type="button"
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent",
                    current === r.revision && "border-primary bg-accent",
                  )}
                  onClick={() => setN(r.revision)}
                >
                  <div className="font-medium">
                    {t("dc.revision", { n: r.revision })}
                    {r.revision === head && (
                      <span className="ml-2 text-xs text-success">
                        {t("dc.history.current")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.author_name} · {formatUtc(r.created_at)}
                  </div>
                  <div className="text-xs">{r.summary}</div>
                </button>
              </li>
            ))}
          </ol>
          <div>
            {detail.isPending ? (
              <Spinner />
            ) : detail.error ? (
              <ErrorFlash error={errorMessage(detail.error)} />
            ) : (
              detail.data && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="m-0 text-lg">
                      {t("dc.revision", { n: detail.data.revision })} —{" "}
                      {detail.data.summary}
                    </h2>
                    {canEdit && detail.data.revision !== head && (
                      <ConfirmButton
                        label={t("dc.history.restore")}
                        confirmLabel={t("dc.history.restoreConfirm", {
                          n: detail.data.revision,
                        })}
                        onConfirm={() => void restore(detail.data!.revision)}
                      />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {detail.data.revision === 1
                      ? t("dc.history.first")
                      : t("dc.history.against", {
                          n: detail.data.revision - 1,
                        })}
                  </p>
                  {(
                    ["objects", "devices", "cells", "annotations"] as const
                  ).map((k) => (
                    <DiffSection
                      key={k}
                      title={t(`dc.history.section.${k}`)}
                      changes={detail.data!.diff[k]}
                    />
                  ))}
                  {Object.values(detail.data.diff).every(
                    (l) => l.length === 0,
                  ) && (
                    <p className="text-sm text-muted-foreground">
                      {t("dc.history.noChanges")}
                    </p>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      )}
      <Button variant="ghost" className="mt-4" asChild>
        <Link to={`/dc/${roomId}`}>{t("dc.history.back")}</Link>
      </Button>
    </>
  );
}

const show = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);

function name(v: Record<string, unknown>): string {
  const p = v.payload as Record<string, unknown> | undefined;
  return String(
    v.name ??
      p?.name ??
      p?.text ??
      (v.cell_no !== undefined ? `#${v.cell_no}` : ""),
  );
}

function DiffSection({
  title,
  changes,
}: {
  title: string;
  changes: EntityChange[];
}) {
  const { t } = useTranslation();
  if (!changes.length) return null;
  return (
    <section>
      <h3 className="mb-1 text-sm">{title}</h3>
      <ul className="space-y-1 text-sm">
        {changes.map((c) => (
          <li key={`${c.change}-${c.key}`} className="rounded-md border p-2">
            {c.change === "added" && (
              <span className="text-success">
                + {name(c.after)}{" "}
                {c.after.u_bottom !== undefined &&
                  `(U${String(c.after.u_bottom)})`}
              </span>
            )}
            {c.change === "removed" && (
              <span className="text-destructive">
                − {name(c.before)}{" "}
                {c.before.u_bottom !== undefined &&
                  `(U${String(c.before.u_bottom)})`}
              </span>
            )}
            {c.change === "changed" && (
              <>
                <div className="font-medium">{c.name || c.key}</div>
                {c.fields.map((f) => (
                  <div key={f.field} className="text-xs">
                    {t(`dc.field.${f.field}` as never, {
                      defaultValue: f.field,
                    })}
                    :{" "}
                    <span className="text-destructive line-through">
                      {show(f.before)}
                    </span>{" "}
                    → <span className="text-success">{show(f.after)}</span>
                  </div>
                ))}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
