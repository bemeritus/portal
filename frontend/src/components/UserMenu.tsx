/**
 * The account card at the foot of the sidebar, and the menu it opens.
 *
 * Resting, it is a single button — avatar, name, role, chevron. Pressing it
 * opens a card upward with the theme control and **Log out**; the theme select
 * carries the "dark mode" of the design's menu, kept as a real four-way choice
 * rather than a binary toggle because the app ships four themes.
 *
 * Closing is handled two ways every menu needs: a click outside it, and Escape.
 */

import { useEffect, useRef, useState } from "react";

import { THEMES, parseTheme, useTheme } from "./ThemeSelect";

interface UserMenuProps {
  username: string;
  isAdmin: boolean;
  loggingOut: boolean;
  onLogout: () => void;
}

/** First two initials of a name, for the avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

export function UserMenu({ username, isAdmin, loggingOut, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);

  const role = isAdmin ? "Admin" : "Member";

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="side-foot" ref={rootRef}>
      {open && (
        <div className="user-menu" role="menu" aria-label="Account">
          <div className="menu-head">
            <span className="avatar" aria-hidden="true">
              {initials(username)}
            </span>
            <span className="who-block">
              <span className="who-name">{username}</span>
              <span className="who-role">{role}</span>
            </span>
          </div>

          <hr className="menu-sep" />

          {/* The theme control — the menu's "appearance" row. A label wraps the
              select so the whole row is one hit target and reads like the
              others. */}
          <label className="menu-item" style={{ margin: 0 }}>
            <span className="menu-icon" aria-hidden="true">
              🌙
            </span>
            <span className="menu-label">Theme</span>
            <select
              className="menu-select"
              aria-label="Theme"
              value={theme}
              onChange={(e) => setTheme(parseTheme(e.target.value))}
            >
              {THEMES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <hr className="menu-sep" />

          <button
            type="button"
            className="menu-item danger"
            role="menuitem"
            disabled={loggingOut}
            onClick={onLogout}
          >
            <span className="menu-icon" aria-hidden="true">
              ⏻
            </span>
            <span className="menu-label">{loggingOut ? "Logging out…" : "Log out"}</span>
          </button>
        </div>
      )}

      <button
        type="button"
        className="user-card"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(username)}
        </span>
        <span className="who-block">
          <span className="who-name">{username}</span>
          <span className="who-role">{role}</span>
        </span>
        <span className="chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
    </div>
  );
}
