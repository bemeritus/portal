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
import { projects, uploads } from "../../api/endpoints";
import type {
  CardAttachment,
  ChecklistItem,
  ProjectCardBody,
  ProjectLabel,
  ProjectMember,
  ProjectPriority,
  Uuid,
} from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";
import { Select } from "../../components/Select";
import { formatDate } from "../../format";

const PRIORITIES: ProjectPriority[] = ["low", "medium", "high", "urgent"];

export function CardModal({
  boardId,
  members,
  labels,
  columnId,
  cardId,
  onClose,
  onSaved,
}: {
  boardId: Uuid;
  members: ProjectMember[];
  labels: ProjectLabel[];
  columnId?: Uuid;
  cardId?: Uuid;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEdit = cardId !== undefined;

  // Checklist and attachment edits change both the modal's draft and the board's
  // tile badges, so both are refreshed after each.
  const refreshCard = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["projects", "card", cardId] }),
      queryClient.invalidateQueries({ queryKey: ["projects", "board", boardId] }),
    ]);
  };

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
            type="text"
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
              <Select
                id="card-assignee"
                ariaLabel={t("projects.assignee")}
                value={assignee}
                onChange={(v) => setAssignee(v as Uuid | "")}
                options={[
                  { value: "", label: t("projects.unassigned") },
                  ...members.map((m) => ({ value: m.id, label: m.username })),
                ]}
              />
            </div>
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 120 }}>
              <label htmlFor="card-priority">{t("projects.priority")}</label>
              <Select
                id="card-priority"
                ariaLabel={t("projects.priority")}
                value={priority}
                onChange={(v) => setPriority(v as ProjectPriority)}
                options={PRIORITIES.map((p) => ({ value: p, label: t(`projects.priorityLevel.${p}`) }))}
              />
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

        {isEdit && (
          <>
            <Checklist
              cardId={cardId as Uuid}
              items={draft.data?.checklist ?? []}
              onChanged={refreshCard}
            />
            <Attachments
              cardId={cardId as Uuid}
              items={draft.data?.attachments ?? []}
              onChanged={refreshCard}
            />
            <Comments cardId={cardId as Uuid} />
          </>
        )}
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

/** A card's checklist — add items, tick them off, delete. Progress is n/total. */
function Checklist({
  cardId,
  items,
  onChanged,
}: {
  cardId: Uuid;
  items: ChecklistItem[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");

  const add = useMutation({
    mutationFn: () => projects.cards.addChecklistItem(cardId, { text }),
    onSuccess: async () => {
      setText("");
      await onChanged();
    },
  });
  const toggle = useMutation({
    mutationFn: (item: ChecklistItem) =>
      projects.checklist.update(item.id, { text: item.text, done: !item.done }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: (id: Uuid) => projects.checklist.remove(id),
    onSuccess: onChanged,
  });

  const done = items.filter((i) => i.done).length;

  return (
    <div className="checklist" style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>
        {t("projects.checklist")}{" "}
        {items.length > 0 && <span className="muted" style={{ fontWeight: 400 }}>{done}/{items.length}</span>}
      </h3>

      {items.map((item) => (
        <div key={item.id} className="chk-row" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <input type="checkbox" checked={item.done} onChange={() => toggle.mutate(item)} />
          <span style={{ flex: 1, textDecoration: item.done ? "line-through" : "none", opacity: item.done ? 0.6 : 1 }}>
            {item.text}
          </span>
          <button type="button" className="icon-btn" style={{ fontSize: 14 }} title={t("common.delete")} onClick={() => remove.mutate(item.id)}>
            ×
          </button>
        </div>
      ))}

      <form
        style={{ display: "flex", gap: 8, marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <input
          type="text"
          value={text}
          placeholder={t("projects.checklistPlaceholder")}
          style={{ flex: 1 }}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn secondary" type="submit" disabled={!text.trim() || add.isPending}>
          {t("common.add")}
        </button>
      </form>
      <ErrorFlash error={add.error ? errorMessage(add.error) : null} />
    </div>
  );
}

/** A card's image attachments — upload through the shared endpoint, then pin. */
function Attachments({
  cardId,
  items,
  onChanged,
}: {
  cardId: Uuid;
  items: CardAttachment[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [uploadError, setUploadError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (file: File) =>
      uploads.image(file).then((r) => projects.cards.addAttachment(cardId, { url: r.url, name: file.name })),
    onSuccess: onChanged,
    onError: (e) => setUploadError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: Uuid) => projects.attachments.remove(id),
    onSuccess: onChanged,
  });

  return (
    <div className="attachments" style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>{t("projects.attachments")}</h3>

      {items.length > 0 && (
        <div className="attach-grid">
          {items.map((a) => (
            <div key={a.id} className="attach">
              <a href={a.url} target="_blank" rel="noreferrer">
                <img src={a.url} alt={a.name} />
              </a>
              <div className="attach-foot">
                <span className="attach-name" title={a.name}>{a.name}</span>
                <button type="button" className="icon-btn" title={t("common.delete")} onClick={() => remove.mutate(a.id)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <label className="btn secondary" style={{ marginTop: 8, display: "inline-block", cursor: "pointer" }}>
        {attach.isPending ? t("common.saving") : t("projects.addAttachment")}
        <input
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setUploadError(null);
            if (file) attach.mutate(file);
            e.target.value = "";
          }}
        />
      </label>
      <ErrorFlash error={uploadError} />
    </div>
  );
}
