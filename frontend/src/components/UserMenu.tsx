/**
 * The account card at the foot of the sidebar, and the menu it opens.
 *
 * Resting, it is a single card-button — avatar, name, plan, chevron. Pressing
 * it opens a card upward with a profile header, the settings rows (theme as a
 * dark-mode switch, language as a themed dropdown), and **Log out** in red,
 * matching the product design. Closing is handled the two ways every menu
 * needs: a click outside it, and Escape.
 *
 * **Settings** links to the user's own settings page (`/settings`), where the
 * same theme and language choices live in full. The quick controls here — the
 * dark-mode switch and the language dropdown — are wired to the real theme
 * state and i18n; Log out to the real sign-out.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LANGUAGES } from "../i18n";
import { useTheme } from "./ThemeSelect";

interface UserMenuProps {
  username: string;
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

/** Thin line icons (stroke = currentColor) so each follows its row's colour. */
const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const Icons = {
  settings: (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  moon: (
    <svg {...svgProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  globe: (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  logout: (
    <svg {...svgProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  chevronRight: (
    <svg {...svgProps} width="18" height="18">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  chevronUp: (
    <svg {...svgProps} width="18" height="18">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ),
  chevronDown: (
    <svg {...svgProps} width="16" height="16">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  check: (
    <svg {...svgProps} width="16" height="16">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

/**
 * The Language row: a themed dropdown replacing the native `<select>`, so the
 * open list follows the app's theme (panel, border, accent) instead of the
 * OS's own menu. Behaves like the account menu — closes on Escape or a click
 * outside its own subtree — and stops clicks from bubbling up to the parent
 * menu's outside-click handler.
 */
function LangSelect() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = i18n.language.split("-")[0];
  const active = LANGUAGES.find((l) => l.value === current) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lang-select" ref={rootRef}>
      <button
        type="button"
        className="menu-item"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="menu-icon">{Icons.globe}</span>
        <span className="menu-label">{t("menu.language")}</span>
        <span className="lang-current">
          {active.label}
          <span className="lang-caret" aria-hidden="true">
            {Icons.chevronDown}
          </span>
        </span>
      </button>

      {open && (
        <ul className="lang-list" role="listbox" aria-label={t("menu.language")}>
          {LANGUAGES.map((l) => {
            const selected = l.value === current;
            return (
              <li key={l.value}>
                <button
                  type="button"
                  className={selected ? "lang-option selected" : "lang-option"}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    void i18n.changeLanguage(l.value);
                    setOpen(false);
                  }}
                >
                  <span className="lang-option-label">{l.label}</span>
                  {selected && <span className="lang-check">{Icons.check}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function UserMenu({ username, loggingOut, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  const isDark = theme === "dark" || theme === "gruvbox";

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

  const avatar = (
    <span className="avatar" aria-hidden="true">
      {initials(username)}
    </span>
  );
  const identity = (
    <span className="who-block">
      <span className="who-name">{username}</span>
    </span>
  );

  return (
    <div className="side-foot" ref={rootRef}>
      {open && (
        <div className="user-menu" role="menu" aria-label={t("menu.account")}>
          {/* Profile header — a pressable row that would lead to the profile. */}
          <button type="button" className="menu-profile" role="menuitem">
            {avatar}
            {identity}
            <span className="menu-arrow">{Icons.chevronRight}</span>
          </button>

          <hr className="menu-sep" />

          <Link to="/settings" className="menu-item" role="menuitem" onClick={() => setOpen(false)}>
            <span className="menu-icon">{Icons.settings}</span>
            <span className="menu-label">{t("menu.settings")}</span>
          </Link>

          {/* Dark mode — a real switch over the light/dark themes; off (grey
              track, knob left) whenever a light theme is active. */}
          <label className="menu-item">
            <span className="menu-icon">{Icons.moon}</span>
            <span className="menu-label">{t("menu.darkMode")}</span>
            <span className="switch">
              <input
                type="checkbox"
                aria-label={t("menu.darkMode")}
                checked={isDark}
                onChange={(e) => setTheme(e.target.checked ? "dark" : "light")}
              />
              <span className="track" aria-hidden="true" />
              <span className="knob" aria-hidden="true" />
            </span>
          </label>

          {/* Language — a custom, themed dropdown (see `LangSelect`) so the
              open list matches the platform's own menus rather than the OS's
              native select popup. */}
          <LangSelect />

          <hr className="menu-sep" />

          <button
            type="button"
            className="menu-item danger"
            role="menuitem"
            disabled={loggingOut}
            onClick={onLogout}
          >
            <span className="menu-icon">{Icons.logout}</span>
            <span className="menu-label">{loggingOut ? t("menu.signingOut") : t("menu.signOut")}</span>
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
        {avatar}
        {identity}
        <span className="chevron">{Icons.chevronUp}</span>
      </button>
    </div>
  );
}
