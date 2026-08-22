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

interface ConfirmButtonProps {
  /** Label in the resting state, e.g. "Delete". */
  label: string;
  /** Label of the armed button. */
  confirmLabel?: string;
  /** Extra classes for the resting button (the armed one is always danger). */
  className?: string;
  /** Disables both buttons while the underlying action is in flight. */
  pending?: boolean;
  onConfirm: () => void;
}

export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  className = "btn small danger",
  pending = false,
  onConfirm,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const { t } = useTranslation();

  if (!armed) {
    return (
      <button type="button" className={className} disabled={pending} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <span className="actions" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn small danger armed"
        disabled={pending}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn small secondary" onClick={() => setArmed(false)}>
        {t("common.cancel")}
      </button>
    </span>
  );
}
