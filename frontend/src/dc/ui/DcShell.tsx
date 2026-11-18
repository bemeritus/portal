/**
 * The server room module's own chrome (SPEC §10.1, mockups in
 * `dc-handoff/design/`): a full-screen page with its top bar — brand and room,
 * the sections (3D, plan, racks, catalog), search (⌘K), the length unit
 * (mm / cm / m) and the three themes — themed by tokens on the root
 * element. Every `/dc` route renders inside it.
 *
 * The command palette lives here; a room page registers what it can offer
 * (objects, actions) through `useShell().setRoomPalette`.
 */

import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Search } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Lang } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { registerDcLocales } from "../../i18n/dc";
import { useToolAccess } from "../../auth/useToolAccess";
import { Spinner } from "../../components/Loading";
import { LANGUAGES } from "../../i18n";
import { dcApi } from "../api";
import { UNITS } from "../model/units";
import { DcSettingsProvider, useDcSettings } from "../settings";
import { applyTokens, clearTokens, THEMES, TOKENS } from "../theme/tokens";
import "../theme/fonts";
import "../theme/dc.css";
import { CommandPalette, type RoomPalette } from "./CommandPalette";

// Before any DC page renders: the module's strings live in its own chunk.
registerDcLocales();

interface Shell {
  openPalette: (query?: string) => void;
  setRoomPalette: (p: RoomPalette | null) => void;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const c = useContext(ShellContext);
  if (!c) throw new Error("useShell outside <DcShell>");
  return c;
}

/** The `/dc` route element: access check, settings, chrome. */
export function DcShellRoute() {
  const { t } = useTranslation();
  const access = useToolAccess();
  if (access.loading) return <Spinner />;
  if (!access.can("dc_room"))
    return (
      <div className="p-8">
        <h1>{t("dc.title")}</h1>
        <p className="text-muted-foreground">{t("dc.noAccess")}</p>
        <Link to="/" className="text-link underline">
          {t("dc.shell.back")}
        </Link>
      </div>
    );
  return (
    <DcSettingsProvider>
      <DcShell>
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </DcShell>
    </DcSettingsProvider>
  );
}

function DcShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const settings = useDcSettings();
  const tokens = TOKENS[settings.theme];
  const [palette, setPalette] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [room, setRoom] = useState<RoomPalette | null>(null);
  const location = useLocation();
  const roomMatch = useMatch("/dc/:roomId/*");
  const roomId =
    roomMatch && /^\d+$/.test(roomMatch.params.roomId ?? "")
      ? Number(roomMatch.params.roomId)
      : null;
  const rooms = useQuery({
    queryKey: ["dc", "rooms"],
    queryFn: ({ signal }) => dcApi.rooms(signal),
  });
  const roomName = rooms.data?.find((r) => r.id === roomId)?.name;

  // On the document, so that dialogs and menus (portalled to <body>) are
  // themed too; the host's own variables are mapped in dc.css.
  useEffect(() => {
    const html = document.documentElement;
    applyTokens(html, tokens);
    html.classList.add("dc-active");
    return () => {
      html.classList.remove("dc-active");
      clearTokens(html);
    };
  }, [tokens]);

  // ⌘K / Ctrl+K opens the palette — in the capture phase, ahead of the
  // platform's own palette, while the module is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPalette((p) => ({ open: !p.open, query: "" }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const shell = useMemo<Shell>(
    () => ({
      openPalette: (query = "") => setPalette({ open: true, query }),
      setRoomPalette: setRoom,
    }),
    [],
  );

  const roomPage = roomId !== null && /^\/dc\/\d+\/?$/.test(location.pathname);
  const view = new URLSearchParams(location.search).get("view");
  const tab = location.pathname.endsWith("/racks")
    ? "racks"
    : location.pathname.startsWith("/dc/catalog")
      ? "catalog"
      : roomId !== null && !roomPage
        ? null
        : roomId !== null && view === "plan"
          ? "plan"
          : roomId !== null
            ? "3d"
            : null;
  const target = roomId ?? rooms.data?.[0]?.id ?? null;

  return (
    <ShellContext.Provider value={shell}>
      <div className="dc-root" data-dc-framed={tokens.framed} data-own-keys>
        <header className="dc-top">
          <div className="dc-top-left">
            <Link
              to="/"
              className="dc-sub no-print"
              title={t("dc.shell.back")}
              aria-label={t("dc.shell.back")}
            >
              <ArrowLeft className="size-4" />
            </Link>
            <Link to="/dc" className="dc-brand">
              {t("dc.shell.brand")}
            </Link>
            {roomName && roomName !== t("dc.shell.brand") && (
              <span className="dc-sub">{roomName}</span>
            )}
          </div>
          <nav className="dc-seg" aria-label={t("dc.shell.views")}>
            {target !== null && (
              <>
                {/* `?view=3d`: chosen, so not sent to the plan. */}
                <Link
                  to={`/dc/${target}?view=3d`}
                  aria-current={tab === "3d" ? "page" : undefined}
                >
                  3D
                </Link>
                <Link
                  to={`/dc/${target}?view=plan`}
                  aria-current={tab === "plan" ? "page" : undefined}
                >
                  {t("dc.shell.plan")}
                </Link>
                <Link
                  to={`/dc/${target}/racks`}
                  aria-current={tab === "racks" ? "page" : undefined}
                >
                  {t("dc.shell.racks")}
                </Link>
              </>
            )}
            <Link
              to={`/dc/catalog${target !== null ? `?room=${target}` : ""}`}
              aria-current={tab === "catalog" ? "page" : undefined}
            >
              {t("dc.shell.catalog")}
            </Link>
          </nav>
          <div className="dc-top-right">
            <button
              type="button"
              className="dc-search"
              onClick={() => shell.openPalette()}
            >
              <Search className="size-4" />
              <span className="truncate">{t("dc.shell.search")}</span>
              <kbd>⌘K</kbd>
            </button>
            <div
              className="dc-seg"
              role="radiogroup"
              aria-label={t("dc.shell.unit")}
            >
              {UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={settings.unit === u}
                  onClick={() => settings.setUnit(u)}
                >
                  {t(`dc.unitWord.${u}`)}
                </button>
              ))}
            </div>
            <div
              className="dc-seg"
              role="radiogroup"
              aria-label={t("dc.shell.theme")}
            >
              {THEMES.map((th) => (
                <button
                  key={th}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === th}
                  onClick={() => settings.setTheme(th)}
                >
                  {t(`dc.theme.${th}`)}
                </button>
              ))}
            </div>
            <UserButton />
          </div>
        </header>
        {/* The room is full-bleed; every other page scrolls under the top
            bar in the portal's usual column (1200 px, the same padding). */}
        {roomPage ? (
          children
        ) : (
          <main className="dc-scroll">
            <div className="dc-page">{children}</div>
          </main>
        )}
        <CommandPalette
          open={palette.open}
          initialQuery={palette.query}
          onClose={() => setPalette({ open: false, query: "" })}
          room={room}
        />
      </div>
    </ShellContext.Provider>
  );
}

function UserButton() {
  const { t, i18n } = useTranslation();
  const { user, setLanguage } = useAuth();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="dc-avatar" aria-label={user.username}>
          {user.username.slice(0, 1).toUpperCase()}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={i18n.language.split("-")[0]}
          onValueChange={(v) => void setLanguage(v as Lang)}
        >
          {LANGUAGES.map((l) => (
            <DropdownMenuRadioItem key={l.value} value={l.value}>
              {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/">{t("dc.shell.back")}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
