/**
 * The user's settings for this module — theme and length unit — saved on the
 * server (`/api/dc/settings`, table `user_settings`) and applied without a
 * reload. Everything that shows a length formats it through `useFmt()`.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { dcApi } from "./api";
import { makeFmt, type Fmt } from "./format";
import type { LengthUnit } from "./model/units";
import type { DcThemeName } from "./theme/tokens";

export interface DcSettings {
  /** `null` = follow the app's light/dark preference. */
  dc_theme: DcThemeName | null;
  dc_unit: LengthUnit;
}

interface Ctx {
  settings: DcSettings;
  /** The saved settings have arrived (or failed to: the defaults apply). */
  ready: boolean;
  /** The theme in effect (resolved from the app's preference when unset). */
  theme: DcThemeName;
  unit: LengthUnit;
  setUnit: (u: LengthUnit) => void;
  setTheme: (t: DcThemeName) => void;
}

const DEFAULTS: DcSettings = { dc_theme: null, dc_unit: "cm" };
const SettingsContext = createContext<Ctx | null>(null);

/** The app's own light/dark choice, from `<html data-theme>`. */
function appIsDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || t === "gruvbox";
}

export function DcSettingsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dc", "settings"],
    queryFn: ({ signal }) => dcApi.settings(signal),
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (body: Partial<DcSettings>) => dcApi.setSettings(body),
    onMutate: (body) => {
      // Apply at once; the server's answer replaces it.
      qc.setQueryData<DcSettings>(["dc", "settings"], (old) => ({
        ...(old ?? DEFAULTS),
        ...body,
      }));
    },
    onSuccess: (s) => qc.setQueryData(["dc", "settings"], s),
    onError: () => qc.invalidateQueries({ queryKey: ["dc", "settings"] }),
  });
  const settings = q.data ?? DEFAULTS;
  const value = useMemo<Ctx>(
    () => ({
      settings,
      ready: q.isSuccess || q.isError,
      theme: settings.dc_theme ?? (appIsDark() ? "studio" : "light"),
      unit: settings.dc_unit,
      setUnit: (dc_unit) => save.mutate({ dc_unit }),
      setTheme: (dc_theme) => save.mutate({ dc_theme }),
    }),
    // `save.mutate` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, q.isSuccess, q.isError],
  );
  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useDcSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useDcSettings outside <DcSettingsProvider>");
  return c;
}

/** Numbers and lengths in the user's language and unit. */
export function useFmt(): Fmt {
  const { t, i18n } = useTranslation();
  const { unit } = useDcSettings();
  return useMemo(
    () => makeFmt(t, i18n.language, unit),
    [t, i18n.language, unit],
  );
}
