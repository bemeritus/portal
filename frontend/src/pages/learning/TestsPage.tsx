/** `/learning/tests` — the test list. Authors get a create link. */

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

export function TestsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const isAuthor = canAuthor(user, "learning");

  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.testsHeading"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["learning", "tests"],
    queryFn: ({ signal }) => learning.tests.list(signal),
  });
  const items = query.data ?? [];

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("learning.testsHeading")}</h1>
        {isAuthor && (
          <Link className="btn" to="/learning/tests/new">
            {t("learning.newTest")}
          </Link>
        )}
      </div>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : items.length === 0 ? (
        <Empty title={t("learning.noTests")} />
      ) : (
        items.map((test) => (
          <Link className="card" key={test.id} to={`/learning/tests/${test.id}`}>
            <h3>{test.title}</h3>
            {test.description && <p className="muted">{test.description}</p>}
            <div className="meta">
              <span>{t("learning.questionsCount", { count: test.question_count })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("learning.by", { name: test.author_username })}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(test.created_at)}</span>
              {test.status === "draft" && (
                <span className="badge draft">{t("learning.draft")}</span>
              )}
            </div>
          </Link>
        ))
      )}
    </>
  );
}
