/**
 * `/` — the document list with its two filters (FR-17 … FR-20).
 *
 * The title filter is debounced: it fires a query per pause, not per
 * keystroke, and each new query cancels the one before it. Without that,
 * typing "postgres" is eight requests racing each other, and the list settles
 * on whichever happens to land last.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { categories as categoriesApi, documents as documentsApi } from "../api/endpoints";
import { useUser } from "../auth/AuthContext";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";
import { categoryTagClass, formatDate } from "../format";
import { hasAnywhere } from "../permissions";

/** How long to wait after the last keystroke before asking the server. */
const TYPING_PAUSE_MS = 250;

export function HomePage() {
  // The filters live in the URL so a filtered list can be linked and survives
  // a refresh.
  const [params, setParams] = useSearchParams();
  const titleParam = params.get("title") ?? "";
  const categoryParam = params.get("category") ?? "";

  const [titleInput, setTitleInput] = useState(titleParam);
  const user = useUser();
  const { t } = useTranslation();
  const canWrite = hasAnywhere(user, "write");

  useEffect(() => {
    document.title = t("docTitle", { page: t("nav.documents"), app: t("app.name") });
  }, [t]);

  // Someone else changed the URL (back button, a link): follow it.
  useEffect(() => {
    setTitleInput(titleParam);
  }, [titleParam]);

  useEffect(() => {
    if (titleInput === titleParam) return;
    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (titleInput) next.set("title", titleInput);
          else next.delete("title");
          return next;
        },
        { replace: true },
      );
    }, TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [titleInput, titleParam, setParams]);

  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.list(signal),
  });

  const documentsQuery = useQuery({
    queryKey: ["documents", titleParam, categoryParam],
    queryFn: ({ signal }) =>
      documentsApi.list({ title: titleParam, category: categoryParam || undefined }, signal),
  });

  const isFiltered = titleParam !== "" || categoryParam !== "";
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
    setTitleInput("");
    setParams(new URLSearchParams());
  }

  return (
    <>
      <div
        className="doc-header"
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("nav.documents")}</h1>
        {canWrite && (
          <Link className="btn" to="/templates/docs/new">
            {t("home.newDocument")}
          </Link>
        )}
      </div>

      <div className="panel" style={{ margin: "16px 0" }}>
        <div className="row">
          <div>
            <label htmlFor="q">{t("home.searchByTitle")}</label>
            <input
              id="q"
              type="search"
              value={titleInput}
              placeholder={t("home.filterPlaceholder")}
              onChange={(e) => setTitleInput(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="c">{t("home.category")}</label>
            <select id="c" value={categoryParam} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t("home.allCategories")}</option>
              {(categoriesQuery.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* Explains an empty dropdown, which otherwise looks broken. */}
            {categoriesQuery.error && <ErrorFlash error={errorMessage(categoriesQuery.error)} />}
          </div>
          {/* `.grow-0` opts this out of the row's equal-width split, so the
              button keeps its own width and sits at the fields' baseline. */}
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
        <Empty title={isFiltered ? t("home.noMatchTitle") : t("home.noneTitle")}>
          <p style={{ margin: "0 0 12px" }}>
            {isFiltered ? t("home.tryOther") : t("home.willShow")}
          </p>
          {isFiltered && (
            <button type="button" className="btn secondary" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </Empty>
      ) : (
        <>
          {/* aria-live so the count is announced when a filter changes the
              list, which is otherwise a silent update for a screen reader. */}
          <div className="loading-inline" aria-live="polite" style={{ marginBottom: 10 }}>
            {t("home.count", { count: documents.length })}
            {documentsQuery.isFetching && <span className="spinner" />}
          </div>

          {documents.map((doc) => (
            <Link className="card" key={doc.id} to={`/templates/docs/${doc.id}`}>
              <h3>{doc.title}</h3>
              <div className="meta">
                <span className={`badge ${categoryTagClass(doc.category_id)}`}>{doc.category_name}</span>
                <span>{doc.author_username}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(doc.created_at)}</span>
                {doc.status === "draft" && <span className="badge draft">{t("status.draft")}</span>}
              </div>
            </Link>
          ))}
        </>
      )}
    </>
  );
}
