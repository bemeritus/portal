/**
 * One document in a list — the card the documents, drafts and bookmarks pages
 * all render. The whole card is the link; the category reads as a coloured
 * badge so the eye can group cards before reading a word.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { categoryTagClass, formatDate } from "../format";
import type { DocumentSummary } from "../api/types";

export function DocCard({ doc, showDraftBadge }: { doc: DocumentSummary; showDraftBadge?: boolean }) {
  const { t } = useTranslation();
  return (
    <Link
      className="group block rounded-xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-ring hover:shadow-md"
      to={`/templates/docs/${doc.id}`}
    >
      <h3 className="mb-1.5 text-card-foreground transition-colors group-hover:text-link">
        {doc.title}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
        <Badge className={categoryTagClass(doc.category_id)}>{doc.category_name}</Badge>
        <span>{doc.author_username}</span>
        <span aria-hidden="true">·</span>
        <span>{formatDate(doc.created_at)}</span>
        {showDraftBadge && doc.status === "draft" && (
          <Badge variant="secondary">{t("status.draft")}</Badge>
        )}
      </div>
    </Link>
  );
}
