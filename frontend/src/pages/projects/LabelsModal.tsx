/**
 * The label manager — a lead's tool for a board's label vocabulary. Add a label
 * (name + a color from the fixed palette), recolor or rename an existing one, or
 * delete it (which drops it off every card). Members never see this; they only
 * pick from the labels it produces.
 */

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type { LabelColor, ProjectLabel, Uuid } from "../../api/types";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ErrorFlash } from "../../components/Flash";

const COLORS: LabelColor[] = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"];

export function LabelsModal({
  boardId,
  labels,
  onClose,
  onChanged,
}: {
  boardId: Uuid;
  labels: ProjectLabel[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>("gray");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = useMutation({
    mutationFn: () => projects.boards.addLabel(boardId, { name, color }),
    onSuccess: async () => {
      setName("");
      setColor("gray");
      await onChanged();
    },
  });
  const update = useMutation({
    mutationFn: (args: { id: Uuid; name: string; color: LabelColor }) =>
      projects.labels.update(args.id, { name: args.name, color: args.color }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: (id: Uuid) => projects.labels.remove(id),
    onSuccess: onChanged,
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("projects.manageLabels")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 12px" }}>{t("projects.manageLabels")}</h2>

        <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          {labels.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("projects.noLabels")}</p>}
          {labels.map((l) => (
            <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                defaultValue={l.name}
                style={{ flex: 1 }}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== l.name) update.mutate({ id: l.id, name: next, color: l.color });
                }}
              />
              <ColorPicker value={l.color} onChange={(c) => update.mutate({ id: l.id, name: l.name, color: c })} />
              <ConfirmButton
                className="icon-btn"
                label="×"
                confirmLabel={t("common.confirmDelete")}
                pending={remove.isPending}
                onConfirm={() => remove.mutate(l.id)}
              />
            </div>
          ))}
        </div>

        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <label htmlFor="label-name">{t("projects.newLabel")}</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id="label-name"
              value={name}
              placeholder={t("projects.labelName")}
              style={{ flex: 1 }}
              onChange={(e) => setName(e.target.value)}
            />
            <ColorPicker value={color} onChange={setColor} />
            <button className="btn" type="submit" disabled={!name.trim() || add.isPending}>
              {t("common.add")}
            </button>
          </div>
        </form>

        <ErrorFlash
          error={
            add.error
              ? errorMessage(add.error)
              : update.error
                ? errorMessage(update.error)
                : remove.error
                  ? errorMessage(remove.error)
                  : null
          }
        />

        <div style={{ marginTop: 14 }}>
          <button className="btn secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A row of color swatches; the picked one is ringed. */
function ColorPicker({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch label-${c}${c === value ? " on" : ""}`}
          aria-label={c}
          aria-pressed={c === value}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}
