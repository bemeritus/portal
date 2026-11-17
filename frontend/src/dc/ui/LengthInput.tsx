/**
 * A length field in the user's unit (мм / см / м): shows `fmt.input(mm)`,
 * keeps what is being typed, and reports whole millimetres — the API never
 * sees anything else.
 */

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { useFmt } from "../settings";

export function LengthInput({
  id,
  value,
  onChange,
  nullable = false,
  ...rest
}: {
  id: string;
  value: number | null;
  onChange: (mm: number | null) => void;
  nullable?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const fmt = useFmt();
  const shown = value === null ? "" : fmt.input(value);
  const [text, setText] = useState(shown);
  // Follow the value (and the unit) unless what is typed already means it.
  useEffect(() => {
    setText((cur) =>
      cur.trim() !== "" && fmt.parse(cur) === value ? cur : shown,
    );
  }, [shown, value, fmt]);
  const bad = text.trim() !== "" && fmt.parse(text) === null;
  return (
    <Input
      id={id}
      inputMode="decimal"
      className="dc-num"
      aria-invalid={bad || undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") onChange(nullable ? null : 0);
        else {
          const mm = fmt.parse(e.target.value);
          if (mm !== null) onChange(mm);
        }
      }}
      onBlur={() => !bad && setText(shown)}
      {...rest}
    />
  );
}
