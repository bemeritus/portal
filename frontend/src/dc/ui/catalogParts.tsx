/**
 * What the catalog's pages share (FEEDBACK-4 §3): the catalog and where its
 * items are used, an item's tags and execution label, its card picture, and
 * its specification as labelled rows with sources — for the item page and
 * the comparison.
 */

import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import i18n, { tDyn } from "../../i18n";
import { dcApi } from "../api";
import { cachedThumbnail, thumbnail, type ThumbSize } from "../engine/preview";
import type { Fmt } from "../format";
import {
  airFaces,
  capacity,
  dimsText,
  execution,
  isPrecision,
} from "../model/catalog";
import { useDcSettings } from "../settings";
import { TOKENS } from "../theme/tokens";
import {
  localText,
  type CatalogItem,
  type PropSource,
  type Text,
} from "../types";

/** The catalog and where its items are used; both cached by React Query. */
export function useCatalog() {
  const items = useQuery({
    queryKey: ["dc", "catalog"],
    queryFn: ({ signal }) => dcApi.catalog(undefined, signal),
  });
  const usage = useQuery({
    queryKey: ["dc", "catalog", "usage"],
    queryFn: ({ signal }) => dcApi.catalogUsage(signal),
  });
  return { items, usage };
}

/** The execution (subtype or kind) in the user's language. */
export function executionLabel(i: CatalogItem, t: TFunction): string {
  const e = execution(i);
  return i.kind === "cooling" || i.kind === "structure"
    ? tDyn(t, `dc.subtype.${e}`)
    : tDyn(t, `dc.kind.${e}`);
}

export interface Tag {
  key: string;
  text: string;
  tone: "good" | "plain" | "warn";
}

/**
 * Tags of an item: precision or comfort, 24/7, inverter, and what data is
 * missing — amber, not red: missing data is not an error.
 */
export function tags(i: CatalogItem, t: TFunction): Tag[] {
  if (i.kind !== "cooling") return [];
  const p = i.props;
  const out: Tag[] = [
    isPrecision(i)
      ? { key: "precision", text: t("dc.catalog.precision"), tone: "good" }
      : { key: "comfort", text: t("dc.catalog.comfort"), tone: "plain" },
  ];
  if (p.designed_24_7) out.push({ key: "24", text: "24/7", tone: "plain" });
  if (p.inverter)
    out.push({ key: "inv", text: t("dc.catalog.inverter"), tone: "plain" });
  if (!p.model_known)
    out.push({
      key: "unknown",
      text: t("dc.catalog.powerUnknown"),
      tone: "warn",
    });
  else if (p.cooling_sensible_w === null)
    out.push({ key: "nosens", text: t("dc.catalog.noSensible"), tone: "warn" });
  return out;
}

export function Tags({ item }: { item: CatalogItem }) {
  const { t } = useTranslation();
  const list = tags(item, t);
  if (!list.length) return null;
  return (
    <div className="dc-tags">
      {list.map((g) => (
        <span key={g.key} className="dc-tag" data-tone={g.tone}>
          {g.text}
        </span>
      ))}
    </div>
  );
}

/** The card picture size: 4:3, sharp up to a 320 px wide card. */
export function thumbSize(): ThumbSize {
  return {
    w: 320,
    h: 240,
    dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  };
}

/**
 * An item's card picture, drawn once per session and theme. Until it is
 * drawn, a skeleton with the item's silhouette (its front, to scale); cards
 * on screen are drawn first (FEEDBACK-7 §3).
 */
export function Thumb({ item }: { item: CatalogItem }) {
  const tokens = TOKENS[useDcSettings().theme];
  const [src, setSrc] = useState<string | null>(() =>
    cachedThumbnail(item, tokens, thumbSize()),
  );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src) return;
    let live = true;
    const done = (u: string) => live && setSrc(u);
    void thumbnail(item, tokens, thumbSize()).then(done);
    const el = box.current;
    const seen = el
      ? new IntersectionObserver((es) => {
          if (es.some((e) => e.isIntersecting))
            void thumbnail(item, tokens, thumbSize(), true).then(done);
        })
      : null;
    if (el) seen!.observe(el);
    return () => {
      live = false;
      seen?.disconnect();
    };
  }, [item, tokens, src]);
  if (src)
    return <img src={src} alt="" className="dc-cat-pic" data-thumb={item.id} />;
  // The silhouette: the item's front, scaled to the picture's 4:3.
  const s = Math.min(240 / item.width_mm, 160 / item.height_mm);
  const [w, h] = [item.width_mm * s, item.height_mm * s];
  return (
    <div
      ref={box}
      className="dc-cat-pic dc-skel"
      aria-hidden
      data-skeleton={item.id}
    >
      <svg viewBox="0 0 320 240" className="dc-skel-shape">
        <rect x={160 - w / 2} y={200 - h} width={w} height={h} rx={4} />
      </svg>
    </div>
  );
}

