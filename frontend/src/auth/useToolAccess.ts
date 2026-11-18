/**
 * The internal tools the signed-in user may use (`/api/auth/me/tools`), for
 * navigation and for hiding controls. It decides what to *show*; the server
 * checks every request behind it (`RequireTool` in `tool_access.rs`).
 */

import { useQuery } from "@tanstack/react-query";

import { auth } from "../api/endpoints";
import type { ToolKey, ToolLevel } from "../api/types";
import { useAuth } from "./AuthContext";

export function useToolAccess() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["me", "tools", user?.id],
    queryFn: ({ signal }) => auth.tools(signal),
    enabled: !!user,
    staleTime: 60_000,
  });
  const grants = q.data ?? [];
  return {
    loading: q.isPending,
    can: (tool: ToolKey, level: ToolLevel = "use") => grants.some((g) => g.tool === tool && g.level === level),
  };
}
