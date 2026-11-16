/**
 * `/login` — the one public page (FR-1, FR-2).
 *
 * It renders no chrome: there is nothing to navigate to until you are in, so
 * it is a centred card on an otherwise empty window.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = t("docTitle", { page: t("login.heading"), app: t("app.name") });
  }, [t]);

  // Where the guard was headed before it sent them here.
  const from = (location.state as LocationState | null)?.from ?? "/";

  if (loading) {
    return (
      <div className="mx-auto mt-[10vh] max-w-sm px-4">
        <Card>
          <CardContent>
            <Spinner />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Already signed in — visiting /login directly should not offer to do it
  // again.
  if (user) return <Navigate to={from} replace />;

  // Nothing to submit until both fields have something in them — a disabled
  // button is clearer than a round-trip that comes back "invalid credentials".
  const incomplete = username.trim() === "" || password.trim() === "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (incomplete || busy) return;
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      // Clear the password but keep the username: the usual mistake is the
      // password, and retyping a correct username is pure friction.
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-[4vh] w-full max-w-sm px-4 sm:mt-[10vh]">
      <Card>
        <CardHeader>
          <CardTitle className="text-[22px]">{t("login.heading")}</CardTitle>
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="u">{t("login.username")}</Label>
              <Input
                id="u"
                type="text"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="p">{t("login.password")}</Label>
              <Input
                id="p"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <ErrorFlash error={error} />

            <Button className="w-full" type="submit" disabled={busy || incomplete}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("login.signingIn") : t("login.logIn")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