// --- The specification, with sources --------------------------------------------------

export interface SpecRow {
  key: string;
  label: string;
  /** `null` = unknown: shown as "no data" with `why`. */
  value: string | null;
  mono: boolean;
  /** Under the value: rating conditions, or the source's note. */
  note?: string;
  /** Why it is unknown. */
  why?: string;
  src?: { text: string; url?: string };
}

export interface SpecGroup {
  key: string;
  title: string;
  rows: SpecRow[];
}

/** The item's specification, grouped as on the item page (FEEDBACK-4 §3.2). */
export function specGroups(
  item: CatalogItem,
  fmt: Fmt,
  t: TFunction,
): SpecGroup[] {
  const textOf = (x: Text | null | undefined) =>
    x ? localText(x, i18n.language) : undefined;
  const source = (k: string): SpecRow["src"] => {
    const s: PropSource | undefined = item.props_src[k] ?? item.props_src.dims;
    if (!s) return undefined;
    return { text: tDyn(t, `dc.src.${s.src}`), url: s.url };
  };
  const unknownWhy =
    item.kind === "cooling" && !item.props.model_known
      ? t("dc.catalog.modelUnknownWhy")
      : t("dc.catalog.notPublished");
  const row = (
    key: string,
    label: string,
    value: string | null,
    mono = true,
    note?: string,
  ): SpecRow => ({
    key,
    label,
    value,
    mono,
    // Conditions and notes belong to a value: none under "no data".
    note:
      value === null ? undefined : (note ?? textOf(item.props_src[key]?.note)),
    why: value === null ? unknownWhy : undefined,
    src: value !== null ? source(key) : undefined,
  });
  const dims = row("dims", t("dc.catalog.rowDims"), dimsText(item, fmt));
  const finish = (f?: { kind: string }) =>
    f
      ? row(
          "finish",
          t("dc.catalog.rowFinish"),
          tDyn(t, `dc.catalog.finish.${f.kind}`),
          false,
        )
      : null;

  if (item.kind === "cooling") {
    const p = item.props;
    const conditions = p.rating_conditions
      ? t("dc.catalog.conditions", { c: textOf(p.rating_conditions) })
      : undefined;
    const faces = airFaces(p);
    const faceText = (fs: string[]) =>
      fs.map((f) => tDyn(t, `dc.catalog.face.${f}`)).join(", ");
    const kw = (w: number | null) => (w === null ? null : fmt.kw(w));
    const groups: SpecGroup[] = [
      {
        key: "cold",
        title: t("dc.catalog.groupCold"),
        rows: [
          row(
            "cooling_sensible_w",
            t("dc.catalog.rowSensible"),
            kw(p.cooling_sensible_w),
            true,
            conditions,
          ),
          row(
            "cooling_total_w",
            t("dc.catalog.rowTotal"),
            kw(p.cooling_total_w),
            true,
            conditions,
          ),
          ...(p.cooling_range_w
            ? [
                row(
                  "cooling_range_w",
                  t("dc.catalog.rowRange"),
                  `${fmt.kw(p.cooling_range_w[0])} – ${fmt.kw(p.cooling_range_w[1])}`,
                ),
              ]
            : []),
          ...(p.capacity_modulation
            ? [
                row(
                  "capacity_modulation",
                  t("dc.catalog.rowModulation"),
                  p.capacity_modulation,
                  false,
                ),
              ]
            : []),
        ],
      },
      {
        key: "air",
        title: t("dc.catalog.groupAir"),
        rows: [
          row(
            "airflow_m3h",
            t("dc.catalog.rowAirflow"),
            p.airflow_m3h.length
              ? p.airflow_m3h.map((x) => fmt.m3h(x)).join(" / ")
              : null,
          ),
          {
            key: "faces",
            label: t("dc.catalog.rowFaces"),
            value: `${faceText(faces.supply)} / ${faceText(faces.ret)}`,
            mono: false,
          },
          ...(p.esp_pa
            ? [
                row(
                  "esp_pa",
                  t("dc.catalog.rowEsp"),
                  `${p.esp_pa.rated} Pa${p.esp_pa.min !== null || p.esp_pa.max !== null ? ` (${p.esp_pa.min ?? "?"}–${p.esp_pa.max ?? "?"})` : ""}`,
                ),
              ]
            : []),
        ],
      },
      {
        key: "dims",
        title: t("dc.catalog.groupDims"),
        rows: [
          dims,
          row(
            "weight_kg",
            t("dc.catalog.rowMass"),
            p.weight_kg === null ? null : fmt.kg(p.weight_kg),
          ),
          ...[finish(p.finish)].filter((x): x is SpecRow => x !== null),
        ],
      },
    ];
    const power = [
      ...(p.power_input_w !== null
        ? [
            row(
              "power_input_w",
              t("dc.catalog.rowPowerInput"),
              fmt.w(p.power_input_w),
            ),
          ]
        : []),
      ...(p.eer !== null
        ? [row("eer", t("dc.catalog.rowEer"), fmt.n(p.eer, 2))]
        : []),
      ...(p.power_supply
        ? [
            row(
              "power_supply",
              t("dc.catalog.rowSupply"),
              p.power_supply,
              false,
            ),
          ]
        : []),
      ...(p.refrigerant
        ? [
            row(
              "refrigerant",
              t("dc.catalog.rowRefrigerant"),
              p.refrigerant,
              false,
            ),
          ]
        : []),
    ];
    // Electrical only when something of it is known.
    if (power.length)
      groups.push({
        key: "power",
        title: t("dc.catalog.groupPower"),
        rows: power,
      });
    return groups;
  }

  const build: SpecRow[] = [];
  if (item.kind === "rack") {
    const p = item.props;
    const door = (d: string | null) => (d ? tDyn(t, `dc.door.${d}`) : "—");
    build.push(
      row("units", t("dc.catalog.rowUnits"), String(p.units)),
      row("u1_height_mm", t("dc.catalog.rowU1"), fmt.mm(p.u1_height_mm)),
      row(
        "door_front",
        t("dc.catalog.rowDoors"),
        `${door(p.door_front)} / ${door(p.door_rear)}`,
        false,
      ),
      row(
        "max_static_load_kg",
        t("dc.catalog.rowLoad"),
        p.max_static_load_kg === null ? null : fmt.kg(p.max_static_load_kg),
      ),
    );
    const f = finish(p.finish);
    if (f) build.push(f);
  }
  if (item.kind === "shelf") {
    const p = item.props;
    build.push(
      row(
        "cells_per_board",
        t("dc.catalog.rowCells"),
        String(p.cells_per_board * p.boards_mm.length),
      ),
      row(
        "boards_mm",
        t("dc.catalog.rowBoards"),
        p.boards_mm.map((x) => fmt.mm(x)).join(", "),
      ),
    );
    const f = finish(p.finish);
    if (f) build.push(f);
  }
  const groups: SpecGroup[] = [
    { key: "dims", title: t("dc.catalog.groupDims"), rows: [dims] },
  ];
  if (build.length)
    groups.push({
      key: "build",
      title: t("dc.catalog.groupBuild"),
      rows: build,
    });
  return groups;
}

