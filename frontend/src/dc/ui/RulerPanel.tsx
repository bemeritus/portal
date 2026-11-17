/**
 * The ruler's panel: the mode (between points / faces, or the gap between
 * two objects), every measurement with what it snapped to, and each end's
 * coordinates — shown and typeable, in the user's unit.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Vec3 } from "../model/ruler";
import { useFmt } from "../settings";
import type { RulerProps } from "./Inspector";

export function RulerPanel({ mode, setMode, measures, clear, setEnd, text }: RulerProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 text-sm">
      <div className="dc-seg" role="radiogroup" aria-label={t("dc.ruler.mode")}>
        {(["points", "objects"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
            {t(`dc.ruler.${m}`)}
          </button>
        ))}
      </div>
      <p className="text-xs" style={{ color: "var(--dc-muted)" }}>
        {mode === "points" ? t("dc.ruler.pointsHelp") : t("dc.ruler.objectsHelp")}
      </p>
      {measures.length === 0 && <p style={{ color: "var(--dc-muted)" }}>{t("dc.ruler.none")}</p>}
      {measures.map((m, i) => (
        <div key={i} className="dc-rows" data-testid="ruler-result">
          <div>
            <b className="dc-num" data-testid="ruler-text">
              {text(m)}
            </b>
          </div>
          <EndInput label="A" p={m.a} onSet={(p) => setEnd(i, "a", p)} />
          <EndInput label="B" p={m.b} onSet={(p) => setEnd(i, "b", p)} />
        </div>
      ))}
      {measures.length > 0 && (
        <button type="button" className="dc-btn" onClick={clear}>
          {t("dc.ruler.clear")}
        </button>
      )}
    </div>
  );
}

function EndInput({ label, p, onSet }: { label: string; p: Vec3; onSet: (p: Vec3) => void }) {
  const fmt = useFmt();
  const [text, setText] = useState(() => p.map((v) => fmt.input(Math.round(v))));
  useEffect(() => setText(p.map((v) => fmt.input(Math.round(v)))), [p, fmt]);
  const commit = () => {
    const v = text.map((s) => fmt.parse(s));
    if (v.every((x): x is number => x !== null)) onSet(v as Vec3);
  };
  return (
    <div>
      <span>{label}</span>
      {(["x", "y", "z"] as const).map((axis, k) => (
        <label key={axis} className="flex items-center gap-1 text-xs">
          {axis}
          <input
            className="dc-num w-16 rounded border bg-transparent px-1 py-0.5 text-right"
            style={{ borderColor: "var(--dc-line)" }}
            value={text[k]}
            aria-label={`${label} ${axis}, ${fmt.unitWord}`}
            onChange={(e) => setText(text.map((s, j) => (j === k ? e.target.value : s)))}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
        </label>
      ))}
    </div>
  );
}
