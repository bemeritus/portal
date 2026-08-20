/**
 * `/login` — the one public page (FR-1, FR-2).
 *
 * It renders no chrome: there is nothing to navigate to until you are in, so
 * it is a centred panel on an otherwise empty window.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ErrorFlash } from "../components/Flash";
import { Spinner } from "../components/Loading";

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Sign in · Knowledge Base";
  }, []);

  // Where the guard was headed before it sent them here.
  const from = (location.state as LocationState | null)?.from ?? "/";

  if (loading) {
    return (
      <div className="center-narrow panel">
        <Spinner />
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
    <div className="center-narrow panel">
      <h2 style={{ marginTop: 0 }}>Sign in</h2>
      <p className="muted">Accounts are created by an administrator.</p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="u">Username</label>
        {/* `type` is not optional: the stylesheet selects `input[type=text]`,
            so an input without one gets none of the field styling and renders
            at the browser's default size next to a correctly sized password
            field. */}
        <input
          id="u"
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="p">Password</label>
        <input
          id="p"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <ErrorFlash error={error} />

        <div style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={busy || incomplete}>
            {busy && <span className="spinner" />}
            {busy ? "Signing in…" : "Log in"}
          </button>
        </div>
      </form>
    </div>
  );
}
