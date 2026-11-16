/**
 * The Markdown answer editor — a GitHub-style compose box built from shadcn/ui
 * parts: one bordered shell whose header row carries Write/Preview tabs, an
 * icon toolbar (tooltips on every control), the image-upload button and an
 * expand toggle; the body is the borderless textarea or the rendered preview.
 *
 * Preview HTML comes from the server's one sanitized Markdown path (debounced),
 * so what the author sees here is exactly what the document page will show.
 * Expanded mode lifts the shell over a dimmed page and shows the editor and
 * the live preview side by side; Escape returns it inline.
 */

import { useEffect, useRef, useState } from "react";
import {
  Bold,
  Braces,
  Code,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  TextQuote,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api/client";
import { documents as documentsApi, uploads as uploadsApi } from "../api/endpoints";
import { ErrorFlash } from "./Flash";

interface MarkdownEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}

function ToolButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          aria-label={title}
          // Keep the textarea's selection: prevent the button taking focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

export function MarkdownEditor({ id, value, onChange }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [expanded, setExpanded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Expanded shows both panes at once; inline, the tabs choose one.
  const previewVisible = expanded || tab === "preview";

  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), 400);
    return () => window.clearTimeout(timer);
  }, [value]);

  // In the expanded view, Escape returns to the inline editor.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const previewQuery = useQuery({
    queryKey: ["preview", debounced],
    queryFn: () => documentsApi.preview(debounced),
    enabled: previewVisible && debounced.trim() !== "",
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadsApi.image(file),
    onSuccess: (result) => {
      setUploadError(null);
      // Insert at the caret if the answer has focus, otherwise append.
      const ta = textareaRef.current;
      const snippet = result.markdown;
      if (ta && document.activeElement === ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        onChange(value.slice(0, start) + snippet + value.slice(end));
      } else {
        const separator = value && !value.endsWith("\n") ? "\n\n" : "";
        onChange(value + separator + snippet);
      }
    },
    onError: (e) => setUploadError(errorMessage(e)),
  });

  // The toolbar operates on the textarea's current selection, then restores it
  // so a formatting click never loses the caret.
  function apply(
    transform: (val: string, s: number, e: number) => { value: string; selStart: number; selEnd: number },
  ) {
    const ta = textareaRef.current;
    if (!ta) return;
    const { value: next, selStart, selEnd } = transform(value, ta.selectionStart, ta.selectionEnd);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = selStart;
      ta.selectionEnd = selEnd;
    });
  }
  const surround = (before: string, after = before) =>
    apply((val, s, e) => {
      const sel = val.slice(s, e);
      return {
        value: val.slice(0, s) + before + sel + after + val.slice(e),
        selStart: s + before.length,
        selEnd: sel ? e + before.length : s + before.length,
      };
    });
  const linePrefix = (prefix: string) =>
    apply((val, s, e) => {
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
    apply((val, s, e) => {
      const sel = val.slice(s, e) || t("editor.linkText");
      const snippet = `[${sel}](url)`;
      const urlStart = s + sel.length + 3;
      return { value: val.slice(0, s) + snippet + val.slice(e), selStart: urlStart, selEnd: urlStart + 3 };
    });

  const preview = (
    <div
      className={cn(
        "answer-prose overflow-y-auto px-4 py-3 text-sm",
        expanded ? "h-full min-h-0 rounded-md border bg-background" : "max-h-[60vh] min-h-72",
      )}
    >
      {debounced.trim() === "" ? (
        <p className="text-muted-foreground">{t("editor.previewEmpty")}</p>
      ) : previewQuery.isPending ? (
        <p className="inline-flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </p>
      ) : (
        // Server-rendered and server-sanitized — the same path the document
        // view uses, so preview and published never diverge.
        <div dangerouslySetInnerHTML={{ __html: previewQuery.data?.html ?? "" }} />
      )}
    </div>
  );

  const textarea = (
    <Textarea
      id={id}
      ref={textareaRef}
      className={cn(
        "rounded-none border-0 bg-transparent px-4 py-3 font-mono text-sm shadow-none focus-visible:ring-0",
        expanded
          ? "h-full min-h-0 resize-none rounded-md border bg-background"
          : "max-h-[60vh] min-h-72 resize-y",
      )}
      placeholder={t("editor.answerPlaceholder")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <>
      {expanded && (
        <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setExpanded(false)} />
      )}
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-card transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25",
          expanded && "fixed inset-2 z-50 flex flex-col shadow-2xl sm:inset-[4vh_4vw]",
        )}
      >
        {/* Header: tabs on the left, formatting tools and window controls on
            the right — one quiet strip, like a code-forge compose box. */}
        <div className="flex flex-wrap items-center gap-1 border-b bg-muted/60 px-2 py-1.5">
          {!expanded && (
            <>
              <Tabs value={tab} onValueChange={(v) => setTab(v as "write" | "preview")}>
                <TabsList className="h-8">
                  <TabsTrigger value="write" className="px-3 text-xs">
                    {t("editor.write")}
                  </TabsTrigger>
                  <TabsTrigger value="preview" className="px-3 text-xs">
                    {t("editor.preview")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
            </>
          )}

          {(expanded || tab === "write") && (
            <div className="flex flex-wrap items-center">
              <ToolButton title={t("editor.bold")} onClick={() => surround("**")}>
                <Bold />
              </ToolButton>
              <ToolButton title={t("editor.italic")} onClick={() => surround("*")}>
                <Italic />
              </ToolButton>
              <ToolButton title={t("editor.heading")} onClick={() => linePrefix("## ")}>
                <Heading2 />
              </ToolButton>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
              <ToolButton title={t("editor.bulletList")} onClick={() => linePrefix("- ")}>
                <List />
              </ToolButton>
              <ToolButton title={t("editor.quote")} onClick={() => linePrefix("> ")}>
                <TextQuote />
              </ToolButton>
              <ToolButton title={t("editor.inlineCode")} onClick={() => surround("`")}>
                <Code />
              </ToolButton>
              <ToolButton title={t("editor.codeBlock")} onClick={() => surround("```\n", "\n```")}>
                <Braces />
              </ToolButton>
              <ToolButton title={t("editor.link")} onClick={insertLink}>
                <LinkIcon />
              </ToolButton>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t("editor.insertImage")}
                    disabled={upload.isPending}
                    onClick={() => fileInput.current?.click()}
                  >
                    {upload.isPending ? <Loader2 className="animate-spin" /> : <ImagePlus />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {upload.isPending ? t("editor.uploading") : t("editor.insertImage")}
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          <span className="flex-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-pressed={expanded}
                aria-label={expanded ? t("editor.collapse") : t("editor.expand")}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {expanded ? t("editor.collapse") : t("editor.expand")}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Body: inline — one pane by tab; expanded — both, side by side. */}
        {expanded ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 md:grid-cols-2">
            {textarea}
            {preview}
          </div>
        ) : tab === "preview" ? (
          preview
        ) : (
          textarea
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first: picking the same file twice in a row fires no change
          // event otherwise.
          e.target.value = "";
          if (file) upload.mutate(file);
        }}
      />
      <p className="mt-1.5 text-xs text-muted-foreground">{t("editor.uploadHint")}</p>
      <ErrorFlash error={uploadError} />
    </>
  );
}
