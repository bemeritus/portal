/**
 * `/templates/docs/:id` — one document, its Q&A blocks in order (FR-21).
 *
 * Answers arrive as HTML the server already rendered and sanitized. That is
 * why `dangerouslySetInnerHTML` is acceptable here and would not be if the
 * Markdown were rendered in the browser: the sanitizer runs where the client
 * cannot skip it.
 */

import { useEffect, useRef } from "react";
import { Link, useNavigate, useNavigationType, useParams } from "react-router-dom";
import { ArrowLeft, Star } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api/client";
import { documents as documentsApi } from "../api/endpoints";
import type { DocumentWithBlocks } from "../api/types";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
import { categoryTagClass, formatDate } from "../format";

/** Above this many questions, offer a jump list rather than a long scroll. */
const TOC_THRESHOLD = 2;

function BackLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      className="mb-2.5 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-link"
      to="/templates"
    >
      <ArrowLeft className="size-3.5" />
      {children}
    </Link>
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const queryClient = useQueryClient();

  const { data: doc, isPending, error } = useQuery({
    queryKey: ["document", id],
    queryFn: ({ signal }) => documentsApi.get(id, signal),
  });

  useEffect(() => {
    if (doc) document.title = t("docTitle", { page: doc.title, app: t("app.name") });
  }, [doc, t]);

  // Counting a view is a separate call, and only a click-through makes it. The
  // navigation type is what distinguishes the cases: following a link anywhere
  // in the app is a PUSH, while a refresh, a pasted URL and the back button are
  // all POP, and the editor's post-save redirect is a REPLACE. The ref keeps it
  // to one count per document per mount — StrictMode runs this effect twice.
  const countedId = useRef("");
  useEffect(() => {
    if (!id || navigationType !== "PUSH" || countedId.current === id) return;
    countedId.current = id;
    documentsApi
      .view(id)
      .then(({ view_count }) => {
        queryClient.setQueryData<DocumentWithBlocks>(["document", id], (prev) =>
          prev ? { ...prev, view_count } : prev,
        );
      })
      .catch(() => {
        // A view count is telemetry; failing to record one must not surface as
        // an error over the document the reader came here for.
      });
  }, [id, navigationType, queryClient]);

  // Bookmarking flips the cached document's flag immediately and invalidates
  // the bookmarks list so it reflects the change on next visit.
  const bookmark = useMutation({
    mutationFn: (next: boolean) =>
      next ? documentsApi.bookmark(id) : documentsApi.unbookmark(id),
    onSuccess: (_data, next) => {
      queryClient.setQueryData<typeof doc>(["document", id], (prev) =>
        prev ? { ...prev, bookmarked: next } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => documentsApi.remove(id),
    onSuccess: async () => {
      // The list this document was on is now wrong. Invalidate rather than
      // refetch: the user is leaving for the home page, which will ask.
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate("/templates", { replace: true });
    },
  });

  if (isPending) return <Spinner />;
  if (error) {
    return (
      <>
        <BackLink>{t("doc.back")}</BackLink>
        <ErrorFlash error={errorMessage(error)} />
      </>
    );
  }

  return (
    <>
      <BackLink>{t("doc.back")}</BackLink>

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-60 flex-1">
          <h1 className="mb-1">{doc.title}</h1>
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            {/* The category reads as a chip, not as prose — it is a thing you
                can be granted rights on, and the badge says so. */}
            <Badge className={categoryTagClass(doc.category_id)}>{doc.category_name}</Badge>
            <span>{doc.author_username}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(doc.created_at)}</span>
            <span aria-hidden="true">·</span>
            <span>{t("doc.views", { count: doc.view_count })}</span>
            <Badge variant={doc.status === "published" ? "success" : "secondary"}>
              {t(`status.${doc.status}`)}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Every reader can bookmark; edit/delete stay gated on rights. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(doc.bookmarked && "border-ring text-link hover:text-link")}
            aria-pressed={doc.bookmarked}
            disabled={bookmark.isPending}
            onClick={() => bookmark.mutate(!doc.bookmarked)}
          >
            <Star className={cn("size-3.5", doc.bookmarked && "fill-current")} aria-hidden="true" />
            {doc.bookmarked ? t("doc.bookmarked") : t("doc.bookmark")}
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/templates/docs/${doc.id}/edit`}>{t("common.edit")}</Link>
          </Button>
          <ConfirmButton
            label={t("common.delete")}
            confirmLabel={t("doc.deleteForGood")}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>

      <ErrorFlash error={remove.error ? errorMessage(remove.error) : null} />

      {doc.blocks.length === 0 ? (
        <p className="text-muted-foreground">{t("doc.noQuestions")}</p>
      ) : (
        <>
          {/* Long docs open with the question list expanded — the blue links
              jump to each question (smooth scroll + scroll-margin on the
              sections). It stays a `<details>` so it can be collapsed. */}
          {doc.blocks.length > TOC_THRESHOLD && (
            <details className="my-4" open>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {t("doc.questions", { count: doc.blocks.length })}
              </summary>
              <ol className="mt-2.5 list-decimal space-y-1 pl-6 text-sm text-muted-foreground">
                {doc.blocks.map((block, i) => (
                  <li key={i}>
                    <a className="text-link hover:underline" href={`#q${i + 1}`}>
                      {block.question}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          )}

          <div className="divide-y">
            {doc.blocks.map((block, i) => (
              <section className="scroll-mt-20 py-5" key={i} id={`q${i + 1}`}>
                <div className="mb-1.5 text-[17px] font-semibold">
                  <span className="mr-1.5 font-medium text-muted-foreground">{i + 1}.</span>
                  {block.question}
                </div>
                {/* Server-rendered and server-sanitized — see the module note. */}
                <div
                  className="answer-prose"
                  dangerouslySetInnerHTML={{ __html: block.answer_html }}
                />
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}
