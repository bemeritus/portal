/**
 * The data modes' legend, top left over the view: fill's colours; power's
 * scale — against the room's budget, or (FEEDBACK-7 §1.7) an absolute
 * 0 → 10 kW scale with a link to set the budget; the owners' colours with
 * their devices and units (§4.7).
 */

import { useTranslation } from "react-i18next";

import { POWER_SCALE_W, type Mode } from "../engine/DcEngine";
import { sequentialCss } from "../engine/materials";
import { categorical, themeFromTokens } from "../engine/theme";
import type { Fmt } from "../format";
import { ownerSlots } from "../model/owners";
import type { DcTokens } from "../theme/tokens";
import type { RoomData } from "../types";

export function ModeLegend({
  mode,
  data,
  tokens,
  fmt,
  onSetBudget,
}: {
  mode: Mode;
  data: RoomData;
  tokens: DcTokens;
  fmt: Fmt;
  /** Open the room's settings; absent when the user cannot edit. */
  onSetBudget?: () => void;
}) {
  const { t } = useTranslation();
  const theme = themeFromTokens(tokens);
  if (mode === "fill")
    return <div className="dc-chip dc-panel">{t("dc.legend.fill")}</div>;
  if (mode === "power") {
    const budget = data.room.settings.rack_power_budget_w;
    if (budget !== null)
      return (
        <div className="dc-chip dc-panel">
          {t("dc.legend.power", { w: fmt.w(budget) })}
        </div>
      );
    const stops = [0, 0.25, 0.5, 0.75, 1]
      .map((k) => sequentialCss(theme, k))
      .join(", ");
    return (
      <div
        className="dc-chip dc-panel dc-legend-scale"
        data-testid="power-legend"
      >
        <span>{t("dc.legend.powerScale")}</span>
        <span className="dc-num">0</span>
        <i
          className="dc-scale"
          style={{ background: `linear-gradient(to right, ${stops})` }}
        />
        <span className="dc-num">{fmt.kw(POWER_SCALE_W)}</span>
        <span className="text-[var(--dc-muted)]">
          {t("dc.legend.noBudget")}{" "}
          {onSetBudget ? (
            <button type="button" className="underline" onClick={onSetBudget}>
              {t("dc.legend.setBudget")}
            </button>
          ) : null}
        </span>
      </div>
    );
  }
  if (mode === "owners") {
    const slots = ownerSlots(data.devices, data.cells);
    const named = slots.filter((o) => o.slot !== null);
    const rest = slots.filter((o) => o.slot === null);
    const colours = categorical(theme);
    return (
      <div
        className="dc-chip dc-panel dc-legend-owners"
        data-testid="owners-legend"
      >
        <span>{t("dc.legend.owners")}</span>
        <ul>
          {named.map((o) => (
            <li key={o.name}>
              <i style={{ background: colours[o.slot!] }} />
              <b>{o.name}</b>
              <span className="dc-num">
                {t("dc.legend.ownerRow", {
                  devices: o.devices,
                  units: o.units,
                })}
              </span>
            </li>
          ))}
          {rest.length > 0 && (
            <li>
              <i style={{ background: theme.dark ? "#5b6068" : "#a7abb2" }} />
              <b>{t("dc.legend.ownersOther")}</b>
              <span className="dc-num">
                {t("dc.legend.ownerRow", {
                  devices: rest.reduce((a, o) => a + o.devices, 0),
                  units: rest.reduce((a, o) => a + o.units, 0),
                })}
              </span>
            </li>
          )}
        </ul>
      </div>
    );
  }
  return null;
}
