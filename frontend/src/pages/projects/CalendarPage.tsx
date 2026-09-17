/**
 * `/projects/calendar` — every due-dated card across all boards, laid out on a
 * month grid. A card links to its board. Navigation steps whole months; "Today"
 * jumps back to the current one.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { projects } from "../../api/endpoints";
import type { CalendarCard } from "../../api/types";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";

/** Local YYYY-MM-DD for a date, matching the card's stored due_date. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const today = new Date();
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });

  useEffect(() => {
    document.title = t("docTitle", { page: t("projects.calendar"), app: t("app.name") });
  }, [t]);

  const query = useQuery({
    queryKey: ["projects", "calendar"],
    queryFn: ({ signal }) => projects.calendar(signal),
  });

  // Group the cards by their due date once, so each day cell is a lookup.
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarCard[]>();
    for (const c of query.data ?? []) {
      const list = map.get(c.due_date) ?? [];
      list.push(c);
      map.set(c.due_date, list);
    }
    return map;
  }, [query.data]);

  // The cells to render: leading blanks to the first weekday, then the days.
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const lead = first.getDay(); // 0 = Sunday
    const days = new Date(view.year, view.month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push(new Date(view.year, view.month, d));
    return out;
  }, [view]);

  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString(i18n.language, {
    month: "long",
    year: "numeric",
  });
  const weekdays = useMemo(() => {
    const base = new Date(2024, 0, 7); // a Sunday
    return Array.from({ length: 7 }, (_, i) =>
      new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).toLocaleDateString(i18n.language, {
        weekday: "short",
      }),
    );
  }, [i18n.language]);

  function step(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  const todayIso = iso(today);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <h1 style={{ flex: 1, minWidth: 0 }}>{t("projects.calendar")}</h1>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn secondary" type="button" onClick={() => step(-1)}>‹</button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => setView({ year: today.getFullYear(), month: today.getMonth() })}
          >
            {t("projects.today")}
          </button>
          <button className="btn secondary" type="button" onClick={() => step(1)}>›</button>
        </div>
      </div>

      <h2 style={{ margin: "0 0 12px", fontSize: 18, textTransform: "capitalize" }}>{monthLabel}</h2>

      <ErrorFlash error={query.error ? errorMessage(query.error) : null} />

      {query.isPending ? (
        <Spinner />
      ) : (
        <div className="cal-grid">
          {weekdays.map((w) => (
            <div key={w} className="cal-weekday">{w}</div>
          ))}
          {cells.map((date, i) => {
            if (!date) return <div key={`b${i}`} className="cal-cell empty" />;
            const key = iso(date);
            const cards = byDate.get(key) ?? [];
            return (
              <div key={key} className={`cal-cell${key === todayIso ? " today" : ""}`}>
                <div className="cal-day">{date.getDate()}</div>
                {cards.map((c) => (
                  <Link key={c.id} to={`/projects/boards/${c.board_id}`} className={`cal-card prio-${c.priority}`} title={`${c.title} · ${c.board_name}`}>
                    {c.title}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
