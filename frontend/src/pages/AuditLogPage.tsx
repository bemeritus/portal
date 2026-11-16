/**
 * `/admin/logs` — the change history (FR-26 … FR-29, §8).
 *
 * Read-only, and not merely by convention: the API has no endpoint that writes
 * here. Times are shown in **UTC** and the column says so — the browser's
 * offset is not the server's, and a log that quietly shifts times is worse than
 * one that is explicit about the zone.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api/client";
import { audit as auditApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { Select } from "../components/Select";
import { formatUtc } from "../format";

/** One screenful, and how much more "Load more" asks for. */
const PAGE = 100;
/** The server clamps to this too; knowing it lets the button retire. */
const MAX = 500;
const TYPING_PAUSE_MS = 250;

/**
 * The colour class for an action tag, from its verb — the part after the dot.
 * Deletions are what an audit reader scans for first, so they get the danger
 * ink; creations read as calm green; permission grants as amber. Everything
 * else (updates, logins) stays neutral.
 */
function actionColor(action: string): string {
  const verb = action.slice(action.lastIndexOf(".") + 1);
  if (verb === "delete") return "text-destructive";
  if (verb === "create") return "text-success";
  if (verb.startsWith("permission")) return "text-tag-3";
  return "text-foreground";
}

const KINDS = [
  { value: "", key: "log.kindEverything" },
  { value: "user", key: "log.kindUsers" },
  { value: "category", key: "log.kindCategories" },
  { value: "document", key: "log.kindDocuments" },
  { value: "upload", key: "log.kindUploads" },
] as const;

export function AuditLogPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    document.title = t("docTitle", { page: t("log.heading"), app: t("app.name") });
  }, [t]);

  // One query per pause in typing, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // A new filter starts from the first page: keeping a raised limit would
  // fetch 500 rows of a search that may match three.
  useEffect(() => {
    setLimit(PAGE);
  }, [kind, search]);

  const { data, isPending, isFetching, error } = useQuery({
    queryKey: ["audit", kind, search, limit],
    queryFn: ({ signal }) =>
      auditApi.list({ target_type: kind || undefined, search: search || undefined, limit }, signal),
    // Keep the current rows on screen while the next page loads, rather than
    // blanking the table under the reader.
    placeholderData: keepPreviousData,
  });

  const entries = data ?? [];
  // A short page means there is nothing more to ask for.
  const canLoadMore = entries.length >= limit && limit < MAX;

  return (
    <>
      <h1>{t("log.heading")}</h1>
      <p className="text-muted-foreground">{t("log.intro")}</p>

      <Card className="my-4">
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="log-search">{t("log.search")}</Label>
            <Input
              id="log-search"
              type="search"
              placeholder={t("log.searchPlaceholder")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="log-kind">{t("log.kind")}</Label>
            <Select
              id="log-kind"
              ariaLabel={t("log.kind")}
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => ({ value: k.value, label: t(k.key) }))}
            />
          </div>
        </CardContent>
      </Card>

      <ErrorFlash error={error ? errorMessage(error) : null} />

      {isPending ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <Empty title={t("log.nothingTitle")}>
          <p>{kind || search ? t("log.noMatch") : t("log.willAppear")}</p>
        </Empty>
      ) : (
        <>
          <Table className="min-w-160">
            <TableHeader>
              <TableRow>
                <TableHead>{t("log.thWhen")}</TableHead>
                <TableHead>{t("log.thWho")}</TableHead>
                <TableHead>{t("log.thAction")}</TableHead>
                <TableHead>{t("log.thTarget")}</TableHead>
                <TableHead>{t("log.thDetails")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground">{formatUtc(entry.at)}</TableCell>
                  <TableCell>{entry.actor_name}</TableCell>
                  <TableCell>
                    {/* Monospaced so 'document.update' and 'document.delete'
                        are told apart by shape as well as by reading them. */}
                    <span
                      className={cn(
                        "rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs whitespace-nowrap",
                        actionColor(entry.action),
                      )}
                    >
                      {entry.action}
                    </span>
                  </TableCell>
                  <TableCell>
                    {/* A deleted document has nowhere to link to — that URL
                        could only 404. */}
                    {entry.target_type === "document" &&
                    entry.target_id &&
                    entry.action !== "document.delete" ? (
                      <Link
                        className="text-link hover:underline"
                        to={`/templates/docs/${entry.target_id}`}
                      >
                        {entry.target_name}
                      </Link>
                    ) : (
                      entry.target_name
                    )}
                  </TableCell>
                  <TableCell className="min-w-56 whitespace-normal text-muted-foreground">
                    {entry.details ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {canLoadMore && (
              <Button
                variant="outline"
                type="button"
                disabled={isFetching}
                onClick={() => setLimit((l) => Math.min(l + PAGE, MAX))}
              >
                {isFetching ? t("common.loading") : t("common.loadMore")}
              </Button>
            )}
            <span className="text-[13px] text-muted-foreground">
              {t("log.entries", { count: entries.length })}
              {limit >= MAX && t("log.serverMax")}
            </span>
          </div>
        </>
      )}
    </>
  );
}
