/**
 * The chrome every page except `/login` sits inside (§8).
 *
 * A top bar with the brand, the "New" shortcut, the theme switcher and the
 * signed-in username; a left rail with the sections and **Log out** at its
 * foot, in the danger colour so it is not mistaken for another section link.
 * Below 760px the rail collapses behind the bar's ☰ toggle — the two share one
 * open/closed state, which is why it lives here and not in either of them.
 */

import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { hasAnywhere } from "../permissions";
import { ThemeSelect } from "./ThemeSelect";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // A section link on a phone should take you there and get out of the way.
  // Without this the rail stays open over the page you just asked for.
  useEffect(() => {
    setRailOpen(false);
  }, [location.pathname]);

  const canWriteSomewhere = hasAnywhere(user, "write");

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      // The component usually unmounts on the line above; this matters for the
      // case where logout failed and the user is still looking at the button.
      setLoggingOut(false);
    }
  }

  return (
    <>
      <nav className="navbar">
        {/* `.nav-toggle` alone, deliberately. It carries its own styling and
            its own `display: none`, which `.btn`'s `display: inline-flex`
            would override — the stylesheet declares `.btn` later at equal
            specificity, so adding it here puts a hamburger on every desktop
            screen. */}
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={railOpen}
          aria-controls="sections"
          aria-label="Toggle sections"
          onClick={() => setRailOpen((open) => !open)}
        >
          ☰
        </button>
        <Link className="brand" to="/" onClick={() => setRailOpen(false)}>
          📚 Knowledge Base
        </Link>
        <span className="spacer" />
        <div className="nav-tools">
          {canWriteSomewhere && (
            <NavLink className="nav-link" to="/docs/new">
              New
            </NavLink>
          )}
          <ThemeSelect />
          {user && (
            <span className="who" title="Signed in as">
              {user.username}
            </span>
          )}
        </div>
      </nav>

      <div className="layout">
        <aside className={`sidebar${railOpen ? " open" : ""}`} id="sections" aria-label="Sections">
          <nav className="side-links">
            <NavLink to="/" end>
              Documents
            </NavLink>
            {user?.is_admin && (
              <>
                <NavLink to="/categories">Categories</NavLink>
                <NavLink to="/admin/users">Users</NavLink>
                <NavLink to="/admin/logs">Logs</NavLink>
              </>
            )}
          </nav>
          <div className="side-foot">
            <button type="button" className="btn danger" disabled={loggingOut} onClick={() => void onLogout()}>
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          </div>
        </aside>

        <main className="container">
          <Outlet />
        </main>
      </div>
    </>
  );
}
