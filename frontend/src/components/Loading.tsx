/** The two shapes of "not yet": a spinner, and list placeholders. */

import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-4 animate-spin text-link" aria-hidden="true" />
      {label ?? t("common.loading")}
    </span>
  );
}

/**
 * Placeholder rows the height of a real card.
 *
 * Reserving the space stops the page jumping when the list arrives, which
 * matters most on the home page — the first thing anyone sees.
 */
export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton className="h-20" key={i} />
      ))}
    </div>
  );
}

/** A list with nothing in it — said in words, not left blank. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-5 py-10 text-center text-muted-foreground">
      <div className="mb-1.5 font-semibold text-foreground">{title}</div>
      {children}
    </div>
  );
}
