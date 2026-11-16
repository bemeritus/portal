/**
 * The ⌘K / Ctrl-K command palette: a global launcher for jumping to a page or
 * straight to a document by typing — built on cmdk via the shadcn/ui
 * `<CommandDialog>`.
 *
 * Two kinds of result share one keyboard-driven list. **Nav commands** are a
 * static set built from the same permission helpers the rail uses, so the
 * palette never offers a door the user cannot open. **Document results** come
 * from the existing full-text search endpoint, debounced so it fires per pause
 * rather than per keystroke. Filtering is ours (`shouldFilter=false` on the
 * dialog): nav commands by label, documents by the server.
 *
 * Open/close state lives in `Layout`, which also owns the ⌘K key listener, so
 * the palette itself is a controlled component.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { documents as documentsApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface Item {
  key: string;
  label: string;
  to: string;
  hint?: string;
}

const TYPING_PAUSE_MS = 200;
const MAX_DOCS = 6;

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  // Reset each time it opens; clearing keeps the next open from flashing the
  // previous search.
  useEffect(() => {
    if (open) {
      setQ("");
      setDebounced("");
    }
  }, [open]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), TYPING_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [q]);

  // The nav commands this user may actually reach, mirroring the rail.
  const commands = useMemo<Item[]>(() => {
    const items: Item[] = [];
    items.push({ key: "documents", label: t("nav.documents"), to: "/templates" });
    items.push({ key: "drafts", label: t("nav.drafts"), to: "/templates/drafts" });
    items.push({ key: "bookmarks", label: t("nav.bookmarks"), to: "/templates/bookmarks" });
    items.push({ key: "new", label: t("nav.newDocument"), to: "/templates/docs/new" });
    items.push({ key: "categories", label: t("nav.categories"), to: "/templates/categories" });
    items.push({ key: "settings", label: t("menu.settings"), to: "/settings" });
    items.push({ key: "analytics", label: t("nav.analytics"), to: "/admin/analytics" });
    items.push({ key: "logs", label: t("nav.logs"), to: "/admin/logs" });
    if (user?.is_admin) {
      items.push({ key: "users", label: t("nav.users"), to: "/admin/users" });
    }
    return items;
  }, [user, t]);

  const filteredCommands = useMemo(() => {
    const needle = debounced.toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, debounced]);

  // Reuse the full-text document search; only ask once there is something to
  // look for and the palette is open.
  const docsQuery = useQuery({
    queryKey: ["command-search", debounced],
    queryFn: ({ signal }) => documentsApi.list({ q: debounced }, signal),
    enabled: open && debounced.length > 0,
  });

  const docItems = useMemo<Item[]>(
    () =>
      (docsQuery.data ?? []).slice(0, MAX_DOCS).map((d) => ({
        key: `doc-${d.id}`,
        label: d.title,
        to: `/templates/docs/${d.id}`,
        hint: d.category_name,
      })),
    [docsQuery.data],
  );

  function go(item: Item) {
    onClose();
    navigate(item.to);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("command.title")}
      description={t("command.placeholder")}
    >
      <CommandInput placeholder={t("command.placeholder")} value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>{t("command.noResults")}</CommandEmpty>
        {filteredCommands.length > 0 && (
          <CommandGroup heading={t("command.pages")}>
            {filteredCommands.map((item) => (
              <CommandItem key={item.key} value={item.key} onSelect={() => go(item)}>
                <span className="flex-1 truncate">{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {docItems.length > 0 && (
          <CommandGroup heading={t("command.documents")}>
            {docItems.map((item) => (
              <CommandItem key={item.key} value={item.key} onSelect={() => go(item)}>
                <span className="flex-1 truncate">{item.label}</span>
                {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
