import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { ApiError } from "./api/client";
import { AuthProvider } from "./auth/AuthContext";
import { ShortcutsProvider } from "./shortcuts/ShortcutsContext";
// Initialises i18next before anything renders, so the first paint is already in
// the stored language.
import "./i18n";
// Self-hosted (bundled) so there is no runtime Google Fonts request — the
// rounded, modern sans the redesign is built on. Variable file, one weight axis.
import "@fontsource-variable/manrope";
import "./styles/main.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Permissions are re-read server-side on every request (SR-10), so a
      // revoked grant takes effect immediately there. Cached data here would
      // still *display* what it showed a minute ago, which is why this window
      // is short rather than the library's default of five minutes.
      staleTime: 10_000,
      // Retrying a 401 or a 403 cannot succeed — the answer will not change
      // by asking again — and it delays the redirect to the login page.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.isUnauthorized || error.isForbidden)) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("no #root element in index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ShortcutsProvider>
            <App />
          </ShortcutsProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
