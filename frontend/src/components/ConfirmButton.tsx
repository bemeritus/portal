/**
 * A destructive-action button that asks before it fires.
 *
 * Deleting a document, dropping a category or blocking a user are one click
 * away and have no undo. This wraps them in a two-step flow — the button turns
 * into "Confirm" + "Cancel" — rather than calling `window.confirm`, which
 * cannot be styled, cannot be dismissed by clicking elsewhere, and blocks the
 * whole tab while it is up.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

interface ConfirmButtonProps {
  /** Label in the resting state, e.g. "Delete". */
  label: string;
  /** Label of the armed button. */
  confirmLabel?: string;
  /** Size shared by the resting and armed buttons. */
  size?: "sm" | "default";
  /** Disables both buttons while the underlying action is in flight. */
  pending?: boolean;
  onConfirm: () => void;
}

export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  size = "sm",
  pending = false,
  onConfirm,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const { t } = useTranslation();

  if (!armed) {
    return (
      <Button
        type="button"
        variant="destructive"
        size={size}
        disabled={pending}
        onClick={() => setArmed(true)}
      >
        {label}
      </Button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        variant="destructive-solid"
        size={size}
        disabled={pending}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size={size} onClick={() => setArmed(false)}>
        {t("common.cancel")}
      </Button>
    </span>
  );
}
