/**
 * `/templates/docs/:id/history` — every state a document has been in.
 *
 * Two panes: the revisions on the left, newest first, and the selected one on
 * the right, read either as a diff against the revision before it or as the
 * content it held. The selection lives in the URL (`?rev=3`), so a reader can
 * link someone straight at the edit they are talking about and a refresh does
 * not drop them back at the top.
 *
 * Restoring rewinds nothing: the server writes the old content again as a new
 * revision. That is why the history only ever grows — and why a mistaken
 * restore is itself undoable.
 */

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, History } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api/client";
import { documents as documentsApi } from "../api/endpoints";
import type { BlockDiff, DiffLine, RevisionChanges, RevisionSummary } from "../api/types";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatUtc } from "../format";

/** Which reading of the selected revision the right-hand pane shows. */
type View = "diff" | "content";

/** The badge for a revision's reason — a restore stands out, an edit does not. */
function kindVariant(kind: RevisionSummary["kind"]) {
  if (kind === "restored") return "default" as const;
  if (kind === "created") return "success" as const;
  return "secondary" as const;
}

/**
 * The server's counts as a line of phrases in the reader's language —
 * "title · 2 blocks edited". The server sends no wording at all, because only
 * this side knows which language to say it in.
 */
function summarize(changes: RevisionChanges, t: TFunction): string[] {
  const parts = changes.fields.map((field) => t(`history.field.${field}`));
  if (changes.blocks_added > 0) {
    parts.push(t("history.blocksAdded", { count: changes.blocks_added }));
  }
  if (changes.blocks_removed > 0) {
    parts.push(t("history.blocksRemoved", { count: changes.blocks_removed }));
  }
  if (changes.blocks_edited > 0) {
    parts.push(t("history.blocksEdited", { count: changes.blocks_edited }));
  }
  return parts;
}

