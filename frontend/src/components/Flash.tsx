/** The one-line message strip used for both failures and confirmations. */

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

/** A failure to render, or nothing when there is none. */
export function ErrorFlash({ error }: { error: string | null }) {
  if (!error) return null;
  return <Flash kind="error">{error}</Flash>;
}
