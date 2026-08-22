/**
 * The account card at the foot of the sidebar, and the menu it opens.
 *
 * Resting, it is a single card-button — avatar, name, plan, chevron. Pressing
 * it opens a card upward with a profile header, the settings rows (theme as a
 * dark-mode switch, language), and **Log out** in red, matching the product
 * design. Closing is handled the two ways every menu needs: a click outside it,
 * and Escape.
 *
 * Settings, Language and Feedback are presentational for now — there is no
 * settings page, no i18n and no feedback endpoint behind them yet — so they
 * render as the design shows but do not act. The dark-mode switch and Log out
 * are wired to the real theme state and the real sign-out.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { LANGUAGES } from "../i18n";
import { useTheme } from "./ThemeSelect";

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
  chat: (
    <svg {...svgProps}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
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
};

export function UserMenu({ username, isAdmin, loggingOut, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const { t, i18n } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  // "Bepul" (free) in the design is the plan line; the app's own account state
  // is the role, so that is what the sub-line shows.
  const role = isAdmin ? t("menu.roleAdmin") : t("menu.roleMember");
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
      <span className="who-role">{role}</span>
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

          <button type="button" className="menu-item" role="menuitem">
            <span className="menu-icon">{Icons.settings}</span>
            <span className="menu-label">{t("menu.settings")}</span>
          </button>

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

          {/* Language — the value on the right is a borderless select, so the
              row reads like the design's "Language · English" but actually
              switches the whole app. */}
          <label className="menu-item">
            <span className="menu-icon">{Icons.globe}</span>
            <span className="menu-label">{t("menu.language")}</span>
            <select
              className="menu-lang"
              aria-label={t("menu.language")}
              value={i18n.language.split("-")[0]}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <hr className="menu-sep" />

          <button type="button" className="menu-item" role="menuitem">
            <span className="menu-icon">{Icons.chat}</span>
            <span className="menu-label">{t("menu.sendFeedback")}</span>
          </button>

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
