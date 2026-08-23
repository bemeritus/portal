/**
 * `/learning/tests/new` and `/:id/edit` — authoring a test.
 *
 * A test is a list of single-choice questions. Each option carries a `key` for
 * React's list identity (never sent), and correctness is a radio group per
 * question, so exactly one option is marked right. On edit the draft arrives
 * *with* the correct flags — the only view that exposes them — via the
 * author-only edit endpoint.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { Select } from "../../components/Select";
import type { LearningTestBody, TestQuestionInput } from "../../api/types";

interface EditableOption {
  key: number;
  label: string;
  is_correct: boolean;
}
interface EditableQuestion {
  key: number;
  prompt: string;
  options: EditableOption[];
}

let nextKey = 1;

function blankOption(is_correct = false): EditableOption {
  return { key: nextKey++, label: "", is_correct };
}
function blankQuestion(): EditableQuestion {
  return { key: nextKey++, prompt: "", options: [blankOption(true), blankOption()] };
}
function fromInput(q: TestQuestionInput): EditableQuestion {
  return {
    key: nextKey++,
    prompt: q.prompt,
    options: q.options.map((o) => ({ key: nextKey++, label: o.label, is_correct: o.is_correct })),
  };
}

export function TestEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("draft");
  const [passScore, setPassScore] = useState("");
  const [questions, setQuestions] = useState<EditableQuestion[]>(() => [blankQuestion()]);
  const [error, setError] = useState<string | null>(null);

  const heading = isEdit ? t("learning.editTest") : t("learning.createTest");

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  const draftQuery = useQuery({
    queryKey: ["learning", "test", id, "draft"],
    queryFn: ({ signal }) => learning.tests.draft(id!, signal),
    enabled: isEdit,
  });

  const draft = draftQuery.data;
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setDescription(draft.description ?? "");
    setStatus(draft.status);
    setPassScore(draft.pass_score == null ? "" : String(draft.pass_score));
    setQuestions(draft.questions.length > 0 ? draft.questions.map(fromInput) : [blankQuestion()]);
  }, [draft]);

  const save = useMutation({
    mutationFn: async (payload: LearningTestBody) => {
      if (isEdit) {
        await learning.tests.update(id!, payload);
        return id!;
      }
      const created = await learning.tests.create(payload);
      return created.id;
    },
    onSuccess: async (savedId) => {
      await queryClient.invalidateQueries({ queryKey: ["learning", "tests"] });
      await queryClient.invalidateQueries({ queryKey: ["learning", "test", savedId] });
      navigate(`/learning/tests/${savedId}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const titleMissing = title.trim() === "";
  const noQuestions = questions.length === 0;

  function updateQuestion(key: number, patch: Partial<EditableQuestion>) {
    setQuestions((prev) => prev.map((q) => (q.key === key ? { ...q, ...patch } : q)));
  }
  function setCorrect(qKey: number, oKey: number) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.key === qKey
          ? { ...q, options: q.options.map((o) => ({ ...o, is_correct: o.key === oKey })) }
          : q,
      ),
    );
  }
  function updateOption(qKey: number, oKey: number, label: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.key === qKey
          ? { ...q, options: q.options.map((o) => (o.key === oKey ? { ...o, label } : o)) }
          : q,
      ),
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (save.isPending || titleMissing) return;
    if (noQuestions) {
      setError(t("learning.needOneQuestion"));
      return;
    }
    setError(null);
    save.mutate({
      title,
      description: description.trim() || null,
      status,
      pass_score: passScore.trim() === "" ? null : Number(passScore),
      questions: questions.map((q) => ({
        prompt: q.prompt,
        options: q.options.map((o) => ({ label: o.label, is_correct: o.is_correct })),
      })),
    });
  }

  if (isEdit && draftQuery.isPending) return <Spinner />;
  if (isEdit && draftQuery.error) {
    return (
      <>
        <Link className="backlink" to="/learning/tests">
          {t("learning.backToTests")}
        </Link>
        <ErrorFlash error={errorMessage(draftQuery.error)} />
      </>
    );
  }

  return (
    <>
      <Link className="backlink" to="/learning/tests">
        {t("learning.backToTests")}
      </Link>
      <h1>{heading}</h1>

      <form onSubmit={onSubmit}>
        <div className="panel">
          <label htmlFor="title">{t("learning.title")}</label>
          <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

          <label htmlFor="desc" style={{ marginTop: 12, display: "block" }}>
            {t("learning.testDescription")}
          </label>
          <input
            id="desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="row">
            <div>
              <label htmlFor="status">{t("learning.status")}</label>
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
            <div>
              <label htmlFor="pass">{t("learning.passScore")}</label>
              <input
                id="pass"
                type="number"
                min={0}
                value={passScore}
                onChange={(e) => setPassScore(e.target.value)}
              />
              <p className="hint">{t("learning.passScoreHint")}</p>
            </div>
          </div>
        </div>

        <p className="muted" style={{ marginTop: 16 }}>
          {t("learning.correctHint")}
        </p>

        {questions.map((q, qi) => (
          <div className="block-editor" key={q.key}>
            <div className="block-head">
              <strong>{t("learning.questionN", { number: qi + 1 })}</strong>
              <button
                type="button"
                className="btn small danger"
                onClick={() => setQuestions((prev) => prev.filter((x) => x.key !== q.key))}
              >
                {t("learning.removeQuestion")}
              </button>
            </div>

            <label htmlFor={`prompt-${q.key}`}>{t("learning.prompt")}</label>
            <input
              id={`prompt-${q.key}`}
              type="text"
              value={q.prompt}
              onChange={(e) => updateQuestion(q.key, { prompt: e.target.value })}
            />

            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              {q.options.map((o, oi) => (
                <div
                  key={o.key}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <input
                    type="radio"
                    name={`correct-${q.key}`}
                    aria-label={t("learning.markCorrect")}
                    checked={o.is_correct}
                    onChange={() => setCorrect(q.key, o.key)}
                  />
                  <input
                    type="text"
                    style={{ flex: 1 }}
                    placeholder={t("learning.option", { number: oi + 1 })}
                    value={o.label}
                    onChange={(e) => updateOption(q.key, o.key, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn icon secondary"
                    aria-label={t("common.remove")}
                    disabled={q.options.length <= 2}
                    onClick={() =>
                      updateQuestion(q.key, {
                        options: q.options.filter((x) => x.key !== o.key),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn secondary small"
              style={{ marginTop: 8 }}
              onClick={() => updateQuestion(q.key, { options: [...q.options, blankOption()] })}
            >
              {t("learning.addOption")}
            </button>
          </div>
        ))}

        <button
          type="button"
          className="btn secondary"
          onClick={() => setQuestions((prev) => [...prev, blankQuestion()])}
        >
          {t("learning.addQuestion")}
        </button>

        <ErrorFlash error={error} />

        <div className="form-bar">
          <button className="btn" type="submit" disabled={save.isPending || titleMissing}>
            {save.isPending && <span className="spinner" />}
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
          <Link className="btn secondary" to="/learning/tests">
            {t("common.cancel")}
          </Link>
        </div>
      </form>
    </>
  );
}
