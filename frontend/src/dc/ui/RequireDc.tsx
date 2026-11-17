/**
 * The DC routes, behind `dc_room:use`. Hiding the menu item is not the control
 * — every `/api/dc` request is checked on the server — but a user without
 * access gets a sentence here rather than a page of 403s.
 */

import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useToolAccess } from "../../auth/useToolAccess";
import { Spinner } from "../../components/Loading";

export function RequireDc() {
  const { t } = useTranslation();
  const access = useToolAccess();
  if (access.loading) return <Spinner />;
  if (!access.can("dc_room"))
    return (
      <>
        <h1>{t("dc.title")}</h1>
        <p className="text-muted-foreground">{t("dc.noAccess")}</p>
      </>
    );
  return <Outlet />;
}
