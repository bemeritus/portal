/**
 * A revision in the user's words and its author (FEEDBACK-6 §5, §6): the
 * digest's sentence translated, and an avatar with the author's initial —
 * the room's first revision shows a neutral mark and no «seed».
 */

import type { TFunction } from "i18next";

import { tDyn } from "../../i18n";
import { revisionSentence, type Phrase } from "../model/history";
import type { Digest, RevisionSummary } from "../types";

/** «Коммутатор» → «коммутатор», «СХД» stays. */
const lowerFirst = (s: string) =>
  s.length > 1 && s[1] === s[1].toLowerCase()
    ? s[0].toLowerCase() + s.slice(1)
    : s;

export function phraseText(p: Phrase, t: TFunction): string {
  const v: Record<string, string | number> = { ...p.values };
  if (typeof v.noun === "string")
    v.devices = tDyn(t, `dc.revs.count.${v.noun}`, { count: v.count });
  if (typeof v.kind === "string")
    v.what = lowerFirst(tDyn(t, `dc.deviceKind.${v.kind}`));
  return tDyn(t, p.key, v);
}

export function revisionText(d: Digest, t: TFunction): string {
  const s = revisionSentence(d);
  return (
    phraseText(s.main, t) + (s.more ? t("dc.revs.more", { count: s.more }) : "")
  );
}

/** The room was created by the seed: no person to show. */
export const bySurvey = (r: RevisionSummary) => r.digest.kind === "created";

const HUES = [255, 150, 20, 200, 320, 90];

export function Avatar({ r, t }: { r: RevisionSummary; t: TFunction }) {
  if (bySurvey(r))
    return (
      <span
        className="dc-avatar-sm"
        data-system
        title={t("dc.revs.bySurvey")}
        aria-label={t("dc.revs.bySurvey")}
      >
        –
      </span>
    );
  const name = r.author_name;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className="dc-avatar-sm"
      style={{ background: `hsl(${HUES[h % HUES.length]} 55% 48%)` }}
      title={name}
      aria-label={name}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
