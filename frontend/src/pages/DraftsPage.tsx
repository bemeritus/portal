/**
 * `/templates/drafts` — the unpublished documents (FR-17, status `draft`).
 *
 * The same list UI as the documents page, narrowed to drafts: the documents
 * page shows only what is published, and everything still being written lives
 * here until it is. A newly created document starts as a draft, so this is
 * where it first appears. Search and the category filter behave exactly as on
 * the documents page.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { categories as categoriesApi, documents as documentsApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";
import { Select } from "../components/Select";
import { categoryTagClass, formatDate } from "../format";

/** How long to wait after the last keystroke before asking the server. */
const TYPING_PAUSE_MS = 250;

export function DraftsPage() {
  const [params, setParams] = useSearchParams();
  const qParam = params.get("q") ?? "";
  const categoryParam = params.get("category") ?? "";

  const [qInput, setQInput] = useState(qParam);
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("nav.drafts"), app: t("app.name") });
  }, [t]);

  useEffect(() => {
    setQInput(qParam);
  }, [qParam]);

  useEffect(() => {
    if (qInput === qParam) return;
    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (qInput) next.set("q", qInput);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [qInput, qParam, setParams]);

  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.list(signal),
  });

  const documentsQuery = useQuery({
    queryKey: ["documents", "draft", qParam, categoryParam],
    queryFn: ({ signal }) =>
      documentsApi.list(
        { q: qParam, category: categoryParam || undefined, status: "draft" },
        signal,
      ),
  });

  const isFiltered = qParam !== "" || categoryParam !== "";
  const documents = documentsQuery.data ?? [];

  function setCategory(value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("category", value);
      else next.delete("category");
      return next;
    });
  }

  function clearFilters() {
    setQInput("");
    setParams(new URLSearchParams());
  }

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("nav.drafts")}</h1>
        <Link className="btn" to="/templates/docs/new">
          {t("home.newDocument")}
        </Link>
      </div>

      <div className="panel" style={{ margin: "16px 0" }}>
        <div className="row">
          <div>
            <label htmlFor="q">{t("home.searchLabel")}</label>
            <input
              id="q"
              type="search"
              value={qInput}
              placeholder={t("home.filterPlaceholder")}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="c">{t("home.category")}</label>
            <Select
              id="c"
              ariaLabel={t("home.category")}
              value={categoryParam}
              onChange={setCategory}
              options={[
                { value: "", label: t("home.allCategories") },
                ...(categoriesQuery.data ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            {categoriesQuery.error && <ErrorFlash error={errorMessage(categoriesQuery.error)} />}
          </div>
          {isFiltered && (
            <div className="grow-0">
              <button type="button" className="btn secondary" onClick={clearFilters}>
                {t("common.clearFilters")}
              </button>
            </div>
          )}
        </div>
      </div>

      <ErrorFlash error={documentsQuery.error ? errorMessage(documentsQuery.error) : null} />

      {documentsQuery.isPending ? (
        <Skeletons />
      ) : documents.length === 0 ? (
        <Empty title={isFiltered ? t("home.noMatchTitle") : t("drafts.noneTitle")}>
          <p style={{ margin: "0 0 12px" }}>
            {isFiltered ? t("home.tryOther") : t("drafts.noneBody")}
          </p>
          {isFiltered && (
            <button type="button" className="btn secondary" onClick={clearFilters}>
              {t("common.clearFilters")}
            </button>
          )}
        </Empty>
      ) : (
        <>
          <div className="loading-inline" aria-live="polite" style={{ marginBottom: 10 }}>
            {t("home.count", { count: documents.length })}
            {documentsQuery.isFetching && <span className="spinner" />}
          </div>

          {documents.map((doc) => (
            <Link className="card" key={doc.id} to={`/templates/docs/${doc.id}`}>
              <h3>{doc.title}</h3>
              <div className="meta">
                <span className={`badge ${categoryTagClass(doc.category_id)}`}>
                  {doc.category_name}
                </span>
                <span>{doc.author_username}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(doc.created_at)}</span>
                <span className="badge draft">{t("status.draft")}</span>
              </div>
            </Link>
          ))}
        </>
      )}
    </>
  );
}
