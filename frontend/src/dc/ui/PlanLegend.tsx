/**
 * The plan's legend (FEEDBACK-5 §2): in the title block's corner, above the
 * title block, never over the view cube or the toolbar. It lists only the
 * marks drawn in the current view, each with a sample drawn the way the plan
 * draws it, in plain words. It folds to an «Обозначения» button; the state
 * is the user's (`dc_legend_collapsed`).
 */

import { useTranslation } from "react-i18next";
import { ChevronDown, ListTree } from "lucide-react";

import type { LegendMarks } from "../engine/DcEngine";
import type { Fmt } from "../format";

/** Model and tape may differ by this much before a dimension is marked. */
const TAPE_TOLERANCE_MM = 5;

export function hasLegend(m: LegendMarks | null): m is LegendMarks {
  return !!m && (m.overhead || m.tapeDot || m.short.length > 0 || m.split);
}

export function PlanLegend({
  marks,
  fmt,
  collapsed,
  onCollapsed,
}: {
  marks: LegendMarks;
  fmt: Fmt;
  collapsed: boolean;
  onCollapsed: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  if (collapsed)
    return (
      <button
        type="button"
        className="dc-legend-button dc-panel"
        aria-expanded={false}
        onClick={() => onCollapsed(false)}
      >
        <ListTree className="size-3.5" /> {t("dc.plan.legend")}
      </button>
    );
  return (
    <section
      className="dc-legend-sheet dc-panel"
      aria-label={t("dc.plan.legend")}
    >
      <header>
        <span>{t("dc.plan.legend")}</span>
        <button
          type="button"
          aria-expanded
          aria-label={t("dc.plan.legendHide")}
          title={t("dc.plan.legendHide")}
          onClick={() => onCollapsed(true)}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </header>
      <ul>
        {marks.overhead && (
          <li data-mark="overhead">
            <svg className="dc-legend-sample" viewBox="0 0 28 10" aria-hidden>
              <line x1="0" y1="5" x2="28" y2="5" />
            </svg>
            <span>{t("dc.plan.overhead")}</span>
          </li>
        )}
        {marks.tapeDot && (
          <li data-mark="tape">
            <span className="dc-legend-sample" aria-hidden>
              <i className="dc-legend-dot" />
            </span>
            <span>
              {t("dc.plan.tapeDiffers", { tol: fmt.mm(TAPE_TOLERANCE_MM) })}
            </span>
          </li>
        )}
        {marks.short.length > 0 && (
          <li data-mark="short">
            <span className="dc-legend-sample" aria-hidden>
              <i className="dc-legend-zone" data-zone="short" />
            </span>
            <span>
              {t("dc.plan.clearance", {
                need: marks.short.map(fmt.mm).join(" / "),
              })}
            </span>
          </li>
        )}
        {marks.split && (
          <li data-mark="split">
            <span className="dc-legend-sample" aria-hidden>
              <i className="dc-legend-zone" data-zone="split" />
            </span>
            <span>{t("dc.plan.clearanceSplit")}</span>
          </li>
        )}
      </ul>
    </section>
  );
}
