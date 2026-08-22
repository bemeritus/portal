/**
 * The route guards.
 *
 * These decide what to *render*, not what is permitted: every request behind
 * them is checked again on the server (SR-9). What they buy is that an
 * anonymous visitor never sees a page's frame flash before being sent to the
 * login form, and that a non-admin who types `/admin/users` gets a sentence
 * instead of an empty table full of failed requests.
 */

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/AuthContext";
import { canAuthor, inSection } from "../permissions";
import type { Section } from "../api/types";
import { Spinner } from "./Loading";

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Until `/me` settles we know nothing. Redirecting here would bounce a
  // signed-in user to the login page on every hard refresh.
  if (loading) {
    return (
      <div className="container">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    // Remember where they were headed so the login form can finish the trip.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

export function RequireAdmin() {
  const { user } = useAuth();
  const { t } = useTranslation();

  // Not a redirect: sending a non-admin somewhere else would leave them
  // wondering whether the click registered. This says what happened.
  if (!user?.is_admin) {
    return (
      <>
        <h1>{t("authz.notAllowed")}</h1>
        <p className="muted">{t("authz.adminsOnly")}</p>
      </>
    );
  }

  return <Outlet />;
}

/**
 * The section door on the client. A user without the section sees a sentence,
 * not a wall of failed requests — the server would refuse every one of them
 * anyway (SR-9).
 */
export function RequireSection({ section }: { section: Section }) {
  const { user } = useAuth();
  const { t } = useTranslation();

  if (!inSection(user, section)) {
    return (
      <>
        <h1>{t("authz.notAllowed")}</h1>
        <p className="muted">{t("authz.noSection")}</p>
      </>
    );
  }

  return <Outlet />;
}

/** The learning author gate — creating and editing learning content. */
export function RequireLearningAuthor() {
  const { user } = useAuth();
  const { t } = useTranslation();

  if (!canAuthor(user, "learning")) {
    return (
      <>
        <h1>{t("authz.notAllowed")}</h1>
        <p className="muted">{t("authz.authorsOnly")}</p>
      </>
    );
  }

  return <Outlet />;
}
