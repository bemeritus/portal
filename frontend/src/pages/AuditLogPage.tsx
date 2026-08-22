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

import { errorMessage } from "../api/client";
import { audit as auditApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
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
 * else (updates, logins) stays neutral. Returns "" for the neutral case so the
 * base `.log-action` styling stands alone.
 */
function actionKind(action: string): string {
  const verb = action.slice(action.lastIndexOf(".") + 1);
  if (verb === "delete") return "delete";
  if (verb === "create") return "create";
  if (verb.startsWith("permission")) return "perm";
  return "";
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
      <p className="muted">{t("log.intro")}</p>

      <div className="panel" style={{ margin: "16px 0" }}>
        <div className="row">
          <div>
            <label htmlFor="log-search">{t("log.search")}</label>
            <input
              id="log-search"
              type="search"
              placeholder={t("log.searchPlaceholder")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="log-kind">{t("log.kind")}</label>
            <select id="log-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {t(k.key)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <ErrorFlash error={error ? errorMessage(error) : null} />

      {isPending ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <Empty title={t("log.nothingTitle")}>
          <p className="muted">{kind || search ? t("log.noMatch") : t("log.willAppear")}</p>
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("log.thWhen")}</th>
                  <th>{t("log.thWho")}</th>
                  <th>{t("log.thAction")}</th>
                  <th>{t("log.thTarget")}</th>
                  <th className="wrap">{t("log.thDetails")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="muted">{formatUtc(entry.at)}</td>
                    <td>{entry.actor_name}</td>
                    <td>
                      <span className={`log-action ${actionKind(entry.action)}`}>{entry.action}</span>
                    </td>
                    <td>
                      {/* A deleted document has nowhere to link to — that URL
                          could only 404. */}
                      {entry.target_type === "document" &&
                      entry.target_id &&
                      entry.action !== "document.delete" ? (
                        <Link to={`/docs/${entry.target_id}`}>{entry.target_name}</Link>
                      ) : (
                        entry.target_name
                      )}
                    </td>
                    <td className="wrap muted">{entry.details ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="actions" style={{ marginTop: 16 }}>
            {canLoadMore && (
              <button
                className="btn secondary"
                type="button"
                disabled={isFetching}
                onClick={() => setLimit((l) => Math.min(l + PAGE, MAX))}
              >
                {isFetching ? t("common.loading") : t("common.loadMore")}
              </button>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              {t("log.entries", { count: entries.length })}
              {limit >= MAX && t("log.serverMax")}
            </span>
          </div>
        </>
      )}
    </>
  );
}
