/**
 * `/worklog` — the server-room work log, listed newest work first.
 *
 * A sibling to the documents list, but the rows are structured journal entries
 * (who, when, where, what) rather than Q&A documents. The search filter lives
 * in the URL and is debounced, exactly as the documents list is, so a filtered
 * view can be linked and survives a refresh.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ImageIcon, Loader2, MapPin, Users, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "../api/client";
import { worklog as worklogApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";
import { formatDate } from "../format";
import type { WorkLogSummary } from "../api/types";

/** How long to wait after the last keystroke before asking the server. */
const TYPING_PAUSE_MS = 250;

export function WorkLogListPage() {
  const [params, setParams] = useSearchParams();
  const qParam = params.get("q") ?? "";
  const [qInput, setQInput] = useState(qParam);
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("nav.serverLog"), app: t("app.name") });
  }, [t]);

  useEffect(() => {
    setQInput(qParam);
  }, [qParam]);

  useEffect(() => {
    if (qInput === qParam) return;
    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (qInput) next.set("q", qInput);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [qInput, qParam, setParams]);

  const listQuery = useQuery({
    queryKey: ["worklog", qParam],
    queryFn: ({ signal }) => worklogApi.list({ q: qParam || undefined }, signal),
  });

  const isFiltered = qParam !== "";
  const entries = listQuery.data ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mb-0 min-w-0 flex-1">{t("nav.serverLog")}</h1>
        <Button asChild>
          <Link to="/worklog/new">{t("worklog.newEntry")}</Link>
        </Button>
      </div>
      <p className="mt-1 mb-0 text-muted-foreground">{t("worklog.listSubtitle")}</p>

      <Card className="my-4">
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="q">{t("worklog.searchLabel")}</Label>
            <Input
              id="q"
              type="search"
              value={qInput}
              placeholder={t("worklog.searchPlaceholder")}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          {isFiltered && (
            <Button type="button" variant="outline" onClick={() => setQInput("")}>
              {t("common.clearFilters")}
            </Button>
          )}
        </CardContent>
      </Card>

      <ErrorFlash error={listQuery.error ? errorMessage(listQuery.error) : null} />

      {listQuery.isPending ? (
        <Skeletons />
      ) : entries.length === 0 ? (
        <Empty title={isFiltered ? t("worklog.noMatchTitle") : t("worklog.noneTitle")}>
          <p className="mb-0">{isFiltered ? t("worklog.tryOther") : t("worklog.willShow")}</p>
        </Empty>
      ) : (
        <>
          <div
            className="mb-2.5 inline-flex items-center gap-2 text-[13px] text-muted-foreground"
            aria-live="polite"
          >
            {t("worklog.count", { count: entries.length })}
            {listQuery.isFetching && <Loader2 className="size-4 animate-spin" />}
          </div>
          <div className="space-y-3.5">
            {entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function EntryCard({ entry }: { entry: WorkLogSummary }) {
  const { t } = useTranslation();
  const heading = entry.title ?? entry.location;
  return (
    <Link
      className="group block rounded-xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-ring hover:shadow-md"
      to={`/worklog/${entry.id}`}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="mb-0 min-w-0 flex-1 text-card-foreground transition-colors group-hover:text-link">
          {heading}
        </h3>
        <span className="text-[13px] text-muted-foreground">{formatDate(entry.performed_at)}</span>
      </div>
      {/* The work itself, clamped so a long write-up does not grow the card. */}
      <p className="mb-2 line-clamp-2 text-sm text-muted-foreground">{entry.work}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3.5" aria-hidden="true" />
          {entry.location}
        </span>
        {entry.performers.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" />
            {entry.performers.join(", ")}
          </span>
        )}
        {entry.media_count > 0 && (
          <span className="inline-flex items-center gap-1" title={t("worklog.mediaCount", { count: entry.media_count })}>
            <ImageIcon className="size-3.5" aria-hidden="true" />
            <Video className="size-3.5" aria-hidden="true" />
            {entry.media_count}
          </span>
        )}
      </div>
    </Link>
  );
}
