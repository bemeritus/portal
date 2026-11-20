/**
 * Constant-size labels as an HTML overlay above the canvas, decluttered by
 * priority: each frame the labels are projected, sorted by priority, and a
 * label whose box would overlap one already placed — or a dimension line
 * other than its own — is hidden (FEEDBACK-6 §1). A hidden label comes back
 * while its object is hovered or selected (`focus`). Text stays crisp at any
 * zoom and follows the theme through CSS.
 */

import * as THREE from "three";

export type LabelKind =
  | "name"
  | "dim"
  | "warn"
  | "caution"
  | "assumed"
  | "note"
  | "measure"
  | "air"
  | "pin";

export interface LabelOptions {
  priority?: number;
  kind?: LabelKind;
  /** Shown even when names are hidden (realistic shows names on demand). */
  always?: boolean;
  title?: string;
  /** Extra CSS class (e.g. the warning dot of a disagreeing dimension). */
  className?: string;
  /** A dimension's two ends: the label hides when they project too close. */
  span?: [THREE.Vector3, THREE.Vector3];
  /**
   * The objects the label belongs to (`obj:12`): it wins over others while
   * one of them is in `focus`.
   */
  refs?: string[];
  /** Clickable (a warning pin): takes the pointer. */
  onClick?: () => void;
}

interface Label {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  priority: number;
  kind: LabelKind;
  always: boolean;
  w: number;
  h: number;
  group: string;
  span: [THREE.Vector3, THREE.Vector3] | null;
  refs: string[];
}

const v = new THREE.Vector3();
/** A screen rectangle, px: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/**
 * The chain a dimension belongs to (`chain:x:3` → `chain:x`): a link's
 * label may run over its neighbours' lines, which are on the same line.
 */
const chainOf = (key: string) =>
  key.startsWith("chain:") ? key.split(":").slice(0, 2).join(":") : key;

