/**
 * `/learning` — the section hub: one card per area (resources, tests, labs).
 *
 * A plain landing rather than a dashboard: the three areas each own their own
 * list, and this is the fork in the road between them.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function LearningHomePage() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("docTitle", { page: t("learning.overviewTitle"), app: t("app.name") });
  }, [t]);

  const cards = [
    { to: "/learning/resources", title: t("nav.resources"), desc: t("learning.resourcesCardDesc") },
    { to: "/learning/tests", title: t("nav.tests"), desc: t("learning.testsCardDesc") },
    { to: "/learning/labs", title: t("nav.labs"), desc: t("learning.labsCardDesc") },
  ];

  return (
    <>
      <h1>{t("learning.overviewTitle")}</h1>
      <p className="muted">{t("learning.overviewSubtitle")}</p>
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {cards.map((c) => (
          <Link className="card" key={c.to} to={c.to}>
            <h3>{c.title}</h3>
            <div className="meta">
              <span>{c.desc}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
