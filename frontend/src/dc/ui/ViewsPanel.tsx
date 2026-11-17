/**
 * Saved camera views and notes pinned in 3D — both are annotations of the
 * room, stored on the server and shared with everyone who can see it.
 */

import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DcEngine } from "../engine/DcEngine";
import type { Op, RoomData } from "../types";

export function ViewsPanel({ data, canEdit, engine, run }: { data: RoomData; canEdit: boolean; engine: RefObject<DcEngine | null>; run: (ops: Op[], label: string) => Promise<boolean> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const views = data.annotations.filter((a) => a.kind === "view");
  const notes = data.annotations.filter((a) => a.kind === "note");
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="mb-1 text-sm">{t("dc.views.title")}</h3>
        {views.length === 0 && <p className="text-xs text-muted-foreground">{t("dc.views.none")}</p>}
        <ul className="space-y-1">
          {views.map((v) =>
            v.kind === "view" ? (
              <li key={v.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex-1 text-left hover:underline"
                  onClick={() =>
                    engine.current?.goView({ position: v.payload.position, target: v.payload.target, fov: v.payload.fov, ortho: v.payload.ortho })
                  }
                >
                  {v.payload.name}
                </button>
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => void run([{ op: "annotation_delete", id: v.id }], t("dc.change.viewDelete", { name: v.payload.name }))}>
                    {t("common.delete")}
                  </Button>
                )}
              </li>
            ) : null,
          )}
        </ul>
        {canEdit && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = engine.current?.view();
              if (!v || !name.trim()) return;
              const r = (a: number[]) => a.map(Math.round) as [number, number, number];
              const ok = await run(
                [{ op: "annotation_create", annotation: { kind: "view", payload: { name: name.trim(), position: r(v.position), target: r(v.target), fov: Math.round(v.fov), ortho: v.ortho } } }],
                t("dc.change.view", { name: name.trim() }),
              );
              if (ok) setName("");
            }}
          >
            <Input value={name} placeholder={t("dc.views.name")} onChange={(e) => setName(e.target.value)} aria-label={t("dc.views.name")} />
            <Button type="submit" size="sm" disabled={!name.trim()}>
              {t("dc.views.save")}
            </Button>
          </form>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-sm">{t("dc.notes.title")}</h3>
        {notes.length === 0 && <p className="text-xs text-muted-foreground">{canEdit ? t("dc.notes.howTo") : t("dc.notes.none")}</p>}
        <ul className="space-y-1">
          {notes.map((n) =>
            n.kind === "note" ? (
              <li key={n.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <div>{n.payload.text}</div>
                  <div className="text-xs text-muted-foreground">{n.author_name ?? ""}</div>
                </div>
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => void run([{ op: "annotation_delete", id: n.id }], t("dc.change.noteDelete"))}>
                    {t("common.delete")}
                  </Button>
                )}
              </li>
            ) : null,
          )}
        </ul>
      </section>
    </div>
  );
}
