/**
 * `/worklog/:id` — one server-room work-log entry in full.
 *
 * Shows every field the technician filled in, the people who did the work
 * (linked accounts and outside names alike), and the photos and clips, with
 * videos playing in place. Edit and delete sit at the foot, the delete behind
 * a confirm like every other destructive action in the app.
 */

import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage } from "../api/client";
import { worklog as worklogApi } from "../api/endpoints";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";
import { formatDateTime } from "../format";
import type { WorkLogDetail } from "../api/types";

export function WorkLogEntryPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const entryQuery = useQuery({
    queryKey: ["worklog", "entry", id],
    queryFn: ({ signal }) => worklogApi.get(id!, signal),
    enabled: Boolean(id),
  });

  const entry = entryQuery.data;
  const heading = entry?.title ?? entry?.location ?? t("nav.serverLog");

  useEffect(() => {
    document.title = t("docTitle", { page: heading, app: t("app.name") });
  }, [heading, t]);

  const remove = useMutation({
    mutationFn: () => worklogApi.remove(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["worklog"] });
      navigate("/worklog", { replace: true });
    },
  });

  if (entryQuery.isPending) return <Spinner />;
  if (entryQuery.error || !entry) {
    return (
      <>
        <BackLink />
        <ErrorFlash error={errorMessage(entryQuery.error) || t("worklog.notFound")} />
      </>
    );
  }

  const performerNames = [
    ...entry.performers.map((p) => p.username),
    ...entry.external_performers,
  ];

  return (
    <>
      <BackLink />

      <div className="mb-1 flex flex-wrap items-start gap-3">
        <h1 className="mb-0 min-w-0 flex-1">{heading}</h1>
      </div>
      <p className="mt-0 mb-4 text-muted-foreground">{formatDateTime(entry.performed_at)}</p>

      <ErrorFlash error={remove.error ? errorMessage(remove.error) : null} />

      <dl className="space-y-5">
        <Field label={t("worklog.performers")}>
          {performerNames.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {entry.performers.map((p) => (
                <Badge key={p.id}>{p.username}</Badge>
              ))}
              {entry.external_performers.map((name) => (
                <Badge key={name} variant="secondary">
                  {name}
                </Badge>
              ))}
            </div>
          )}
        </Field>

        <Field label={t("worklog.location")}>{entry.location}</Field>
        <Field label={t("worklog.work")}>
          <Prose text={entry.work} />
        </Field>
        {entry.reason && (
          <Field label={t("worklog.reason")}>
            <Prose text={entry.reason} />
          </Field>
        )}
        {entry.result && (
          <Field label={t("worklog.result")}>
            <Prose text={entry.result} />
          </Field>
        )}

        {entry.media.length > 0 && (
          <Field label={t("worklog.media")}>
            <MediaGallery entry={entry} />
          </Field>
        )}
      </dl>

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t pt-5 text-[13px] text-muted-foreground">
        <span>
          {t("worklog.recordedBy", { name: entry.author_username ?? t("worklog.unknownAuthor") })}
          {" · "}
          {formatDateTime(entry.created_at)}
        </span>
        <span className="flex-1" />
        <Button asChild variant="outline" size="sm">
          <Link to={`/worklog/${entry.id}/edit`}>{t("common.edit")}</Link>
        </Button>
        <ConfirmButton
          label={t("common.delete")}
          confirmLabel={t("worklog.confirmDelete")}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
      <Link to="/worklog">
        <ArrowLeft className="size-4" />
        {t("nav.serverLog")}
      </Link>
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

/** Plain text with the author's own line breaks kept. */
function Prose({ text }: { text: string }) {
  return <p className="mb-0 whitespace-pre-wrap">{text}</p>;
}

function MediaGallery({ entry }: { entry: WorkLogDetail }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {entry.media.map((m) =>
        m.kind === "image" ? (
          <a
            key={m.id}
            href={m.url}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-lg border bg-card"
          >
            <img src={m.url} alt={m.original_name} className="h-full max-h-80 w-full object-cover" />
          </a>
        ) : (
          <video
            key={m.id}
            src={m.url}
            controls
            preload="metadata"
            className="max-h-80 w-full rounded-lg border bg-black"
          />
        ),
      )}
    </div>
  );
}
