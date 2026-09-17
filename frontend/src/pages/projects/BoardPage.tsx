/**
 * `/projects/boards/:id` — one Kanban board.
 *
 * Columns sit left to right, cards top to bottom inside each. Any member drags a
 * card to reorder it or move it between columns (native HTML5 drag-and-drop, no
 * extra dependency); the move is persisted per drop and the board refetched. A
 * lead additionally manages the structure — add or remove columns, delete the
 * board. Card create and edit share one modal.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type { ProjectCardView, ProjectColumnView, Uuid } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { canAuthor } from "../../permissions";
import { CardModal } from "./CardModal";

/** Which card the modal is on: a new card in a column, or an existing card. */
type Editing = { mode: "new"; columnId: Uuid } | { mode: "edit"; cardId: Uuid } | null;

export function BoardPage() {
  const { id } = useParams<{ id: Uuid }>();
  const boardId = id as Uuid;
  const { t } = useTranslation();
  const user = useUser();
  const isLead = canAuthor(user, "projects");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dragging, setDragging] = useState<Uuid | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [newColumn, setNewColumn] = useState("");
  const [addingColumn, setAddingColumn] = useState(false);

  const boardKey = ["projects", "board", boardId];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: boardKey });

  const query = useQuery({
    queryKey: boardKey,
    queryFn: ({ signal }) => projects.boards.get(boardId, signal),
  });
  const board = query.data;

  // The assignable set, for the card modal's picker. Loaded once with the board.
  const membersQuery = useQuery({
    queryKey: ["projects", "members"],
    queryFn: ({ signal }) => projects.members(signal),
  });

  useEffect(() => {
    if (board) {
      document.title = t("docTitle", { page: board.name, app: t("app.name") });
    }
  }, [board, t]);

  const move = useMutation({
    mutationFn: (args: { cardId: Uuid; columnId: Uuid; position: number }) =>
      projects.cards.move(args.cardId, { column_id: args.columnId, position: args.position }),
    onSuccess: invalidate,
  });

  const removeBoard = useMutation({
    mutationFn: () => projects.boards.remove(boardId),
    onSuccess: () => navigate("/projects", { replace: true }),
  });

  const addColumn = useMutation({
    mutationFn: () => projects.boards.addColumn(boardId, { name: newColumn }),
    onSuccess: async () => {
      setNewColumn("");
      setAddingColumn(false);
      await invalidate();
    },
  });

  const removeColumn = useMutation({
    mutationFn: (columnId: Uuid) => projects.columns.remove(columnId),
    onSuccess: invalidate,
  });

  /** Position within a column, excluding the dragged card (the server's rule). */
  function dropPosition(column: ProjectColumnView, beforeCardId: Uuid | null): number {
    const rest = column.cards.filter((c) => c.id !== dragging);
    if (beforeCardId === null) return rest.length;
    const idx = rest.findIndex((c) => c.id === beforeCardId);
    return idx < 0 ? rest.length : idx;
  }

  function onDropInto(column: ProjectColumnView, beforeCardId: Uuid | null) {
    if (!dragging) return;
    move.mutate({ cardId: dragging, columnId: column.id, position: dropPosition(column, beforeCardId) });
    setDragging(null);
  }

  if (query.isPending) {
    return (
      <div className="container">
        <Spinner />
      </div>
    );
  }
  if (query.error || !board) {
    return <ErrorFlash error={query.error ? errorMessage(query.error) : t("projects.boardMissing")} />;
  }

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{board.name}</h1>
        {isLead && (
          <ConfirmButton
            className="btn danger"
            label={t("projects.deleteBoard")}
            confirmLabel={t("common.confirmDelete")}
            pending={removeBoard.isPending}
            onConfirm={() => removeBoard.mutate()}
          />
        )}
      </div>
      {board.description && <p className="muted" style={{ marginBottom: 16 }}>{board.description}</p>}

      <ErrorFlash error={move.error ? errorMessage(move.error) : null} />

      <div className="kanban">
        {board.columns.map((column) => (
          <section
            key={column.id}
            className={`kanban-col${dragging ? " droppable" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onDropInto(column, null);
            }}
          >
            <header className="kanban-col-head">
              <h2>
                {column.name} <span className="count">{column.cards.length}</span>
              </h2>
              {isLead && (
                <ConfirmButton
                  className="icon-btn"
                  label="×"
                  confirmLabel={t("common.confirmDelete")}
                  pending={removeColumn.isPending}
                  onConfirm={() => removeColumn.mutate(column.id)}
                />
              )}
            </header>

            <div className="kanban-cards">
              {column.cards.map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  dimmed={dragging === card.id}
                  onDragStart={() => setDragging(card.id)}
                  onDragEnd={() => setDragging(null)}
                  onDropBefore={() => onDropInto(column, card.id)}
                  onOpen={() => setEditing({ mode: "edit", cardId: card.id })}
                />
              ))}
            </div>

            <button
              className="kanban-add"
              type="button"
              onClick={() => setEditing({ mode: "new", columnId: column.id })}
            >
              + {t("projects.addCard")}
            </button>
          </section>
        ))}

        {isLead && (
          <div className="kanban-col add-col">
            {addingColumn ? (
              <form
                style={{ display: "grid", gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newColumn.trim()) addColumn.mutate();
                }}
              >
                <input
                  autoFocus
                  value={newColumn}
                  placeholder={t("projects.columnName")}
                  onChange={(e) => setNewColumn(e.target.value)}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn" type="submit" disabled={!newColumn.trim() || addColumn.isPending}>
                    {t("common.add")}
                  </button>
                  <button className="btn secondary" type="button" onClick={() => setAddingColumn(false)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <button className="kanban-add" type="button" onClick={() => setAddingColumn(true)}>
                + {t("projects.addColumn")}
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <CardModal
          members={membersQuery.data ?? []}
          columnId={editing.mode === "new" ? editing.columnId : undefined}
          cardId={editing.mode === "edit" ? editing.cardId : undefined}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await invalidate();
          }}
        />
      )}
    </>
  );
}

function CardTile({
  card,
  dimmed,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onOpen,
}: {
  card: ProjectCardView;
  dimmed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const overdue = useMemo(() => isOverdue(card.due_date), [card.due_date]);

  return (
    <article
      className={`kanban-card${dimmed ? " dragging" : ""}${over ? " drop-over" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={() => {
        setOver(false);
        onDragEnd();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onDropBefore();
      }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <div className="kanban-card-title">{card.title}</div>
      <div className="kanban-card-meta">
        {card.assignee_username && <span className="chip">@{card.assignee_username}</span>}
        {card.due_date && (
          <span className={`chip due${overdue ? " overdue" : ""}`}>
            {overdue ? t("projects.overdue") : t("projects.due")} {card.due_date}
          </span>
        )}
      </div>
    </article>
  );
}

/** A due date strictly before today (local) is overdue. */
function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${due}T00:00:00`) < today;
}
