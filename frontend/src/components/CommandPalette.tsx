/**
 * The ⌘K / Ctrl-K command palette: a global launcher for jumping to a page or
 * straight to a document by typing.
 *
 * Two kinds of result share one keyboard-driven list. **Nav commands** are a
 * static set built from the same permission helpers the rail uses, so the
 * palette never offers a door the user cannot open. **Document results** come
 * from the existing full-text search endpoint, debounced so it fires per pause
 * rather than per keystroke. ↑/↓ move the selection across both, Enter opens it,
 * Escape (or a backdrop click) closes.
 *
 * Open/close state lives in `Layout`, which also owns the ⌘K key listener, so
 * the palette itself is a controlled component.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { documents as documentsApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { hasAnywhere, inSection } from "../permissions";

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
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);

  // Reset and focus each time it opens; clearing on close keeps the next open
  // from flashing the previous search.
  useEffect(() => {
    if (open) {
      setQ("");
      setDebounced("");
      setSelected(0);
      // Focus after the element is actually in the DOM.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), TYPING_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [q]);

  // The nav commands this user may actually reach, mirroring the rail's gating.
  const commands = useMemo<Item[]>(() => {
    const items: Item[] = [];
    if (inSection(user, "templates")) {
      items.push({ key: "documents", label: t("nav.documents"), to: "/templates" });
      items.push({ key: "bookmarks", label: t("nav.bookmarks"), to: "/templates/bookmarks" });
      if (hasAnywhere(user, "write")) {
        items.push({ key: "new", label: t("nav.newDocument"), to: "/templates/docs/new" });
      }
      if (user?.is_admin) {
        items.push({ key: "categories", label: t("nav.categories"), to: "/templates/categories" });
      }
    }
    if (inSection(user, "learning")) {
      items.push({ key: "learning", label: t("nav.overview"), to: "/learning" });
      items.push({ key: "resources", label: t("nav.resources"), to: "/learning/resources" });
      items.push({ key: "tests", label: t("nav.tests"), to: "/learning/tests" });
      items.push({ key: "labs", label: t("nav.labs"), to: "/learning/labs" });
    }
    items.push({ key: "settings", label: t("menu.settings"), to: "/settings" });
    if (user?.is_admin) {
      items.push({ key: "users", label: t("nav.users"), to: "/admin/users" });
      items.push({ key: "analytics", label: t("nav.analytics"), to: "/admin/analytics" });
      items.push({ key: "logs", label: t("nav.logs"), to: "/admin/logs" });
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

  const all = useMemo(() => [...filteredCommands, ...docItems], [filteredCommands, docItems]);

  // Keep the selection in range as the list shrinks or grows.
  useEffect(() => {
    setSelected((s) => (all.length === 0 ? 0 : Math.min(s, all.length - 1)));
  }, [all.length]);

  if (!open) return null;

  function go(item: Item | undefined) {
    if (!item) return;
    onClose();
    navigate(item.to);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (all.length === 0 ? 0 : (s + 1) % all.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (all.length === 0 ? 0 : (s - 1 + all.length) % all.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(all[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const commandCount = filteredCommands.length;

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("command.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="cmdk-input"
          placeholder={t("command.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" role="listbox">
          {all.length === 0 ? (
            <div className="cmdk-empty">{t("command.noResults")}</div>
          ) : (
            <>
              {filteredCommands.length > 0 && (
                <div className="cmdk-group">{t("command.pages")}</div>
              )}
              {filteredCommands.map((item, i) => (
                <Row
                  key={item.key}
                  item={item}
                  active={selected === i}
                  onHover={() => setSelected(i)}
                  onPick={() => go(item)}
                />
              ))}
              {docItems.length > 0 && <div className="cmdk-group">{t("command.documents")}</div>}
              {docItems.map((item, i) => (
                <Row
                  key={item.key}
                  item={item}
                  active={selected === commandCount + i}
                  onHover={() => setSelected(commandCount + i)}
                  onPick={() => go(item)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  item,
  active,
  onHover,
  onPick,
}: {
  item: Item;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cmdk-row${active ? " active" : ""}`}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <span className="cmdk-label">{item.label}</span>
      {item.hint && <span className="cmdk-hint">{item.hint}</span>}
    </button>
  );
}
