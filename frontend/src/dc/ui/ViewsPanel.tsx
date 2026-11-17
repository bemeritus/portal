/**
 * Saved views (§11.4) and notes pinned in 3D. A view keeps the camera, the
 * mode, the owner highlight and the selection; it is shared with everyone
 * who can see the room, or personal (the server shows it to its author
 * only). «Скопировать ссылку» gives the link to exactly this screen.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Lock, Users } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Op, RoomData, ViewPayload } from "../types";

interface Props {
  data: RoomData;
  canEdit: boolean;
  run: (ops: Op[], label: string) => Promise<boolean>;
  saveView: (name: string, shared: boolean) => Promise<boolean>;
  openView: (v: ViewPayload) => void;
  copyLink: () => void;
}

export function ViewsPanel({ data, canEdit, run, saveView, openView, copyLink }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(true);
  const views = data.annotations.flatMap((a) => (a.kind === "view" ? [{ id: a.id, v: a.payload, author: a.author_name }] : []));
  const notes = data.annotations.flatMap((a) => (a.kind === "note" ? [{ id: a.id, n: a.payload, author: a.author_name }] : []));
  return (
    <div className="space-y-4 text-sm">
      <button type="button" className="dc-btn w-full" onClick={copyLink}>
        <Link2 className="mr-1 inline size-4" />
        {t("dc.views.copyLink")}
      </button>
      <section>
        <div className="dc-section-title">{t("dc.views.title")}</div>
        {views.length === 0 && <p className="text-xs" style={{ color: "var(--dc-muted)" }}>{t("dc.views.none")}</p>}
        <div className="dc-rows">
          {views.map(({ id, v, author }) => (
            <div key={id}>
              <button type="button" className="flex-1 text-left hover:underline" onClick={() => openView(v)}>
                {v.shared ? <Users className="mr-1 inline size-3.5" aria-label={t("dc.views.shared")} /> : <Lock className="mr-1 inline size-3.5" aria-label={t("dc.views.personal")} />}
                {v.name}
                <span className="ml-1 text-xs" style={{ color: "var(--dc-muted)" }}>
                  {[v.mode && t(`dc.mode.${v.mode}`), v.owner, author].filter(Boolean).join(" · ")}
                </span>
              </button>
              {canEdit && (
                <button type="button" className="text-xs underline" onClick={() => void run([{ op: "annotation_delete", id }], t("dc.change.viewDelete", { name: v.name }))}>
                  {t("common.delete")}
                </button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <form
            className="mt-2 space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (name.trim() && (await saveView(name.trim(), shared))) setName("");
            }}
          >
            <Input value={name} placeholder={t("dc.views.name")} onChange={(e) => setName(e.target.value)} aria-label={t("dc.views.name")} />
            <div className="flex items-center gap-2">
              <div className="dc-seg" role="radiogroup" aria-label={t("dc.views.who")}>
                <button type="button" role="radio" aria-checked={shared} onClick={() => setShared(true)}>
                  {t("dc.views.shared")}
                </button>
                <button type="button" role="radio" aria-checked={!shared} onClick={() => setShared(false)}>
                  {t("dc.views.personal")}
                </button>
              </div>
              <button type="submit" className="dc-btn dc-btn-primary ml-auto" disabled={!name.trim()}>
                {t("dc.views.save")}
              </button>
            </div>
          </form>
        )}
      </section>
      <section>
        <div className="dc-section-title">{t("dc.notes.title")}</div>
        {notes.length === 0 && <p className="text-xs" style={{ color: "var(--dc-muted)" }}>{canEdit ? t("dc.notes.howTo") : t("dc.notes.none")}</p>}
        <div className="dc-rows">
          {notes.map(({ id, n, author }) => (
            <div key={id}>
              <span className="flex-1">
                {n.text}
                <span className="block text-xs" style={{ color: "var(--dc-muted)" }}>
                  {author ?? ""}
                </span>
              </span>
              {canEdit && (
                <button type="button" className="text-xs underline" onClick={() => void run([{ op: "annotation_delete", id }], t("dc.change.noteDelete"))}>
                  {t("common.delete")}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
