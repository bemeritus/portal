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

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import {
  categories as categoriesApi,
  documents as documentsApi,
  tags as tagsApi,
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
  const [tags, setTags] = useState<string[]>([]);
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
    setTags(draft.tags);
    setBlocks(draft.blocks.length > 0 ? draft.blocks.map((b) => newBlock(b)) : [newBlock()]);
  }, [draft]);

  // The whole tag vocabulary, for suggesting existing tags as you type.
  const tagVocabQuery = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => tagsApi.list(signal),
  });

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
      // Both the list and this document's cached copy are now stale, and a
      // brand-new tag has just joined the vocabulary.
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["document", savedId] });
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
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
      tags,
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

          <label htmlFor="tag-input">{t("editor.tags")}</label>
          <TagsInput value={tags} onChange={setTags} suggestions={tagVocabQuery.data ?? []} />
          <p className="hint">{t("editor.tagsHint")}</p>
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

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}

/**
 * A chip-list tag editor: type a tag and press Enter or comma to add it,
 * Backspace on an empty field removes the last one, and each chip has its own
 * remove button. Tags are normalised to lower-case here too so what the author
 * sees matches what the server will store (see `normalize_tags`).
 */
function TagsInput({ value, onChange, suggestions }: TagsInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const name = raw.trim().toLowerCase();
    if (name === "" || value.includes(name)) {
      setDraft("");
      return;
    }
    onChange([...value, name]);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  // Only offer tags not already picked.
  const available = suggestions.filter((s) => !value.includes(s));

  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span className="tag-chip" key={tag}>
          {tag}
          <button
            type="button"
            className="tag-remove"
            aria-label={t("editor.removeTag", { tag })}
            onClick={() => onChange(value.filter((x) => x !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id="tag-input"
        type="text"
        className="tag-field"
        list="tag-suggestions"
        placeholder={t("editor.tagsPlaceholder")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
      />
      <datalist id="tag-suggestions">
        {available.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
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

  // Live preview: the answer, rendered by the server's one sanitized path, so
  // it always matches the published document. Debounced, and only asked for
  // while the preview pane is open.
  const [showPreview, setShowPreview] = useState(false);
  const [debouncedAnswer, setDebouncedAnswer] = useState(block.answer);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedAnswer(block.answer), 400);
    return () => window.clearTimeout(id);
  }, [block.answer]);

  // In the expanded (fullscreen) preview, Escape returns to the inline editor.
  useEffect(() => {
    if (!showPreview) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setShowPreview(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showPreview]);
  const previewQuery = useQuery({
    queryKey: ["preview", debouncedAnswer],
    queryFn: () => documentsApi.preview(debouncedAnswer),
    enabled: showPreview && debouncedAnswer.trim() !== "",
  });

  // The toolbar operates on the answer textarea's current selection, then
  // restores it so a formatting click never loses the caret.
  function applyToAnswer(
    transform: (val: string, s: number, e: number) => { value: string; selStart: number; selEnd: number },
  ) {
    const ta = answerRef.current;
    if (!ta) return;
    const { value, selStart, selEnd } = transform(block.answer, ta.selectionStart, ta.selectionEnd);
    onChange({ answer: value });
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = selStart;
      ta.selectionEnd = selEnd;
    });
  }
  const surround = (before: string, after = before) =>
    applyToAnswer((val, s, e) => {
      const sel = val.slice(s, e);
      return {
        value: val.slice(0, s) + before + sel + after + val.slice(e),
        selStart: s + before.length,
        selEnd: sel ? e + before.length : s + before.length,
      };
    });
  const linePrefix = (prefix: string) =>
    applyToAnswer((val, s, e) => {
      const lineStart = val.lastIndexOf("\n", s - 1) + 1;
      const nl = val.indexOf("\n", e);
      const lineEnd = nl === -1 ? val.length : nl;
      const target = val.slice(lineStart, lineEnd);
      const prefixed = target
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
      return {
        value: val.slice(0, lineStart) + prefixed + val.slice(lineEnd),
        selStart: lineStart,
        selEnd: lineEnd + (prefixed.length - target.length),
      };
    });
  const insertLink = () =>
    applyToAnswer((val, s, e) => {
      const sel = val.slice(s, e) || t("editor.linkText");
      const snippet = `[${sel}](url)`;
      const urlStart = s + sel.length + 3;
      return { value: val.slice(0, s) + snippet + val.slice(e), selStart: urlStart, selEnd: urlStart + 3 };
    });

  const tools = [
    { key: "bold", label: "B", title: t("editor.bold"), on: () => surround("**") },
    { key: "italic", label: "I", title: t("editor.italic"), on: () => surround("*") },
    { key: "heading", label: "H", title: t("editor.heading"), on: () => linePrefix("## ") },
    { key: "list", label: "•", title: t("editor.bulletList"), on: () => linePrefix("- ") },
    { key: "quote", label: "❝", title: t("editor.quote"), on: () => linePrefix("> ") },
    { key: "code", label: "</>", title: t("editor.inlineCode"), on: () => surround("`") },
    { key: "codeblock", label: "{ }", title: t("editor.codeBlock"), on: () => surround("```\n", "\n```") },
    { key: "link", label: "🔗", title: t("editor.link"), on: insertLink },
  ];

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

      <div className={`md-region${showPreview ? " fullscreen" : ""}`}>
        <div className="answer-head">
          <label htmlFor={answerId}>{t("editor.answerLabel")}</label>
          <div className="md-toolbar">
            {tools.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className="md-tool"
                title={tool.title}
                aria-label={tool.title}
                // Keep the textarea's selection: prevent the button from taking focus.
                onMouseDown={(e) => e.preventDefault()}
                onClick={tool.on}
              >
                {tool.label}
              </button>
            ))}
            <button
              type="button"
              className={`md-tool preview-toggle${showPreview ? " active" : ""}`}
              aria-pressed={showPreview}
              title={showPreview ? t("editor.exitPreview") : t("editor.preview")}
              onClick={() => setShowPreview((v) => !v)}
            >
              {showPreview ? t("editor.exitPreview") : t("editor.preview")}
            </button>
          </div>
        </div>
        <div className={showPreview ? "md-split" : undefined}>
          <textarea
            id={answerId}
            ref={answerRef}
            className="md-editor"
            placeholder={t("editor.answerPlaceholder")}
            value={block.answer}
            onChange={(e) => onChange({ answer: e.target.value })}
          />
          {showPreview && (
            <div className="md-preview">
              {debouncedAnswer.trim() === "" ? (
                <p className="muted">{t("editor.previewEmpty")}</p>
              ) : (
                // Server-rendered and server-sanitized — the same path the
                // document view uses, so preview and published never diverge.
                <div className="a" dangerouslySetInnerHTML={{ __html: previewQuery.data?.html ?? "" }} />
              )}
            </div>
          )}
        </div>
      </div>

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
