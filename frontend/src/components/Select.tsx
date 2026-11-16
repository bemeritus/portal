/**
 * The app's dropdown, now a thin wrapper over the shadcn/ui `<Select>` (Radix
 * underneath), keeping the prop shape every page already uses: a `value`, an
 * `onChange(value)`, and a flat `options` list.
 *
 * Radix refuses an item whose value is the empty string, but the pages lean on
 * `""` for their "All categories" / "— choose —" entries — so the wrapper maps
 * `""` to a private sentinel on the way in and back again on the way out.
 */

import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

/** Stands in for the empty-string value Radix cannot represent. */
const EMPTY = "__empty__";

export function Select({ value, onChange, options, id, ariaLabel, placeholder, className }: SelectProps) {
  return (
    <SelectRoot
      value={value === "" ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? "" : v)}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder ?? ""} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value === "" ? EMPTY : opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
