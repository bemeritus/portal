/**
 * The create/edit modal for a card. Given a `columnId` it creates a new card;
 * given a `cardId` it loads the card's raw form and edits it. Phase 2 adds
 * priority, labels (picked from the board's vocabulary) and — in edit mode — a
 * comment thread.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type {
  ProjectCardBody,
  ProjectLabel,
  ProjectMember,
  ProjectPriority,
  Uuid,
} from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";
import { formatDate } from "../../format";

const PRIORITIES: ProjectPriority[] = ["low", "medium", "high", "urgent"];

export function CardModal({
  members,
  labels,
  columnId,
  cardId,
  onClose,
  onSaved,
}: {
  members: ProjectMember[];
  labels: ProjectLabel[];
  columnId?: Uuid;
  cardId?: Uuid;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const isEdit = cardId !== undefined;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<Uuid | "">("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<ProjectPriority>("medium");
  const [labelIds, setLabelIds] = useState<Uuid[]>([]);

  const draft = useQuery({
    queryKey: ["projects", "card", cardId],
    queryFn: ({ signal }) => projects.cards.draft(cardId as Uuid, signal),
    enabled: isEdit,
  });

  useEffect(() => {
    if (draft.data) {
      setTitle(draft.data.title);
      setDescription(draft.data.description ?? "");
      setAssignee(draft.data.assignee_id ?? "");
      setDue(draft.data.due_date ?? "");
      setPriority(draft.data.priority);
      setLabelIds(draft.data.label_ids);
    }
  }, [draft.data]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function body(): ProjectCardBody {
    return {
      title,
      description,
      assignee_id: assignee === "" ? null : assignee,
      due_date: due === "" ? null : due,
      priority,
      label_ids: labelIds,
    };
  }

  function toggleLabel(id: Uuid) {
    setLabelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  const save = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        await projects.cards.update(cardId as Uuid, body());
      } else {
        await projects.columns.addCard(columnId as Uuid, body());
      }
    },
    onSuccess: onSaved,
  });

  const remove = useMutation({
    mutationFn: () => projects.cards.remove(cardId as Uuid),
    onSuccess: onSaved,
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t("projects.editCard") : t("projects.newCard")}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          style={{ display: "grid", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) save.mutate();
          }}
        >
          <h2 style={{ margin: 0 }}>{isEdit ? t("projects.editCard") : t("projects.newCard")}</h2>

          <label htmlFor="card-title">{t("projects.cardTitle")}</label>
          <input
            id="card-title"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("projects.cardTitlePlaceholder")}
          />

          <label htmlFor="card-desc">{t("projects.cardDescription")}</label>
          <textarea
            id="card-desc"
            value={description}
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("projects.cardDescriptionPlaceholder")}
          />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 140 }}>
              <label htmlFor="card-assignee">{t("projects.assignee")}</label>
              <select
                id="card-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value as Uuid | "")}
              >
                <option value="">{t("projects.unassigned")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.username}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 120 }}>
              <label htmlFor="card-priority">{t("projects.priority")}</label>
              <select
                id="card-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as ProjectPriority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`projects.priorityLevel.${p}`)}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 140 }}>
              <label htmlFor="card-due">{t("projects.dueDate")}</label>
              <input id="card-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>

          {labels.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              <span>{t("projects.labels")}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {labels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`label label-${l.color}${labelIds.includes(l.id) ? " on" : " off"}`}
                    onClick={() => toggleLabel(l.id)}
                    aria-pressed={labelIds.includes(l.id)}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ErrorFlash
            error={
              save.error
                ? errorMessage(save.error)
                : remove.error
                  ? errorMessage(remove.error)
                  : draft.error
                    ? errorMessage(draft.error)
                    : null
            }
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" type="submit" disabled={!title.trim() || save.isPending}>
              {isEdit ? t("common.save") : t("common.create")}
            </button>
            <button className="btn secondary" type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            {isEdit && (
              <span style={{ marginLeft: "auto" }}>
                <ConfirmButton
                  className="btn danger"
                  label={t("projects.deleteCard")}
                  confirmLabel={t("common.confirmDelete")}
                  pending={remove.isPending}
                  onConfirm={() => remove.mutate()}
                />
              </span>
            )}
          </div>
        </form>

        {isEdit && <Comments cardId={cardId as Uuid} />}
      </div>
    </div>
  );
}

/** The comment thread on a card — list, post, and delete-your-own. */
function Comments({ cardId }: { cardId: Uuid }) {
  const { t } = useTranslation();
  const user = useUser();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const key = ["projects", "comments", cardId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => projects.cards.comments(cardId, signal),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const post = useMutation({
    mutationFn: () => projects.cards.comment(cardId, { body: text }),
    onSuccess: async () => {
      setText("");
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: Uuid) => projects.comments.remove(id),
    onSuccess: invalidate,
  });

  const comments = query.data ?? [];

  return (
    <div className="comments" style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>{t("projects.comments")}</h3>

      {comments.length === 0 && !query.isPending && (
        <p className="muted" style={{ margin: "0 0 10px" }}>{t("projects.noComments")}</p>
      )}

      {comments.map((c) => {
        const mine = user?.is_admin || (c.author_id !== null && c.author_id === user?.id);
        return (
          <div key={c.id} className="comment" style={{ marginBottom: 12 }}>
            <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <strong>{c.author_username ?? t("projects.formerMember")}</strong>
              <span className="muted">{formatDate(c.created_at)}</span>
              {mine && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ marginLeft: "auto", fontSize: 14 }}
                  title={t("common.delete")}
                  onClick={() => remove.mutate(c.id)}
                >
                  ×
                </button>
              )}
            </div>
            <div className="a" dangerouslySetInnerHTML={{ __html: c.body_html }} />
          </div>
        );
      })}

      <form
        style={{ display: "grid", gap: 8, marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) post.mutate();
        }}
      >
        <textarea
          value={text}
          rows={2}
          placeholder={t("projects.commentPlaceholder")}
          onChange={(e) => setText(e.target.value)}
        />
        <ErrorFlash error={post.error ? errorMessage(post.error) : null} />
        <div>
          <button className="btn" type="submit" disabled={!text.trim() || post.isPending}>
            {t("projects.postComment")}
          </button>
        </div>
      </form>
    </div>
  );
}
