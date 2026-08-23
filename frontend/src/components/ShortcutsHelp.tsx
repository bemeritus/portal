/**
 * The `?` cheat-sheet: a read-only overlay listing every shortcut and the key
 * it is currently bound to, with a link to Settings for changing them.
 *
 * Controlled by `Layout` (which owns the shortcut handlers); Escape and a
 * backdrop click close it. Unbound actions are shown greyed with a dash.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { formatCombo, SHORTCUTS } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  const { t } = useTranslation();
  const { bindings } = useShortcuts();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h2>{t("shortcuts.title")}</h2>
          <Link className="help-edit" to="/settings" onClick={onClose}>
            {t("shortcuts.edit")}
          </Link>
        </div>
        <ul className="help-list">
          {SHORTCUTS.map((s) => (
            <li key={s.id}>
              <span>{t(s.labelKey)}</span>
              {bindings[s.id] ? (
                <kbd className="kbd">{formatCombo(bindings[s.id])}</kbd>
              ) : (
                <span className="muted">—</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
