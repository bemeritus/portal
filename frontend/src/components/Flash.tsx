/** The one-line message strip used for both failures and confirmations. */

import { useTranslation } from "react-i18next";

import { translateApiError } from "../i18n/errors";

interface FlashProps {
  kind: "error" | "ok";
  children: React.ReactNode;
}

export function Flash({ kind, children }: FlashProps) {
  return (
    // aria-live so a screen reader announces the outcome of a save the user
    // cannot see happen. Errors are assertive; confirmations can wait for a
    // pause in speech.
    <p className={`flash ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

/**
 * A failure to render, or nothing when there is none.
 *
 * Every API error reaches the screen through here, so this is where the
 * server's English sentence is swapped for the current language's — and, since
 * it reads the live language, an error already on screen re-translates when the
 * language changes.
 */
export function ErrorFlash({ error }: { error: string | null }) {
  const { i18n } = useTranslation();
  if (!error) return null;
  return <Flash kind="error">{translateApiError(error, i18n.language)}</Flash>;
}
