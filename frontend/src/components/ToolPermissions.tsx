/**
 * «Внутренние инструменты» on the user admin page: one row per registered
 * tool, a checkbox per level it offers. Every click saves the user's whole set
 * (`PUT /api/users/{id}/tools`), and the server writes one audit entry per
 * grant added or removed.
 *
 * `edit` implies `use` in the server's rule, so ticking `edit` shows `use` as
 * ticked and locked rather than storing a second row.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "../api/client";
import { users as usersApi } from "../api/endpoints";
import type { ToolGrant, ToolKey, ToolLevel, User } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import type { TKey } from "../i18n";
import { ErrorFlash } from "./Flash";
import { Spinner } from "./Loading";
import { Select } from "./Select";

export const TOOL_NAME: Record<ToolKey, TKey> = {
  port_checker: "tools.portChecker",
  mail_tester: "tools.mailTester",
  online_pinger: "tools.onlinePinger",
  dns_checker: "tools.dnsChecker",
  dc_room: "tools.dcRoom",
};

const LEVEL_NAME: Record<ToolLevel, TKey> = {
  use: "tools.levelUse",
  edit: "tools.levelEdit",
};

const LEVEL_HINT: Partial<Record<ToolKey, TKey>> = {
  dc_room: "tools.dcRoomHint",
};

const has = (grants: ToolGrant[], tool: ToolKey, level: ToolLevel) =>
  grants.some((g) => g.tool === tool && g.level === level);

export function ToolPermissions({ users }: { users: User[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [userId, setUserId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const selected = users.find((u) => u.id === userId) ?? null;

  const registry = useQuery({
    queryKey: ["tool-registry"],
    queryFn: ({ signal }) => usersApi.toolRegistry(signal),
  });
  const grants = useQuery({
    queryKey: ["user-tools", userId],
    queryFn: ({ signal }) => usersApi.tools(userId, signal),
    enabled: userId !== "",
  });

  const save = useMutation({
    mutationFn: (next: ToolGrant[]) => usersApi.setTools(userId, next),
    onSuccess: async (saved) => {
      setError(null);
      queryClient.setQueryData(["user-tools", userId], saved);
      // Our own navigation depends on our own grants.
      if (userId === me?.id) await queryClient.invalidateQueries({ queryKey: ["me", "tools"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function toggle(tool: ToolKey, level: ToolLevel, on: boolean) {
    const current = grants.data ?? [];
    let next = current.filter((g) => !(g.tool === tool && g.level === level));
    if (on) {
      next.push({ tool, level });
      // Holding `edit` already means `use`; keep one row, not two.
      if (level === "edit") next = next.filter((g) => !(g.tool === tool && g.level === "use"));
    }
    save.mutate(next);
  }

  return (
    <Card className="mt-7">
      <CardHeader>
        <CardTitle>{t("tools.sectionTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("tools.sectionDesc")}</p>
        <div className="max-w-72 space-y-1.5">
          <Label htmlFor="tools-user">{t("tools.user")}</Label>
          <Select
            id="tools-user"
            value={userId}
            onChange={setUserId}
            placeholder={t("tools.pickUser")}
            options={users.map((u) => ({ value: u.id, label: u.username }))}
          />
        </div>

        {selected?.is_admin && <p className="text-sm">{t("tools.adminHasAll")}</p>}

        {userId === "" ? null : registry.isPending || grants.isPending ? (
          <Spinner />
        ) : registry.error || grants.error ? (
          <ErrorFlash error={errorMessage(registry.error ?? grants.error)} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tools.thTool")}</TableHead>
                <TableHead>{t("tools.thLevels")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registry.data.map((info) => {
                const editHeld = has(grants.data, info.tool, "edit");
                const hint = LEVEL_HINT[info.tool];
                return (
                  <TableRow key={info.tool}>
                    <TableCell>
                      <div>{t(TOOL_NAME[info.tool])}</div>
                      <code className="text-xs text-muted-foreground">{info.tool}</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-4">
                        {info.levels.map((level) => {
                          const implied = level === "use" && editHeld;
                          return (
                            <label
                              key={level}
                              className="inline-flex cursor-pointer items-center gap-2 text-sm"
                            >
                              <Checkbox
                                checked={implied || has(grants.data, info.tool, level)}
                                disabled={implied || save.isPending}
                                aria-label={`${t(TOOL_NAME[info.tool])}: ${t(LEVEL_NAME[level])}`}
                                onCheckedChange={(v) => toggle(info.tool, level, v === true)}
                              />
                              {t(LEVEL_NAME[level])}
                            </label>
                          );
                        })}
                      </div>
                      {hint && <p className="mt-1 text-[13px] text-muted-foreground">{t(hint)}</p>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <ErrorFlash error={error} />
      </CardContent>
    </Card>
  );
}