/** Three key figures per kind, for the item page's tiles. */
export function keyFigures(
  item: CatalogItem,
  fmt: Fmt,
  t: TFunction,
): { label: string; value: string | null }[] {
  if (item.kind === "cooling") {
    const c = capacity(item);
    const p = item.props;
    return [
      {
        label:
          c && !c.sensible
            ? t("dc.catalog.tileTotal")
            : t("dc.catalog.tileSensible"),
        value: c ? fmt.kw(c.w) : null,
      },
      {
        label: t("dc.catalog.tileAir"),
        value: p.airflow_m3h.length
          ? fmt.m3h(Math.max(...p.airflow_m3h))
          : null,
      },
      {
        label: t("dc.catalog.tileMass"),
        value: p.weight_kg === null ? null : fmt.kg(p.weight_kg),
      },
    ];
  }
  if (item.kind === "rack")
    return [
      { label: t("dc.catalog.tileUnits"), value: `${item.props.units} U` },
      {
        label: t("dc.catalog.tileLoad"),
        value:
          item.props.max_static_load_kg === null
            ? null
            : fmt.kg(item.props.max_static_load_kg),
      },
      { label: t("dc.catalog.tileDims"), value: dimsText(item, fmt) },
    ];
  if (item.kind === "shelf")
    return [
      {
        label: t("dc.catalog.tileCells"),
        value: String(item.props.cells_per_board * item.props.boards_mm.length),
      },
      { label: t("dc.catalog.tileDims"), value: dimsText(item, fmt) },
    ];
  return [{ label: t("dc.catalog.tileDims"), value: dimsText(item, fmt) }];
}

/**
 * A comfort air conditioner's limits, in one line on its card and page
 * (FEEDBACK-7 §7). It will link to SPEC §12 once those calculations exist.
 */
export function ComfortNote({ item }: { item: CatalogItem }) {
  const { t } = useTranslation();
  if (item.kind !== "cooling" || isPrecision(item)) return null;
  return (
    <p className="dc-comfort-note" data-testid="comfort-note">
      {t("dc.catalog.comfortNote")}
    </p>
  );
}
