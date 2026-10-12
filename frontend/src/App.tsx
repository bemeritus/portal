/**
 * The route table (§8), now organized by section.
 *
 * Everything except `/login` is nested inside `<RequireAuth>` and then inside
 * `<Layout>`. Below that the `templates` section sits behind its own door
 * (`<RequireSection>`): `/templates/*` is the category + Q&A world. `/admin/*`
 * is cross-section and stays at the top level behind `<RequireAdmin>`. The index
 * route sends each user to whichever section they can actually enter.
 */

import { Link, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RequireAdmin, RequireAuth, RequireSection } from "./components/RequireAuth";
import { useAuth } from "./auth/AuthContext";
import { inSection } from "./permissions";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BookmarksPage } from "./pages/BookmarksPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { DocumentPage } from "./pages/DocumentPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useTranslation } from "react-i18next";

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p className="muted">That address does not match anything here.</p>
      <Link className="btn secondary" to="/">
        Home
      </Link>
    </>
  );
}

/**
 * The bare index. Sends the user to whichever section they hold — templates
 * first, since it is the platform's original home — or explains that they hold
 * none, which is a real state (a user created with no sections at all).
 */
function SectionLanding() {
  const { user } = useAuth();
  const { t } = useTranslation();
  if (inSection(user, "templates")) return <Navigate to="/templates" replace />;
  return (
    <>
      <h1>{t("authz.noSectionsTitle")}</h1>
      <p className="muted">{t("authz.noSectionsBody")}</p>
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<SectionLanding />} />

          {/* Every signed-in user's own settings — theme and language. Cross-
              section, so it sits at the top level rather than under a door. */}
          <Route path="settings" element={<SettingsPage />} />

          {/* Templates — the category + Q&A world. */}
          <Route path="templates" element={<RequireSection section="templates" />}>
            <Route index element={<HomePage />} />
            <Route path="bookmarks" element={<BookmarksPage />} />
            {/* Before `docs/:id`, or "new" would be read as an id. */}
            <Route path="docs/new" element={<EditorPage />} />
            <Route path="docs/:id" element={<DocumentPage />} />
            <Route path="docs/:id/edit" element={<EditorPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="categories" element={<CategoriesPage />} />
            </Route>
          </Route>

          {/* Cross-section admin. */}
          <Route element={<RequireAdmin />}>
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/logs" element={<AuditLogPage />} />
            <Route path="admin/analytics" element={<AnalyticsPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* Anything outside the trees above (a stray link, an old bookmark) goes
          to the index, which forwards to the user's section. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
