/** `/learning/resources` — the resource list. Authors get a create link. */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { useUser } from "../../auth/AuthContext";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Skeletons } from "../../components/Loading";
import { formatDate } from "../../format";
import { canAuthor } from "../../permissions";

export function ResourcesPage() {
  const { t } = useTranslation();
  const user = useUser();
  const isAuthor = canAuthor(user, "learning");

  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.resourcesHeading"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["learning", "resources"],
    queryFn: ({ signal }) => learning.resources.list(signal),
  });
  const items = query.data ?? [];

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("learning.resourcesHeading")}</h1>
        {isAuthor && (
          <Link className="btn" to="/learning/resources/new">
            {t("learning.newResource")}
          </Link>
        )}
      </div>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : items.length === 0 ? (
        <Empty title={t("learning.noResources")} />
      ) : (
        items.map((r) => (
          <Link className="card" key={r.id} to={`/learning/resources/${r.id}`}>
            <h3>{r.title}</h3>
            <div className="meta">
              <span>{t("learning.by", { name: r.author_username })}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(r.created_at)}</span>
              {r.status === "draft" && <span className="badge draft">{t("learning.draft")}</span>}
            </div>
          </Link>
        ))
      )}
    </>
  );
}
