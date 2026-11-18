/**
 * `/dc/catalog/:section` — the equipment catalog as pictures, not a list of
 * names (SPEC §11.3, FEEDBACK-4 §3.1; mockup `design/CatalogList.png`).
 * Read-only in phase 1: placing items in a room and editing the catalog are
 * phase 2.
 *
 * A sidebar of sections and filters, a header that says what the list is,
 * cards or a sortable table, and a comparison tray. Every filter, the sort,
 * the view and the picked items live in the URL, so a filtered list can be
 * shared.
 */

import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Slider } from "radix-ui";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Columns2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { tDyn } from "../../i18n";
import type { Fmt } from "../format";
import {
  airflow,
  applyFilters,
  bounds,
  capacity,
  counts,
  dimsNumbers,
  execution,
  filtering,
  filtersToParams,
  fromRoom,
  mass,
  parseFilters,
  resetFilters,
  SECTIONS,
  shortModel,
  sortItems,
  usageCount,
  type Filters,
  type SortKey,
} from "../model/catalog";
import { useFmt } from "../settings";
import type { CatalogItem } from "../types";
import { executionLabel, Tags, Thumb, useCatalog } from "./catalogParts";

const SORT_KEYS: SortKey[] = [
  "cold",
  "air",
  "size",
  "mass",
  "name",
  "brand",
  "exec",
  "h247",
  "used",
];

type SetFilters = (next: Filters | ((f: Filters) => Filters)) => void;

/**
 * The filters in the URL, and a setter that writes them back. A function
 * gets the filters of the address bar as it is now — not of the last
 * render, as React Router's own functional form does — so quick changes
 * (two compare toggles before a re-render) do not overwrite each other.
 */
function useFilters(): [Filters, SetFilters] {
  const [search, setSearch] = useSearchParams();
  const f = useMemo(() => parseFilters(search), [search]);
  return [
    f,
    (next) => {
      const now = parseFilters(new URLSearchParams(window.location.search));
      setSearch(
        filtersToParams(typeof next === "function" ? next(now) : next),
        {
          replace: true,
        },
      );
    },
  ];
}

