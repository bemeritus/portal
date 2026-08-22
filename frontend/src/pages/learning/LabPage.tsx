/**
 * `/learning/labs/:id` — one lab: the brief to work from, and the caller's own
 * progress on it (state + submission). Authors also get edit/delete; an admin
 * gets a link to everyone's submissions.
 *
 * The brief is server-rendered, sanitized HTML — same contract as a document.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { useUser } from "../../auth/AuthContext";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash, Flash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { canAuthor } from "../../permissions";

/** The states a learner may set themselves — `reviewed` is an admin verdict. */
const LEARNER_STATES = ["not_started", "in_progress", "submitted"] as const;

export function LabPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAuthor = canAuthor(user, "learning");

  const { data: lab, isPending, error } = useQuery({
    queryKey: ["learning", "lab", id],
    queryFn: ({ signal }) => learning.labs.get(id, signal),
  });

  const [state, setState] = useState("not_started");
  const [submission, setSubmission] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (lab) document.title = t("docTitle", { page: lab.title, app: t("app.name") });
  }, [lab, t]);

  // Seed the form from the caller's saved progress once it lands.
  useEffect(() => {
    if (!lab) return;
    setState(lab.my_progress?.state ?? "not_started");
    setSubmission(lab.my_progress?.submission ?? "");
  }, [lab]);

  const save = useMutation({
    mutationFn: () => learning.labs.saveProgress(id, { state, submission: submission || null }),
    onSuccess: async () => {
      setFormError(null);
      setNotice(t("learning.progressSaved"));
      await queryClient.invalidateQueries({ queryKey: ["learning", "lab", id] });
      await queryClient.invalidateQueries({ queryKey: ["learning", "labs"] });
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => learning.labs.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["learning", "labs"] });
      navigate("/learning/labs", { replace: true });
    },
  });

  if (isPending) return <Spinner />;
  if (error) {
    return (
      <>
        <Link className="backlink" to="/learning/labs">
          {t("learning.backToLabs")}
        </Link>
        <ErrorFlash error={errorMessage(error)} />
      </>
    );
  }

  // `reviewed` is not in LEARNER_STATES; if an admin set it, keep it visible in
  // the select rather than silently snapping the learner back a step.
  const stateOptions = LEARNER_STATES.includes(state as (typeof LEARNER_STATES)[number])
    ? LEARNER_STATES
    : [...LEARNER_STATES, state];

  return (
    <>
      <Link className="backlink" to="/learning/labs">
        {t("learning.backToLabs")}
      </Link>

      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1>{lab.title}</h1>
          <div className="meta">
            <span>{t("learning.by", { name: lab.author_username })}</span>
            <span className={`badge ${lab.status === "published" ? "published" : "draft"}`}>
              {t(`status.${lab.status}`)}
            </span>
          </div>
        </div>
        {(isAuthor || user?.is_admin) && (
          <div className="actions">
            {user?.is_admin && (
              <Link className="btn secondary small" to={`/learning/labs/${lab.id}/submissions`}>
                {t("learning.results")}
              </Link>
            )}
            {isAuthor && (
              <Link className="btn secondary small" to={`/learning/labs/${lab.id}/edit`}>
                {t("common.edit")}
              </Link>
            )}
            {isAuthor && (
              <ConfirmButton
                label={t("common.delete")}
                confirmLabel={t("learning.deleteForGood")}
                pending={remove.isPending}
                onConfirm={() => remove.mutate()}
              />
            )}
          </div>
        )}
      </div>

      <ErrorFlash error={remove.error ? errorMessage(remove.error) : null} />

      <div className="a" dangerouslySetInnerHTML={{ __html: lab.brief_html }} />

      <div className="panel" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t("learning.yourProgress")}</h3>

        {lab.my_progress?.grade != null && (
          <p className="badge published" style={{ display: "inline-block" }}>
            {t("learning.grade", { grade: lab.my_progress.grade })}
          </p>
        )}

        <label htmlFor="state">{t("learning.thState")}</label>
        <select id="state" value={state} onChange={(e) => setState(e.target.value)}>
          {stateOptions.map((s) => (
            <option key={s} value={s}>
              {t(`learning.state_${s}`)}
            </option>
          ))}
        </select>

        <label htmlFor="submission" style={{ marginTop: 12, display: "block" }}>
          {t("learning.yourSubmission")}
        </label>
        <textarea
          id="submission"
          className="md-editor"
          value={submission}
          onChange={(e) => setSubmission(e.target.value)}
        />

        {notice && <Flash kind="ok">{notice}</Flash>}
        <ErrorFlash error={formError} />

        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn"
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("common.saving") : t("learning.saveProgress")}
          </button>
        </div>
      </div>
    </>
  );
}
