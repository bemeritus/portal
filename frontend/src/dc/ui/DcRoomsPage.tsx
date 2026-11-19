/**
 * `/dc` — the server rooms (FEEDBACK-6 §5, `Rooms.png`): each room as a card
 * with a plan drawn from the room itself (warnings in red), its figures, its
 * last change in words and the ways into it; a placeholder for the room
 * builder; beside them the catalog and the recent changes across rooms.
 */

import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Spinner } from "../../components/Loading";
import { dcApi } from "../api";
import { whenText } from "../format";
import { percent, roomFigures } from "../model/summary";
import { useFmt } from "../settings";
import type { RevisionSummary, RoomData, RoomSummary } from "../types";
import { useCatalog } from "./catalogParts";
import { MiniPlan } from "./MiniPlan";
import { Avatar, revisionText } from "./revisionText";
import { Figure } from "./RoomSummary";

export function DcRoomsPage() {
  const { t, i18n } = useTranslation();
  const rooms = useQuery({
    queryKey: ["dc", "rooms"],
    queryFn: ({ signal }) => dcApi.rooms(signal),
  });
  const ids = rooms.data?.map((r) => r.id) ?? [];
  const data = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["dc", "room", id],
      queryFn: ({ signal }: { signal: AbortSignal }) => dcApi.room(id, signal),
    })),
  });
  const revs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["dc", "revisions", id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        dcApi.revisions(id, signal),
    })),
  });
  const { items } = useCatalog();
  useEffect(() => {
    document.title = t("docTitle", { page: t("dc.title"), app: t("app.name") });
  }, [t]);

  // The latest changes across every room, newest first.
  const recent = useMemo(
    () =>
      revs
        .flatMap((q, i) =>
          (q.data ?? []).map((r) => ({ r, room: rooms.data![i] })),
        )
        .sort((a, b) => b.r.created_at.localeCompare(a.r.created_at))
        .slice(0, 5),
    [revs, rooms.data],
  );

  return (
    <div className="dc-rooms">
      <h1>{t("dc.title")}</h1>
      {rooms.isPending ? (
        <Spinner />
      ) : rooms.error ? (
        <ErrorFlash error={errorMessage(rooms.error)} />
      ) : (
        <div className="dc-rooms-grid">
          <div className="dc-rooms-main">
            {rooms.data.length === 0 && <Empty title={t("dc.noRooms")} />}
            {rooms.data.map((r, i) => (
              <RoomCard
                key={r.id}
                room={r}
                data={data[i]?.data}
                revisions={revs[i]?.data}
              />
            ))}
            <div className="dc-room-new" aria-disabled>
              <b>{t("dc.roomsPage.newRoom")}</b>
              <span>{t("dc.roomsPage.newRoomHint")}</span>
            </div>
          </div>
          <aside className="dc-rooms-side">
            <Link to="/dc/catalog" className="dc-card dc-side-card">
              <b>{t("dc.roomsPage.catalog")}</b>
              <span>
                {t("dc.roomsPage.catalogHint", {
                  count: items.data?.length ?? 0,
                })}
              </span>
            </Link>
            {recent.length > 0 && (
              <section className="dc-card dc-side-card">
                <b>{t("dc.roomsPage.recent")}</b>
                <ul className="dc-recent">
                  {recent.map(({ r, room }) => (
                    <li key={`${room.id}-${r.revision}`}>
                      <Avatar r={r} t={t} />
                      <Link to={`/dc/${room.id}/history?rev=${r.revision}`}>
                        <span>{revisionText(r.digest, t)}</span>
                        <small>
                          {rooms.data.length > 1 && `${room.name} · `}
                          {whenText(r.created_at, i18n.language, t)}
                        </small>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function RoomCard({
  room,
  data,
  revisions,
}: {
  room: RoomSummary;
  data?: RoomData;
  revisions?: RevisionSummary[];
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const catalog = useMemo(
    () => new Map((data?.catalog ?? []).map((c) => [c.id, c])),
    [data],
  );
  const f = data ? roomFigures(data) : null;
  const warned = new Set(
    (f?.short ?? []).map(
      (c) => data!.objects.find((o) => o.id === c.object_id)?.name ?? "",
    ),
  );
  const last = revisions?.[0];
  const used = f ? percent(f.used, f.units) : null;
  return (
    <article className="dc-card dc-room-card" data-testid="room-card">
      <Link
        to={`/dc/${room.id}`}
        className="dc-room-plan"
        aria-label={t("dc.roomsPage.planLabel", { name: room.name })}
      >
        {data && (
          <MiniPlan
            floorPlan={data.room.floor_plan}
            objects={data.objects}
            catalog={catalog}
            marked={warned}
          />
        )}
      </Link>
      <div className="dc-room-info">
        <header>
          <h2>{room.name}</h2>
          {f && f.short.length > 0 && (
            <span className="dc-pill" data-tone="warn">
              {t("dc.roomsPage.warnings", { count: f.short.length })}
            </span>
          )}
        </header>
        {f && <div className="dc-muted dc-num">{fmt.dims(...f.size)}</div>}
        <div className="dc-figures">
          <Figure value={room.rack_count} label={t("dc.roomsPage.racks")} />
          <Figure value={room.device_count} label={t("dc.roomsPage.devices")} />
          <Figure
            value={used === null ? null : `${used} %`}
            label={t("dc.roomsPage.used")}
          />
          <Figure
            value={f && f.powerKnown > 0 ? fmt.kw(f.powerW) : null}
            label={t("dc.roomsPage.power")}
            sub={
              f && f.powerKnown > 0
                ? t("dc.roomsPage.powerOf", {
                    known: f.powerKnown,
                    total: f.devices,
                  })
                : undefined
            }
          />
        </div>
        {f?.empty && <p className="dc-muted">{t("dc.roomsPage.noDevices")}</p>}
        {last && (
          <p className="dc-room-last">
            {t("dc.roomsPage.lastChange", {
              n: last.revision,
              when: whenText(last.created_at, i18n.language, t),
              what: revisionText(last.digest, t),
            })}
          </p>
        )}
        <nav className="dc-room-actions">
          <Link to={`/dc/${room.id}?view=3d`} className="dc-btn dc-btn-primary">
            {t("dc.roomsPage.open3d")}
          </Link>
          <Link to={`/dc/${room.id}?view=plan`} className="dc-btn">
            {t("dc.roomsPage.plan")}
          </Link>
          <Link to={`/dc/${room.id}/racks`} className="dc-btn">
            {t("dc.roomsPage.racksBtn")}
          </Link>
          <Link to={`/dc/${room.id}/history`} className="dc-btn">
            {t("dc.roomsPage.history")}
          </Link>
        </nav>
      </div>
    </article>
  );
}
