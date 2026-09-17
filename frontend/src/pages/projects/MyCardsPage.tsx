/** `/projects/my-cards` — every card assigned to the caller, across all boards. */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Skeletons } from "../../components/Loading";

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${due}T00:00:00`) < today;
}

export function MyCardsPage() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("projects.myCards"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["projects", "my-cards"],
    queryFn: ({ signal }) => projects.myCards(signal),
  });
  const cards = query.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>{t("projects.myCards")}</h1>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : cards.length === 0 ? (
        <Empty title={t("projects.noAssigned")} />
      ) : (
        cards.map((c) => (
          <Link className="card" key={c.id} to={`/projects/boards/${c.board_id}`}>
            <h3>{c.title}</h3>
            <div className="meta">
              <span>{c.board_name}</span>
              <span aria-hidden="true">·</span>
              <span>{c.column_name}</span>
              {c.priority !== "medium" && (
                <span className={`chip prio-chip prio-${c.priority}`}>
                  {t(`projects.priorityLevel.${c.priority}`)}
                </span>
              )}
              {c.due_date && (
                <span className={`chip due${isOverdue(c.due_date) ? " overdue" : ""}`}>
                  {isOverdue(c.due_date) ? t("projects.overdue") : t("projects.due")} {c.due_date}
                </span>
              )}
            </div>
          </Link>
        ))
      )}
    </>
  );
}
