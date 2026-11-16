/**
 * `/templates/bookmarks` — the caller's own bookmarked documents, newest first.
 *
 * A private shortlist: the server only ever returns the current user's rows,
 * and still narrows them to the categories they may read, so a bookmark does
 * not outlive lost access. The cards mirror the document list's.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { bookmarks as bookmarksApi } from "../api/endpoints";
import { DocCard } from "../components/DocCard";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";

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
      <p className="mb-4 text-muted-foreground">{t("bookmarks.subtitle")}</p>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Skeletons />
      ) : documents.length === 0 ? (
        <Empty title={t("bookmarks.noneTitle")}>
          <p className="m-0">{t("bookmarks.noneBody")}</p>
        </Empty>
      ) : (
        <div className="space-y-3.5">
          {documents.map((doc) => (
            <DocCard key={doc.id} doc={doc} showDraftBadge />
          ))}
        </div>
      )}
    </>
  );
}
