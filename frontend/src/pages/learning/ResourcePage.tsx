/**
 * `/learning/resources/:id` — one resource. The body arrives as HTML the server
 * already rendered and sanitized, so `dangerouslySetInnerHTML` is safe here for
 * the same reason it is on a document (the sanitizer runs where the client
 * cannot skip it).
 */

import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { formatDate } from "../../format";
import { canAuthor } from "../../permissions";

export function ResourcePage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAuthor = canAuthor(user, "learning");

  const { data: r, isPending, error } = useQuery({
    queryKey: ["learning", "resource", id],
    queryFn: ({ signal }) => learning.resources.get(id, signal),
  });

  useEffect(() => {
    if (r) document.title = t("docTitle", { page: r.title, app: t("app.name") });
  }, [r, t]);

  const remove = useMutation({
    mutationFn: () => learning.resources.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["learning", "resources"] });
      navigate("/learning/resources", { replace: true });
    },
  });

  if (isPending) return <Spinner />;
  if (error) {
    return (
      <>
        <Link className="backlink" to="/learning/resources">
          {t("learning.backToResources")}
        </Link>
        <ErrorFlash error={errorMessage(error)} />
      </>
    );
  }

  return (
    <>
      <Link className="backlink" to="/learning/resources">
        {t("learning.backToResources")}
      </Link>

      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1>{r.title}</h1>
          <div className="meta">
            <span>{t("learning.by", { name: r.author_username })}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(r.created_at)}</span>
            <span className={`badge ${r.status === "published" ? "published" : "draft"}`}>
              {t(`status.${r.status}`)}
            </span>
          </div>
        </div>
        {isAuthor && (
          <div className="actions">
            <Link className="btn secondary small" to={`/learning/resources/${r.id}/edit`}>
              {t("common.edit")}
            </Link>
            <ConfirmButton
              label={t("common.delete")}
              confirmLabel={t("learning.deleteForGood")}
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </div>
        )}
      </div>

      <ErrorFlash error={remove.error ? errorMessage(remove.error) : null} />

      <div className="a" dangerouslySetInnerHTML={{ __html: r.body_html }} />
    </>
  );
}