/** Does the segment a–b cross the box [x0, y0, x1, y1] (inset by 2 px)? */
function segmentHitsRect(
  a: [number, number],
  b: [number, number],
  r: [number, number, number, number],
): boolean {
  const [x0, y0, x1, y1] = [r[0] + 2, r[1] + 2, r[2] - 2, r[3] - 2];
  // Liang–Barsky clipping.
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

export class Labels {
  readonly root: HTMLDivElement;
  private labels = new Map<string, Label>();
  /** Names shown for everything (schema mode), or only for `focus`. */
  showNames = true;
  focus = new Set<string>();
  /** Objects hidden in the viewport (`obj:12`): their labels go too. */
  hiddenRefs = new Set<string>();
  /**
   * The section box (FEEDBACK-7 §4.4): a label outside it is hidden; one
   * above its top stands at the cut instead.
   */
  clip: THREE.Box3 | null = null;

  /** Hide or show every label at once (the rail's labels toggle). */
  setVisible(on: boolean) {
    this.root.hidden = !on;
  }

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "dc-labels";
    this.root.setAttribute("aria-hidden", "true");
    host.appendChild(this.root);
  }

  set(key: string, text: string, pos: THREE.Vector3, opts: LabelOptions = {}) {
    let l = this.labels.get(key);
    const kind = opts.kind ?? "name";
    if (!l) {
      const el = document.createElement("div");
      this.root.appendChild(el);
      l = {
        el,
        pos: pos.clone(),
        priority: 0,
        kind,
        always: false,
        w: 0,
        h: 0,
        group: key.split(":")[0],
        span: null,
        refs: [],
      };
      this.labels.set(key, l);
    }
    l.pos.copy(pos);
    l.priority = opts.priority ?? 1;
    l.always = opts.always ?? false;
    l.kind = kind;
    l.el.className = `dc-label dc-label-${kind}${opts.className ? ` ${opts.className}` : ""}`;
    l.span = opts.span ? [opts.span[0].clone(), opts.span[1].clone()] : null;
    l.refs = opts.refs ?? [];
    l.el.onclick = opts.onClick
      ? (e) => {
          e.stopPropagation();
          opts.onClick!();
        }
      : null;
    l.el.dataset.key = key;
    if (l.el.textContent !== text) {
      l.el.textContent = text;
      l.w = 0;
    }
    if (opts.title) l.el.title = opts.title;
    else l.el.removeAttribute("title");
  }

  /** Remove every label whose key starts with `group:`. */
  clear(group: string) {
    for (const [k, l] of this.labels)
      if (l.group === group) {
        l.el.remove();
        this.labels.delete(k);
      }
  }

  remove(key: string) {
    const l = this.labels.get(key);
    if (l) {
      l.el.remove();
      this.labels.delete(key);
    }
  }

  /** The keys of the labels shown in the last frame (tests). */
  shown(): string[] {
    return [...this.labels.entries()]
      .filter(([, l]) => l.el.style.display !== "none")
      .map(([k]) => k);
  }

  /**
   * Place the labels for this frame. `panels` are the viewport's panels
   * (px): a label whose anchor falls under one, or whose box a panel would
   * cut, is hidden (FEEDBACK-7 §1.3). `avoid` is the selected object's
   * silhouette: a dimension's label never sits on it (§1.4).
   */
  update(
    camera: THREE.Camera,
    width: number,
    height: number,
    panels: Box[] = [],
  ) {
    const placed: Box[] = [];
    const focused = (l: Label, key: string) =>
      this.focus.has(key.split(":").slice(0, 2).join(":")) ||
      l.refs.some((r) => this.focus.has(r));
    const rank = (l: Label, key: string) =>
      l.priority + (focused(l, key) ? 10 : 0);
    const list = [...this.labels.entries()].sort(
      (a, b) => rank(b[1], b[0]) - rank(a[1], a[0]),
    );
    // Every dimension line on screen: no label may sit on one but its own.
    const toScreen = (p: THREE.Vector3): [number, number] => {
      v.copy(p).project(camera);
      return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
    };
    const lines: { key: string; a: [number, number]; b: [number, number] }[] =
      [];
    if (!this.root.hidden)
      for (const [key, l] of this.labels)
        if (l.span) {
          const a = toScreen(l.span[0]),
            b = toScreen(l.span[1]);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 8)
            lines.push({ key, a, b });
        }
    const hits = (a: Box, b: Box) =>
      a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const inside = (x: number, y: number, b: Box) =>
      x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    const avoid = this.avoid;
    for (const [key, l] of list) {
      // Names and assumed-value badges follow the mode (all, or on focus);
      // dimensions, warnings, notes and ruler marks always show.
      const onDemand = l.kind === "name" || l.kind === "assumed";
      const wanted =
        l.always ||
        !onDemand ||
        this.showNames ||
        this.focus.has(key.split(":").slice(0, 2).join(":"));
      let longEnough = true;
      if (l.span) {
        // A dimension seen end-on (a height in a top view) is not drawn;
        // a short one still is — its text may run past its ends.
        const a = l.span[0].clone().project(camera),
          b = l.span[1].clone().project(camera);
        longEnough =
          Math.hypot(((a.x - b.x) * width) / 2, ((a.y - b.y) * height) / 2) > 8;
      }
      const c = this.clip;
      v.copy(l.pos);
      if (c && v.y > c.max.y) v.y = c.max.y - 40;
      const clipped =
        !!c &&
        (v.x < c.min.x ||
          v.x > c.max.x ||
          v.z < c.min.z ||
          v.z > c.max.z ||
          v.y < c.min.y);
      v.project(camera);
      const ax = ((v.x + 1) / 2) * width,
        ay = ((1 - v.y) / 2) * height;
      const visible =
        wanted &&
        longEnough &&
        v.z > -1 &&
        v.z < 1 &&
        Math.abs(v.x) < 1.2 &&
        Math.abs(v.y) < 1.2 &&
        !this.hiddenRefs.has(key.split(":").slice(0, 2).join(":")) &&
        !l.refs.some((r) => this.hiddenRefs.has(r)) &&
        !clipped &&
        // Its anchor under a panel: hidden, not cut.
        !panels.some((p) => inside(ax, ay, p));
      if (!visible) {
        l.el.style.display = "none";
        continue;
      }
      l.el.style.display = "";
      if (!l.w) {
        l.w = l.el.offsetWidth;
        l.h = l.el.offsetHeight;
      }
      // Where it may stand: a dimension's label slides along its line, or
      // just past its ends; any other label may step up or down by its height.
      const spots: [number, number][] = [];
      if (l.span) {
        const a = toScreen(l.span[0]),
          b = toScreen(l.span[1]);
        const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const [dx, dy] = [ax - mx, ay - my];
        for (const t of [0.5, 0.3, 0.7, 0.15, 0.85, -0.2, 1.2])
          spots.push([
            a[0] + (b[0] - a[0]) * t + dx,
            a[1] + (b[1] - a[1]) * t + dy,
          ]);
      } else {
        spots.push([ax, ay]);
        if (l.priority < 9)
          spots.push(
            [ax, ay - l.h - 2],
            [ax, ay + l.h + 2],
            [ax, ay - 2 * l.h - 4],
          );
        else spots.push([ax, ay - l.h - 2]);
      }
      let at: Box | null = null;
      let clashFree = false;
      for (const [cx, cy] of spots) {
        const x = cx - l.w / 2,
          y = cy - l.h / 2;
        const r: Box = [x, y, x + l.w, y + l.h];
        // Cut by a panel or the canvas edge: not here.
        if (
          r[0] < 0 ||
          r[1] < 0 ||
          r[2] > width ||
          r[3] > height ||
          panels.some((p) => hits(r, p))
        )
          continue;
        if (!at) at = r;
        const clash =
          placed.some((p) => hits(r, p)) ||
          lines.some(
            (s) =>
              s.key !== key &&
              chainOf(s.key) !== chainOf(key) &&
              segmentHitsRect(s.a, s.b, r),
          ) ||
          // A dimension's label is never on the selected object.
          (l.kind === "dim" && !!avoid && hits(r, avoid));
        if (!clash) {
          at = r;
          clashFree = true;
          break;
        }
      }
      // Focus orders the labels; only a high priority of its own exempts one.
      if (!at || (!clashFree && l.priority < 9)) {
        l.el.style.display = "none";
        continue;
      }
      placed.push(at);
      l.el.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px)`;
    }
  }

  /** The selected object's silhouette on screen, px, or null. */
  avoid: Box | null = null;

  dispose() {
    this.root.remove();
    this.labels.clear();
  }
}
