/** The two shapes of "not yet": a spinner, and list placeholders. */

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="loading-inline" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Placeholder rows the height of a real card.
 *
 * Reserving the space stops the page jumping when the list arrives, which
 * matters most on the home page — the first thing anyone sees.
 */
export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

/** A list with nothing in it — said in words, not left blank. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}
