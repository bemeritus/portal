/**
 * `/dc/catalog/item/:id` — one catalog item on a page of its own, so it can
 * be linked (FEEDBACK-4 §3.2; mockup `design/CatalogItem.png`).
 *
 * Left, the 3D viewer: 3D / front / side / top; dimensions, airflow and a
 * 42U rack for scale as toggles. Right, what the item is: tags, three key
 * figures, the specification in groups with the source of every value,
 * where it is used, and the actions.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Box, Link2, Ruler, Wind } from "lucide-react";

import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { tDyn } from "../../i18n";
import {
  ItemViewer,
  type ViewerToggles,
  type ViewName,
} from "../engine/preview";
import { airFaces, modelRemark, sectionOf, shortModel } from "../model/catalog";
import { useDcSettings, useFmt } from "../settings";
import { TOKENS } from "../theme/tokens";
import type { CatalogItem } from "../types";
import {
  executionLabel,
  keyFigures,
  specGroups,
  ComfortNote,
  Tags,
  useCatalog,
} from "./catalogParts";

const VIEWS: ViewName[] = ["3d", "front", "side", "top"];
const VIEW_KEY: Record<ViewName, string> = {
  "3d": "dc.catalog.view3d",
  front: "dc.catalog.viewFront",
  side: "dc.catalog.viewSide",
  top: "dc.catalog.viewTop",
};

/** The viewer's hint shows once per session, on the first hover. */
let hintShown = false;

