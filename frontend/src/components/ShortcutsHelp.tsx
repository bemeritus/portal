/**
 * The `?` cheat-sheet: a read-only dialog listing every shortcut and the key
 * it is currently bound to, with a link to Settings for changing them.
 *
 * Controlled by `Layout` (which owns the shortcut handlers); the shadcn
 * `<Dialog>` handles Escape and backdrop clicks. Unbound actions are shown
 * greyed with a dash.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { formatCombo, SHORTCUTS } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  const { t } = useTranslation();
  const { bindings } = useShortcuts();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-3 pr-6">
            {t("shortcuts.title")}
            <Link
              className="text-[13px] font-medium text-link hover:underline"
              to="/settings"
              onClick={onClose}
            >
              {t("shortcuts.edit")}
            </Link>
          </DialogTitle>
        </DialogHeader>
        <ul className="divide-y">
          {SHORTCUTS.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>{t(s.labelKey)}</span>
              {bindings[s.id] ? (
                <Kbd>{formatCombo(bindings[s.id])}</Kbd>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
