/**
 * The create/edit modal for a card. Given a `columnId` it creates a new card at
 * the bottom of that column; given a `cardId` it loads the card's raw form and
 * edits it. Title, description (markdown), assignee and due date — the Phase 1
 * card. Delete lives here too, in edit mode.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type { ProjectCardBody, ProjectMember, Uuid } from "../../api/types";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";

export function CardModal({
  members,
  columnId,
  cardId,
  onClose,
  onSaved,
}: {
  members: ProjectMember[];
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

  // In edit mode, load the card's raw form to seed the fields.
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
    }
  }, [draft.data]);

  // Close on Escape, the one key a modal owes the keyboard.
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
    };
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
            rows={5}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("projects.cardDescriptionPlaceholder")}
          />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 160 }}>
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
            <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 160 }}>
              <label htmlFor="card-due">{t("projects.dueDate")}</label>
              <input id="card-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>

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
      </div>
    </div>
  );
}
