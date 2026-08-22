/**
 * `/docs/new` and `/docs/:id/edit` — authoring a Q&A document (FR-11 … FR-15).
 *
 * Blocks carry a client-side `key` that never goes to the server. React needs
 * a stable identity per row or it reuses the wrong DOM node when blocks are
 * reordered — the symptom being text that appears to jump between questions.
 * The array's order is the document's order (FR-14); the server writes
 * `position` from it.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import {
  categories as categoriesApi,
  documents as documentsApi,
  uploads as uploadsApi,
} from "../api/endpoints";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
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
  const backHref = isEdit ? `/docs/${id}` : "/";
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
      navigate(`/docs/${savedId}`, { replace: true });
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
        <Link className="backlink" to={backHref}>
          {backLabel}
        </Link>
        <ErrorFlash error={errorMessage(draftQuery.error)} />
      </>
    );
  }

  return (
    <>
      <Link className="backlink" to={backHref}>
        {backLabel}
      </Link>
      <h1>{heading}</h1>

      <form onSubmit={onSubmit}>
        <div className="panel">
          <label htmlFor="title">{t("editor.title")}</label>
          <input
            id="title"
            type="text"
            placeholder={t("editor.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="row">
            <div>
              <label htmlFor="cat">{t("editor.category")}</label>
              <select id="cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t("editor.choose")}</option>
                {(categoriesQuery.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {/* Explains an empty picker, which otherwise looks broken. */}
              {categoriesQuery.error && (
                <ErrorFlash error={errorMessage(categoriesQuery.error)} />
              )}
              {categoriesQuery.data?.length === 0 && (
                <p className="hint">{t("editor.noWritable")}</p>
              )}
            </div>

            <div>
              <label htmlFor="status">{t("editor.status")}</label>
              <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="draft">{t("editor.statusDraft")}</option>
                <option value="published">{t("editor.statusPublished")}</option>
              </select>
              {/* Says what status actually does. It marks the document; it does
                  not restrict who can open it — see §12.9. */}
              <p className="hint">{t("editor.statusHint")}</p>
            </div>
          </div>
        </div>

        <h3 style={{ marginTop: 24 }}>
          {t("editor.qaBlocks")}
          <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
            {` (${blocks.length})`}
          </span>
        </h3>
        <p className="muted">
          {t("editor.markdownHint1")}
          <code>![alt](/uploads/…)</code>
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

        <button
          type="button"
          className="btn secondary"
          onClick={() => setBlocks((prev) => [...prev, newBlock()])}
        >
          {t("editor.addBlock")}
        </button>

        <ErrorFlash error={error} />

        <div className="form-bar">
          <button className="btn" type="submit" disabled={busy || titleMissing || categoryMissing}>
            {busy && <span className="spinner" />}
            {busy ? t("common.saving") : t("common.save")}
          </button>
          <Link className="btn secondary" to={backHref}>
            {t("common.cancel")}
          </Link>
          {/* Explains a disabled Save instead of leaving it a mystery. */}
          {disabledReason && (
            <span className="muted" style={{ fontSize: 13 }}>
              {disabledReason}
            </span>
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
  const fileInput = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => uploadsApi.image(file),
    onSuccess: (result) => {
      setUploadError(null);
      // Insert at the caret if the answer has focus, otherwise append. The
      // Leptos version could only open the upload in a new tab and leave the
      // author to copy the URL back by hand; a JSON response makes this the
      // obvious thing to do instead.
      const textarea = answerRef.current;
      const snippet = result.markdown;
      if (textarea && document.activeElement === textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const next = block.answer.slice(0, start) + snippet + block.answer.slice(end);
        onChange({ answer: next });
      } else {
        const separator = block.answer && !block.answer.endsWith("\n") ? "\n\n" : "";
        onChange({ answer: block.answer + separator + snippet });
      }
    },
    onError: (e) => setUploadError(errorMessage(e)),
  });

  const questionId = `q-${block.key}`;
  const answerId = `a-${block.key}`;

  return (
    <div className="block-editor">
      <div className="block-head">
        <strong>{t("editor.question", { number })}</strong>
        <div className="grow-0">
          <button
            type="button"
            className="btn icon secondary"
            title={t("editor.moveUp")}
            aria-label={t("editor.moveUpAria")}
            disabled={isFirst}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn icon secondary"
            title={t("editor.moveDown")}
            aria-label={t("editor.moveDownAria")}
            disabled={isLast}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <span className="danger">
            {isOnly ? (
              <button
                type="button"
                className="btn small danger"
                title={t("editor.removeDisabledTitle")}
                disabled
              >
                {t("common.remove")}
              </button>
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

      <label htmlFor={questionId}>{t("editor.questionLabel")}</label>
      <input
        id={questionId}
        type="text"
        placeholder={t("editor.questionPlaceholder")}
        value={block.question}
        onChange={(e) => onChange({ question: e.target.value })}
      />

      <label htmlFor={answerId}>{t("editor.answerLabel")}</label>
      <textarea
        id={answerId}
        ref={answerRef}
        className="md-editor"
        placeholder={t("editor.answerPlaceholder")}
        value={block.answer}
        onChange={(e) => onChange({ answer: e.target.value })}
      />

      <div className="actions" style={{ marginTop: 8 }}>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first: picking the same file twice in a row fires no
            // change event otherwise.
            e.target.value = "";
            if (file) upload.mutate(file);
          }}
        />
        <button
          type="button"
          className="btn secondary small"
          disabled={upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? t("editor.uploading") : t("editor.insertImage")}
        </button>
        <span className="hint">{t("editor.uploadHint")}</span>
      </div>

      <ErrorFlash error={uploadError} />
    </div>
  );
}
