/**
 * `/learning/tests/:id` — taking a test.
 *
 * The options carry no correct/incorrect marks (the take view withholds them);
 * the server scores the submission and returns the result, which is the only
 * place the answer key is ever consulted. Authors and admins reach the same
 * page — they can also take a test — with extra links to edit it or see every
 * learner's results.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { learning } from "../../api/endpoints";
import { useUser } from "../../auth/AuthContext";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Spinner } from "../../components/Loading";
import { formatDate } from "../../format";
import { canAuthor } from "../../permissions";
import type { AttemptResult, Uuid } from "../../api/types";

export function TestTakePage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const user = useUser();
  const queryClient = useQueryClient();
  const isAuthor = canAuthor(user, "learning");

  const { data: test, isPending, error } = useQuery({
    queryKey: ["learning", "test", id],
    queryFn: ({ signal }) => learning.tests.get(id, signal),
  });
  const attemptsQuery = useQuery({
    queryKey: ["learning", "test", id, "attempts"],
    queryFn: ({ signal }) => learning.tests.myAttempts(id, signal),
  });

  const [answers, setAnswers] = useState<Record<Uuid, Uuid>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);

  useEffect(() => {
    if (test) document.title = t("docTitle", { page: test.title, app: t("app.name") });
  }, [test, t]);

  const submit = useMutation({
    mutationFn: () =>
      learning.tests.submit(id, {
        answers: (test?.questions ?? []).map((q) => ({
          question_id: q.id,
          option_id: answers[q.id] ?? null,
        })),
      }),
    onSuccess: async (res) => {
      setResult(res);
      await queryClient.invalidateQueries({ queryKey: ["learning", "test", id, "attempts"] });
    },
  });

  if (isPending) return <Spinner />;
  if (error) {
    return (
      <>
        <Link className="backlink" to="/learning/tests">
          {t("learning.backToTests")}
        </Link>
        <ErrorFlash error={errorMessage(error)} />
      </>
    );
  }

  const allAnswered = test.questions.length > 0 && test.questions.every((q) => answers[q.id]);

  function retake() {
    setAnswers({});
    setResult(null);
  }

  return (
    <>
      <Link className="backlink" to="/learning/tests">
        {t("learning.backToTests")}
      </Link>

      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1>{test.title}</h1>
          {test.description && <p className="muted">{test.description}</p>}
        </div>
        {(isAuthor || user?.is_admin) && (
          <div className="actions">
            {user?.is_admin && (
              <Link className="btn secondary small" to={`/learning/tests/${test.id}/results`}>
                {t("learning.results")}
              </Link>
            )}
            {isAuthor && (
              <Link className="btn secondary small" to={`/learning/tests/${test.id}/edit`}>
                {t("common.edit")}
              </Link>
            )}
          </div>
        )}
      </div>

      {test.questions.length === 0 ? (
        <p className="muted">{t("learning.noQuestionsYet")}</p>
      ) : result ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>
            {t("learning.yourScore", { score: result.score, max: result.max_score })}
          </h3>
          {result.passed != null &&
            (result.passed ? (
              <span className="badge published">{t("learning.passed")}</span>
            ) : (
              <span className="badge draft">{t("learning.failed")}</span>
            ))}
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={retake}>
              {t("learning.retake")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {test.questions.map((q, qi) => (
            <fieldset className="panel" key={q.id} style={{ marginBottom: 12 }}>
              <legend style={{ fontWeight: 600 }}>
                {qi + 1}. {q.prompt}
              </legend>
              {q.options.map((o) => (
                <label className="chk" key={o.id} style={{ display: "block" }}>
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    checked={answers[q.id] === o.id}
                    onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: o.id }))}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
          ))}

          <ErrorFlash error={submit.error ? errorMessage(submit.error) : null} />

          <div className="form-bar">
            <button
              className="btn"
              type="button"
              disabled={submit.isPending || !allAnswered}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? t("learning.submitting") : t("learning.submitTest")}
            </button>
            {!allAnswered && (
              <span className="muted" style={{ fontSize: 13 }}>
                {t("learning.needAllAnswers")}
              </span>
            )}
          </div>
        </>
      )}

      <h3 style={{ marginTop: 24 }}>{t("learning.pastAttempts")}</h3>
      {attemptsQuery.isPending ? (
        <Spinner />
      ) : (attemptsQuery.data ?? []).length === 0 ? (
        <Empty title={t("learning.noAttempts")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("learning.thScore")}</th>
                <th>{t("learning.thResult")}</th>
                <th>{t("learning.thSubmitted")}</th>
              </tr>
            </thead>
            <tbody>
              {(attemptsQuery.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.score} / {a.max_score}
                  </td>
                  <td>
                    {a.passed == null ? (
                      "—"
                    ) : a.passed ? (
                      <span className="badge published">{t("learning.passed")}</span>
                    ) : (
                      <span className="badge draft">{t("learning.failed")}</span>
                    )}
                  </td>
                  <td>{formatDate(a.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
