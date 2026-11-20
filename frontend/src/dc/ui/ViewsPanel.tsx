/**
 * Saved views (§11.4) and notes pinned in 3D. A view keeps the camera, the
 * mode, the owner highlight, the selection and what else is on screen —
 * layers, X-ray, hidden objects, the section box (FEEDBACK-7 §4); it is
 * shared with everyone who can see the room, or personal (the server shows
 * it to its author only). "Copy link" gives the link to exactly this screen.
 *
 * FEEDBACK-7 §1.5, §4.8: the name field full width, the shared / personal
 * switch and the save button under it; each saved view with a small render
 * of it, its name, author and who sees it, and on hover open / update from
 * the current view / delete. The views have an order (drag a row) and play
 * in it as a tour.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical, Link2, Play } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Op, RoomData, ViewPayload } from "../types";

interface Props {
  data: RoomData;
  canEdit: boolean;
  run: (ops: Op[], label: string) => Promise<boolean>;
  saveView: (name: string, shared: boolean) => Promise<boolean>;
  openView: (v: ViewPayload) => void;
  copyLink: () => void;
  /** What is on screen now, as a view (without name and sharing). */
  current: () => Omit<ViewPayload, "name" | "shared">;
  /** A small render of a view, as an image URL. */
  thumb: (id: number, v: ViewPayload) => string | null;
  startTour: () => void;
}

