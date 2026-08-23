/**
 * `/templates/bookmarks` — the caller's own bookmarked documents, newest first.
 *
 * A private shortlist: the server only ever returns the current user's rows,
 * and still narrows them to the categories they may read, so a bookmark does
 * not outlive lost access. The cards mirror the document list's.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { bookmarks as bookmarksApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";
import { categoryTagClass, formatDate } from "../format";

export function BookmarksPage() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("bookmarks.heading"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["bookmarks"],
    queryFn: ({ signal }) => bookmarksApi.list(signal),
  });

  const documents = query.data ?? [];

  return (
    <>
      <h1>{t("bookmarks.heading")}</h1>
      <p className="muted">{t("bookmarks.subtitle")}</p>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : documents.length === 0 ? (
        <Empty title={t("bookmarks.noneTitle")}>
          <p style={{ margin: 0 }}>{t("bookmarks.noneBody")}</p>
        </Empty>
      ) : (
        documents.map((doc) => (
          <Link className="card" key={doc.id} to={`/templates/docs/${doc.id}`}>
            <h3>{doc.title}</h3>
            <div className="meta">
              <span className={`badge ${categoryTagClass(doc.category_id)}`}>{doc.category_name}</span>
              <span>{doc.author_username}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(doc.created_at)}</span>
              {doc.status === "draft" && <span className="badge draft">{t("status.draft")}</span>}
            </div>
            {doc.tags.length > 0 && (
              <div className="tag-row">
                {doc.tags.map((tag) => (
                  <span className="tag-chip" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </Link>
        ))
      )}
    </>
  );
}
