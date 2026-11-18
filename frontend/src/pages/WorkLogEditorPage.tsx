/**
 * `/worklog/new` and `/worklog/:id/edit` — writing up a piece of server-room
 * work.
 *
 * The form is the structured journal the technicians asked for: when the work
 * happened, who did it (accounts here plus any outside names), where, what, why
 * and the result, with photos and clips attached. Media is uploaded the moment
 * it is chosen — to `/api/media`, which takes video up to a gigabyte — and the
 * entry stores only the returned filenames.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ImagePlus, Loader2, Plus, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "../api/client";
import { media as mediaApi, worklog as worklogApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
import type { MediaKind, WorkLogBody } from "../api/types";

/** An attached file, with the preview URL kept alongside what the body sends. */
interface AttachedMedia {
  file_path: string;
  kind: MediaKind;
  original_name: string;
  url: string;
}

/** ISO → the `YYYY-MM-DDTHH:mm` a `datetime-local` input wants, in local time. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The current local time, as the input's default for a new entry. */
function nowLocalInput(): string {
  return toLocalInput(new Date().toISOString());
}

export function WorkLogEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [performedAt, setPerformedAt] = useState(nowLocalInput);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [work, setWork] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  const [performerIds, setPerformerIds] = useState<Set<string>>(() => new Set());
  const [externals, setExternals] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AttachedMedia[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const heading = isEdit ? t("worklog.editEntry") : t("worklog.newEntry");
  const backHref = isEdit ? `/worklog/${id}` : "/worklog";

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  const performersQuery = useQuery({
    queryKey: ["worklog", "performers"],
    queryFn: ({ signal }) => worklogApi.performers(signal),
  });

  const entryQuery = useQuery({
    queryKey: ["worklog", "entry", id],
    queryFn: ({ signal }) => worklogApi.get(id!, signal),
    enabled: isEdit,
  });

  // Fill the form once the entry lands. Keyed on the object so a refetch does
  // not stamp over edits already made.
  const entry = entryQuery.data;
  useEffect(() => {
    if (!entry) return;
    setPerformedAt(toLocalInput(entry.performed_at));
    setTitle(entry.title ?? "");
    setLocation(entry.location);
    setWork(entry.work);
    setReason(entry.reason ?? "");
    setResult(entry.result ?? "");
    setPerformerIds(new Set(entry.performers.map((p) => p.id)));
    setExternals(entry.external_performers);
    setAttachments(
      entry.media.map((m) => ({
        file_path: m.url.replace(/^\/uploads\//, ""),
        kind: m.kind,
        original_name: m.original_name,
        url: m.url,
      })),
    );
  }, [entry]);

  const upload = useMutation({
    mutationFn: (file: File) => mediaApi.upload(file),
    onSuccess: (res) => {
      setUploadError(null);
      setAttachments((prev) => [
        ...prev,
        {
          file_path: res.file_path,
          kind: res.kind,
          original_name: res.original_name,
          url: res.url,
        },
      ]);
    },
    onError: (e) => setUploadError(errorMessage(e)),
  });

  const save = useMutation({
    mutationFn: async (body: WorkLogBody) => {
      if (isEdit) {
        await worklogApi.update(id!, body);
        return id!;
      }
      const created = await worklogApi.create(body);
      return created.id;
    },
    onSuccess: async (savedId) => {
      await queryClient.invalidateQueries({ queryKey: ["worklog"] });
      navigate(`/worklog/${savedId}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const trimmedExternals = useMemo(
    () => externals.map((s) => s.trim()).filter((s) => s !== ""),
    [externals],
  );
  const hasPerformer = performerIds.size > 0 || trimmedExternals.length > 0;
  const locationMissing = location.trim() === "";
  const workMissing = work.trim() === "";
  const canSave = !locationMissing && !workMissing && hasPerformer && !save.isPending;

  function togglePerformer(userId: string, checked: boolean) {
    setPerformerIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    const body: WorkLogBody = {
      title: title.trim() === "" ? null : title.trim(),
      performed_at: new Date(performedAt).toISOString(),
      location: location.trim(),
      work: work.trim(),
      reason: reason.trim() === "" ? null : reason.trim(),
      result: result.trim() === "" ? null : result.trim(),
      performer_user_ids: [...performerIds],
      external_performers: trimmedExternals,
      media: attachments.map((a) => ({
        file_path: a.file_path,
        kind: a.kind,
        original_name: a.original_name,
      })),
    };
    save.mutate(body);
  }

  if (isEdit && entryQuery.isPending) return <Spinner />;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
        <Link to={backHref}>
          <ArrowLeft className="size-4" />
          {isEdit ? t("worklog.backToEntry") : t("nav.serverLog")}
        </Link>
      </Button>

      <h1>{heading}</h1>

      <ErrorFlash error={error} />

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="performed_at">{t("worklog.performedAt")} *</Label>
            <Input
              id="performed_at"
              type="datetime-local"
              value={performedAt}
              onChange={(e) => setPerformedAt(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">{t("worklog.titleOptional")}</Label>
            <Input
              id="title"
              value={title}
              placeholder={t("worklog.titlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>

        {/* Who worked: accounts here, plus any outside names. */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("worklog.performers")} *</legend>
          <Card>
            <CardContent className="space-y-3">
              {performersQuery.isPending ? (
                <Spinner />
              ) : performersQuery.error ? (
                <ErrorFlash error={errorMessage(performersQuery.error)} />
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(performersQuery.data ?? []).map((u) => (
                    <label
                      key={u.id}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={performerIds.has(u.id)}
                        onCheckedChange={(c) => togglePerformer(u.id, c === true)}
                      />
                      {u.username}
                    </label>
                  ))}
                </div>
              )}

              <div className="space-y-2 border-t pt-3">
                <span className="text-[13px] text-muted-foreground">
                  {t("worklog.externalHint")}
                </span>
                {externals.map((name, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={name}
                      placeholder={t("worklog.externalPlaceholder")}
                      onChange={(e) =>
                        setExternals((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.remove")}
                      onClick={() => setExternals((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setExternals((prev) => [...prev, ""])}
                >
                  <Plus className="size-4" />
                  {t("worklog.addExternal")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="location">{t("worklog.location")} *</Label>
          <Input
            id="location"
            value={location}
            placeholder={t("worklog.locationPlaceholder")}
            onChange={(e) => setLocation(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="work">{t("worklog.work")} *</Label>
          <Textarea
            id="work"
            value={work}
            rows={4}
            placeholder={t("worklog.workPlaceholder")}
            onChange={(e) => setWork(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reason">{t("worklog.reason")}</Label>
          <Textarea
            id="reason"
            value={reason}
            rows={3}
            placeholder={t("worklog.reasonPlaceholder")}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="result">{t("worklog.result")}</Label>
          <Textarea
            id="result"
            value={result}
            rows={3}
            placeholder={t("worklog.resultPlaceholder")}
            onChange={(e) => setResult(e.target.value)}
          />
        </div>

        {/* Photos and clips. */}
        <div className="space-y-2">
          <Label>{t("worklog.media")}</Label>
          {attachments.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {attachments.map((a, i) => (
                <div key={`${a.file_path}-${i}`} className="relative overflow-hidden rounded-lg border bg-card">
                  {a.kind === "image" ? (
                    <img src={a.url} alt={a.original_name} className="h-28 w-full object-cover" />
                  ) : (
                    <video src={a.url} className="h-28 w-full bg-black object-cover" preload="metadata" />
                  )}
                  <Button
                    type="button"
                    variant="destructive-solid"
                    size="icon"
                    className="absolute top-1 right-1 size-7"
                    aria-label={t("common.remove")}
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <label className="inline-flex">
            <Button asChild variant="outline" size="sm" disabled={upload.isPending}>
              <span className="cursor-pointer">
                {upload.isPending ? <Loader2 className="animate-spin" /> : <ImagePlus />}
                {upload.isPending ? t("worklog.uploading") : t("worklog.addMedia")}
              </span>
            </Button>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
              className="hidden"
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) upload.mutate(file);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("worklog.mediaHint")}</p>
          <ErrorFlash error={uploadError} />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t pt-5">
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
          <Button asChild type="button" variant="ghost">
            <Link to={backHref}>{t("common.cancel")}</Link>
          </Button>
          {!hasPerformer && (
            <span className="text-[13px] text-muted-foreground">{t("worklog.needPerformer")}</span>
          )}
        </div>
      </form>
    </>
  );
}
