/**
 * The chrome every page except `/login` sits inside (§8).
 *
 * A top bar with the brand, the theme switcher and the signed-in username; a
 * left rail with the templates links (documents, bookmarks, and categories for
 * an admin). Admin links are cross-section and sit in their own group at the
 * foot.
 *
 * Below 760px the rail collapses behind the bar's ☰ toggle — the two share one
 * open/closed state, which is why it lives here and not in either of them.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/AuthContext";
import { comboFromEvent, isTypingTarget, SHORTCUTS } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useTheme } from "./ThemeSelect";
import { UserMenu } from "./UserMenu";

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
      newDocument: () => navigate("/templates/docs/new"),
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
    [navigate, setTheme],
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

  const showNewDocument = !!user;

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
            <NavLink to="/templates" end>
              {t("nav.documents")}
            </NavLink>
            <NavLink to="/templates/drafts">{t("nav.drafts")}</NavLink>
            <NavLink to="/templates/bookmarks">{t("nav.bookmarks")}</NavLink>
            <NavLink to="/templates/categories">{t("nav.categories")}</NavLink>

            <hr className="side-sep" />
            <NavLink to="/admin/analytics">{t("nav.analytics")}</NavLink>
            <NavLink to="/admin/logs">{t("nav.logs")}</NavLink>
            {user?.is_admin && <NavLink to="/admin/users">{t("nav.users")}</NavLink>}
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
