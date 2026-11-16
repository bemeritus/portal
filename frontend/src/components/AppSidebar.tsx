/**
 * The application sidebar, built on shadcn/ui's `<Sidebar>` — the official
 * dashboard-block layout: brand at the top, a solid "quick create" primary
 * button, the main navigation with icons, an Admin group, utility items at the
 * foot, and the account card (see `UserMenu`) in the footer.
 *
 * Collapses to an icon rail on desktop (the header's trigger / Ctrl-B) and to
 * a sheet on mobile; navigating closes the sheet.
 */

import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  FileText,
  FolderOpen,
  Network,
  PencilLine,
  Plus,
  ScrollText,
  Search,
  Settings,
  Star,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAuth } from "../auth/AuthContext";
import { UserMenu } from "./UserMenu";

interface AppSidebarProps {
  /** Opens the ⌘K command palette — the sidebar's Search item. */
  onSearch: () => void;
}

export function AppSidebar({ onSearch }: AppSidebarProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();

  // A section link on a phone should take you there and get out of the way.
  useEffect(() => {
    setOpenMobile(false);
  }, [location.pathname, setOpenMobile]);

  const path = location.pathname;

  const mainItems = [
    {
      to: "/templates",
      label: t("nav.documents"),
      icon: FileText,
      active: path === "/templates" || path.startsWith("/templates/docs"),
    },
    {
      to: "/templates/drafts",
      label: t("nav.drafts"),
      icon: PencilLine,
      active: path.startsWith("/templates/drafts"),
    },
    {
      to: "/templates/bookmarks",
      label: t("nav.bookmarks"),
      icon: Star,
      active: path.startsWith("/templates/bookmarks"),
    },
    {
      to: "/templates/categories",
      label: t("nav.categories"),
      icon: FolderOpen,
      active: path.startsWith("/templates/categories"),
    },
  ];

  const adminItems = [
    {
      to: "/admin/analytics",
      label: t("nav.analytics"),
      icon: BarChart3,
      active: path.startsWith("/admin/analytics"),
    },
    {
      to: "/admin/logs",
      label: t("nav.logs"),
      icon: ScrollText,
      active: path.startsWith("/admin/logs"),
    },
    ...(user?.is_admin
      ? [
          {
            to: "/admin/users",
            label: t("nav.users"),
            icon: Users,
            active: path.startsWith("/admin/users"),
          },
        ]
      : []),
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
              <Link to="/">
                <BookOpen className="!size-5" />
                <span className="text-base font-bold">{t("app.name")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-2">
            {/* The primary action, solid like the block's "Quick Create". */}
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("nav.newDocument")}
                  className="min-w-8 bg-primary font-medium text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                >
                  <Link to="/templates/docs/new">
                    <Plus />
                    <span>{t("nav.newDocument")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            <SidebarMenu>
              {mainItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild tooltip={item.label} isActive={item.active}>
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.admin")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {adminItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild tooltip={item.label} isActive={item.active}>
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.tools")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("nav.portChecker")}
                  isActive={path.startsWith("/tools/port-check")}
                >
                  <Link to="/tools/port-check">
                    <Network />
                    <span>{t("nav.portChecker")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Utility items pinned above the account card, like the block's
            Settings / Get Help / Search group. */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("menu.settings")}
                  isActive={path.startsWith("/settings")}
                >
                  <Link to="/settings">
                    <Settings />
                    <span>{t("menu.settings")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={t("nav.search")} onClick={onSearch}>
                  <Search />
                  <span>{t("nav.search")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>{user && <UserMenu user={user} />}</SidebarFooter>
    </Sidebar>
  );
}
