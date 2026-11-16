/**
 * `/tools/port-check` — is a TCP port reachable?
 *
 * The browser cannot open raw sockets, so the check runs on the server and
 * answers from *its* vantage point — which is what an internal tool wants:
 * "can the app host reach the database box", not "can the internet". The page
 * says so under the form, because the two questions have different answers.
 *
 * Results pile up in a session-local history list, newest first, so a round
 * of "which of these five hosts answers" doesn't mean re-reading one line.
 */

import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, CircleAlert, Clock, Loader2, Unplug } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api/client";
import { tools as toolsApi } from "../api/endpoints";
import { ErrorFlash } from "../components/Flash";
import type { PortCheckResult } from "../api/types";

/** How each outcome is shown: which i18n key, which icon, which colour. */
const STATES = {
  open: { key: "tools.resultOpen", icon: CheckCircle2, className: "text-success" },
  closed: { key: "tools.resultClosed", icon: Unplug, className: "text-destructive" },
  timeout: { key: "tools.resultTimeout", icon: Clock, className: "text-muted-foreground" },
  unreachable: { key: "tools.resultUnreachable", icon: CircleAlert, className: "text-destructive" },
} as const;

export function PortCheckerPage() {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PortCheckResult[]>([]);

  useEffect(() => {
    document.title = t("docTitle", { page: t("tools.portHeading"), app: t("app.name") });
  }, [t]);

  const check = useMutation({
    mutationFn: ({ host, port }: { host: string; port: number }) => toolsApi.portCheck(host, port),
    onSuccess: (result) => {
      setError(null);
      setHistory((prev) => [result, ...prev].slice(0, 20));
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const incomplete = host.trim() === "" || !portValid;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (incomplete || check.isPending) return;
    check.mutate({ host: host.trim(), port: portNumber });
  }

  return (
    <div className="max-w-2xl">
      <h1>{t("tools.portHeading")}</h1>
      <p className="text-muted-foreground">{t("tools.portSubtitle")}</p>

      <Card className="my-4">
        <CardContent>
          <form onSubmit={onSubmit}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-[3] space-y-1.5">
                <Label htmlFor="pc-host">{t("tools.host")}</Label>
                <Input
                  id="pc-host"
                  type="text"
                  autoFocus
                  placeholder={t("tools.hostPlaceholder")}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>
              <div className="min-w-24 flex-1 space-y-1.5">
                <Label htmlFor="pc-port">{t("tools.port")}</Label>
                <Input
                  id="pc-port"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="5432"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={incomplete || check.isPending}>
                {check.isPending && <Loader2 className="animate-spin" />}
                {check.isPending ? t("tools.checking") : t("tools.check")}
              </Button>
            </div>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">{t("tools.vantage")}</p>
        </CardContent>
      </Card>

      <ErrorFlash error={error} />

      <div className="space-y-2.5">
        {history.map((result, i) => {
          const view = STATES[result.state];
          const Icon = view.icon;
          return (
            // Newest first; older entries fade so the fresh answer reads first.
            <Alert key={`${result.host}:${result.port}:${i}`} className={cn(i > 0 && "opacity-70")}>
              <Icon className={view.className} />
              <AlertDescription>
                <span className={cn("font-semibold", view.className)}>
                  {t(view.key, { host: result.host, port: result.port })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("tools.resolved", { ip: result.resolved_ip, ms: result.elapsed_ms })}
                </span>
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </div>
  );
}
