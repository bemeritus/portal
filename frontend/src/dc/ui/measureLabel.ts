import type { TFunction } from "i18next";
import i18n from "i18next";

import { tDyn } from "../../i18n";

/**
 * A measurement or catalog property key in words. Rack and unit numbers fold
 * into one key with `{{n}}` (`racks.back.r2` → `racks_back_n`, n = 2); gaps
 * name both ends. A key with no translation is shown as it is.
 */
export function measureLabel(key: string, t: TFunction): string {
  const gapM = key.match(/^racks\.gap\.(.+)-(.+)$/);
  if (gapM) {
    const end = (x: string) =>
      x === "left_wall"
        ? t("dc.measureKey.leftWall")
        : x === "right_wall"
          ? t("dc.measureKey.rightWall")
          : t("dc.measureKey.rack", { n: x.replace(/\D/g, "") });
    return t("dc.measureKey.gap", { a: end(gapM[1]), b: end(gapM[2]) });
  }
  let n = "";
  const generic = key.replace(
    /\b(?:r|ac)(\d+)\b|board_(\d+)/g,
    (_m, a?: string, b?: string) => {
      n = a ?? b ?? "";
      return b ? "board_n" : "n";
    },
  );
  const tk = `dc.measureKey.${generic.replace(/\./g, "_")}`;
  return i18n.exists(tk) ? tDyn(t, tk, { n }) : key;
}
