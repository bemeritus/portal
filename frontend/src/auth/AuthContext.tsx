/**
 * Who is signed in, for the whole app.
 *
 * The session lives in an HttpOnly cookie, which JavaScript cannot read by
 * design. So "am I signed in?" is not a local question: the app asks
 * `GET /api/auth/me` once on load and keeps the answer here. A 401 is not an
 * error in that exchange — it is the answer "nobody", and the only honest
 * source of it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError } from "../api/client";
import { auth } from "../api/endpoints";
import type { User } from "../api/types";

interface AuthState {
  user: User | null;
  /** True until the first `/me` settles — the app must not decide before then. */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-read the session after a change that could alter our own grants. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // React 18+ mounts twice in development. Without this the first request is
  // aborted by the second mount's cleanup and the app can flash the login page.
  const started = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setUser(await auth.me(signal));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // 401 means "nobody is signed in", which is a normal outcome here.
      // Anything else — the server is down, a proxy is misconfigured — is
      // still not a reason to keep a stale user in memory.
      if (!(e instanceof ApiError && e.isUnauthorized)) {
        console.error("could not load the current user", e);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: async (username, password) => {
        // The login response carries the user, so there is no second request
        // and no window where the app is signed in but does not know by whom.
        setUser(await auth.login(username, password));
      },
      logout: async () => {
        try {
          await auth.logout();
        } finally {
          // Even if the call failed, this browser is done with that session.
          // Keeping the user on screen would offer actions that now 401.
          setUser(null);
        }
      },
      refresh: () => load(),
    }),
    [user, loading, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an <AuthProvider>");
  return context;
}

/** The signed-in user, for the many places that only render behind the guard. */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("useUser must be used inside a <RequireAuth>");
  return user;
}
