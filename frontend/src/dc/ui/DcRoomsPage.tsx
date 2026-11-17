/** `/dc` — the server rooms, and the way into the catalog. */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Library, Server } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { errorMessage } from "../../api/client";
import { ErrorFlash } from "../../components/Flash";
import { Empty, Spinner } from "../../components/Loading";
import { formatDate } from "../../format";
import { dcApi } from "../api";

export function DcRoomsPage() {
  const { t } = useTranslation();
  const rooms = useQuery({
    queryKey: ["dc", "rooms"],
    queryFn: ({ signal }) => dcApi.rooms(signal),
  });
  useEffect(() => {
    document.title = t("docTitle", { page: t("dc.title"), app: t("app.name") });
  }, [t]);
  return (
    <>
      <h1>{t("dc.title")}</h1>
      {rooms.isPending ? (
        <Spinner />
      ) : rooms.error ? (
        <ErrorFlash error={errorMessage(rooms.error)} />
      ) : rooms.data.length === 0 ? (
        <Empty title={t("dc.noRooms")} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rooms.data.map((r) => (
            <Link key={r.id} to={`/dc/${r.id}`} className="block">
              <Card className="transition-colors hover:bg-accent">
                <CardContent className="flex items-start gap-3 pt-6">
                  <Server className="mt-1 size-5 text-muted-foreground" />
                  <div>
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {t("dc.roomStats", {
                        racks: r.rack_count,
                        devices: r.device_count,
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("dc.revision", { n: r.revision })} ·{" "}
                      {formatDate(r.updated_at)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <p className="mt-6">
        <Link
          to="/dc/catalog"
          className="inline-flex items-center gap-2 text-link hover:underline"
        >
          <Library className="size-4" />
          {t("dc.catalog.title")}
        </Link>
      </p>
    </>
  );
}
