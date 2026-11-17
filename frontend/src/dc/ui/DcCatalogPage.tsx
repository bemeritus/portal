/**
 * `/dc/catalog` — the equipment catalog as pictures, not a list of names
 * (SPEC §11.3). Read-only in phase 1: placing items in a room and editing the
 * catalog are phase 2.
 */

import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Spinner } from "../../components/Loading";
import { tDyn } from "../../i18n";
import { dcApi } from "../api";
import { ItemPreview, thumbnail } from "../engine/preview";
import type { Fmt } from "../format";
import { useDcSettings, useFmt } from "../settings";
import { TOKENS } from "../theme/tokens";
import type { CatalogItem, Kind } from "../types";

/** Sections of the catalog (and of the phase 2 palette). */
const SECTIONS: { key: string; kinds: (Kind | "ups" | "pdu" | "panel" | "raised_floor")[] }[] = [
  { key: "racks", kinds: ["rack", "shelf"] },
  { key: "cooling", kinds: ["cooling"] },
  { key: "power", kinds: ["ups", "pdu", "panel"] },
  { key: "floor", kinds: ["raised_floor"] },
  { key: "trays", kinds: ["cable_tray"] },
  { key: "structures", kinds: ["structure"] },
];

type Sort = "capacity" | "size" | "brand";

/** Sensible capacity when published, otherwise null (the card says so). */
const sensible = (i: CatalogItem) => (i.kind === "cooling" ? i.props.cooling_sensible_w : null);
const capacity = (i: CatalogItem) => (i.kind === "cooling" ? (i.props.cooling_sensible_w ?? i.props.cooling_total_w ?? 0) : 0);
const airflow = (i: CatalogItem) => (i.kind === "cooling" ? Math.max(0, ...i.props.airflow_m3h) : 0);

function Thumb({ item }: { item: CatalogItem }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // Let the page paint first; draw one thumbnail per idle moment.
    const id = window.setTimeout(() => setSrc(thumbnail(item)), 0);
    return () => window.clearTimeout(id);
  }, [item]);
  return <div className="flex h-36 items-center justify-center rounded bg-muted/40">{src ? <img src={src} alt="" className="h-36 object-contain" /> : <Spinner />}</div>;
}

export function Badges({ item }: { item: CatalogItem }) {
  const { t } = useTranslation();
  if (item.kind !== "cooling") return null;
  const p = item.props;
  const precision = p.subtype === "in_row" || p.subtype === "precision_perimeter";
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={precision ? "success" : "secondary"}>{precision ? t("dc.catalog.precision") : t("dc.catalog.comfort")}</Badge>
      {p.designed_24_7 && <Badge variant="secondary">24/7</Badge>}
      {p.inverter && <Badge variant="secondary">{t("dc.catalog.inverter")}</Badge>}
      {p.model_known && p.cooling_sensible_w === null && <Badge variant="destructive">{t("dc.catalog.noSensible")}</Badge>}
      {!p.model_known && <Badge variant="destructive">{t("dc.catalog.modelUnknown")}</Badge>}
    </div>
  );
}

function keyNumbers(item: CatalogItem, fmt: Fmt, t: TFunction): string[] {
  const dims = `${fmt.n(item.width_mm)} × ${fmt.n(item.depth_mm)} × ${fmt.mm(item.height_mm)}`;
  switch (item.kind) {
    case "cooling": {
      const s = sensible(item);
      const total = item.props.cooling_total_w;
      let cap: string = t("dc.catalog.capacityUnknown");
      if (s !== null) cap = t("dc.catalog.sensibleKw", { v: fmt.kw(s) });
      else if (total !== null) cap = t("dc.catalog.totalKw", { v: fmt.kw(total) });
      const air: string = airflow(item) ? fmt.m3h(airflow(item)) : t("dc.catalog.airflowUnknown");
      return [cap, air, dims];
    }
    case "rack":
      return [t("dc.catalog.units", { n: item.props.units }), dims];
    case "shelf":
      return [t("dc.catalog.cells", { n: item.props.boards_mm.length * item.props.cells_per_board }), dims];
    default:
      return [dims];
  }
}

