/**
 * The measurement status panel (SPEC §3.3): every number the room was built
 * from, with how it was obtained. Ranges read `5540–5550`; assumed values are
 * marked and also flagged in the 3D view; derived values that disagree with a
 * tape reading show both. Then what to re-measure, what the model leaves out,
 * and the catalog properties of this room's equipment that are assumed.
 */

import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useFmt } from "../settings";
import { disagrees, isRange } from "../model/measure";
import {
  localText,
  type CatalogItem,
  type MeasSrc,
  type RoomData,
} from "../types";
import { measureLabel } from "./measureLabel";

const SRC_STYLE: Record<MeasSrc, string> = {
  measured: "",
  range: "",
  derived: "text-muted-foreground",
  assumed: "bg-tag-3/15",
  photo: "bg-tag-3/10",
};

export function MeasurementsPanel({
  data,
  catalog,
  onSelect,
}: {
  data: RoomData;
  catalog: Map<number, CatalogItem>;
  onSelect: (objectId: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const m = data.room.measurements;
  const byName = new Map(data.objects.map((o) => [o.name, o.id]));
  const counts = m.entries.reduce<Record<string, number>>(
    (a, e) => ({ ...a, [e.src]: (a[e.src] ?? 0) + 1 }),
    {},
  );
  const itemsAssumed = [...catalog.values()].flatMap((it) =>
    Object.entries(it.props_src)
      .filter(([, s]) => s.src === "assumed" || s.src === "photo")
      .map(([prop, s]) => ({
        it,
        prop,
        note: s.note && localText(s.note, i18n.language),
      })),
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-1">
        {(
          ["measured", "range", "derived", "assumed", "photo"] as MeasSrc[]
        ).map((s) => (
          <Badge
            key={s}
            variant={s === "assumed" ? "destructive" : "secondary"}
            title={t(`dc.src.${s}Hint`)}
          >
            {t(`dc.src.${s}`)}: {counts[s] ?? 0}
          </Badge>
        ))}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1">{t("dc.measure.what")}</th>
            <th>{t("dc.measure.value")}</th>
            <th>{t("dc.measure.src")}</th>
          </tr>
        </thead>
        <tbody>
          {m.entries.map((e) => (
            <tr
              key={e.key}
              className={cn("border-t align-top", SRC_STYLE[e.src])}
            >
              <td className="py-1 pr-2">
                <div>{measureLabel(e.key, t)}</div>
                {e.objects.length > 0 && (
                  <div className="flex flex-wrap gap-x-1">
                    {e.objects.map((o) => (
                      <button
                        key={o}
                        type="button"
                        className="text-link hover:underline"
                        onClick={() =>
                          byName.has(o) && onSelect(byName.get(o)!)
                        }
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                {e.note && (
                  <div className="text-muted-foreground">{e.note}</div>
                )}
              </td>
              <td className="pr-2 whitespace-nowrap">
                {e.min !== undefined &&
                e.max !== undefined &&
                e.min !== e.max &&
                e.src === "range"
                  ? fmt.range(e.min, e.max)
                  : fmt.mm(e.value)}
                {e.src !== "range" &&
                  e.min !== undefined &&
                  e.max !== undefined && (
                    <div className="text-muted-foreground">
                      {t("dc.measure.read", { v: fmt.range(e.min, e.max) })}
                    </div>
                  )}
                {e.model !== undefined &&
                  (e.model !== e.value || isRange(e)) && (
                    <div
                      className={cn(
                        "text-muted-foreground",
                        disagrees(e) && "text-destructive",
                      )}
                    >
                      {disagrees(e) && (
                        <span className="dc-dot" aria-hidden="true" />
                      )}
                      {t("dc.measure.modelValue", { v: fmt.mm(e.model) })}
                    </div>
                  )}
              </td>
              <td>
                <span
                  className={cn(
                    e.src === "assumed" && "font-medium text-tag-3",
                  )}
                >
                  {t(`dc.src.${e.src}`)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {itemsAssumed.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm">{t("dc.measure.catalogAssumed")}</h3>
          <ul className="space-y-1 text-xs">
            {itemsAssumed.map(({ it, prop, note }) => (
              <li key={`${it.id}-${prop}`}>
                <span className="font-medium">{it.model}</span> ·{" "}
                {t(`dc.prop.${prop}` as never, { defaultValue: prop })}
                {note && <div className="text-muted-foreground">{note}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {m.conflicts.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm">{t("dc.measure.conflicts")}</h3>
          <ul className="list-disc pl-4 text-xs">
            {m.conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-1 text-sm">{t("dc.measure.remeasure")}</h3>
        <ul className="list-disc pl-4 text-xs">
          {m.remeasure.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 text-sm">{t("dc.measure.notModelled")}</h3>
        <ul className="list-disc pl-4 text-xs">
          {m.not_modelled.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted-foreground">
        {t("dc.measure.dataNote")}
      </p>
    </div>
  );
}