export function DcCatalogItemPage() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { id } = useParams();
  const navigate = useNavigate();
  const { items, usage } = useCatalog();
  const item = items.data?.find((i) => i.id === Number(id));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = t("docTitle", {
      page: item ? shortModel(item.model) : t("dc.catalog.title"),
      app: t("app.name"),
    });
  }, [t, item]);

  if (items.isPending) return <ItemSkeleton />;
  if (items.error) return <ErrorFlash error={errorMessage(items.error)} />;
  if (!item)
    return (
      <div className="dc-cat-item-page">
        <p className="dc-muted">{t("dc.catalog.notFound")}</p>
        <Link to="/dc/catalog/cooling">{t("dc.catalog.title")}</Link>
      </div>
    );

  const section = sectionOf(item.kind);
  const uses = (usage.data ?? []).filter((u) => u.catalog_id === item.id);
  const rooms = [
    ...new Map(uses.map((u) => [u.room_id, u.room_name])).entries(),
  ];
  const remark = modelRemark(item.model);
  const header = [
    item.kind === "cooling" && !item.props.model_known
      ? t("dc.catalog.modelUnassigned")
      : item.manufacturer,
    executionLabel(item, t),
    remark,
  ]
    .filter(Boolean)
    .join(" · ");
  const datasheet = item.kind === "cooling" ? item.props.source_url : null;

  return (
    <div className="dc-cat-item-page">
      <nav className="dc-crumbs" aria-label={t("dc.catalog.title")}>
        <Link to="/dc/catalog/cooling">{t("dc.catalog.title")}</Link>
        <span aria-hidden>/</span>
        <Link to={`/dc/catalog/${section}`}>
          {tDyn(t, `dc.section.${section}`)}
        </Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{shortModel(item.model)}</span>
      </nav>
      <div className="dc-item">
        <Viewer item={item} />
        <section className="dc-item-info">
          <p className="dc-muted">{header}</p>
          <h1 title={item.model}>{shortModel(item.model)}</h1>
          <Tags item={item} />
          <ComfortNote item={item} />
          <div className="dc-tiles">
            {keyFigures(item, fmt, t).map((k) => (
              <div key={k.label} className="dc-tile">
                <span>{k.label}</span>
                <b className="dc-num">{k.value ?? t("dc.catalog.noData")}</b>
              </div>
            ))}
          </div>
          {specGroups(item, fmt, t).map((g) => (
            <section key={g.key} className="dc-spec" aria-label={g.title}>
              <h2>{g.title}</h2>
              <dl>
                {g.rows.map((r) => (
                  <div
                    key={r.key}
                    className="dc-spec-row"
                    data-testid={`spec-${r.key}`}
                  >
                    <dt>
                      {r.label}
                      {r.note && <small>{r.note}</small>}
                    </dt>
                    <dd>
                      {r.value === null ? (
                        <span className="dc-nodata">
                          {t("dc.catalog.noData")}
                          {r.why && <small> · {r.why}</small>}
                        </span>
                      ) : (
                        <span className={r.mono ? "dc-num" : undefined}>
                          {r.value}
                        </span>
                      )}
                      {r.src &&
                        (r.src.url ? (
                          <a
                            className="dc-src"
                            href={r.src.url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {t("dc.catalog.source", { src: r.src.text })}
                          </a>
                        ) : (
                          <span className="dc-src">{r.src.text}</span>
                        ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section className="dc-where" aria-label={t("dc.catalog.whereUsed")}>
            <h2>{t("dc.catalog.whereUsed")}</h2>
            {rooms.length === 0 ? (
              <p className="dc-muted">{t("dc.catalog.notUsed")}</p>
            ) : (
              <ul>
                {rooms.map(([roomId, roomName]) => (
                  <li key={roomId}>
                    <Link to={`/dc/${roomId}?view=3d`}>{roomName}</Link>:{" "}
                    {uses
                      .filter((u) => u.room_id === roomId)
                      .map((u, n) => (
                        <span key={u.object_id}>
                          {n > 0 && ", "}
                          <Link to={`/dc/${roomId}?view=3d#obj-${u.object_id}`}>
                            {u.object_name}
                          </Link>
                        </span>
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="dc-item-actions">
            <button type="button" className="dc-btn dc-btn-primary" disabled>
              {t("dc.catalog.place")}
            </button>
            <button
              type="button"
              className="dc-btn"
              onClick={() => navigate(`/dc/catalog/${section}?cmp=${item.id}`)}
            >
              {t("dc.catalog.compare")}
            </button>
            <button
              type="button"
              className="dc-btn"
              aria-label={t("dc.catalog.copyLink")}
              title={t("dc.catalog.copyLink")}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(window.location.href)
                  .then(() => setCopied(true));
              }}
            >
              <Link2 className="size-4" />
            </button>
            <span role="status" className="dc-muted">
              {copied ? t("dc.catalog.linkCopied") : ""}
            </span>
          </div>
          <div className="dc-item-foot">
            <span className="dc-muted">{t("dc.catalog.placeLater")}</span>
            {datasheet && (
              <a href={datasheet} target="_blank" rel="noreferrer noopener">
                {t("dc.catalog.datasheet")}
              </a>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Viewer({ item }: { item: CatalogItem }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const theme = useDcSettings().theme;
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ItemViewer | null>(null);
  const [view, setView] = useState<ViewName>("3d");
  const [toggles, setToggles] = useState<ViewerToggles>({
    dims: true,
    openings: item.kind === "cooling",
    rack: false,
  });
  const [hint, setHint] = useState(false);
  const face = (k: string) => tDyn(t, `dc.catalog.face.${k}`);
  const text = { mm: fmt.mm, rack: t("dc.catalog.rack42"), face };

  // One viewer per item and theme; toggles, view and words go to it.
  useEffect(() => {
    if (!host.current) return;
    const v = new ItemViewer(host.current, item, text, TOKENS[theme], toggles);
    viewer.current = v;
    // The end-to-end tests read what the viewer draws.
    if (import.meta.env.DEV) Object.assign(window, { __dcViewer: v });
    return () => {
      v.dispose();
      viewer.current = null;
    };
    // The rest is pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, theme]);
  useEffect(() => viewer.current?.setToggles(toggles), [toggles]);
  useEffect(() => viewer.current?.setView(view), [view]);
  useEffect(
    () =>
      viewer.current?.setText({
        mm: fmt.mm,
        rack: t("dc.catalog.rack42"),
        face: (k) => tDyn(t, `dc.catalog.face.${k}`),
      }),
    [fmt, t],
  );

  const faces = item.kind === "cooling" ? airFaces(item.props) : null;
  const faceText = (fs: string[]) =>
    fs.map((f) => tDyn(t, `dc.catalog.face.${f}`)).join(", ");
  const toggle = (k: keyof ViewerToggles) =>
    setToggles((s) => ({ ...s, [k]: !s[k] }));

  return (
    <section className="dc-item-viewer dc-panel">
      <div className="dc-viewer-bar">
        <div
          className="dc-seg"
          role="radiogroup"
          aria-label={t("dc.catalog.views")}
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => setView(v)}
            >
              {tDyn(t, VIEW_KEY[v])}
            </button>
          ))}
        </div>
        <div className="dc-seg" role="group">
          <button
            type="button"
            aria-pressed={toggles.dims}
            onClick={() => toggle("dims")}
          >
            <Ruler className="size-4" /> {t("dc.catalog.toggleDims")}
          </button>
          {item.kind === "cooling" && (
            <button
              type="button"
              aria-pressed={toggles.openings}
              onClick={() => toggle("openings")}
            >
              <Wind className="size-4" /> {t("dc.catalog.toggleAir")}
            </button>
          )}
          <button
            type="button"
            aria-pressed={toggles.rack}
            onClick={() => toggle("rack")}
          >
            <Box className="size-4" /> {t("dc.catalog.toggleRack")}
          </button>
        </div>
      </div>
      <div
        ref={host}
        className="dc-viewer-host"
        role="img"
        aria-label={t("dc.catalog.viewerLabel", { model: item.model })}
        onPointerEnter={() => {
          if (hintShown) return;
          hintShown = true;
          setHint(true);
          window.setTimeout(() => setHint(false), 4000);
        }}
      >
        {hint && (
          <div className="dc-viewer-hint" role="tooltip">
            {t("dc.catalog.viewerHint")}
          </div>
        )}
      </div>
      {faces && toggles.openings && (
        <div className="dc-viewer-legend" data-testid="air-legend">
          <span>
            <i data-air="supply" />
            {t("dc.catalog.legendSupply", { face: faceText(faces.supply) })}
          </span>
          <span>
            <i data-air="return" />
            {t("dc.catalog.legendReturn", { face: faceText(faces.ret) })}
          </span>
        </div>
      )}
    </section>
  );
}

/** A loading state laid out like the page. */
function ItemSkeleton() {
  return (
    <div className="dc-cat-item-page" aria-busy>
      <div className="dc-skel dc-skel-line" style={{ width: 240 }} />
      <div className="dc-item">
        <div className="dc-item-viewer dc-panel dc-skel" />
        <div className="dc-item-info">
          <div className="dc-skel dc-skel-line" style={{ width: "60%" }} />
          <div className="dc-skel dc-skel-title" />
          <div className="dc-tiles">
            {[0, 1, 2].map((i) => (
              <div key={i} className="dc-tile dc-skel" />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="dc-skel dc-skel-line" />
          ))}
        </div>
      </div>
    </div>
  );
}