export function DcCatalogPage() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const q = useQuery({ queryKey: ["dc", "catalog"], queryFn: ({ signal }) => dcApi.catalog(undefined, signal) });
  const [section, setSection] = useState("cooling");
  const [subtype, setSubtype] = useState("");
  const [brand, setBrand] = useState("");
  const [minKw, setMinKw] = useState("");
  const [maxKw, setMaxKw] = useState("");
  const [maxWidth, setMaxWidth] = useState("");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>("capacity");
  const [detail, setDetail] = useState<CatalogItem | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    document.title = t("docTitle", { page: t("dc.catalog.title"), app: t("app.name") });
  }, [t]);

  const items = q.data ?? [];
  const kinds = SECTIONS.find((s) => s.key === section)!.kinds as string[];
  const inSection = items.filter((i) => kinds.includes(i.kind));
  const brands = [...new Set(inSection.map((i) => i.manufacturer).filter(Boolean))].sort();
  const subtypes = [...new Set(inSection.flatMap((i) => (i.kind === "cooling" ? [i.props.subtype] : i.kind === "structure" ? [i.props.subtype] : [])))];
  const shown = inSection
    .filter((i) => !subtype || (i.kind === "cooling" && i.props.subtype === subtype) || (i.kind === "structure" && i.props.subtype === subtype))
    .filter((i) => !brand || i.manufacturer === brand)
    .filter((i) => !minKw || capacity(i) >= Number(minKw) * 1000)
    .filter((i) => !maxKw || capacity(i) <= Number(maxKw) * 1000)
    .filter((i) => !maxWidth || i.width_mm <= Number(maxWidth))
    .filter((i) => !text.trim() || `${i.manufacturer} ${i.model}`.toLowerCase().includes(text.trim().toLowerCase()))
    .sort((a, b) =>
      sort === "capacity" ? capacity(b) - capacity(a) : sort === "size" ? a.width_mm * a.depth_mm - b.width_mm * b.depth_mm : `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`),
    );

  return (
    <>
      <p className="mb-2">
        <Link to="/dc" className="text-sm text-link hover:underline">
          ← {t("dc.rooms")}
        </Link>
      </p>
      <h1>{t("dc.catalog.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("dc.catalog.intro")}</p>
      <div className="my-3 flex flex-wrap gap-1" role="tablist">
        {SECTIONS.map((s) => {
          const n = items.filter((i) => (s.kinds as string[]).includes(i.kind)).length;
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={section === s.key}
              className={cn("rounded-md border px-3 py-1 text-sm", section === s.key ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              onClick={() => {
                setSection(s.key);
                setSubtype("");
                setBrand("");
              }}
            >
              {tDyn(t, `dc.section.${s.key}`)} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        <Input className="h-8 w-52" placeholder={t("dc.catalog.search")} aria-label={t("dc.catalog.search")} value={text} onChange={(e) => setText(e.target.value)} />
        {subtypes.length > 1 && (
          <select className="h-8 rounded-md border bg-background px-2" aria-label={t("dc.catalog.subtype")} value={subtype} onChange={(e) => setSubtype(e.target.value)}>
            <option value="">{t("dc.catalog.allSubtypes")}</option>
            {subtypes.map((s) => (
              <option key={s} value={s}>
                {tDyn(t, `dc.subtype.${s}`)}
              </option>
            ))}
          </select>
        )}
        {brands.length > 1 && (
          <select className="h-8 rounded-md border bg-background px-2" aria-label={t("dc.catalog.brand")} value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">{t("dc.catalog.allBrands")}</option>
            {brands.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        )}
        {section === "cooling" && (
          <label className="flex items-center gap-1">
            {t("dc.catalog.kwRange")}
            <Input className="h-8 w-16" type="number" min={0} value={minKw} onChange={(e) => setMinKw(e.target.value)} aria-label={t("dc.catalog.kwMin")} />–
            <Input className="h-8 w-16" type="number" min={0} value={maxKw} onChange={(e) => setMaxKw(e.target.value)} aria-label={t("dc.catalog.kwMax")} />
          </label>
        )}
        <label className="flex items-center gap-1">
          {t("dc.catalog.maxWidth")}
          <Input className="h-8 w-20" type="number" min={0} value={maxWidth} onChange={(e) => setMaxWidth(e.target.value)} />
        </label>
        <select className="h-8 rounded-md border bg-background px-2" aria-label={t("dc.catalog.sort")} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="capacity">{t("dc.catalog.sortCapacity")}</option>
          <option value="size">{t("dc.catalog.sortSize")}</option>
          <option value="brand">{t("dc.catalog.sortBrand")}</option>
        </select>
        {compare.length > 0 && (
          <Button size="sm" onClick={() => setComparing(true)}>
            {t("dc.catalog.compare", { n: compare.length })}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <ErrorFlash error={errorMessage(q.error)} />
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground">{inSection.length === 0 ? t("dc.catalog.emptySection") : t("dc.catalog.noMatch")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((item) => (
            <div key={item.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <button type="button" className="text-left" onClick={() => setDetail(item)} aria-label={t("dc.catalog.open", { model: item.model })}>
                <Thumb item={item} />
                <div className="mt-2 text-xs text-muted-foreground">{item.manufacturer || t("dc.catalog.noBrand")}</div>
                <div className="font-medium">{item.model}</div>
              </button>
              <ul className="text-sm">
                {keyNumbers(item, fmt, t).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <Badges item={item} />
              <label className="mt-auto flex items-center gap-2 text-xs">
                <Checkbox
                  checked={compare.includes(item.id)}
                  disabled={!compare.includes(item.id) && compare.length >= 3}
                  onCheckedChange={(v) => setCompare((c) => (v === true ? [...c, item.id] : c.filter((x) => x !== item.id)))}
                />
                {t("dc.catalog.toCompare")}
              </label>
            </div>
          ))}
        </div>
      )}
      {detail && <DetailDialog item={detail} onClose={() => setDetail(null)} />}
      {comparing && <CompareDialog items={items.filter((i) => compare.includes(i.id))} onClose={() => setComparing(false)} />}
    </>
  );
}

function Preview({ items }: { items: CatalogItem[] }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const theme = useDcSettings().theme;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const p = new ItemPreview(host.current, items, {
      mm: fmt.mm,
      supply: t("dc.catalog.supply"),
      ret: t("dc.catalog.return"),
      rack: t("dc.catalog.refRack"),
      person: t("dc.catalog.refPerson"),
    }, TOKENS[theme]);
    return () => p.dispose();
  }, [items, t, fmt, theme]);
  return <div ref={host} className="dc-host relative h-[380px] overflow-hidden rounded-md border" aria-label={t("dc.catalog.previewLabel")} />;
}

/** Every property with its value, unit and where it came from. */
function specRows(item: CatalogItem, fmt: Fmt, t: TFunction): [string, string, string][] {
  const src = (k: string) => {
    const s = item.props_src[k] ?? item.props_src.dims;
    return s ? tDyn(t, `dc.src.${s.src}`) : "";
  };
  const rows: [string, string, string][] = [[t("dc.dims.wdh"), `${fmt.n(item.width_mm)} × ${fmt.n(item.depth_mm)} × ${fmt.mm(item.height_mm)}`, src("dims")]];
  const show = (v: unknown, k: string): string => {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return t("dc.catalog.notPublished");
    if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
    if (k.endsWith("_w")) return fmt.w(v as number);
    if (k === "cooling_range_w") return `${fmt.w((v as number[])[0])} – ${fmt.w((v as number[])[1])}`;
    if (k === "airflow_m3h") return (v as number[]).map((x) => fmt.m3h(x)).join(" / ");
    if (k.endsWith("_mm")) return fmt.mm(v as number);
    if (k === "boards_mm") return (v as number[]).map((x) => fmt.mm(x)).join(", ");
    if (k === "weight_kg") return fmt.kg(v as number);
    if (k === "esp_pa") {
      const e = v as { rated: number; min: number | null; max: number | null };
      return `${e.rated} Pa (${e.min ?? "?"}–${e.max ?? "?"})`;
    }
    if (k === "subtype") return tDyn(t, `dc.subtype.${String(v)}`);
    if (k === "discharge_options") return (v as string[]).map((x) => tDyn(t, `dc.discharge.${x}`)).join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  for (const [k, v] of Object.entries(item.props)) {
    if (k === "openings" || k === "derating" || k === "source_url" || k === "model_known") continue;
    rows.push([tDyn(t, `dc.prop.${k}`, { defaultValue: k }), show(v, k), src(k)]);
  }
  return rows;
}

function DetailDialog({ item, onClose }: { item: CatalogItem; onClose: () => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const urls = [...new Set(Object.values(item.props_src).map((s) => s.url).filter(Boolean) as string[])];
  const items = useMemo(() => [item], [item]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {item.manufacturer} {item.model}
          </DialogTitle>
        </DialogHeader>
        <Badges item={item} />
        <Preview items={items} />
        <p className="text-xs text-muted-foreground">{t("dc.catalog.previewNote")}</p>
        <table className="w-full text-sm">
          <tbody>
            {specRows(item, fmt, t).map(([k, v, s]) => (
              <tr key={k} className="border-t">
                <td className="py-1 pr-3 text-muted-foreground">{k}</td>
                <td className="pr-3">{v}</td>
                <td className="text-xs text-muted-foreground">{s}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {Object.entries(item.props_src)
          .filter(([, s]) => s.note)
          .map(([k, s]) => (
            <p key={k} className="text-xs text-muted-foreground">
              {tDyn(t, `dc.prop.${k}`, { defaultValue: k })}: {s.note}
            </p>
          ))}
        {urls.length > 0 && (
          <div className="text-sm">
            {t("dc.catalog.sources")}:{" "}
            {urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="mr-2 break-all text-link underline">
                {new URL(u).hostname}
              </a>
            ))}
          </div>
        )}
        {item.kind === "cooling" && <p className="text-xs text-muted-foreground">{t("dc.catalog.advisory")}</p>}
        <div>
          <Button disabled title={t("dc.catalog.placeLater")}>
            {t("dc.catalog.place")}
          </Button>
          <span className="ml-2 text-xs text-muted-foreground">{t("dc.catalog.placeLater")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareDialog({ items, onClose }: { items: CatalogItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const rows = items.map((i) => specRows(i, fmt, t));
  const keys = [...new Set(rows.flatMap((r) => r.map((x) => x[0])))];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{t("dc.catalog.compareTitle")}</DialogTitle>
        </DialogHeader>
        <Preview items={items} />
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th />
              {items.map((i) => (
                <th key={i.id} className="text-left">
                  {i.manufacturer} {i.model}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t">
                <td className="py-1 pr-3 text-muted-foreground">{k}</td>
                {rows.map((r, n) => (
                  <td key={n} className="pr-3">
                    {r.find((x) => x[0] === k)?.[1] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
