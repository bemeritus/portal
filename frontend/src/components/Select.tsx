/**
 * The app's dropdown: one themed control that replaces every native `<select>`,
 * so an opened list follows the platform's theme (panel, border, accent) instead
 * of the OS's own menu — the same treatment the language switcher got.
 *
 * The trigger keeps focus throughout; the list is a popup driven by
 * `aria-activedescendant`, which keeps the keyboard model (↑/↓, Home/End,
 * Enter/Space to choose, Escape to close, type-to-jump) without juggling focus
 * across option nodes. It closes on Escape or a click outside its own subtree.
 *
 * Options carry their own labels, including any leading "— choose —" / "All"
 * entry (pass it with `value: ""`), so callers render exactly what they had.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  ariaLabel?: string;
  /** Shown when `value` matches no option (rare); defaults to empty. */
  placeholder?: string;
  className?: string;
}

const chevron = (
  <svg
    className="select-caret"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function Select({ value, onChange, options, id, ariaLabel, placeholder, className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reactId = useId();
  const baseId = id ?? reactId;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex].label : (placeholder ?? "");

  // Close on a click anywhere outside, like the account menu.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Keep the active option in view as the keyboard moves it.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function openList() {
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function choose(i: number) {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Tab":
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      default:
        // Type-to-jump: land on the next option whose label starts with the
        // key, wrapping from the top if there is none below the current one.
        if (e.key.length === 1) {
          const needle = e.key.toLowerCase();
          const starts = (o: SelectOption) => o.label.toLowerCase().startsWith(needle);
          const below = options.findIndex((o, i) => i > active && starts(o));
          const idx = below >= 0 ? below : options.findIndex(starts);
          if (idx >= 0) setActive(idx);
        }
    }
  }

  return (
    <div className={`select${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        type="button"
        id={baseId}
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{current}</span>
        {chevron}
      </button>

      {open && (
        <ul
          className="select-list"
          role="listbox"
          ref={listRef}
          aria-label={ariaLabel}
          aria-activedescendant={`${baseId}-opt-${active}`}
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            return (
              <li key={opt.value} id={`${baseId}-opt-${i}`} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`select-option${selected ? " selected" : ""}${i === active ? " active" : ""}`}
                  // Keep focus on the trigger so the keyboard model holds.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className="select-option-label">{opt.label}</span>
                  {selected && (
                    <svg
                      className="select-check"
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
