/**
 * The route table (§8).
 *
 * Everything except `/login` is nested inside `<RequireAuth>` and then inside
 * `<Layout>`. Any signed-in user reaches the whole `/templates/*` world; only
 * `/templates/categories` and `/admin/*` stay behind `<RequireAdmin>`. The index
 * forwards to the documents list.
 */

import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/Loading";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BookmarksPage } from "./pages/BookmarksPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { DocumentPage } from "./pages/DocumentPage";
import { DraftsPage } from "./pages/DraftsPage";
import { EditorPage } from "./pages/EditorPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { PortCheckerPage } from "./pages/PortCheckerPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkLogEditorPage } from "./pages/WorkLogEditorPage";
import { WorkLogEntryPage } from "./pages/WorkLogEntryPage";
import { WorkLogListPage } from "./pages/WorkLogListPage";

// The server room pages carry three.js; they load on first visit, so the rest
// of the app does not download a 3D engine it never uses.
const DcRoomsPage = lazy(() => import("./dc/ui/DcRoomsPage").then((m) => ({ default: m.DcRoomsPage })));
const DcRoomPage = lazy(() => import("./dc/ui/DcRoomPage").then((m) => ({ default: m.DcRoomPage })));
const DcHistoryPage = lazy(() => import("./dc/ui/DcHistoryPage").then((m) => ({ default: m.DcHistoryPage })));
const DcShellRoute = lazy(() => import("./dc/ui/DcShell").then((m) => ({ default: m.DcShellRoute })));
const DcRacksPage = lazy(() => import("./dc/ui/DcRacksPage").then((m) => ({ default: m.DcRacksPage })));
const DcLabelsPage = lazy(() => import("./dc/ui/DcLabelsPage").then((m) => ({ default: m.DcLabelsPage })));
const DcCatalogPage = lazy(() => import("./dc/ui/DcCatalogPage").then((m) => ({ default: m.DcCatalogPage })));
const DcCatalogItemPage = lazy(() =>
  import("./dc/ui/DcCatalogItemPage").then((m) => ({ default: m.DcCatalogItemPage })),
);
const DcCatalogComparePage = lazy(() =>
  import("./dc/ui/DcCatalogComparePage").then((m) => ({ default: m.DcCatalogComparePage })),
);

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p className="mb-4 text-muted-foreground">That address does not match anything here.</p>
      <Button asChild variant="outline">
        <Link to="/">Home</Link>
      </Button>
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        {/* The server room module, behind the internal tools family → dc_room.
            Its own full-screen chrome (SPEC §10.1), outside the host layout. */}
        <Route
          path="dc"
          element={
            <Suspense fallback={<Spinner />}>
              <DcShellRoute />
            </Suspense>
          }
        >
          <Route index element={<DcRoomsPage />} />
          <Route path="catalog" element={<DcCatalogPage />} />
          <Route path="catalog/item/:id" element={<DcCatalogItemPage />} />
          <Route path="catalog/compare" element={<DcCatalogComparePage />} />
          <Route path="catalog/:section" element={<DcCatalogPage />} />
          <Route path=":roomId" element={<DcRoomPage />} />
          <Route path=":roomId/racks" element={<DcRacksPage />} />
          <Route path=":roomId/labels" element={<DcLabelsPage />} />
          <Route path=":roomId/history" element={<DcHistoryPage />} />
        </Route>

        <Route element={<Layout />}>
          <Route index element={<Navigate to="/templates" replace />} />

          {/* Every signed-in user's own settings — theme and language. */}
          <Route path="settings" element={<SettingsPage />} />

          {/* Small network utilities, open to any signed-in user. */}
          <Route path="tools/port-check" element={<PortCheckerPage />} />

          {/* The server-room work log — structured journal entries, open to
              any signed-in user like the documents are. "new" before ":id" so
              it is not read as an id. */}
          <Route path="worklog">
            <Route index element={<WorkLogListPage />} />
            <Route path="new" element={<WorkLogEditorPage />} />
            <Route path=":id" element={<WorkLogEntryPage />} />
            <Route path=":id/edit" element={<WorkLogEditorPage />} />
          </Route>

          {/* The category + Q&A world. Categories are managed by any user
              (adding and renaming); only deleting stays admin-only, enforced
              inside the page and on the server. */}
          <Route path="templates">
            <Route index element={<HomePage />} />
            <Route path="drafts" element={<DraftsPage />} />
            <Route path="bookmarks" element={<BookmarksPage />} />
            {/* Before `docs/:id`, or "new" would be read as an id. */}
            <Route path="docs/new" element={<EditorPage />} />
            <Route path="docs/:id" element={<DocumentPage />} />
            <Route path="docs/:id/edit" element={<EditorPage />} />
            <Route path="docs/:id/history" element={<HistoryPage />} />
            <Route path="categories" element={<CategoriesPage />} />
          </Route>

          {/* The log and analytics are read-only and open to any signed-in
              user; only user management stays admin-only. */}
          <Route path="admin/logs" element={<AuditLogPage />} />
          <Route path="admin/analytics" element={<AnalyticsPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="admin/users" element={<AdminUsersPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* Anything outside the trees above (a stray link, an old bookmark). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