export function DcCatalogPage() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { section = "cooling" } = useParams();
  const navigate = useNavigate();
  const { items: q, usage } = useCatalog();
  const [f, setF] = useFilters();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = t("docTitle", {
      page: tDyn(t, `dc.section.${section}`),
      app: t("app.name"),
    });
  }, [t, section]);

  const sec = SECTIONS.find((s) => s.key === section) ?? SECTIONS[1];
  const all = q.data ?? [];
  const inSection = all.filter((i) => sec.kinds.includes(i.kind));
  const used = useMemo(() => usageCount(usage.data ?? []), [usage.data]);
  const label = (i: CatalogItem) => executionLabel(i, t);
  const shown = sortItems(
    applyFilters(inSection, f),
    f.sort,
    f.dir,
    used,
    label,
  );
  const datasheets = inSection.filter((i) => !fromRoom(i)).length;
  const room = inSection.length - datasheets;
  const picked = f.compare
    .map((id) => all.find((i) => i.id === id))
    .filter((i): i is CatalogItem => !!i);
  const toggleCompare = (id: number) =>
    setF((cur) => ({
      ...cur,
      compare: cur.compare.includes(id)
        ? cur.compare.filter((x) => x !== id)
        : [...cur.compare, id].slice(-3),
    }));

  const sidebar = (
    <Sidebar
      section={sec.key}
      all={all}
      inSection={inSection}
      f={f}
      setF={setF}
      fmt={fmt}
      t={t}
    />
  );

  return (
    <div className="dc-cat">
      <aside className="dc-cat-side" aria-label={t("dc.catalog.filters")}>
        {sidebar}
      </aside>
      <section className="dc-cat-main">
        <header className="dc-cat-head">
          <div className="dc-cat-titlerow">
            <h1>{tDyn(t, `dc.section.${sec.key}`)}</h1>
            <span className="dc-pill">{t("dc.catalog.readOnly")}</span>
          </div>
          <p className="dc-cat-summary">
            {sec.designer
              ? t("dc.catalog.designerSection")
              : [
                  datasheets > 0 &&
                    t("dc.catalog.summaryDatasheet", { count: datasheets }),
                  room > 0 &&
                    t(
                      datasheets > 0
                        ? "dc.catalog.summaryRoom"
                        : "dc.catalog.summaryRoomOnly",
                      {
                        count: room,
                      },
                    ),
                ]
                  .filter(Boolean)
                  .join(" ")}
          </p>
          <div className="dc-cat-tools">
            <label className="dc-cat-search">
              <Search className="size-4" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={f.q}
                placeholder={t("dc.catalog.search")}
                aria-label={t("dc.catalog.search")}
                onChange={(e) => setF((c) => ({ ...c, q: e.target.value }))}
              />
            </label>
            <span className="dc-cat-count" data-testid="catalog-count">
              {t("dc.catalog.shown", {
                n: shown.length,
                total: inSection.length,
              })}
            </span>
            <span className="flex-1" />
            <Sheet>
              <SheetTrigger asChild>
                <button type="button" className="dc-btn dc-cat-filters-btn">
                  <SlidersHorizontal className="size-4" />
                  {t("dc.catalog.filters")}
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="dc-cat-sheet">
                <SheetHeader>
                  <SheetTitle>{t("dc.catalog.filters")}</SheetTitle>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>
            <SortButton f={f} setF={setF} t={t} />
            <div
              className="dc-seg"
              role="group"
              aria-label={t("dc.catalog.views")}
            >
              {(["cards", "table"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={f.view === v}
                  onClick={() => setF((c) => ({ ...c, view: v }))}
                >
                  {v === "cards"
                    ? t("dc.catalog.viewCards")
                    : t("dc.catalog.viewTable")}
                </button>
              ))}
            </div>
          </div>
        </header>

        {q.isPending ? (
          <div className="dc-cat-grid" aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="dc-cat-card dc-skel-card" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorFlash error={errorMessage(q.error)} />
        ) : sec.designer || inSection.length === 0 ? (
          <p className="dc-muted">
            {sec.designer
              ? t("dc.catalog.designerSection")
              : t("dc.catalog.emptySection")}
          </p>
        ) : shown.length === 0 ? (
          <p className="dc-muted">{t("dc.catalog.noMatch")}</p>
        ) : f.view === "table" ? (
          <CatalogTable
            items={shown}
            f={f}
            setF={setF}
            used={used}
            fmt={fmt}
            t={t}
          />
        ) : (
          <div className="dc-cat-grid">
            {shown.map((item) => (
              <Card
                key={item.id}
                item={item}
                used={used.get(item.id) ?? 0}
                picked={f.compare.includes(item.id)}
                onPick={() => toggleCompare(item.id)}
                fmt={fmt}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {picked.length > 0 && (
        <div
          className="dc-tray"
          role="region"
          aria-label={t("dc.catalog.compareTray")}
        >
          <span className="dc-tray-title">{t("dc.catalog.compareTray")}</span>
          {picked.map((i) => (
            <span key={i.id} className="dc-tray-chip">
              {shortModel(i.model)}
              <button
                type="button"
                aria-label={t("dc.catalog.compareRemove", {
                  model: shortModel(i.model),
                })}
                onClick={() => toggleCompare(i.id)}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          {picked.length < 3 && (
            <button
              type="button"
              className="dc-tray-more"
              onClick={() => searchRef.current?.focus()}
            >
              {t("dc.catalog.compareMore")}
            </button>
          )}
          <button
            type="button"
            className="dc-btn dc-btn-primary"
            disabled={picked.length < 2}
            title={
              picked.length < 2 ? t("dc.catalog.compareNeedTwo") : undefined
            }
            onClick={() =>
              navigate(
                `/dc/catalog/compare?ids=${picked.map((i) => i.id).join(",")}`,
              )
            }
          >
            {t("dc.catalog.compareGo")}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Sidebar: sections and filters --------------------------------------------------------

function Sidebar({
  section,
  all,
  inSection,
  f,
  setF,
  fmt,
  t,
}: {
  section: string;
  all: CatalogItem[];
  inSection: CatalogItem[];
  f: Filters;
  setF: SetFilters;
  fmt: Fmt;
  t: TFunction;
}) {
  const cooling = section === "cooling";
  const execs = counts(inSection, execution);
  const brands = counts(inSection, (i) => i.manufacturer);
  const kwBounds = bounds(inSection, (i) => capacity(i)?.w ?? null);
  const wBounds = bounds(inSection, (i) => i.width_mm);
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const execName = (e: string) =>
    tDyn(
      t,
      cooling || section === "structures" ? `dc.subtype.${e}` : `dc.kind.${e}`,
    );

  return (
    <div className="dc-cat-sidebar">
      <nav aria-label={t("dc.catalog.sections")} className="dc-cat-sections">
        {SECTIONS.map((s) => {
          const n = all.filter((i) => s.kinds.includes(i.kind)).length;
          return s.designer ? (
            <span key={s.key} className="dc-cat-section" data-muted>
              {tDyn(t, `dc.section.${s.key}`)}
              <small>{t("dc.catalog.designer")}</small>
            </span>
          ) : (
            <Link
              key={s.key}
              to={`/dc/catalog/${s.key}${f.view === "table" ? "?view=table" : ""}`}
              className="dc-cat-section"
              aria-current={s.key === section ? "page" : undefined}
            >
              {tDyn(t, `dc.section.${s.key}`)}
              <small className="dc-num">{n}</small>
            </Link>
          );
        })}
      </nav>

      {cooling && (
        <FilterGroup title={t("dc.catalog.purpose")}>
          <div
            className="dc-seg dc-seg-fill"
            role="radiogroup"
            aria-label={t("dc.catalog.purpose")}
          >
            {(["all", "precision", "comfort"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={f.purpose === p}
                onClick={() => setF((c) => ({ ...c, purpose: p }))}
              >
                {p === "all"
                  ? t("dc.catalog.purposeAll")
                  : p === "precision"
                    ? t("dc.catalog.purposePrecision")
                    : t("dc.catalog.purposeComfort")}
              </button>
            ))}
          </div>
        </FilterGroup>
      )}

      {execs.length > 1 && (
        <FilterGroup title={t("dc.catalog.execution")}>
          {execs.map(([e, n]) => (
            <CheckRow
              key={e}
              id={`exec-${e}`}
              label={execName(e)}
              count={n}
              checked={!f.execOff.includes(e)}
              onChange={() =>
                setF((c) => ({ ...c, execOff: toggle(c.execOff, e) }))
              }
            />
          ))}
        </FilterGroup>
      )}

      {brands.length > 1 && (
        <FilterGroup title={t("dc.catalog.manufacturer")}>
          {brands.map(([b, n]) => (
            <CheckRow
              key={b || "-"}
              id={`brand-${b || "none"}`}
              label={b || t("dc.catalog.noBrand")}
              count={n}
              checked={!f.brandOff.includes(b)}
              onChange={() =>
                setF((c) => ({ ...c, brandOff: toggle(c.brandOff, b) }))
              }
            />
          ))}
        </FilterGroup>
      )}

      {cooling && kwBounds && (
        <RangeFilter
          id="kw"
          title={t("dc.catalog.cold")}
          bounds={[
            Math.floor(kwBounds[0] / 1000) * 1000,
            Math.ceil(kwBounds[1] / 1000) * 1000,
          ]}
          step={500}
          value={f.kw}
          onChange={(kw) => setF((c) => ({ ...c, kw }))}
          text={(v) => fmt.kw(v)}
          range={(a, b) =>
            t("dc.unit.kw", {
              v: `${fmt.n(a / 1000, 1)}–${fmt.n(b / 1000, 1)}`,
            })
          }
          t={t}
        />
      )}
      {wBounds && wBounds[0] !== wBounds[1] && (
        <RangeFilter
          id="width"
          title={t("dc.catalog.width")}
          bounds={[
            Math.floor(wBounds[0] / 100) * 100,
            Math.ceil(wBounds[1] / 100) * 100,
          ]}
          step={10}
          value={f.width}
          onChange={(width) => setF((c) => ({ ...c, width }))}
          text={(v) => fmt.mm(v)}
          range={(a, b) => fmt.range(a, b)}
          t={t}
        />
      )}

      {cooling && (
        <div className="dc-cat-switches">
          <SwitchRow
            id="only247"
            label={t("dc.catalog.only247")}
            checked={f.only247}
            onChange={(v) => setF((c) => ({ ...c, only247: v }))}
          />
          <SwitchRow
            id="sensible"
            label={t("dc.catalog.sensiblePublished")}
            checked={f.sensibleOnly}
            onChange={(v) => setF((c) => ({ ...c, sensibleOnly: v }))}
          />
        </div>
      )}

      <button
        type="button"
        className="dc-link-btn"
        disabled={!filtering(f)}
        onClick={() => setF(resetFilters)}
      >
        {t("dc.catalog.reset")}
      </button>
    </div>
  );
}

function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="dc-cat-group">
      <legend className="dc-section-title">{title}</legend>
      {children}
    </fieldset>
  );
}

function CheckRow({
  id,
  label,
  count,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="dc-cat-check">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id}>{label}</label>
      <small className="dc-num">{count}</small>
    </div>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="dc-cat-switch">
      <label htmlFor={id}>{label}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * A two-handle range slider over `bounds`; an end at its bound is open
 * (`null`), so the filter does not drop items whose value is unknown until
 * it is narrowed. The URL is written when a handle is let go.
 */
function RangeFilter({
  id,
  title,
  bounds: [lo, hi],
  step,
  value,
  onChange,
  text,
  range,
  t,
}: {
  id: string;
  title: string;
  bounds: [number, number];
  step: number;
  value: [number | null, number | null];
  onChange: (v: [number | null, number | null]) => void;
  text: (v: number) => string;
  range: (a: number, b: number) => string;
  t: TFunction;
}) {
  const [live, setLive] = useState<[number, number]>([
    value[0] ?? lo,
    value[1] ?? hi,
  ]);
  useEffect(() => setLive([value[0] ?? lo, value[1] ?? hi]), [value, lo, hi]);
  const [a, b] = live;
  const shown =
    a <= lo && b >= hi
      ? t("dc.catalog.rangeAll")
      : a <= lo
        ? t("dc.catalog.upTo", { v: text(b) })
        : b >= hi
          ? t("dc.catalog.from", { v: text(a) })
          : range(a, b);
  return (
    <fieldset className="dc-cat-group">
      <legend className="dc-section-title dc-cat-range-head">
        <span>{title}</span>
        <span className="dc-num" data-testid={`range-${id}`}>
          {shown}
        </span>
      </legend>
      <Slider.Root
        className="dc-slider"
        min={lo}
        max={hi}
        step={step}
        minStepsBetweenThumbs={1}
        value={live}
        onValueChange={(v) => setLive([v[0], v[1]])}
        onValueCommit={(v) =>
          onChange([v[0] <= lo ? null : v[0], v[1] >= hi ? null : v[1]])
        }
      >
        <Slider.Track className="dc-slider-track">
          <Slider.Range className="dc-slider-range" />
        </Slider.Track>
        <Slider.Thumb
          className="dc-slider-thumb"
          aria-label={`${title}: min`}
        />
        <Slider.Thumb
          className="dc-slider-thumb"
          aria-label={`${title}: max`}
        />
      </Slider.Root>
    </fieldset>
  );
}

function SortButton({
  f,
  setF,
  t,
}: {
  f: Filters;
  setF: SetFilters;
  t: TFunction;
}) {
  const order = t("dc.catalog.sortOrder", {
    key: tDyn(t, `dc.catalog.sortBy.${f.sort}`),
    dir: f.dir === "asc" ? t("dc.catalog.dirAsc") : t("dc.catalog.dirDesc"),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="dc-btn dc-cat-sort"
          data-testid="catalog-sort"
        >
          <span className="dc-muted">{t("dc.catalog.sortLabel")}</span> {order}
          <ChevronDown className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={f.sort}
          onValueChange={(v) => setF((c) => ({ ...c, sort: v as SortKey }))}
        >
          {SORT_KEYS.map((k) => (
            <DropdownMenuRadioItem key={k} value={k}>
              {tDyn(t, `dc.catalog.sortBy.${k}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={f.dir}
          onValueChange={(v) =>
            setF((c) => ({ ...c, dir: v as "asc" | "desc" }))
          }
        >
          <DropdownMenuRadioItem value="desc">
            {t("dc.catalog.dirDesc")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="asc">
            {t("dc.catalog.dirAsc")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Cards and the table ---------------------------------------------------------------------

function Card({
  item,
  used,
  picked,
  onPick,
  fmt,
  t,
}: {
  item: CatalogItem;
  used: number;
  picked: boolean;
  onPick: () => void;
  fmt: Fmt;
  t: TFunction;
}) {
  const name = shortModel(item.model);
  const maker =
    item.kind === "cooling" && !item.props.model_known
      ? t("dc.catalog.modelUnassigned")
      : item.manufacturer || t("dc.catalog.noBrand");
  const c = capacity(item);
  const air = airflow(item);
  return (
    <article className="dc-cat-card" data-testid="catalog-card">
      <div className="dc-cat-img">
        <Thumb item={item} />
        {used > 0 && (
          <span className="dc-cat-used">
            {t("dc.catalog.inRoom", { count: used })}
          </span>
        )}
        <button
          type="button"
          className="dc-cat-pick"
          aria-pressed={picked}
          aria-label={
            picked
              ? t("dc.catalog.compareRemove", { model: name })
              : t("dc.catalog.compareAdd", { model: name })
          }
          title={
            picked
              ? t("dc.catalog.compareRemove", { model: name })
              : t("dc.catalog.compareAdd", { model: name })
          }
          onClick={onPick}
        >
          <Columns2 className="size-4" />
        </button>
      </div>
      <div className="dc-cat-body">
        <h3>
          {/* One link for the whole card (its ::after covers it). */}
          <Link
            to={`/dc/catalog/item/${item.id}`}
            className="dc-cat-link"
            title={item.model}
            aria-label={t("dc.catalog.open", { model: item.model })}
          >
            {name}
          </Link>
        </h3>
        <p className="dc-muted">
          {maker} · {executionLabel(item, t)}
        </p>
        {item.kind === "cooling" && (
          <dl className="dc-cat-spec">
            <div>
              <dt>
                {c === null
                  ? t("dc.catalog.coldUnknown")
                  : c.sensible
                    ? t("dc.catalog.coldSensible")
                    : t("dc.catalog.coldTotal")}
              </dt>
              <dd className="dc-num">{c ? fmt.kw(c.w) : "—"}</dd>
            </div>
            <div>
              <dt>{t("dc.catalog.air")}</dt>
              <dd className="dc-num">{air === null ? "—" : fmt.m3h(air)}</dd>
            </div>
          </dl>
        )}
        {item.kind === "rack" && (
          <p className="dc-num">
            {t("dc.catalog.units", { n: item.props.units })}
          </p>
        )}
        {item.kind === "shelf" && (
          <p className="dc-num">
            {t("dc.catalog.cells", {
              n: item.props.cells_per_board * item.props.boards_mm.length,
            })}
          </p>
        )}
        <div className="dc-cat-dims">
          <span>{t("dc.catalog.dimsIn", { unit: fmt.unitWord })}</span>
          <span className="dc-num" data-testid="card-dims">
            {dimsNumbers(item, fmt)}
          </span>
        </div>
        <Tags item={item} />
      </div>
    </article>
  );
}

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "name", label: "dc.catalog.colName" },
  { key: "brand", label: "dc.catalog.colBrand" },
  { key: "exec", label: "dc.catalog.colExec" },
  { key: "cold", label: "dc.catalog.colCold", num: true },
  { key: "air", label: "dc.catalog.colAir", num: true },
  { key: "size", label: "dc.catalog.colDims", num: true },
  { key: "mass", label: "dc.catalog.colMass", num: true },
  { key: "h247", label: "dc.catalog.col247" },
  { key: "used", label: "dc.catalog.colUsed", num: true },
];

function CatalogTable({
  items,
  f,
  setF,
  used,
  fmt,
  t,
}: {
  items: CatalogItem[];
  f: Filters;
  setF: SetFilters;
  used: Map<number, number>;
  fmt: Fmt;
  t: TFunction;
}) {
  // The same column again flips the order; a new one starts A–Z for text,
  // largest first for numbers.
  const sortBy = (k: SortKey) =>
    setF((cur) => ({
      ...cur,
      sort: k,
      dir:
        cur.sort === k
          ? cur.dir === "asc"
            ? "desc"
            : "asc"
          : ["name", "brand", "exec"].includes(k)
            ? "asc"
            : "desc",
    }));
  return (
    <div className="dc-cat-tablewrap">
      <table className="dc-cat-table" data-testid="catalog-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const text = tDyn(t, c.label, { unit: fmt.unitWord });
              const active = f.sort === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  data-num={c.num || undefined}
                  aria-sort={
                    active
                      ? f.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => sortBy(c.key)}
                    title={t("dc.catalog.sortByColumn", { col: text })}
                  >
                    {text}
                    {active &&
                      (f.dir === "asc" ? (
                        <ArrowUp className="size-3.5" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3.5" aria-hidden />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const c = capacity(i);
            const air = airflow(i);
            const m = mass(i);
            return (
              <tr key={i.id} data-testid="catalog-row">
                <td>
                  <Link to={`/dc/catalog/item/${i.id}`} title={i.model}>
                    {shortModel(i.model)}
                  </Link>
                </td>
                <td>
                  {i.kind === "cooling" && !i.props.model_known
                    ? t("dc.catalog.modelUnassigned")
                    : i.manufacturer || "—"}
                </td>
                <td>{executionLabel(i, t)}</td>
                <td data-num>
                  {c === null ? (
                    "—"
                  ) : (
                    <>
                      {fmt.n(c.w / 1000, 1)}
                      {!c.sensible && (
                        <small className="dc-total-mark">
                          {" "}
                          {t("dc.catalog.totalMark")}
                        </small>
                      )}
                    </>
                  )}
                </td>
                <td data-num>{air === null ? "—" : fmt.n(air)}</td>
                <td data-num>{dimsNumbers(i, fmt)}</td>
                <td data-num>{m === null ? "—" : fmt.n(m, 1)}</td>
                <td>
                  {i.kind === "cooling" && i.props.designed_24_7 !== null
                    ? i.props.designed_24_7
                      ? t("common.yes")
                      : t("common.no")
                    : "—"}
                </td>
                <td data-num>{used.get(i.id) ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
