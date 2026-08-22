/** `/learning/tests/:id/results` — every learner's attempts. Admin only. */

import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Spinner } from "../../components/Loading";
import { formatDate } from "../../format";

export function TestResultsPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();

  const testQuery = useQuery({
    queryKey: ["learning", "test", id],
    queryFn: ({ signal }) => learning.tests.get(id, signal),
  });
  const query = useQuery({
    queryKey: ["learning", "test", id, "results"],
    queryFn: ({ signal }) => learning.tests.results(id, signal),
  });

  const title = testQuery.data?.title ?? "";
  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.results"), app: t("app.name") });
  }, [t]);

  const rows = query.data ?? [];

  return (
    <>
      <Link className="backlink" to={`/learning/tests/${id}`}>
        {t("learning.backToTests")}
      </Link>
      <h1>{t("learning.resultsHeading", { title })}</h1>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title={t("learning.noAttempts")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("learning.thUser")}</th>
                <th>{t("learning.thScore")}</th>
                <th>{t("learning.thResult")}</th>
                <th>{t("learning.thSubmitted")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.username}</td>
                  <td>
                    {r.score} / {r.max_score}
                  </td>
                  <td>
                    {r.passed == null ? (
                      "—"
                    ) : r.passed ? (
                      <span className="badge published">{t("learning.passed")}</span>
                    ) : (
                      <span className="badge draft">{t("learning.failed")}</span>
                    )}
                  </td>
                  <td>{formatDate(r.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
