/** `/learning/labs` — the lab list, each row carrying the caller's own state. */

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

export function LabsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const isAuthor = canAuthor(user, "learning");

  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.labsHeading"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["learning", "labs"],
    queryFn: ({ signal }) => learning.labs.list(signal),
  });
  const items = query.data ?? [];

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("learning.labsHeading")}</h1>
        {isAuthor && (
          <Link className="btn" to="/learning/labs/new">
            {t("learning.newLab")}
          </Link>
        )}
      </div>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : items.length === 0 ? (
        <Empty title={t("learning.noLabs")} />
      ) : (
        items.map((l) => (
          <Link className="card" key={l.id} to={`/learning/labs/${l.id}`}>
            <h3>{l.title}</h3>
            <div className="meta">
              <span>{t("learning.by", { name: l.author_username })}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(l.created_at)}</span>
              {l.my_state && (
                <span className="badge">{t(`learning.state_${l.my_state}`)}</span>
              )}
              {l.status === "draft" && <span className="badge draft">{t("learning.draft")}</span>}
            </div>
          </Link>
        ))
      )}
    </>
  );
}
