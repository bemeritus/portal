/**
 * Constant-size labels as an HTML overlay above the canvas, decluttered by
 * priority: each frame the labels are projected, sorted by priority, and a
 * label whose box would overlap one already placed is hidden. Text stays
 * crisp at any zoom and follows the theme through CSS.
 */

import * as THREE from "three";

export type LabelKind =
  "name" | "dim" | "warn" | "assumed" | "note" | "measure";

export interface LabelOptions {
  priority?: number;
  kind?: LabelKind;
  /** Shown even when names are hidden (Реалистичный shows names on demand). */
  always?: boolean;
  title?: string;
  /** Extra CSS class (e.g. the warning dot of a disagreeing dimension). */
  className?: string;
  /** A dimension's two ends: the label hides when they project too close. */
  span?: [THREE.Vector3, THREE.Vector3];
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
}

const v = new THREE.Vector3();

export class Labels {
  readonly root: HTMLDivElement;
  private labels = new Map<string, Label>();
  /** Names shown for everything (Схема), or only for `focus`. */
  showNames = true;
  focus = new Set<string>();

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
      };
      this.labels.set(key, l);
    }
    l.pos.copy(pos);
    l.priority = opts.priority ?? 1;
    l.always = opts.always ?? false;
    l.kind = kind;
    l.el.className = `dc-label dc-label-${kind}${opts.className ? ` ${opts.className}` : ""}`;
    l.span = opts.span ? [opts.span[0].clone(), opts.span[1].clone()] : null;
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

  update(camera: THREE.Camera, width: number, height: number) {
    const placed: [number, number, number, number][] = [];
    const list = [...this.labels.entries()].sort(
      (a, b) => b[1].priority - a[1].priority,
    );
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
      v.copy(l.pos).project(camera);
      const visible =
        wanted &&
        longEnough &&
        v.z > -1 &&
        v.z < 1 &&
        Math.abs(v.x) < 1.2 &&
        Math.abs(v.y) < 1.2;
      if (!visible) {
        l.el.style.display = "none";
        continue;
      }
      l.el.style.display = "";
      if (!l.w) {
        l.w = l.el.offsetWidth;
        l.h = l.el.offsetHeight;
      }
      const x = ((v.x + 1) / 2) * width - l.w / 2;
      const y = ((1 - v.y) / 2) * height - l.h / 2;
      const r: [number, number, number, number] = [x, y, x + l.w, y + l.h];
      const clash = placed.some(
        (p) => r[0] < p[2] && p[0] < r[2] && r[1] < p[3] && p[1] < r[3],
      );
      if (clash && l.priority < 9) {
        l.el.style.display = "none";
        continue;
      }
      placed.push(r);
      l.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  dispose() {
    this.root.remove();
    this.labels.clear();
  }
}
