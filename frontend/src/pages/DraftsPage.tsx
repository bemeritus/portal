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
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "../api/client";
import { categories as categoriesApi, documents as documentsApi } from "../api/endpoints";
import { DocCard } from "../components/DocCard";
import { ErrorFlash } from "../components/Flash";
import { Empty, Skeletons } from "../components/Loading";
import { Select } from "../components/Select";

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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mb-0 min-w-0 flex-1">{t("nav.drafts")}</h1>
        <Button asChild>
          <Link to="/templates/docs/new">{t("home.newDocument")}</Link>
        </Button>
      </div>

      <Card className="my-4">
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="q">{t("home.searchLabel")}</Label>
            <Input
              id="q"
              type="search"
              value={qInput}
              placeholder={t("home.filterPlaceholder")}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="c">{t("home.category")}</Label>
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
            <Button type="button" variant="outline" onClick={clearFilters}>
              {t("common.clearFilters")}
            </Button>
          )}
        </CardContent>
      </Card>

      <ErrorFlash error={documentsQuery.error ? errorMessage(documentsQuery.error) : null} />

      {documentsQuery.isPending ? (
        <Skeletons />
      ) : documents.length === 0 ? (
        <Empty title={isFiltered ? t("home.noMatchTitle") : t("drafts.noneTitle")}>
          <p className="mb-3">{isFiltered ? t("home.tryOther") : t("drafts.noneBody")}</p>
          {isFiltered && (
            <Button type="button" variant="outline" onClick={clearFilters}>
              {t("common.clearFilters")}
            </Button>
          )}
        </Empty>
      ) : (
        <>
          <div
            className="mb-2.5 inline-flex items-center gap-2 text-[13px] text-muted-foreground"
            aria-live="polite"
          >
            {t("home.count", { count: documents.length })}
            {documentsQuery.isFetching && <Loader2 className="size-4 animate-spin" />}
          </div>

          <div className="space-y-3.5">
            {documents.map((doc) => (
              <DocCard key={doc.id} doc={doc} showDraftBadge />
            ))}
          </div>
        </>
      )}
    </>
  );
}
