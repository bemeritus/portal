/**
 * The route table (§8).
 *
 * Everything except `/login` is nested inside `<RequireAuth>` and then inside
 * `<Layout>`, so the chrome and the guard are declared once rather than
 * repeated per page. The admin sections sit behind a second guard.
 */

import { Link, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { DocumentPage } from "./pages/DocumentPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p className="muted">That address does not match anything here.</p>
      <Link className="btn secondary" to="/">
        Back to documents
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
          <Route index element={<HomePage />} />
          {/* Before `/docs/:id`, or "new" would be read as an id. */}
          <Route path="docs/new" element={<EditorPage />} />
          <Route path="docs/:id" element={<DocumentPage />} />
          <Route path="docs/:id/edit" element={<EditorPage />} />

          <Route element={<RequireAdmin />}>
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/logs" element={<AuditLogPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* Anything outside the two trees above (there is nothing today, but a
          stray link or an old bookmark counts) goes home. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
