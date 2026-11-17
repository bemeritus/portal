/**
 * Search the room — names, owners, serials, notes of devices, cells and
 * objects. Picking a result flies to it; a device's rack opens its doors.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { dcApi } from "../api";
import type { SelRef } from "../engine/DcEngine";
import type { SearchHit } from "../types";

export function SearchBox({ roomId, onPick }: { roomId: number; onPick: (ref: SelRef) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const q = useQuery({
    queryKey: ["dc", "search", roomId, term],
    queryFn: ({ signal }) => dcApi.search(roomId, term, signal),
    enabled: term.length > 0,
  });
  const pick = (h: SearchHit) => {
    setOpen(false);
    if (h.kind === "device") onPick({ type: "device", id: h.id, rackId: h.object_id });
    else if (h.kind === "cell") onPick({ type: "cell", shelfId: h.object_id, cellNo: h.cell_no ?? 1 });
    else onPick({ type: "object", id: h.object_id });
  };
  return (
    <div className="relative w-64">
      <Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
      <Input
        className="h-8 pl-8"
        placeholder={t("dc.search.placeholder")}
        aria-label={t("dc.search.label")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.data?.[0]) pick(q.data[0]);
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && term && (
        <ul className="absolute z-20 mt-1 max-h-80 w-96 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md" role="listbox">
          {q.data?.length === 0 && <li className="px-2 py-1 text-muted-foreground">{t("dc.search.none")}</li>}
          {q.data?.map((h) => (
            <li key={`${h.kind}-${h.id}-${h.cell_no ?? ""}`}>
              <button type="button" role="option" className="w-full rounded px-2 py-1 text-left hover:bg-accent" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
                <div className="font-medium">{h.name}</div>
                <div className="text-xs text-muted-foreground">
                  {h.kind === "device" && `${h.object_name} · U${h.u_bottom}${h.u_height && h.u_height > 1 ? `–${(h.u_bottom ?? 0) + h.u_height - 1}` : ""} · ${t(`dc.face.${h.face ?? "front"}`)}`}
                  {h.kind === "cell" && `${h.object_name} · ${t("dc.shelf.cell", { n: h.cell_no })}`}
                  {h.kind === "object" && t("dc.search.object")}
                  {h.owner && ` · ${h.owner}`}
                  {h.serial && ` · ${h.serial}`}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
