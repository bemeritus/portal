/**
 * `/api/dc` — every call the server room module makes.
 *
 * State-changing requests carry the session's CSRF token in `X-CSRF-Token`
 * (the server refuses them otherwise). The token is fetched once and kept in
 * memory only; a 403 that says the page is out of date refetches it once.
 */

import { ApiError, request, type RequestOptions } from "../api/client";
import type {
  Applied,
  CapacityAnswer,
  CatalogItem,
  CatalogUse,
  Face,
  ImportResult,
  Op,
  RevisionDetail,
  RevisionSummary,
  RoomData,
  RoomSummary,
  SearchHit,
} from "./types";
import type { DcSettings } from "./settings";

const BASE = "/api/dc";

let csrf: Promise<string> | null = null;

function token(): Promise<string> {
  csrf ??= request<{ token: string }>(`${BASE}/csrf`).then((r) => r.token);
  csrf.catch(() => {
    csrf = null;
  });
  return csrf;
}

async function write<T>(path: string, options: RequestOptions): Promise<T> {
  const send = async () =>
    request<T>(path, {
      method: "POST",
      ...options,
      headers: { ...options.headers, "X-CSRF-Token": await token() },
    });
  try {
    return await send();
  } catch (e) {
    // A token from before a re-login: get a fresh one and try once more.
    if (
      e instanceof ApiError &&
      e.status === 403 &&
      e.message.startsWith("The page is out of date")
    ) {
      csrf = null;
      return send();
    }
    throw e;
  }
}

const q = (
  params: Record<string, string | number | boolean | undefined | null>,
) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const dcApi = {
  settings: (signal?: AbortSignal) =>
    request<DcSettings>(`${BASE}/settings`, { signal }),
  setSettings: (body: Partial<DcSettings>) =>
    write<DcSettings>(`${BASE}/settings`, { method: "PUT", body }),
  rooms: (signal?: AbortSignal) =>
    request<RoomSummary[]>(`${BASE}/rooms`, { signal }),
  room: (id: number, signal?: AbortSignal) =>
    request<RoomData>(`${BASE}/rooms/${id}`, { signal }),
  head: (id: number, signal?: AbortSignal) =>
    request<{ revision: number; updated_at: string }>(
      `${BASE}/rooms/${id}/revision`,
      { signal },
    ),
  catalog: (kind?: string, signal?: AbortSignal) =>
    request<CatalogItem[]>(`${BASE}/catalog${q({ kind })}`, { signal }),
  catalogUsage: (signal?: AbortSignal) =>
    request<CatalogUse[]>(`${BASE}/catalog/usage`, { signal }),

  changes: (id: number, base_revision: number, ops: Op[], summary?: string) =>
    write<Applied>(`${BASE}/rooms/${id}/changes`, {
      body: { base_revision, ops, summary },
    }),

  revisions: (id: number, signal?: AbortSignal) =>
    request<RevisionSummary[]>(`${BASE}/rooms/${id}/revisions`, { signal }),
  revision: (id: number, n: number, signal?: AbortSignal) =>
    request<RevisionDetail>(`${BASE}/rooms/${id}/revisions/${n}`, { signal }),
  restore: (id: number, n: number, base_revision: number) =>
    write<Applied>(`${BASE}/rooms/${id}/revisions/${n}/restore`, {
      body: { base_revision },
    }),

  capacity: (
    id: number,
    u: number,
    face: Face,
    power_w: number | null,
    signal?: AbortSignal,
  ) =>
    request<CapacityAnswer>(
      `${BASE}/rooms/${id}/capacity${q({ u, face, power_w })}`,
      { signal },
    ),
  search: (id: number, term: string, signal?: AbortSignal) =>
    request<SearchHit[]>(`${BASE}/rooms/${id}/search${q({ q: term })}`, {
      signal,
    }),

  importDevices: (
    id: number,
    csv: string,
    dryRun: boolean,
    base_revision?: number,
  ) =>
    write<ImportResult>(
      `${BASE}/rooms/${id}/import/devices${q({ dry_run: dryRun || undefined, base_revision })}`,
      {
        text: { content: csv, type: "text/csv; charset=utf-8" },
      },
    ),

  /** Download URLs; the browser follows them with the session cookie. */
  exportDxf: (id: number) => `${BASE}/rooms/${id}/export/plan.dxf`,
  /** The inventory has no lengths, so the user's unit does not apply. */
  exportCsv: (id: number) => `${BASE}/rooms/${id}/export/inventory.csv`,
  /** The import template: the user's headers, the room's racks, examples. */
  importTemplate: (id: number) => `${BASE}/rooms/${id}/import/template.csv`,
};
