/**
 * `/admin/analytics` — how the knowledge base is actually used.
 *
 * Read-only: the server computes a most-read ranking and the list of logged
 * empty searches. It answers "what do people read" and "what did they look for
 * and not find" — the last being the list of articles worth writing next.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
      <p className="text-muted-foreground">{t("analytics.subtitle")}</p>

      {/* Two headline numbers at the top of the page. */}
      <div className="my-4 flex flex-wrap gap-3">
        <Card className="min-w-40 flex-1">
          <CardContent className="flex flex-col gap-1">
            <span className="text-[28px] font-bold tabular-nums">{data.total_documents}</span>
            <span className="text-[13px] text-muted-foreground">
              {t("analytics.totalDocuments")}
            </span>
          </CardContent>
        </Card>
        <Card className="min-w-40 flex-1">
          <CardContent className="flex flex-col gap-1">
            <span className="text-[28px] font-bold tabular-nums">{data.total_views}</span>
            <span className="text-[13px] text-muted-foreground">{t("analytics.totalViews")}</span>
          </CardContent>
        </Card>
      </div>

      <section className="mt-7">
        <h2 className="mb-3 text-lg">{t("analytics.mostViewed")}</h2>
        <DocTable rows={data.popular} emptyText={t("analytics.noViews")} />
      </section>

      <section className="mt-7">
        <h2 className="mb-1 text-lg">{t("analytics.contentGaps")}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("analytics.contentGapsHint")}</p>
        {data.search_misses.length === 0 ? (
          <Empty title={t("analytics.noGaps")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.query")}</TableHead>
                <TableHead className="text-right">{t("analytics.times")}</TableHead>
                <TableHead>{t("analytics.lastSearched")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.search_misses.map((m) => (
                <TableRow key={m.query}>
                  <TableCell>
                    <Link
                      className="text-link hover:underline"
                      to={`/templates?q=${encodeURIComponent(m.query)}`}
                    >
                      {m.query}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.count}</TableCell>
                  <TableCell>{formatDate(m.last_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

function DocTable({ rows, emptyText }: { rows: PopularDoc[]; emptyText: string }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <Empty title={emptyText} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("analytics.document")}</TableHead>
          <TableHead>{t("analytics.category")}</TableHead>
          <TableHead className="text-right">{t("analytics.views")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={d.id}>
            <TableCell>
              <Link className="text-link hover:underline" to={`/templates/docs/${d.id}`}>
                {d.title}
              </Link>
            </TableCell>
            <TableCell>{d.category_name}</TableCell>
            <TableCell className="text-right tabular-nums">{d.view_count}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
