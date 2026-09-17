/**
 * `/projects/boards/:id` — one Kanban board.
 *
 * Columns left to right, cards top to bottom. Any member drags a card to
 * reorder or move it (native HTML5 drag-and-drop); the move is persisted per
 * drop and the board refetched. A filter bar narrows the visible cards by text,
 * assignee, priority and label without touching the server. A lead manages the
 * structure — columns, labels, and the board itself. Card create and edit share
 * one modal.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type { ProjectCardView, ProjectColumnView, ProjectPriority, Uuid } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { canAuthor } from "../../permissions";
import { CardModal } from "./CardModal";
import { LabelsModal } from "./LabelsModal";

type Editing = { mode: "new"; columnId: Uuid } | { mode: "edit"; cardId: Uuid } | null;

type Filter = { text: string; assignee: Uuid | ""; priority: ProjectPriority | ""; label: Uuid | "" };

const EMPTY_FILTER: Filter = { text: "", assignee: "", priority: "", label: "" };

const PRIORITIES: ProjectPriority[] = ["low", "medium", "high", "urgent"];

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
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);

  const boardKey = ["projects", "board", boardId];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: boardKey });

  const query = useQuery({
    queryKey: boardKey,
    queryFn: ({ signal }) => projects.boards.get(boardId, signal),
  });
  const board = query.data;

  const membersQuery = useQuery({
    queryKey: ["projects", "members"],
    queryFn: ({ signal }) => projects.members(signal),
  });
  const labelsQuery = useQuery({
    queryKey: ["projects", "labels", boardId],
    queryFn: ({ signal }) => projects.boards.labels(boardId, signal),
  });
  const labels = useMemo(() => labelsQuery.data ?? [], [labelsQuery.data]);

  useEffect(() => {
    if (board) document.title = t("docTitle", { page: board.name, app: t("app.name") });
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

  const filterActive = filter.text !== "" || filter.assignee !== "" || filter.priority !== "" || filter.label !== "";

  function matches(card: ProjectCardView): boolean {
    if (filter.assignee !== "" && card.assignee_id !== filter.assignee) return false;
    if (filter.priority !== "" && card.priority !== filter.priority) return false;
    if (filter.label !== "" && !card.labels.some((l) => l.id === filter.label)) return false;
    if (filter.text !== "" && !card.title.toLowerCase().includes(filter.text.toLowerCase())) return false;
    return true;
  }

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
          <button className="btn secondary" type="button" onClick={() => setLabelsOpen(true)}>
            {t("projects.manageLabels")}
          </button>
        )}
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
      {board.description && <p className="muted" style={{ marginBottom: 12 }}>{board.description}</p>}

      {/* Filter bar — client-side, over the already-loaded board. */}
      <div className="board-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input
          value={filter.text}
          placeholder={t("projects.filterText")}
          onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
          style={{ flex: 1, minWidth: 140 }}
        />
        <select value={filter.assignee} onChange={(e) => setFilter((f) => ({ ...f, assignee: e.target.value as Uuid | "" }))}>
          <option value="">{t("projects.filterAllAssignees")}</option>
          {(membersQuery.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>{m.username}</option>
          ))}
        </select>
        <select value={filter.priority} onChange={(e) => setFilter((f) => ({ ...f, priority: e.target.value as ProjectPriority | "" }))}>
          <option value="">{t("projects.filterAllPriorities")}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{t(`projects.priorityLevel.${p}`)}</option>
          ))}
        </select>
        {labels.length > 0 && (
          <select value={filter.label} onChange={(e) => setFilter((f) => ({ ...f, label: e.target.value as Uuid | "" }))}>
            <option value="">{t("projects.filterAllLabels")}</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
        {filterActive && (
          <button className="btn secondary" type="button" onClick={() => setFilter(EMPTY_FILTER)}>
            {t("common.clearFilters")}
          </button>
        )}
      </div>

      <ErrorFlash error={move.error ? errorMessage(move.error) : null} />

      <div className="kanban">
        {board.columns.map((column) => {
          const visible = column.cards.filter(matches);
          return (
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
                  {column.name}{" "}
                  <span className="count">
                    {filterActive ? `${visible.length}/${column.cards.length}` : column.cards.length}
                  </span>
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
                {visible.map((card) => (
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
          );
        })}

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
          labels={labels}
          columnId={editing.mode === "new" ? editing.columnId : undefined}
          cardId={editing.mode === "edit" ? editing.cardId : undefined}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await invalidate();
          }}
        />
      )}

      {labelsOpen && (
        <LabelsModal
          boardId={boardId}
          labels={labels}
          onClose={() => setLabelsOpen(false)}
          onChanged={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["projects", "labels", boardId] }),
              invalidate(),
            ]);
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
      className={`kanban-card prio-${card.priority}${dimmed ? " dragging" : ""}${over ? " drop-over" : ""}`}
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
      {card.labels.length > 0 && (
        <div className="kanban-card-labels">
          {card.labels.map((l) => (
            <span key={l.id} className={`label-dot label-${l.color}`} title={l.name} />
          ))}
        </div>
      )}
      <div className="kanban-card-title">{card.title}</div>
      <div className="kanban-card-meta">
        {card.priority !== "medium" && (
          <span className={`chip prio-chip prio-${card.priority}`}>
            {t(`projects.priorityLevel.${card.priority}`)}
          </span>
        )}
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

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${due}T00:00:00`) < today;
}