/** One line of a unified diff: a gutter mark, then the line itself. */
function DiffLineRow({ line }: { line: DiffLine }) {
  const { t } = useTranslation();

  // A fold marker: the server sends how many unchanged lines it stands for.
  if (line.kind === "skip") {
    return (
      <div className="diff-line diff-skip">
        <span aria-hidden="true" className="diff-mark">⋯</span>
        <span>{t("history.unchangedLines", { count: Number(line.text) })}</span>
      </div>
    );
  }

  const mark = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return (
    <div className={`diff-line diff-${line.kind}`}>
      <span aria-hidden="true" className="diff-mark">{mark}</span>
      {/* A blank line still needs its row height, hence the no-break space. */}
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

/** The badge colour for what happened to one Q&A block. */
function blockVariant(kind: BlockDiff["kind"]) {
  if (kind === "added") return "success" as const;
  if (kind === "removed") return "destructive" as const;
  if (kind === "changed") return "default" as const;
  return "secondary" as const;
}

/** One block's diff, headed by its question and what became of it. */
function BlockDiffCard({ block }: { block: BlockDiff }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge variant={blockVariant(block.kind)}>{t(`history.block.${block.kind}`)}</Badge>
        <span className="font-semibold">{block.question}</span>
      </div>
      {block.question_old && (
        <div className="mb-1.5 text-sm text-muted-foreground">
          {t("history.questionWas")} <span className="line-through">{block.question_old}</span>
        </div>
      )}
      {block.lines.length > 0 && (
        <div className="diff-body">
          {block.lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

function BackLink({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <Link
      className="mb-2.5 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-link"
      to={`/templates/docs/${id}`}
    >
      <ArrowLeft className="size-3.5" />
      {t("history.backToDoc")}
    </Link>
  );
}

export function HistoryPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("diff");
  const [restoredAs, setRestoredAs] = useState<number | null>(null);

  const list = useQuery({
    queryKey: ["revisions", id],
    queryFn: ({ signal }) => documentsApi.revisions(id, signal),
  });

  // The URL owns the selection. Missing, stale or unparseable, the newest
  // revision is the one anyone wants to see first.
  const asked = Number(params.get("rev"));
  const newest = list.data?.[0]?.revision;
  const selected = list.data?.some((rev) => rev.revision === asked) ? asked : newest;

  const detail = useQuery({
    queryKey: ["revision", id, selected],
    queryFn: ({ signal }) => documentsApi.revision(id, selected as number, signal),
    enabled: selected !== undefined,
  });

  useEffect(() => {
    document.title = t("docTitle", { page: t("history.heading"), app: t("app.name") });
  }, [t]);

  const restore = useMutation({
    mutationFn: (revision: number) => documentsApi.restore(id, revision),
    onSuccess: async ({ revision }) => {
      setRestoredAs(revision);
      // The document changed and so did its history — both caches are stale,
      // as is any list showing the title or status.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["revisions", id] }),
        queryClient.invalidateQueries({ queryKey: ["document", id] }),
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
      ]);
      setParams({ rev: String(revision) }, { replace: true });
    },
  });

  if (list.isPending) return <Spinner />;
  if (list.error) {
    return (
      <>
        <BackLink id={id} />
        <ErrorFlash error={errorMessage(list.error)} />
      </>
    );
  }

  const revisions = list.data ?? [];
  const current = detail.data;

  return (
    <>
      <BackLink id={id} />

      <h1 className="mb-1 flex items-center gap-2">
        <History className="size-5 text-muted-foreground" aria-hidden="true" />
        {t("history.heading")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {revisions[0]?.title} · {t("history.revisions", { count: revisions.length })}
      </p>

      {restoredAs !== null && (
        <Flash kind="ok">{t("history.restored", { revision: restoredAs })}</Flash>
      )}
      <ErrorFlash error={restore.error ? errorMessage(restore.error) : null} />

      {revisions.length === 0 ? (
        <Empty title={t("history.noneTitle")}>{t("history.noneBody")}</Empty>
      ) : (
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[21rem_1fr]">
          {/* --- The revisions, newest first --- */}
          <ol className="space-y-2">
            {revisions.map((rev) => {
              const summary = summarize(rev.changes, t);
              return (
                <li key={rev.revision}>
                  <button
                    className={cn(
                      "w-full rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent",
                      rev.revision === selected && "border-ring bg-accent",
                    )}
                    type="button"
                    aria-current={rev.revision === selected}
                    onClick={() => setParams({ rev: String(rev.revision) }, { replace: true })}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold tabular-nums">#{rev.revision}</span>
                      <Badge variant={kindVariant(rev.kind)}>
                        {rev.kind === "restored"
                          ? t("history.kind.restored", { revision: rev.restored_from })
                          : t(`history.kind.${rev.kind}`)}
                      </Badge>
                      {rev.is_current && <Badge variant="outline">{t("history.current")}</Badge>}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {rev.edited_by ?? t("history.unknownUser")} · {formatUtc(rev.edited_at)}
                    </div>
                    {summary.length > 0 && (
                      <div className="mt-1 text-sm text-muted-foreground">
                        {summary.join(" · ")}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* --- The selected revision --- */}
          <div className="min-w-0">
            {detail.isPending && <Spinner />}
            {detail.error && <ErrorFlash error={errorMessage(detail.error)} />}
            {current && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 className="mr-auto text-lg font-semibold">
                    {t("history.revision", { revision: current.revision })}
                    {current.compared_to !== null && (
                      <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                        {t("history.comparedTo", { revision: current.compared_to })}
                      </span>
                    )}
                  </h2>
                  {/* Two readings of one revision: what changed, and what it
                      said. The second is what a restore would bring back. */}
                  <div className="inline-flex overflow-hidden rounded-lg border">
                    {(["diff", "content"] as const).map((mode) => (
                      <button
                        className={cn(
                          "px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                          view === mode && "bg-accent font-medium",
                        )}
                        key={mode}
                        type="button"
                        aria-pressed={view === mode}
                        onClick={() => setView(mode)}
                      >
                        {t(`history.view.${mode}`)}
                      </button>
                    ))}
                  </div>
                  {!current.is_current && (
                    <ConfirmButton
                      label={t("history.restore")}
                      confirmLabel={t("history.restoreConfirm")}
                      pending={restore.isPending}
                      onConfirm={() => restore.mutate(current.revision)}
                    />
                  )}
                </div>

                {view === "diff" ? (
                  <div className="space-y-3">
                    {current.compared_to === null && (
                      <p className="text-sm text-muted-foreground">{t("history.firstRevision")}</p>
                    )}
                    {/* Title, status and category — the parts of a document
                        that are not Q&A text. */}
                    {current.fields.length > 0 && (
                      <div className="space-y-1 rounded-xl border bg-card p-3 text-sm">
                        {current.fields.map((field) => (
                          <div key={field.field}>
                            <span className="font-medium">{t(`history.field.${field.field}`)}</span>
                            {": "}
                            <span className="text-destructive line-through">
                              {field.field === "status" ? t(`status.${field.old}`) : field.old}
                            </span>{" "}
                            <span aria-hidden="true">→</span>{" "}
                            <span className="text-success">
                              {field.field === "status" ? t(`status.${field.new}`) : field.new}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Unchanged blocks are noise in a diff; the content view
                        is where the whole document is readable. */}
                    {current.fields.length === 0 &&
                    current.blocks.every((block) => block.kind === "unchanged") ? (
                      <p className="text-sm text-muted-foreground">{t("history.noTextChanges")}</p>
                    ) : (
                      current.blocks
                        .filter((block) => block.kind !== "unchanged")
                        .map((block, i) => <BlockDiffCard block={block} key={i} />)
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">
                      {current.title} · {t(`status.${current.status}`)}
                      {current.category_name ? ` · ${current.category_name}` : ""}
                    </div>
                    {current.rendered.length === 0 ? (
                      <p className="text-muted-foreground">{t("doc.noQuestions")}</p>
                    ) : (
                      current.rendered.map((block, i) => (
                        <section className="border-t py-4" key={i}>
                          <div className="mb-1.5 text-[17px] font-semibold">
                            <span className="mr-1.5 font-medium text-muted-foreground">
                              {i + 1}.
                            </span>
                            {block.question}
                          </div>
                          {/* Server-rendered and server-sanitized, exactly as
                              on the document page. */}
                          <div
                            className="answer-prose"
                            dangerouslySetInnerHTML={{ __html: block.answer_html }}
                          />
                        </section>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
