/**
 * `/templates/docs/:id` — one document, its Q&A blocks in order (FR-21).
 *
 * Answers arrive as HTML the server already rendered and sanitized. That is
 * why `dangerouslySetInnerHTML` is acceptable here and would not be if the
 * Markdown were rendered in the browser: the sanitizer runs where the client
 * cannot skip it.
 */

import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { documents as documentsApi } from "../api/endpoints";
import { useUser } from "../auth/AuthContext";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
import { categoryTagClass, formatDate } from "../format";
import { hasIn } from "../permissions";

/** Above this many questions, offer a jump list rather than a long scroll.
 * Two, matching the original Leptos view: even a short Q&A doc gets the list. */
const TOC_THRESHOLD = 2;

export function DocumentPage() {
  const { id = "" } = useParams();
  const user = useUser();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: doc, isPending, error } = useQuery({
    queryKey: ["document", id],
    queryFn: ({ signal }) => documentsApi.get(id, signal),
  });

  useEffect(() => {
    if (doc) document.title = t("docTitle", { page: doc.title, app: t("app.name") });
  }, [doc, t]);

  // Voting patches the cached document in place so the counts and the pressed
  // thumb update without a refetch. Pressing the active thumb again clears it.
  const vote = useMutation({
    mutationFn: (next: boolean | null) =>
      next === null ? documentsApi.clearVote(id) : documentsApi.vote(id, next),
    onSuccess: (summary) => {
      queryClient.setQueryData<typeof doc>(["document", id], (prev) =>
        prev ? { ...prev, ...summary } : prev,
      );
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
        <Link className="backlink" to="/templates">
          {t("doc.back")}
        </Link>
        <ErrorFlash error={errorMessage(error)} />
      </>
    );
  }

  const canEdit = hasIn(user, doc.category_id, "edit");
  const canDelete = hasIn(user, doc.category_id, "delete");

  return (
    <>
      <Link className="backlink" to="/templates">
        {t("doc.back")}
      </Link>

      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1>{doc.title}</h1>
          <div className="meta">
            {/* The category reads as a chip, not as prose — it is a thing you
                can be granted rights on, and the badge says so. */}
            <span className={`badge ${categoryTagClass(doc.category_id)}`}>{doc.category_name}</span>
            <span>{doc.author_username}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(doc.created_at)}</span>
            <span aria-hidden="true">·</span>
            <span>{t("doc.views", { count: doc.view_count })}</span>
            <span className={`badge ${doc.status === "published" ? "published" : "draft"}`}>
              {t(`status.${doc.status}`)}
            </span>
          </div>
          {doc.tags.length > 0 && (
            <div className="tag-row">
              {doc.tags.map((tag) => (
                // Each tag links back to the list filtered to it, turning the
                // label into a way to find everything else wearing it.
                <Link className="tag-chip" key={tag} to={`/templates?q=${encodeURIComponent(tag)}`}>
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </div>
        {(canEdit || canDelete) && (
          <div className="actions">
            {canEdit && (
              <Link className="btn secondary small" to={`/templates/docs/${doc.id}/edit`}>
                {t("common.edit")}
              </Link>
            )}
            {canDelete && (
              <ConfirmButton
                label={t("common.delete")}
                confirmLabel={t("doc.deleteForGood")}
                pending={remove.isPending}
                onConfirm={() => remove.mutate()}
              />
            )}
          </div>
        )}
      </div>

      <ErrorFlash error={remove.error ? errorMessage(remove.error) : null} />

      {doc.blocks.length === 0 ? (
        <p className="muted">{t("doc.noQuestions")}</p>
      ) : (
        <>
          {/* Long docs open with the question list expanded — the blue links
              jump to each question (smooth scroll + `.qa` scroll-margin). It
              stays a `<details>` so it can be collapsed, but shows on entry. */}
          {doc.blocks.length > TOC_THRESHOLD && (
            <details className="toc" open>
              <summary>{t("doc.questions", { count: doc.blocks.length })}</summary>
              <ol>
                {doc.blocks.map((block, i) => (
                  <li key={i}>
                    <a href={`#q${i + 1}`}>{block.question}</a>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {doc.blocks.map((block, i) => (
            <section className="qa" key={i} id={`q${i + 1}`}>
              <div className="q">
                <span className="qnum">{i + 1}.</span>
                {block.question}
              </div>
              {/* Server-rendered and server-sanitized — see the module note. */}
              <div className="a" dangerouslySetInnerHTML={{ __html: block.answer_html }} />
            </section>
          ))}
        </>
      )}

      {/* Was this helpful? — one vote per reader, pressing the active thumb
          again clears it. Counts sit beside each thumb so the room's verdict
          is visible, which is also the signal the analytics page ranks on. */}
      <div className="feedback">
        <span className="feedback-q">{t("doc.helpfulQuestion")}</span>
        <div className="feedback-buttons">
          <button
            type="button"
            className={`feedback-btn${doc.my_vote === true ? " active up" : ""}`}
            aria-pressed={doc.my_vote === true}
            disabled={vote.isPending}
            onClick={() => vote.mutate(doc.my_vote === true ? null : true)}
          >
            <span aria-hidden="true">👍</span> {t("doc.yes")}
            <span className="feedback-count">{doc.helpful_count}</span>
          </button>
          <button
            type="button"
            className={`feedback-btn${doc.my_vote === false ? " active down" : ""}`}
            aria-pressed={doc.my_vote === false}
            disabled={vote.isPending}
            onClick={() => vote.mutate(doc.my_vote === false ? null : false)}
          >
            <span aria-hidden="true">👎</span> {t("doc.no")}
            <span className="feedback-count">{doc.not_helpful_count}</span>
          </button>
        </div>
      </div>
    </>
  );
}
