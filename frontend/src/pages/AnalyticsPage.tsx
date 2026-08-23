/**
 * `/admin/analytics` — how the knowledge base is actually used (admin only).
 *
 * Read-only: three rankings the server computes from views, 👍/👎 feedback and
 * logged empty searches. It answers "what do people read", "what have they
 * flagged as unhelpful", and "what did they look for and not find" — the last
 * being the list of articles worth writing next.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { analytics as analyticsApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { PopularDoc } from "../api/types";

export function AnalyticsPage() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("analytics.heading"), app: t("app.name") });
  }, [t]);

  const { data, isPending, error } = useQuery({
    queryKey: ["analytics"],
    queryFn: ({ signal }) => analyticsApi.overview(signal),
  });

  if (isPending) return <Spinner />;
  if (error) return <ErrorFlash error={errorMessage(error)} />;

  return (
    <>
      <h1>{t("analytics.heading")}</h1>
      <p className="muted">{t("analytics.subtitle")}</p>

      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-value">{data.total_documents}</span>
          <span className="stat-label">{t("analytics.totalDocuments")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{data.total_views}</span>
          <span className="stat-label">{t("analytics.totalViews")}</span>
        </div>
      </div>

      <section className="analytics-section">
        <h2>{t("analytics.mostViewed")}</h2>
        <DocTable rows={data.popular} emptyText={t("analytics.noViews")} />
      </section>

      <section className="analytics-section">
        <h2>{t("analytics.needsWork")}</h2>
        <p className="muted">{t("analytics.needsWorkHint")}</p>
        <DocTable rows={data.needs_work} emptyText={t("analytics.noNegative")} />
      </section>

      <section className="analytics-section">
        <h2>{t("analytics.contentGaps")}</h2>
        <p className="muted">{t("analytics.contentGapsHint")}</p>
        {data.search_misses.length === 0 ? (
          <Empty title={t("analytics.noGaps")} />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("analytics.query")}</th>
                  <th className="num">{t("analytics.times")}</th>
                  <th>{t("analytics.lastSearched")}</th>
                </tr>
              </thead>
              <tbody>
                {data.search_misses.map((m) => (
                  <tr key={m.query}>
                    <td>
                      <Link to={`/templates?q=${encodeURIComponent(m.query)}`}>{m.query}</Link>
                    </td>
                    <td className="num">{m.count}</td>
                    <td>{formatDate(m.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function DocTable({ rows, emptyText }: { rows: PopularDoc[]; emptyText: string }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <Empty title={emptyText} />;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("analytics.document")}</th>
            <th>{t("analytics.category")}</th>
            <th className="num">{t("analytics.views")}</th>
            <th className="num">👍</th>
            <th className="num">👎</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <Link to={`/templates/docs/${d.id}`}>{d.title}</Link>
              </td>
              <td>{d.category_name}</td>
              <td className="num">{d.view_count}</td>
              <td className="num">{d.helpful_count}</td>
              <td className="num">{d.not_helpful_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