/** The saved views in their tour order: ordered ones first, then by age. */
export function viewsInOrder(data: RoomData) {
  return data.annotations
    .flatMap((a) =>
      a.kind === "view"
        ? [{ id: a.id, v: a.payload, author: a.author_name }]
        : [],
    )
    .sort(
      (a, b) =>
        (a.v.order ?? Number.MAX_SAFE_INTEGER) -
          (b.v.order ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
    );
}

export function ViewsPanel({
  data,
  canEdit,
  run,
  saveView,
  openView,
  copyLink,
  current,
  thumb,
  startTour,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(true);
  const [dragged, setDragged] = useState<number | null>(null);
  const views = viewsInOrder(data);
  const notes = data.annotations.flatMap((a) =>
    a.kind === "note"
      ? [{ id: a.id, n: a.payload, author: a.author_name }]
      : [],
  );
  const update = (id: number, v: ViewPayload, label: string) =>
    run(
      [
        {
          op: "annotation_update",
          id,
          annotation: { kind: "view", payload: v },
        },
      ],
      label,
    );
  /** Move `from` to where `to` stands; renumber the views that moved. */
  const reorder = (from: number, to: number) => {
    const ids = views.map((x) => x.id);
    const at = ids.indexOf(to);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(at, 0, from);
    const ops: Op[] = [];
    ids.forEach((id, i) => {
      const x = views.find((y) => y.id === id)!;
      if (x.v.order !== i + 1)
        ops.push({
          op: "annotation_update",
          id,
          annotation: { kind: "view", payload: { ...x.v, order: i + 1 } },
        });
    });
    if (ops.length) void run(ops, t("dc.change.viewsOrder"));
  };
  return (
    <div className="space-y-4 text-sm">
      <button type="button" className="dc-btn w-full" onClick={copyLink}>
        <Link2 className="mr-1 inline size-4" />
        {t("dc.views.copyLink")}
      </button>
      <section>
        <div className="dc-views-head">
          <div className="dc-section-title">{t("dc.views.title")}</div>
          {views.length > 0 && (
            <button
              type="button"
              className="dc-btn"
              data-testid="tour-start"
              onClick={startTour}
            >
              <Play className="mr-1 inline size-3.5" />
              {t("dc.views.tour")}
            </button>
          )}
        </div>
        {views.length === 0 && (
          <p className="text-xs" style={{ color: "var(--dc-muted)" }}>
            {t("dc.views.none")}
          </p>
        )}
        <ul className="dc-views" data-testid="saved-views">
          {views.map(({ id, v, author }) => {
            const src = thumb(id, v);
            return (
              <li
                key={id}
                data-testid="saved-view"
                draggable={canEdit}
                title={canEdit ? t("dc.views.drag") : undefined}
                data-dragging={dragged === id || undefined}
                onDragStart={(e) => {
                  setDragged(id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragged(null)}
                onDragOver={(e) => {
                  if (dragged !== null) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragged !== null && dragged !== id) reorder(dragged, id);
                  setDragged(null);
                }}
              >
                {/* The grip column is there for everyone, so the columns line up. */}
                {canEdit ? (
                  <GripVertical
                    className="dc-views-grip size-3.5"
                    aria-hidden
                  />
                ) : (
                  <span aria-hidden />
                )}
                <button
                  type="button"
                  className="dc-views-thumb"
                  onClick={() => openView(v)}
                  aria-label={`${t("dc.views.open")}: ${v.name}`}
                >
                  {src ? <img src={src} alt="" /> : null}
                </button>
                <div className="dc-views-text">
                  <b>{v.name}</b>
                  <small>
                    {[
                      author,
                      v.shared
                        ? t("dc.views.sharedShort")
                        : t("dc.views.personalShort"),
                      v.mode && t(`dc.mode.${v.mode}`),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {v.caption && <small>{v.caption}</small>}
                </div>
                <div className="dc-views-actions">
                  <button type="button" onClick={() => openView(v)}>
                    {t("dc.views.open")}
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() =>
                        void update(
                          id,
                          {
                            ...current(),
                            name: v.name,
                            shared: v.shared,
                            order: v.order,
                            caption: v.caption,
                            hold_s: v.hold_s,
                          },
                          t("dc.change.viewUpdate", { name: v.name }),
                        )
                      }
                    >
                      {t("dc.views.update")}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() =>
                        void run(
                          [{ op: "annotation_delete", id }],
                          t("dc.change.viewDelete", { name: v.name }),
                        )
                      }
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </div>
                {canEdit && (
                  <details className="dc-views-more">
                    <summary>{t("dc.views.details")}</summary>
                    <ViewDetails
                      v={v}
                      onSave={(patch) =>
                        void update(
                          id,
                          { ...v, ...patch },
                          t("dc.change.viewUpdate", { name: v.name }),
                        )
                      }
                    />
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <form
            className="dc-views-save"
            onSubmit={async (e) => {
              e.preventDefault();
              if (name.trim() && (await saveView(name.trim(), shared)))
                setName("");
            }}
          >
            <Input
              value={name}
              placeholder={t("dc.views.name")}
              onChange={(e) => setName(e.target.value)}
              aria-label={t("dc.views.name")}
            />
            <div className="dc-views-save-row">
              <div
                className="dc-seg"
                role="radiogroup"
                aria-label={t("dc.views.who")}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={shared}
                  onClick={() => setShared(true)}
                >
                  {t("dc.views.shared")}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!shared}
                  onClick={() => setShared(false)}
                >
                  {t("dc.views.personal")}
                </button>
              </div>
              {/* Disabled only without a name, and it says so. */}
              <span title={name.trim() ? undefined : t("dc.views.needName")}>
                <button
                  type="submit"
                  className="dc-btn dc-btn-primary"
                  disabled={!name.trim()}
                >
                  {t("dc.views.save")}
                </button>
              </span>
            </div>
          </form>
        )}
      </section>
      <section>
        <div className="dc-section-title">{t("dc.notes.title")}</div>
        {notes.length === 0 && (
          <p className="text-xs" style={{ color: "var(--dc-muted)" }}>
            {canEdit ? t("dc.notes.howTo") : t("dc.notes.none")}
          </p>
        )}
        <div className="dc-rows">
          {notes.map(({ id, n, author }) => (
            <div key={id}>
              <span className="flex-1">
                {n.text}
                <span
                  className="block text-xs"
                  style={{ color: "var(--dc-muted)" }}
                >
                  {author ?? ""}
                </span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() =>
                    void run(
                      [{ op: "annotation_delete", id }],
                      t("dc.change.noteDelete"),
                    )
                  }
                >
                  {t("common.delete")}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** A view's caption and hold time in the tour. */
function ViewDetails({
  v,
  onSave,
}: {
  v: ViewPayload;
  onSave: (patch: Partial<ViewPayload>) => void;
}) {
  const { t } = useTranslation();
  const [caption, setCaption] = useState(v.caption ?? "");
  const [hold, setHold] = useState(String(v.hold_s ?? 6));
  const s = Math.round(Number(hold));
  const ok = Number.isFinite(s) && s >= 1 && s <= 600;
  return (
    <form
      className="dc-views-details"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ caption: caption.trim() || undefined, hold_s: s });
      }}
    >
      <label>
        <span>{t("dc.views.caption")}</span>
        <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
      </label>
      <label>
        <span>{t("dc.views.hold")}</span>
        <Input
          inputMode="numeric"
          value={hold}
          aria-invalid={!ok || undefined}
          onChange={(e) => setHold(e.target.value)}
        />
      </label>
      <button type="submit" className="dc-btn" disabled={!ok}>
        {t("common.save")}
      </button>
    </form>
  );
}
