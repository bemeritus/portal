/**
 * CSV import of devices: choose a file, see the dry run's diff (new, changed,
 * unchanged, and every problem by line), then apply it all at once — or not
 * at all. The format is the inventory template's (`;`, UTF-8); headers may be
 * in any of the three languages.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, errorMessage } from "../../api/client";
import { ErrorFlash, Flash } from "../../components/Flash";
import { translateApiError } from "../../i18n/errors";
import { dcApi } from "../api";
import type { DeviceFields, ImportResult, ImportRowError } from "../types";

const FIELDS: (keyof DeviceFields)[] = [
  "u_bottom",
  "u_height",
  "face",
  "kind",
  "name",
  "owner",
  "serial",
  "power_w",
  "power_src",
  "status",
  "note",
];

export function ImportDialog({
  roomId,
  revision,
  onClose,
  onDone,
}: {
  roomId: number;
  revision: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);

  const rowError = (e: ImportRowError) =>
    t("dc.import.line", { line: e.line }) +
    ": " +
    t(`dc.import.error.${e.code}` as never, {
      column: e.column
        ? t(`dc.csvColumn.${e.column}` as never, { defaultValue: e.column })
        : "",
      value: e.value ?? "",
      defaultValue: e.code,
    });

  async function check(text: string) {
    setBusy(true);
    setError(null);
    try {
      setResult(await dcApi.importDevices(roomId, text, true));
    } catch (e) {
      setError(translateApiError(errorMessage(e), i18n.language));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!csv || !result) return;
    setBusy(true);
    setError(null);
    try {
      const r = await dcApi.importDevices(roomId, csv, false, result.revision);
      setDone(r);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone changed the room since the dry run: check again.
        setError(translateApiError(e.message, i18n.language));
        await check(csv);
      } else setError(translateApiError(errorMessage(e), i18n.language));
    } finally {
      setBusy(false);
    }
  }

  const fmtVal = (v: unknown) => (v === null || v === "" ? "—" : String(v));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("dc.import.title")}</DialogTitle>
        </DialogHeader>
        {done ? (
          <div className="space-y-3">
            <Flash kind="ok">
              {t("dc.import.applied", {
                created: done.created,
                updated: done.updated,
                revision: done.revision,
              })}
            </Flash>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t("dc.import.help")}</p>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label={t("dc.import.file")}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name);
                const text = await f.text();
                setCsv(text);
                setResult(null);
                await check(text);
              }}
            />
            <ErrorFlash error={error} />
            {busy && (
              <p className="text-muted-foreground">{t("dc.import.checking")}</p>
            )}
            {result && (
              <>
                <p>
                  {fileName}:{" "}
                  {t("dc.import.summary", {
                    created: result.created,
                    updated: result.updated,
                    unchanged: result.unchanged,
                    errors: result.plan.errors.length,
                  })}
                </p>
                {result.plan.errors.length > 0 && (
                  <div className="rounded-md border border-destructive/50 p-2">
                    <div className="font-medium text-destructive">
                      {t("dc.import.fix")}
                    </div>
                    <ul className="list-disc pl-4 text-xs">
                      {result.plan.errors.map((e, i) => (
                        <li key={i}>{rowError(e)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th>{t("dc.import.line", { line: "" })}</th>
                      <th>{t("dc.import.action")}</th>
                      <th>{t("dc.device.rack")}</th>
                      <th>{t("dc.import.details")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.plan.changes.map((c) => (
                      <tr key={c.line} className="border-t align-top">
                        <td className="py-1">{c.line}</td>
                        <td
                          className={
                            c.action === "create"
                              ? "text-success"
                              : c.action === "update"
                                ? "text-tag-3"
                                : "text-muted-foreground"
                          }
                        >
                          {t(`dc.import.${c.action}`)}
                        </td>
                        <td>{c.rack}</td>
                        <td>
                          {c.action === "create" &&
                            `U${c.after.u_bottom} · ${c.after.name}`}
                          {c.action === "update" &&
                            FIELDS.filter(
                              (f) => c.before[f] !== c.after[f],
                            ).map((f) => (
                              <div key={f}>
                                {t(`dc.csvColumn.${f}` as never, {
                                  defaultValue: f,
                                })}
                                :{" "}
                                <span className="line-through">
                                  {fmtVal(c.before[f])}
                                </span>{" "}
                                → {fmtVal(c.after[f])}
                              </div>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <Button
                    disabled={
                      busy ||
                      result.plan.errors.length > 0 ||
                      result.created + result.updated === 0
                    }
                    onClick={() => void apply()}
                  >
                    {t("dc.import.apply", {
                      n: result.created + result.updated,
                    })}
                  </Button>
                  <Button variant="ghost" onClick={onClose}>
                    {t("common.cancel")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("dc.import.atomic", { revision })}
                </p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
