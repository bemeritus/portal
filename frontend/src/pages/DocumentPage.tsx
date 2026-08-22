/**
 * `/docs/:id` — one document, its Q&A blocks in order (FR-21).
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

/** Above this many questions, offer a jump list rather than a long scroll. */
const TOC_THRESHOLD = 4;

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

  const remove = useMutation({
    mutationFn: () => documentsApi.remove(id),
    onSuccess: async () => {
      // The list this document was on is now wrong. Invalidate rather than
      // refetch: the user is leaving for the home page, which will ask.
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate("/", { replace: true });
    },
  });

  if (isPending) return <Spinner />;
  if (error) {
    return (
      <>
        <Link className="backlink" to="/">
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
      <Link className="backlink" to="/">
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
            <span className={`badge ${doc.status === "published" ? "published" : "draft"}`}>
              {t(`status.${doc.status}`)}
            </span>
          </div>
        </div>
        {(canEdit || canDelete) && (
          <div className="actions">
            {canEdit && (
              <Link className="btn secondary small" to={`/docs/${doc.id}/edit`}>
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
          {doc.blocks.length > TOC_THRESHOLD && (
            <details className="toc">
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
    </>
  );
}
