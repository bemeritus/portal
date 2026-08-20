/**
 * Every endpoint the app calls, as one typed function each.
 *
 * Components never build URLs. That keeps the query-string encoding, the
 * `/api` prefix and the response types in one file, and it means a route
 * renamed in `backend/src/routes/` is a compile error here rather than a 404
 * discovered by clicking.
 */

import { api } from "./client";
import type {
  AuditEntry,
  Category,
  CategoryBody,
  CategoryPermission,
  CreateUserBody,
  DocumentBody,
  DocumentDraft,
  DocumentSummary,
  DocumentWithBlocks,
  UploadResponse,
  User,
  Uuid,
} from "./types";

const BASE = "/api";

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const auth = {
  login: (username: string, password: string) =>
    api.post<User>(`${BASE}/auth/login`, { username, password }),
  logout: () => api.post<void>(`${BASE}/auth/logout`),
  /** 401 when there is no session — the caller treats that as "signed out". */
  me: (signal?: AbortSignal) => api.get<User>(`${BASE}/auth/me`, signal),
};

export const categories = {
  /** The categories the caller can see at all. */
  list: (signal?: AbortSignal) => api.get<Category[]>(`${BASE}/categories`, signal),
  /** The subset they may write or edit in — what the editor's picker offers. */
  writable: (signal?: AbortSignal) => api.get<Category[]>(`${BASE}/categories/writable`, signal),
  create: (body: CategoryBody) => api.post<Category>(`${BASE}/categories`, body),
  update: (id: Uuid, body: CategoryBody) => api.put<void>(`${BASE}/categories/${id}`, body),
  remove: (id: Uuid) => api.del<void>(`${BASE}/categories/${id}`),
};

export const documents = {
  list: (filters: { title?: string; category?: Uuid }, signal?: AbortSignal) =>
    api.get<DocumentSummary[]>(
      `${BASE}/documents${query({ title: filters.title, category: filters.category })}`,
      signal,
    ),
  get: (id: Uuid, signal?: AbortSignal) =>
    api.get<DocumentWithBlocks>(`${BASE}/documents/${id}`, signal),
  /** The same document as raw Markdown, for the editor. Requires EDIT. */
  draft: (id: Uuid, signal?: AbortSignal) =>
    api.get<DocumentDraft>(`${BASE}/documents/${id}/draft`, signal),
  create: (body: DocumentBody) => api.post<{ id: Uuid }>(`${BASE}/documents`, body),
  update: (id: Uuid, body: DocumentBody) => api.put<void>(`${BASE}/documents/${id}`, body),
  remove: (id: Uuid) => api.del<void>(`${BASE}/documents/${id}`),
};

export const users = {
  list: (signal?: AbortSignal) => api.get<User[]>(`${BASE}/users`, signal),
  create: (body: CreateUserBody) => api.post<{ id: Uuid }>(`${BASE}/users`, body),
  /** Replaces the user's grants wholesale — omitted categories lose theirs. */
  setPermissions: (id: Uuid, category_perms: CategoryPermission[]) =>
    api.put<void>(`${BASE}/users/${id}/permissions`, { category_perms }),
  setActive: (id: Uuid, active: boolean) => api.put<void>(`${BASE}/users/${id}/active`, { active }),
  resetPassword: (id: Uuid, new_password: string) =>
    api.put<void>(`${BASE}/users/${id}/password`, { new_password }),
};

export const audit = {
  list: (
    filters: { target_type?: string; search?: string; limit?: number },
    signal?: AbortSignal,
  ) =>
    api.get<AuditEntry[]>(
      `${BASE}/audit${query({
        target_type: filters.target_type,
        search: filters.search,
        limit: filters.limit,
      })}`,
      signal,
    ),
};

export const uploads = {
  image: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.upload<UploadResponse>(`${BASE}/upload`, form);
  },
};
