/**
 * `/dc/catalog/compare?ids=1,2,3` — two or three catalog items side by
 * side (FEEDBACK-4 §3.1): pictures, then every specification row, with the
 * rows where they differ highlighted. A page, so a comparison can be linked.
 */

import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { differing, sectionOf, shortModel } from "../model/catalog";
import { useFmt } from "../settings";
import type { CatalogItem } from "../types";
import { specGroups, Tags, Thumb, useCatalog } from "./catalogParts";

export function DcCatalogComparePage() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [search] = useSearchParams();
  const { items } = useCatalog();
  const ids = (search.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const picked = ids
    .map((id) => items.data?.find((i) => i.id === id))
    .filter((i): i is CatalogItem => !!i)
    .slice(0, 3);

  useEffect(() => {
    document.title = t("docTitle", {
      page: t("dc.catalog.compareTitle"),
      app: t("app.name"),
    });
  }, [t]);

  if (items.isPending) return <Spinner />;
  if (items.error) return <ErrorFlash error={errorMessage(items.error)} />;
  const section = picked[0] ? sectionOf(picked[0].kind) : "cooling";
  const back = `/dc/catalog/${section}?cmp=${picked.map((i) => i.id).join(",")}`;
  if (picked.length < 2)
    return (
      <div className="dc-cat-item-page">
        <p className="dc-muted">{t("dc.catalog.compareNeedTwo")}</p>
        <Link to={back}>{t("dc.catalog.title")}</Link>
      </div>
    );

  // Rows by label across the items, in the order the first item lists them.
  const groups = picked.map((i) => specGroups(i, fmt, t));
  const labels: { group: string; label: string }[] = [];
  for (const gs of groups)
    for (const g of gs)
      for (const r of g.rows)
        if (!labels.some((l) => l.label === r.label))
          labels.push({ group: g.title, label: r.label });
  const cell = (n: number, label: string) => {
    const r = groups[n].flatMap((g) => g.rows).find((x) => x.label === label);
    return r ? (r.value ?? t("dc.catalog.noData")) : "—";
  };
  const values = labels.map((l) => picked.map((_, n) => cell(n, l.label)));
  const diff = differing(values);

  return (
    <div className="dc-cat-item-page">
      <nav className="dc-crumbs">
        <Link to={back}>{t("dc.catalog.title")}</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{t("dc.catalog.compareTitle")}</span>
      </nav>
      <h1>{t("dc.catalog.compareTitle")}</h1>
      <p className="dc-muted">{t("dc.catalog.compareDiffers")}</p>
      <div className="dc-cat-tablewrap">
        <table className="dc-compare" data-testid="compare-table">
          <thead>
            <tr>
              <th />
              {picked.map((i) => (
                <th key={i.id} scope="col">
                  <Thumb item={i} />
                  <Link to={`/dc/catalog/item/${i.id}`}>
                    {shortModel(i.model)}
                  </Link>
                  <small className="dc-muted">{i.manufacturer}</small>
                  <Tags item={i} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, k) => (
              <tr key={l.label} data-differs={diff[k] || undefined}>
                <th scope="row">
                  <small className="dc-muted">{l.group}</small>
                  {l.label}
                </th>
                {values[k].map((v, n) => (
                  <td key={n} className="dc-num">
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
