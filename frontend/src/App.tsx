/**
 * The route table (§8).
 *
 * Everything except `/login` is nested inside `<RequireAuth>` and then inside
 * `<Layout>`. Any signed-in user reaches the whole `/templates/*` world; only
 * `/templates/categories` and `/admin/*` stay behind `<RequireAdmin>`. The index
 * forwards to the documents list.
 */

import { Link, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BookmarksPage } from "./pages/BookmarksPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { DocumentPage } from "./pages/DocumentPage";
import { DraftsPage } from "./pages/DraftsPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";

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

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/templates" replace />} />

          {/* Every signed-in user's own settings — theme and language. */}
          <Route path="settings" element={<SettingsPage />} />

          {/* The category + Q&A world. */}
          <Route path="templates">
            <Route index element={<HomePage />} />
            <Route path="drafts" element={<DraftsPage />} />
            <Route path="bookmarks" element={<BookmarksPage />} />
            {/* Before `docs/:id`, or "new" would be read as an id. */}
            <Route path="docs/new" element={<EditorPage />} />
            <Route path="docs/:id" element={<DocumentPage />} />
            <Route path="docs/:id/edit" element={<EditorPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="categories" element={<CategoriesPage />} />
            </Route>
          </Route>

          {/* Admin-only. */}
          <Route element={<RequireAdmin />}>
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/logs" element={<AuditLogPage />} />
            <Route path="admin/analytics" element={<AnalyticsPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* Anything outside the trees above (a stray link, an old bookmark). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
