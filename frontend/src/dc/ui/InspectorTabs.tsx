/**
 * The inspector's tabs as one segmented control on one row (FEEDBACK-2 §1).
 * Each label's width is measured in a hidden copy of the row — so the theme's
 * font, the language and the badge all count — and `fitTabs` decides the
 * padding and what goes into «⋯». It is measured again whenever the row or
 * the labels change size (theme, language, fonts loading, a resize).
 *
 * Keyboard: ←/→ go through every tab, overflowed ones included (the active
 * tab always stands in the row), Home/End to the first/last; selection
 * follows focus.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fitTabs, type TabsFit } from "./tabsFit";

/** Label padding, px a side: the theme's look, and the least it may shrink to. */
const PAD_MAX = 12;
const PAD_MIN = 5;

export function tabId(key: string) {
  return `dc-tab-${key}`;
}
export const TABPANEL_ID = "dc-tabpanel";

export function InspectorTabs<K extends string>({
  tabs,
  active,
  onTab,
  label,
  badge,
}: {
  tabs: readonly K[];
  active: K;
  onTab: (k: K) => void;
  label: (k: K) => string;
  badge?: (k: K) => ReactNode;
}) {
  const { t } = useTranslation();
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const focusActive = useRef(false);
  const chosen = useRef(false);
  const activeIdx = Math.max(0, tabs.indexOf(active));
  const [fit, setFit] = useState<TabsFit>(() => ({
    pad: PAD_MAX,
    visible: tabs.map((_, i) => i),
    overflow: [],
  }));

  const relayout = useCallback(() => {
    const r = row.current;
    const m = measure.current;
    if (!r || !m) return;
    const cs = getComputedStyle(r);
    const avail =
      r.clientWidth -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight) -
      // Sub-pixel text widths: never end up a fraction too wide.
      2;
    const items = [...m.children] as HTMLElement[];
    const widths = items
      .slice(0, tabs.length)
      .map((el) => el.getBoundingClientRect().width);
    const more = items[tabs.length].getBoundingClientRect().width;
    const next = fitTabs({
      widths,
      more,
      avail,
      gap: parseFloat(cs.columnGap) || 0,
      padMax: PAD_MAX,
      padMin: PAD_MIN,
      active: activeIdx,
    });
    setFit((prev) =>
      prev.pad === next.pad &&
      prev.visible.join() === next.visible.join() &&
      prev.overflow.join() === next.overflow.join()
        ? prev
        : next,
    );
  }, [tabs.length, activeIdx]);

  // Before paint, so a wrong first layout is never seen.
  useLayoutEffect(relayout);

  useEffect(() => {
    const ro = new ResizeObserver(() => relayout());
    if (row.current) ro.observe(row.current);
    if (measure.current) ro.observe(measure.current);
    void document.fonts?.ready.then(relayout);
    return () => ro.disconnect();
  }, [relayout]);

  // After a keyboard move the newly active tab takes the focus.
  // A tab coming out of «⋯» is in the row only after the relayout.
  useEffect(() => {
    if (!focusActive.current) return;
    const el = document.getElementById(tabId(active));
    if (!el) return;
    focusActive.current = false;
    el.focus();
  }, [active, fit]);

  const onKeyDown = (e: KeyboardEvent) => {
    const n = tabs.length;
    const to =
      e.key === "ArrowRight"
        ? (activeIdx + 1) % n
        : e.key === "ArrowLeft"
          ? (activeIdx - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    focusActive.current = true;
    onTab(tabs[to]);
  };

  return (
    <div className="dc-tabs-bar">
      <div
        ref={row}
        className="dc-tabs-row"
        style={{ "--dc-tab-pad": `${fit.pad}px` } as CSSProperties}
      >
        <div
          className="dc-tabs"
          role="tablist"
          aria-label={t("dc.inspector.tabs")}
          onKeyDown={onKeyDown}
        >
          {fit.visible.map((i) => {
            const k = tabs[i];
            return (
              <button
                key={k}
                id={tabId(k)}
                type="button"
                role="tab"
                className="dc-tab"
                aria-selected={k === active}
                aria-controls={TABPANEL_ID}
                tabIndex={k === active ? 0 : -1}
                onClick={() => onTab(k)}
              >
                {label(k)}
                {badge?.(k)}
              </button>
            );
          })}
        </div>
        {fit.overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="dc-tab dc-tab-more"
                aria-label={t("dc.inspector.moreTabs")}
                title={t("dc.inspector.moreTabs")}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                // A tab was picked: the focus goes to it, not back to «⋯».
                if (chosen.current) e.preventDefault();
                chosen.current = false;
              }}
            >
              {fit.overflow.map((i) => (
                <DropdownMenuItem
                  key={tabs[i]}
                  onSelect={() => {
                    chosen.current = true;
                    focusActive.current = true;
                    onTab(tabs[i]);
                  }}
                >
                  {label(tabs[i])}
                  {badge?.(tabs[i])}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Every label at no padding, and «⋯»: what `fitTabs` measures. */}
        <div ref={measure} className="dc-tabs dc-tabs-measure" aria-hidden>
          {tabs.map((k) => (
            <span key={k} className="dc-tab">
              {label(k)}
              {badge?.(k)}
            </span>
          ))}
          <span className="dc-tab dc-tab-more">
            <MoreHorizontal className="size-4" />
          </span>
        </div>
      </div>
    </div>
  );
}
