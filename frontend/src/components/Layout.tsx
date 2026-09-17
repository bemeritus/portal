/**
 * The chrome every page except `/login` sits inside (§8).
 *
 * A top bar with the brand, the section switcher, the theme switcher and the
 * signed-in username; a left rail whose links follow the section you are in.
 * The switcher only shows the sections the user can actually enter, and the
 * rail's contents change with the current section — templates has documents and
 * categories, learning has resources, tests and labs. Admin links are
 * cross-section and sit in their own group at the foot.
 *
 * Below 760px the rail collapses behind the bar's ☰ toggle — the two share one
 * open/closed state, which is why it lives here and not in either of them.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/AuthContext";
import type { Section } from "../api/types";
import { hasAnywhere, inSection } from "../permissions";
import { comboFromEvent, isTypingTarget, SHORTCUTS } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useTheme } from "./ThemeSelect";
import { UserMenu } from "./UserMenu";

/** Which section the current URL belongs to. Templates is the default home. */
function sectionOf(pathname: string): Section {
  if (pathname.startsWith("/learning")) return "learning";
  if (pathname.startsWith("/projects")) return "projects";
  return "templates";
}

/** The section switcher's entries, in the fixed home-first order. */
const SECTION_TABS: { section: Section; to: string; labelKey: string }[] = [
  { section: "templates", to: "/templates", labelKey: "nav.templates" },
  { section: "learning", to: "/learning", labelKey: "nav.learning" },
  { section: "projects", to: "/projects", labelKey: "nav.projects" },
];

export function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { bindings } = useShortcuts();
  const [, setTheme] = useTheme();

  // A section link on a phone should take you there and get out of the way.
  useEffect(() => {
    setRailOpen(false);
  }, [location.pathname]);

  // What each shortcut id actually does — the handlers the registry cannot hold
  // because they need the router, theme and palette state that live here.
  const handlers = useMemo<Record<string, () => void>>(
    () => ({
      commandPalette: () => setPaletteOpen((v) => !v),
      newDocument: () => {
        if (hasAnywhere(user, "write")) navigate("/templates/docs/new");
      },
      goDocuments: () => navigate("/templates"),
      goBookmarks: () => navigate("/templates/bookmarks"),
      goSettings: () => navigate("/settings"),
      toggleTheme: () => {
        // Read the live theme off <html>, which every `useTheme` consumer keeps
        // in sync — Layout's own state could lag a change made from the menu.
        const current = document.documentElement.dataset.theme;
        const isDark = current === "dark" || current === "gruvbox";
        setTheme(isDark ? "light" : "dark");
      },
      showHelp: () => setHelpOpen(true),
    }),
    [user, navigate, setTheme],
  );

  // One global key listener drives every shortcut from the user's live bindings.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const combo = comboFromEvent(e);
      if (!combo) return;
      for (const def of SHORTCUTS) {
        if (!bindings[def.id] || bindings[def.id] !== combo) continue;
        if (!def.allowInInput && isTypingTarget(e.target)) return;
        const run = handlers[def.id];
        if (run) {
          e.preventDefault();
          run();
        }
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bindings, handlers]);

  const section = sectionOf(location.pathname);
  const heldTabs = SECTION_TABS.filter((tab) => inSection(user, tab.section));
  // The "New document" shortcut belongs to templates; it has no meaning while
  // the learning rail is showing, where each list carries its own create link.
  const showNewDocument = section === "templates" && hasAnywhere(user, "write");

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <>
      <nav className="navbar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={railOpen}
          aria-controls="sections"
          aria-label={t("nav.toggleSections")}
          onClick={() => setRailOpen((open) => !open)}
        >
          ☰
        </button>
        <Link className="brand" to="/" onClick={() => setRailOpen(false)}>
          📚 {t("app.name")}
        </Link>

        {/* The section switcher — only the doors this user holds. Hidden
            entirely for someone with a single section, since there is nothing
            to switch between. */}
        {heldTabs.length > 1 && (
          <div className="section-tabs" role="tablist" aria-label={t("nav.sections")}>
            {heldTabs.map((tab) => (
              <NavLink key={tab.section} className="section-tab" to={tab.to}>
                {t(tab.labelKey)}
              </NavLink>
            ))}
          </div>
        )}

        <span className="spacer" />
        <div className="nav-tools">
          {showNewDocument && (
            <NavLink className="nav-link" to="/templates/docs/new">
              {t("nav.new")}
            </NavLink>
          )}
        </div>
      </nav>

      <div className="layout">
        <aside
          className={`sidebar${railOpen ? " open" : ""}`}
          id="sections"
          aria-label={t("nav.sections")}
        >
          <nav className="side-links">
            {section === "templates" && (
              <>
                <NavLink to="/templates" end>
                  {t("nav.documents")}
                </NavLink>
                <NavLink to="/templates/bookmarks">{t("nav.bookmarks")}</NavLink>
                {user?.is_admin && (
                  <NavLink to="/templates/categories">{t("nav.categories")}</NavLink>
                )}
              </>
            )}
            {section === "learning" && (
              <>
                <NavLink to="/learning" end>
                  {t("nav.overview")}
                </NavLink>
                <NavLink to="/learning/resources">{t("nav.resources")}</NavLink>
                <NavLink to="/learning/tests">{t("nav.tests")}</NavLink>
                <NavLink to="/learning/labs">{t("nav.labs")}</NavLink>
              </>
            )}
            {section === "projects" && (
              <NavLink to="/projects" end>
                {t("nav.boards")}
              </NavLink>
            )}

            {user?.is_admin && (
              <>
                <hr className="side-sep" />
                <NavLink to="/admin/users">{t("nav.users")}</NavLink>
                <NavLink to="/admin/analytics">{t("nav.analytics")}</NavLink>
                <NavLink to="/admin/logs">{t("nav.logs")}</NavLink>
              </>
            )}
          </nav>
          {user && (
            <UserMenu
              username={user.username}
              loggingOut={loggingOut}
              onLogout={() => void onLogout()}
            />
          )}
        </aside>

        <main className="container">
          <Outlet />
        </main>
      </div>

      {showNewDocument && (
        <Link
          className="fab"
          to="/templates/docs/new"
          aria-label={t("nav.newDocument")}
          title={t("nav.newDocument")}
        >
          +
        </Link>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
