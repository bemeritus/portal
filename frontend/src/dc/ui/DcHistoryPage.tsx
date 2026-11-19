/**
 * `/dc/:roomId/history` (FEEDBACK-6 §6, `History.png`): the room's revisions
 * as sentences a person understands, with author and time, filtered to all,
 * mine or imports; a revision's detail with plans before and after (what it
 * touched marked), its changes grouped with old → new, a way to see the room
 * at that revision in 3D, and restoring it — as a new revision, so the
 * history is never rewritten. `?rev=N` opens a revision.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { useToolAccess } from "../../auth/useToolAccess";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash, Flash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { tDyn } from "../../i18n";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import { whenText } from "../format";
import { changeRows, touched, type ChangeRow } from "../model/history";
import {
  localText,
  type DcObject,
  type EntityChange,
  type RevisionDetail,
  type RoomData,
  type Text,
} from "../types";
import { MiniPlan } from "./MiniPlan";
import { Avatar, bySurvey, revisionText } from "./revisionText";

type Filter = "all" | "mine" | "import";

export function DcHistoryPage() {
  const { roomId: param } = useParams();
  const roomId = Number(param);
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useAuth().user?.id;
  const canEdit = useToolAccess().can("dc_room", "edit");
  const [search, setSearch] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const room = useQuery({
    queryKey: ["dc", "room", roomId],
    queryFn: ({ signal }) => dcApi.room(roomId, signal),
  });
  const list = useQuery({
    queryKey: ["dc", "revisions", roomId],
    queryFn: ({ signal }) => dcApi.revisions(roomId, signal),
  });
  const head = list.data?.[0]?.revision ?? null;
  const current = Number(search.get("rev")) || head;
  const detail = useQuery({
    queryKey: ["dc", "revision", roomId, current],
    queryFn: ({ signal }) => dcApi.revision(roomId, current!, signal),
    enabled: current !== null,
  });
  const before = useQuery({
    queryKey: ["dc", "revision", roomId, (current ?? 0) - 1],
    queryFn: ({ signal }) => dcApi.revision(roomId, current! - 1, signal),
    enabled: current !== null && current > 1,
  });
  useEffect(() => {
    document.title = t("docTitle", {
      page: t("dc.history.title"),
      app: t("app.name"),
    });
  }, [t]);

  const shown = (list.data ?? []).filter(
    (r) =>
      filter === "all" ||
      (filter === "mine" && r.author_id !== null && r.author_id === me) ||
      (filter === "import" && r.digest.kind === "import"),
  );
  const open = (n: number) => {
    const q = new URLSearchParams(search);
    q.set("rev", String(n));
    setSearch(q, { replace: true });
  };

  async function restore(rev: number) {
    setError(null);
    try {
      const r = await dcApi.restore(roomId, rev, head!);
      setNotice(t("dc.history.restored", { from: rev, to: r.revision }));
      await qc.invalidateQueries({ queryKey: ["dc"] });
      open(r.revision);
    } catch (e) {
      setError(translateApiError(errorMessage(e), i18n.language));
      await qc.invalidateQueries({ queryKey: ["dc", "revisions", roomId] });
    }
  }

  return (
    <div className="dc-history">
      <Link to={`/dc/${roomId}`} className="dc-back">
        ← {room.data?.room.name ?? t("dc.history.back")}
      </Link>
      <div className="dc-history-head">
        <h1>{t("dc.history.title")}</h1>
        <div
          className="dc-seg"
          role="radiogroup"
          aria-label={t("dc.history.filter")}
        >
          {(["all", "mine", "import"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`dc.history.only.${f}`)}
            </button>
          ))}
        </div>
      </div>
      {notice && <Flash kind="ok">{notice}</Flash>}
      <ErrorFlash error={error} />
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorFlash error={errorMessage(list.error)} />
      ) : (
        <div className="dc-history-grid">
          <ol className="dc-revs" aria-label={t("dc.history.title")}>
            {shown.length === 0 && (
              <li className="dc-muted">{t("dc.history.noneShown")}</li>
            )}
            {shown.map((r) => (
              <li key={r.revision}>
                <button
                  type="button"
                  aria-current={current === r.revision || undefined}
                  onClick={() => open(r.revision)}
                >
                  <Avatar r={r} t={t} />
                  <span>
                    <b>{revisionText(r.digest, t)}</b>
                    <small>
                      {t("dc.history.revLine", {
                        n: r.revision,
                        when: whenText(r.created_at, i18n.language, t),
                      })}
                      {r.revision === head && ` · ${t("dc.history.current")}`}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <section className="dc-card dc-rev-detail" aria-live="polite">
            {detail.isPending || !room.data ? (
              <Spinner />
            ) : detail.error ? (
              <ErrorFlash error={errorMessage(detail.error)} />
            ) : (
              <Detail
                roomId={roomId}
                d={detail.data}
                before={detail.data.revision > 1 ? before.data : undefined}
                room={room.data}
                head={head!}
                canRestore={canEdit && detail.data.revision !== head}
                onRestore={() => void restore(detail.data.revision)}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Detail({
  roomId,
  d,
  before,
  room,
  head,
  canRestore,
  onRestore,
}: {
  roomId: number;
  d: RevisionDetail;
  before: RevisionDetail | undefined;
  room: RoomData;
  head: number;
  canRestore: boolean;
  onRestore: () => void;
}) {
  const { t, i18n } = useTranslation();
  const catalog = useMemo(
    () => new Map(room.catalog.map((c) => [c.id, c])),
    [room.catalog],
  );
  const marked = touched(d.digest);
  const rows = changeRows(d.digest);
  const plan = (objects: DcObject[], label: string) => (
    <MiniPlan
      floorPlan={room.room.floor_plan}
      objects={objects}
      catalog={catalog}
      marked={marked}
      tone="change"
      label={label}
    />
  );
  const beforeLabel =
    d.revision > 1
      ? t("dc.history.before", { n: d.revision - 1 })
      : t("dc.history.beforeNone");
  const afterLabel = t("dc.history.after", { n: d.revision });
  return (
    <>
      <header className="dc-rev-head">
        <div>
          <small className="dc-muted">
            {t("dc.history.detailLine", {
              n: d.revision,
              when: whenText(d.created_at, i18n.language, t),
            })}
            {!bySurvey(d) && ` · ${d.author_name}`}
          </small>
          <h2>{revisionText(d.digest, t)}</h2>
        </div>
        <div className="dc-rev-actions">
          <Link
            className="dc-btn"
            to={`/dc/${roomId}?view=3d&rev=${d.revision}`}
          >
            {t("dc.history.open3d")}
          </Link>
          {canRestore && (
            <ConfirmButton
              label={t("dc.history.restore")}
              confirmLabel={t("dc.history.restoreConfirm", { n: d.revision })}
              onConfirm={onRestore}
            />
          )}
        </div>
      </header>
      <div className="dc-rev-plans">
        <figure>
          <figcaption>{beforeLabel}</figcaption>
          <div className="dc-rev-plan">
            {d.revision === 1 ? (
              plan([], beforeLabel)
            ) : before ? (
              plan(before.snapshot.objects, beforeLabel)
            ) : (
              <Spinner />
            )}
          </div>
        </figure>
        <figure>
          <figcaption>{afterLabel}</figcaption>
          <div className="dc-rev-plan">
            {plan(d.snapshot.objects, afterLabel)}
          </div>
        </figure>
      </div>
      {d.digest.kind === "created" ? (
        <p className="dc-muted">{t("dc.history.createdNote")}</p>
      ) : (
        <section>
          <h3 className="dc-rev-count">
            {t("dc.history.changes", { count: rows.length })}
          </h3>
          {rows.length === 0 ? (
            <p className="dc-muted">{t("dc.history.noChanges")}</p>
          ) : (
            <ul className="dc-rev-changes">
              {rows.slice(0, 200).map((r, i) => (
                <ChangeLine key={i} r={r} diff={d.diff} />
              ))}
              {rows.length > 200 && (
                <li className="dc-muted">
                  {t("dc.revs.more", { count: rows.length - 200 })}
                </li>
              )}
            </ul>
          )}
        </section>
      )}
      {d.revision !== head && (
        <p className="dc-rev-note">
          {t("dc.history.restoreNote", { next: head + 1, n: d.revision })}
        </p>
      )}
    </>
  );
}

/** One change: what happened, to what, from → to; other edits field by field. */
function ChangeLine({
  r,
  diff,
}: {
  r: ChangeRow;
  diff: RevisionDetail["diff"];
}) {
  const { t, i18n } = useTranslation();
  const fields =
    r.tag === "changed"
      ? ([...diff.devices, ...diff.objects].find(
          (c): c is Extract<EntityChange, { change: "changed" }> =>
            c.change === "changed" && c.name === r.name,
        )?.fields ?? [])
      : [];
  return (
    <li>
      <span className="dc-pill" data-tag={r.tag}>
        {t(`dc.revs.tag.${r.tag}`)}
      </span>
      <div>
        <b>
          {r.name}
          {r.kind && (
            <span className="dc-muted">
              {" "}
              · {tDyn(t, `dc.deviceKind.${r.kind}`)}
            </span>
          )}
          {r.count !== undefined && (
            <span className="dc-muted">
              {" "}
              · {t("dc.revs.count.device", { count: r.count })}
            </span>
          )}
        </b>
        {(r.before || r.after) && (
          <div className="dc-muted">
            {r.before}
            {r.before && r.after && " → "}
            {r.after}
          </div>
        )}
        {fields
          .filter((f) => f.field !== "contents_known")
          .map((f) => (
            <div key={f.field} className="dc-muted">
              {tDyn(t, `dc.field.${f.field}`)}: {show(f.before, i18n.language)}{" "}
              → {show(f.after, i18n.language)}
            </div>
          ))}
      </div>
    </li>
  );
}

/** A note in every language ({en, ru, uz}) shows in the user's. */
const isLocal = (v: unknown): v is Text =>
  typeof v === "object" &&
  v !== null &&
  ["en", "ru", "uz"].every(
    (k) => typeof (v as Record<string, unknown>)[k] === "string",
  );

const show = (v: unknown, lang: string) =>
  v === null || v === undefined || v === ""
    ? "—"
    : isLocal(v)
      ? localText(v, lang)
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
