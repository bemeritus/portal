/** `/learning/labs/:id/submissions` — every learner's progress. Admin only. */

import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Spinner } from "../../components/Loading";
import { formatDate } from "../../format";

export function LabSubmissionsPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();

  const labQuery = useQuery({
    queryKey: ["learning", "lab", id],
    queryFn: ({ signal }) => learning.labs.get(id, signal),
  });
  const query = useQuery({
    queryKey: ["learning", "lab", id, "submissions"],
    queryFn: ({ signal }) => learning.labs.submissions(id, signal),
  });

  const title = labQuery.data?.title ?? "";
  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.results"), app: t("app.name") });
  }, [t]);

  const rows = query.data ?? [];

  return (
    <>
      <Link className="backlink" to={`/learning/labs/${id}`}>
        {t("learning.backToLabs")}
      </Link>
      <h1>{t("learning.submissionsHeading", { title })}</h1>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title={t("learning.noSubmissions")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("learning.thUser")}</th>
                <th>{t("learning.thState")}</th>
                <th className="wrap">{t("learning.thSubmission")}</th>
                <th>{t("learning.thGrade")}</th>
                <th>{t("learning.thUpdated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.username}</td>
                  <td>{t(`learning.state_${r.state}`)}</td>
                  <td className="wrap" style={{ whiteSpace: "pre-wrap" }}>
                    {r.submission ?? ""}
                  </td>
                  <td>{r.grade ?? "—"}</td>
                  <td>{formatDate(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
