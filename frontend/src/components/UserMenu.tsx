/**
 * The account card in the sidebar footer, and the menu it opens — the shadcn
 * dashboard-block "nav-user" pattern: a `SidebarMenuButton` trigger showing
 * avatar, name and role, opening a `DropdownMenu` with the quick settings
 * (dark-mode switch, language submenu), a Settings link and **Log out**.
 *
 * The quick controls are wired to the real theme state and i18n; Log out calls
 * the real sign-out and returns to `/login`.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronsUpDown, Globe, LogOut, Moon, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import type { Lang } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { LANGUAGES } from "../i18n";
import { useTheme } from "./ThemeSelect";
import type { User } from "../api/types";

/** First two initials of a name, for the avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

function Avatar({ username, className = "size-8" }: { username: string; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground uppercase ${className}`}
      aria-hidden="true"
    >
      {initials(username)}
    </span>
  );
}

export function UserMenu({ user }: { user: User }) {
  const { logout, setLanguage } = useAuth();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const [theme, setTheme] = useTheme();
  const { t, i18n } = useTranslation();
  const [loggingOut, setLoggingOut] = useState(false);

  const isDark = theme === "dark" || theme === "gruvbox";
  const currentLang = i18n.language.split("-")[0];
  const role = user.is_admin ? t("menu.roleAdmin") : t("menu.roleMember");

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
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar username={user.username} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{user.username}</span>
                <span className="truncate text-xs text-muted-foreground">{role}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar username={user.username} />
                <div className="grid flex-1 leading-tight">
                  <span className="truncate font-semibold">{user.username}</span>
                  <span className="truncate text-xs text-muted-foreground">{role}</span>
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link to="/settings">
                <Settings />
                {t("menu.settings")}
              </Link>
            </DropdownMenuItem>

            {/* Dark mode — a real switch over the light/dark themes; off (grey
                track, knob left) whenever a light theme is active. Selecting it
                must not close the menu, hence the preventDefault. */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setTheme(isDark ? "light" : "dark");
              }}
            >
              <Moon />
              <span className="flex-1">{t("menu.darkMode")}</span>
              <Switch
                checked={isDark}
                aria-label={t("menu.darkMode")}
                tabIndex={-1}
                onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                onClick={(e) => e.stopPropagation()}
              />
            </DropdownMenuItem>

            {/* Language — a submenu of radio items, themed like the app's own
                menus rather than the OS's native select popup. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe />
                <span className="flex-1">{t("menu.language")}</span>
                <span className="text-xs text-muted-foreground">
                  {(LANGUAGES.find((l) => l.value === currentLang) ?? LANGUAGES[0]).label}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={currentLang}
                    onValueChange={(value) => void setLanguage(value as Lang)}
                  >
                    {LANGUAGES.map((l) => (
                      <DropdownMenuRadioItem key={l.value} value={l.value}>
                        {l.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              variant="destructive"
              disabled={loggingOut}
              onSelect={() => void onLogout()}
            >
              <LogOut />
              {loggingOut ? t("menu.signingOut") : t("menu.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
