/** `/learning/labs/new` and `/:id/edit` — authoring a lab. */

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { Select } from "../../components/Select";
import type { LearningLabBody } from "../../api/types";

export function LabEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [status, setStatus] = useState("draft");
  const [error, setError] = useState<string | null>(null);

  const heading = isEdit ? t("learning.editLab") : t("learning.createLab");

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  const draftQuery = useQuery({
    queryKey: ["learning", "lab", id, "draft"],
    queryFn: ({ signal }) => learning.labs.draft(id!, signal),
    enabled: isEdit,
  });

  const draft = draftQuery.data;
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setBrief(draft.brief);
    setStatus(draft.status);
  }, [draft]);

  const save = useMutation({
    mutationFn: async (payload: LearningLabBody) => {
      if (isEdit) {
        await learning.labs.update(id!, payload);
        return id!;
      }
      const created = await learning.labs.create(payload);
      return created.id;
    },
    onSuccess: async (savedId) => {
      await queryClient.invalidateQueries({ queryKey: ["learning", "labs"] });
      await queryClient.invalidateQueries({ queryKey: ["learning", "lab", savedId] });
      navigate(`/learning/labs/${savedId}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const titleMissing = title.trim() === "";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (save.isPending || titleMissing) return;
    setError(null);
    save.mutate({ title, brief, status });
  }

  if (isEdit && draftQuery.isPending) return <Spinner />;
  if (isEdit && draftQuery.error) {
    return (
      <>
        <Link className="backlink" to="/learning/labs">
          {t("learning.backToLabs")}
        </Link>
        <ErrorFlash error={errorMessage(draftQuery.error)} />
      </>
    );
  }

  return (
    <>
      <Link className="backlink" to="/learning/labs">
        {t("learning.backToLabs")}
      </Link>
      <h1>{heading}</h1>

      <form onSubmit={onSubmit}>
        <div className="panel">
          <label htmlFor="title">{t("learning.title")}</label>
          <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

          <label htmlFor="status" style={{ marginTop: 12, display: "block" }}>
            {t("learning.status")}
          </label>
          <Select
            id="status"
            ariaLabel={t("learning.status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "draft", label: t("learning.statusDraft") },
              { value: "published", label: t("learning.statusPublished") },
            ]}
          />
        </div>

        <label htmlFor="brief" style={{ marginTop: 16, display: "block" }}>
          {t("learning.labBrief")}
        </label>
        <textarea
          id="brief"
          className="md-editor"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />

        <ErrorFlash error={error} />

        <div className="form-bar">
          <button className="btn" type="submit" disabled={save.isPending || titleMissing}>
            {save.isPending && <span className="spinner" />}
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
          <Link className="btn secondary" to="/learning/labs">
            {t("common.cancel")}
          </Link>
        </div>
      </form>
    </>
  );
}
