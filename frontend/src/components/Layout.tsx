/**
 * The chrome every page except `/login` sits inside (§8) — the shadcn
 * dashboard-block shell: `SidebarProvider` wrapping the `AppSidebar` and a
 * `SidebarInset` whose slim header carries the collapse trigger.
 *
 * The global keyboard shortcuts and the command palette / help overlays live
 * here because they need the router and theme state.
 */

import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "../auth/AuthContext";
import { comboFromEvent, isTypingTarget, SHORTCUTS } from "../shortcuts/registry";
import { useShortcuts } from "../shortcuts/ShortcutsContext";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useTheme } from "./ThemeSelect";

export function Layout() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // The server room's 3D view takes the whole area beside the sidebar.
  const fullBleed = /^\/dc\/\d+\/?$/.test(location.pathname);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { bindings } = useShortcuts();
  const [, setTheme] = useTheme();

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
        // A view that uses plain keys itself (the server room's walk mode:
        // W A S D, Q E, R) keeps them while it has the focus.
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          e.target instanceof Element &&
          e.target.closest("[data-own-keys]")
        )
          return;
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

  return (
    <SidebarProvider>
      <AppSidebar onSearch={() => setPaletteOpen(true)} />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" aria-label={t("nav.toggleSections")} />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          {/* The brand repeats here only while the sidebar is away (mobile). */}
          <span className="text-sm font-bold md:hidden">{t("app.name")}</span>
        </header>

        <main
          className={
            fullBleed
              ? "flex min-h-0 w-full min-w-0 flex-1 flex-col"
              : "mx-auto w-full max-w-[1200px] min-w-0 flex-1 px-4 pt-6 pb-16 md:px-6"
          }
        >
          <Outlet />
        </main>
      </SidebarInset>

      {user && (
        <>
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
          <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        </>
      )}
    </SidebarProvider>
  );
}
