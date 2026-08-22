/** `/learning/resources/new` and `/:id/edit` — authoring a resource. */

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import type { LearningResourceBody } from "../../api/types";

export function ResourceEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("draft");
  const [error, setError] = useState<string | null>(null);

  const heading = isEdit ? t("learning.editResource") : t("learning.createResource");

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  const draftQuery = useQuery({
    queryKey: ["learning", "resource", id, "draft"],
    queryFn: ({ signal }) => learning.resources.draft(id!, signal),
    enabled: isEdit,
  });

  const draft = draftQuery.data;
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setBody(draft.body);
    setStatus(draft.status);
  }, [draft]);

  const save = useMutation({
    mutationFn: async (payload: LearningResourceBody) => {
      if (isEdit) {
        await learning.resources.update(id!, payload);
        return id!;
      }
      const created = await learning.resources.create(payload);
      return created.id;
    },
    onSuccess: async (savedId) => {
      await queryClient.invalidateQueries({ queryKey: ["learning", "resources"] });
      await queryClient.invalidateQueries({ queryKey: ["learning", "resource", savedId] });
      navigate(`/learning/resources/${savedId}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const titleMissing = title.trim() === "";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (save.isPending || titleMissing) return;
    setError(null);
    save.mutate({ title, body, status });
  }

  if (isEdit && draftQuery.isPending) return <Spinner />;
  if (isEdit && draftQuery.error) {
    return (
      <>
        <Link className="backlink" to="/learning/resources">
          {t("learning.backToResources")}
        </Link>
        <ErrorFlash error={errorMessage(draftQuery.error)} />
      </>
    );
  }

  return (
    <>
      <Link className="backlink" to="/learning/resources">
        {t("learning.backToResources")}
      </Link>
      <h1>{heading}</h1>

      <form onSubmit={onSubmit}>
        <div className="panel">
          <label htmlFor="title">{t("learning.title")}</label>
          <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

          <label htmlFor="status" style={{ marginTop: 12, display: "block" }}>
            {t("learning.status")}
          </label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">{t("learning.statusDraft")}</option>
            <option value="published">{t("learning.statusPublished")}</option>
          </select>
        </div>

        <label htmlFor="body" style={{ marginTop: 16, display: "block" }}>
          {t("learning.resourceBody")}
        </label>
        <textarea
          id="body"
          className="md-editor"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <ErrorFlash error={error} />

        <div className="form-bar">
          <button className="btn" type="submit" disabled={save.isPending || titleMissing}>
            {save.isPending && <span className="spinner" />}
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
          <Link className="btn secondary" to="/learning/resources">
            {t("common.cancel")}
          </Link>
        </div>
      </form>
    </>
  );
}
