/** `/projects` — the board list. Leads get a create form. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import { useUser } from "../../auth/AuthContext";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Skeletons } from "../../components/Loading";
import { formatDate } from "../../format";
import { canAuthor } from "../../permissions";

export function ProjectsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const isLead = canAuthor(user, "projects");
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    document.title = t("docTitle", { page: t("projects.boardsHeading"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["projects", "boards"],
    queryFn: ({ signal }) => projects.boards.list(signal),
  });
  const boards = query.data ?? [];

  const create = useMutation({
    mutationFn: () => projects.boards.create({ name, description }),
    onSuccess: async () => {
      setName("");
      setDescription("");
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["projects", "boards"] });
    },
  });

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("projects.boardsHeading")}</h1>
        {isLead && !creating && (
          <button className="btn" type="button" onClick={() => setCreating(true)}>
            {t("projects.newBoard")}
          </button>
        )}
      </div>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {creating && (
        <form
          className="card"
          style={{ display: "grid", gap: 10, marginBottom: 20 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label htmlFor="board-name">{t("projects.boardName")}</label>
          <input
            id="board-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={t("projects.boardNamePlaceholder")}
          />
          <label htmlFor="board-desc">{t("projects.boardDescription")}</label>
          <textarea
            id="board-desc"
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
          <ErrorFlash error={create.error ? errorMessage(create.error) : null} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" type="submit" disabled={!name.trim() || create.isPending}>
              {t("common.create")}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
                setDescription("");
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      {query.isPending ? (
        <Skeletons />
      ) : boards.length === 0 ? (
        <Empty title={t("projects.noBoards")} />
      ) : (
        boards.map((b) => (
          <Link className="card" key={b.id} to={`/projects/boards/${b.id}`}>
            <h3>{b.name}</h3>
            {b.description && <p className="muted">{b.description}</p>}
            <div className="meta">
              <span>{t("projects.cardCount", { count: b.card_count })}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(b.created_at)}</span>
            </div>
          </Link>
        ))
      )}
    </>
  );
}
