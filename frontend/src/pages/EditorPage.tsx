/**
 * `/templates/docs/new` and `/templates/docs/:id/edit` — authoring a Q&A
 * document (FR-11 … FR-15).
 *
 * Blocks carry a client-side `key` that never goes to the server. React needs
 * a stable identity per row or it reuses the wrong DOM node when blocks are
 * reordered — the symptom being text that appears to jump between questions.
 * The array's order is the document's order (FR-14); the server writes
 * `position` from it.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "../api/client";
import { categories as categoriesApi, documents as documentsApi } from "../api/endpoints";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Select } from "../components/Select";
import type { DocumentBody, QaBlockInput } from "../api/types";

/** A block plus the identity React lists need. */
interface EditableBlock extends QaBlockInput {
  key: number;
}

let nextKey = 1;

function newBlock(block: QaBlockInput = { question: "", answer: "" }): EditableBlock {
  return { ...block, key: nextKey++ };
}

export function EditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("draft");
  const [blocks, setBlocks] = useState<EditableBlock[]>(() => [newBlock()]);
  const [error, setError] = useState<string | null>(null);

  const heading = isEdit ? t("editor.editDocument") : t("editor.newDocument");
  const backHref = isEdit ? `/templates/docs/${id}` : "/templates";
  const backLabel = isEdit ? t("editor.backToDocument") : t("editor.allDocuments");

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  // Only the categories the caller may write or edit in (FR-25). Offering the
  // rest would be offering a save the server is going to refuse.
  const categoriesQuery = useQuery({
    queryKey: ["categories", "writable"],
    queryFn: ({ signal }) => categoriesApi.writable(signal),
  });

  const draftQuery = useQuery({
    queryKey: ["document", id, "draft"],
    queryFn: ({ signal }) => documentsApi.draft(id!, signal),
    enabled: isEdit,
  });

  // Fill the form once the draft lands. Keyed on the draft object so a refetch
  // of the same data does not stamp over edits in progress.
  const draft = draftQuery.data;
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setCategoryId(draft.category_id);
    setStatus(draft.status);
    setBlocks(draft.blocks.length > 0 ? draft.blocks.map((b) => newBlock(b)) : [newBlock()]);
  }, [draft]);

  const save = useMutation({
    mutationFn: async (body: DocumentBody) => {
      if (isEdit) {
        await documentsApi.update(id!, body);
        return id!;
      }
      const created = await documentsApi.create(body);
      return created.id;
    },
    onSuccess: async (savedId) => {
      // Both the list and this document's cached copy are now stale.
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["document", savedId] });
      navigate(`/templates/docs/${savedId}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const titleMissing = title.trim() === "";
  const categoryMissing = categoryId === "";
  const busy = save.isPending;

  function updateBlock(key: number, patch: Partial<QaBlockInput>) {
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  function moveBlock(key: number, delta: -1 | 1) {
    setBlocks((prev) => {
      const i = prev.findIndex((b) => b.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || titleMissing || categoryMissing) return;
    setError(null);
    save.mutate({
      title,
      category_id: categoryId,
      status,
      // Strip the client-side key: the server's shape has no room for it.
      blocks: blocks.map(({ question, answer }) => ({ question, answer })),
    });
  }

  const disabledReason = useMemo(() => {
    if (titleMissing && categoryMissing) return t("editor.saveTitleAndCategory");
    if (titleMissing) return t("editor.saveAddTitle");
    if (categoryMissing) return t("editor.saveChooseCategory");
    return null;
  }, [titleMissing, categoryMissing, t]);

  if (isEdit && draftQuery.isPending) return <Spinner />;
  if (isEdit && draftQuery.error) {
    return (
      <>
        <Link
          className="mb-2.5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-link"
          to={backHref}
        >
          <ArrowLeft className="size-3.5" />
          {backLabel}
        </Link>
        <ErrorFlash error={errorMessage(draftQuery.error)} />
      </>
    );
  }

  return (
    <>
      <Link
        className="mb-2.5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-link"
        to={backHref}
      >
        <ArrowLeft className="size-3.5" />
        {backLabel}
      </Link>
      <h1>{heading}</h1>

      <form onSubmit={onSubmit}>
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">{t("editor.title")}</Label>
              <Input
                id="title"
                type="text"
                placeholder={t("editor.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="cat">{t("editor.category")}</Label>
                <Select
                  id="cat"
                  ariaLabel={t("editor.category")}
                  value={categoryId}
                  onChange={setCategoryId}
                  options={[
                    { value: "", label: t("editor.choose") },
                    ...(categoriesQuery.data ?? []).map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
                {/* Explains an empty picker, which otherwise looks broken. */}
                {categoriesQuery.error && (
                  <ErrorFlash error={errorMessage(categoriesQuery.error)} />
                )}
                {categoriesQuery.data?.length === 0 && (
                  <p className="text-[13px] text-muted-foreground">{t("editor.noWritable")}</p>
                )}
              </div>

              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="status">{t("editor.status")}</Label>
                <Select
                  id="status"
                  ariaLabel={t("editor.status")}
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: "draft", label: t("editor.statusDraft") },
                    { value: "published", label: t("editor.statusPublished") },
                  ]}
                />
                {/* Says what status actually does. It marks the document; it
                    does not restrict who can open it — see §12.9. */}
                <p className="text-[13px] text-muted-foreground">{t("editor.statusHint")}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <h3 className="mt-6">
          {t("editor.qaBlocks")}
          <span className="text-sm font-normal text-muted-foreground">{` (${blocks.length})`}</span>
        </h3>
        <p className="mb-3 text-muted-foreground">
          {t("editor.markdownHint1")}
          <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[13px]">
            ![alt](/uploads/…)
          </code>
          {t("editor.markdownHint2")}
        </p>

        {blocks.map((block, i) => (
          <BlockEditor
            key={block.key}
            block={block}
            number={i + 1}
            isFirst={i === 0}
            isLast={i === blocks.length - 1}
            isOnly={blocks.length <= 1}
            onChange={(patch) => updateBlock(block.key, patch)}
            onMove={(delta) => moveBlock(block.key, delta)}
            onRemove={() => setBlocks((prev) => prev.filter((b) => b.key !== block.key))}
          />
        ))}

        <Button type="button" variant="outline" onClick={() => setBlocks((prev) => [...prev, newBlock()])}>
          {t("editor.addBlock")}
        </Button>

        <ErrorFlash error={error} />

        {/* Save / Cancel stay reachable without scrolling to the end of a long
            form. */}
        <div className="sticky bottom-0 z-10 mt-5 flex flex-wrap items-center gap-2.5 border-t bg-background py-3">
          <Button type="submit" disabled={busy || titleMissing || categoryMissing}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("common.saving") : t("common.save")}
          </Button>
          <Button asChild variant="outline">
            <Link to={backHref}>{t("common.cancel")}</Link>
          </Button>
          {/* Explains a disabled Save instead of leaving it a mystery. */}
          {disabledReason && (
            <span className="text-[13px] text-muted-foreground">{disabledReason}</span>
          )}
        </div>
      </form>
    </>
  );
}

interface BlockEditorProps {
  block: EditableBlock;
  number: number;
  isFirst: boolean;
  isLast: boolean;
  isOnly: boolean;
  onChange: (patch: Partial<QaBlockInput>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}


function BlockEditor({
  block,
  number,
  isFirst,
  isLast,
  isOnly,
  onChange,
  onMove,
  onRemove,
}: BlockEditorProps) {
  const { t } = useTranslation();
  const questionId = `q-${block.key}`;
  const answerId = `a-${block.key}`;

  return (
    <div className="mb-4 overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b bg-muted/40 px-4 py-2">
        <strong className="text-sm">{t("editor.question", { number })}</strong>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            title={t("editor.moveUp")}
            aria-label={t("editor.moveUpAria")}
            disabled={isFirst}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            title={t("editor.moveDown")}
            aria-label={t("editor.moveDownAria")}
            disabled={isLast}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <span className="ml-2">
            {isOnly ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                title={t("editor.removeDisabledTitle")}
                disabled
              >
                {t("common.remove")}
              </Button>
            ) : (
              // A block can hold a lot of typing — never drop it on a single
              // stray click.
              <ConfirmButton
                label={t("common.remove")}
                confirmLabel={t("editor.yesRemove")}
                onConfirm={onRemove}
              />
            )}
          </span>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={questionId}>{t("editor.questionLabel")}</Label>
          <Input
            id={questionId}
            type="text"
            placeholder={t("editor.questionPlaceholder")}
            value={block.question}
            onChange={(e) => onChange({ question: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={answerId}>{t("editor.answerLabel")}</Label>
          <MarkdownEditor
            id={answerId}
            value={block.answer}
            onChange={(answer) => onChange({ answer })}
          />
        </div>
      </div>
    </div>
  );
}
