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
  AnalyticsOverview,
  AttemptResult,
  AttemptRow,
  AttemptSubmit,
  AuditEntry,
  Category,
  CategoryBody,
  CategoryPermission,
  CreateUserBody,
  DocumentBody,
  DocumentDraft,
  DocumentSummary,
  DocumentWithBlocks,
  FeedbackSummary,
  LabProgressSubmit,
  LabSubmissionRow,
  LearningLabBody,
  LearningLabDraft,
  LearningLabSummary,
  LearningLabView,
  LearningResourceBody,
  LearningResourceDraft,
  LearningResourceSummary,
  LearningResourceView,
  LearningTestBody,
  LearningTestDraft,
  LearningTestSummary,
  LearningTestView,
  AttachmentBody,
  CalendarCard,
  ChecklistItemBody,
  ChecklistUpdate,
  MyCard,
  ProjectBoardBody,
  ProjectBoardSummary,
  ProjectBoardView,
  ProjectCardBody,
  ProjectCardDraft,
  ProjectCardMove,
  ProjectColumnBody,
  ProjectComment,
  ProjectCommentBody,
  ProjectLabel,
  ProjectLabelBody,
  ProjectMember,
  SectionAccess,
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

// The templates section owns categories and documents; its routes moved under
// `/api/templates` when sections were introduced. Everything else on these two
// objects is unchanged.
const TEMPLATES = `${BASE}/templates`;

export const categories = {
  /** The categories the caller can see at all. */
  list: (signal?: AbortSignal) => api.get<Category[]>(`${TEMPLATES}/categories`, signal),
  /** The subset they may write or edit in — what the editor's picker offers. */
  writable: (signal?: AbortSignal) =>
    api.get<Category[]>(`${TEMPLATES}/categories/writable`, signal),
  create: (body: CategoryBody) => api.post<Category>(`${TEMPLATES}/categories`, body),
  update: (id: Uuid, body: CategoryBody) => api.put<void>(`${TEMPLATES}/categories/${id}`, body),
  remove: (id: Uuid) => api.del<void>(`${TEMPLATES}/categories/${id}`),
};

export const documents = {
  list: (filters: { q?: string; category?: Uuid }, signal?: AbortSignal) =>
    api.get<DocumentSummary[]>(
      `${TEMPLATES}/documents${query({ q: filters.q, category: filters.category })}`,
      signal,
    ),
  get: (id: Uuid, signal?: AbortSignal) =>
    api.get<DocumentWithBlocks>(`${TEMPLATES}/documents/${id}`, signal),
  /** The same document as raw Markdown, for the editor. Requires EDIT. */
  draft: (id: Uuid, signal?: AbortSignal) =>
    api.get<DocumentDraft>(`${TEMPLATES}/documents/${id}/draft`, signal),
  create: (body: DocumentBody) => api.post<{ id: Uuid }>(`${TEMPLATES}/documents`, body),
  update: (id: Uuid, body: DocumentBody) => api.put<void>(`${TEMPLATES}/documents/${id}`, body),
  remove: (id: Uuid) => api.del<void>(`${TEMPLATES}/documents/${id}`),
  /** Vote 👍 (true) / 👎 (false); returns the updated tally. */
  vote: (id: Uuid, helpful: boolean) =>
    api.post<FeedbackSummary>(`${TEMPLATES}/documents/${id}/feedback`, { helpful }),
  /** Clear this reader's vote. */
  clearVote: (id: Uuid) => api.del<FeedbackSummary>(`${TEMPLATES}/documents/${id}/feedback`),
  /** Bookmark / un-bookmark this document for the current user. */
  bookmark: (id: Uuid) => api.post<void>(`${TEMPLATES}/documents/${id}/bookmark`),
  unbookmark: (id: Uuid) => api.del<void>(`${TEMPLATES}/documents/${id}/bookmark`),
  /** Render markdown to the same sanitized HTML the doc view shows — live preview. */
  preview: (markdown: string) => api.post<{ html: string }>(`${TEMPLATES}/preview`, { markdown }),
};

export const tags = {
  /** The whole tag vocabulary, alphabetical — for editor suggestions. */
  list: (signal?: AbortSignal) => api.get<string[]>(`${TEMPLATES}/tags`, signal),
};

export const bookmarks = {
  /** The current user's bookmarked documents, newest first. */
  list: (signal?: AbortSignal) =>
    api.get<DocumentSummary[]>(`${TEMPLATES}/bookmarks`, signal),
};

export const analytics = {
  /** The admin dashboard payload: views, feedback rankings, search gaps. */
  overview: (signal?: AbortSignal) => api.get<AnalyticsOverview>(`${BASE}/analytics`, signal),
};

export const users = {
  list: (signal?: AbortSignal) => api.get<User[]>(`${BASE}/users`, signal),
  create: (body: CreateUserBody) => api.post<{ id: Uuid }>(`${BASE}/users`, body),
  /**
   * Replaces the user's grants *and* section access wholesale — anything
   * omitted is dropped. Sent together because they are edited on one screen and
   * the server writes them in one transaction (and derives the templates door
   * from the grants, so they must be consistent).
   */
  setPermissions: (id: Uuid, category_perms: CategoryPermission[], sections: SectionAccess[]) =>
    api.put<void>(`${BASE}/users/${id}/permissions`, { category_perms, sections }),
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

// The learning section: resources, tests and labs. Reading needs section
// access; creating/editing needs the author bit; the results/submissions
// endpoints are admin-only. The server enforces all of it — these are just the
// URLs.
const LEARNING = `${BASE}/learning`;

export const learning = {
  resources: {
    list: (signal?: AbortSignal) =>
      api.get<LearningResourceSummary[]>(`${LEARNING}/resources`, signal),
    get: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningResourceView>(`${LEARNING}/resources/${id}`, signal),
    /** Raw markdown source, for the editor. Requires the author permission. */
    draft: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningResourceDraft>(`${LEARNING}/resources/${id}/edit`, signal),
    create: (body: LearningResourceBody) =>
      api.post<{ id: Uuid }>(`${LEARNING}/resources`, body),
    update: (id: Uuid, body: LearningResourceBody) =>
      api.put<void>(`${LEARNING}/resources/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${LEARNING}/resources/${id}`),
  },
  tests: {
    list: (signal?: AbortSignal) => api.get<LearningTestSummary[]>(`${LEARNING}/tests`, signal),
    /** The take view — questions and options, never which one is correct. */
    get: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningTestView>(`${LEARNING}/tests/${id}`, signal),
    /** Full test with the correct flags, for the editor. Author only. */
    draft: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningTestDraft>(`${LEARNING}/tests/${id}/edit`, signal),
    create: (body: LearningTestBody) => api.post<{ id: Uuid }>(`${LEARNING}/tests`, body),
    update: (id: Uuid, body: LearningTestBody) =>
      api.put<void>(`${LEARNING}/tests/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${LEARNING}/tests/${id}`),
    /** Submit answers; the server scores and returns the graded result. */
    submit: (id: Uuid, body: AttemptSubmit) =>
      api.post<AttemptResult>(`${LEARNING}/tests/${id}/attempts`, body),
    /** The caller's own attempts on a test. */
    myAttempts: (id: Uuid, signal?: AbortSignal) =>
      api.get<AttemptResult[]>(`${LEARNING}/tests/${id}/attempts`, signal),
    /** Everyone's attempts — admin only. */
    results: (id: Uuid, signal?: AbortSignal) =>
      api.get<AttemptRow[]>(`${LEARNING}/tests/${id}/results`, signal),
  },
  labs: {
    list: (signal?: AbortSignal) => api.get<LearningLabSummary[]>(`${LEARNING}/labs`, signal),
    get: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningLabView>(`${LEARNING}/labs/${id}`, signal),
    /** Raw markdown source, for the editor. Author only. */
    draft: (id: Uuid, signal?: AbortSignal) =>
      api.get<LearningLabDraft>(`${LEARNING}/labs/${id}/edit`, signal),
    create: (body: LearningLabBody) => api.post<{ id: Uuid }>(`${LEARNING}/labs`, body),
    update: (id: Uuid, body: LearningLabBody) => api.put<void>(`${LEARNING}/labs/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${LEARNING}/labs/${id}`),
    /** Advance the caller's own progress on a lab. */
    saveProgress: (id: Uuid, body: LabProgressSubmit) =>
      api.put<void>(`${LEARNING}/labs/${id}/progress`, body),
    /** Everyone's progress — admin only. */
    submissions: (id: Uuid, signal?: AbortSignal) =>
      api.get<LabSubmissionRow[]>(`${LEARNING}/labs/${id}/submissions`, signal),
  },
};

// The projects section: Kanban boards. Membership does the work on cards;
// managing boards and columns needs the author (lead) bit. The server enforces
// it all — these are just the URLs.
const PROJECTS = `${BASE}/projects`;

export const projects = {
  /** Assignable people — active members of the section, plus admins. */
  members: (signal?: AbortSignal) => api.get<ProjectMember[]>(`${PROJECTS}/members`, signal),
  /** Every card assigned to the caller, across all boards. */
  myCards: (signal?: AbortSignal) => api.get<MyCard[]>(`${PROJECTS}/my-cards`, signal),
  /** Every due-dated card, across all boards — for the calendar view. */
  calendar: (signal?: AbortSignal) => api.get<CalendarCard[]>(`${PROJECTS}/calendar`, signal),
  boards: {
    list: (signal?: AbortSignal) =>
      api.get<ProjectBoardSummary[]>(`${PROJECTS}/boards`, signal),
    /** The whole board: columns in order, each with its cards in order. */
    get: (id: Uuid, signal?: AbortSignal) =>
      api.get<ProjectBoardView>(`${PROJECTS}/boards/${id}`, signal),
    create: (body: ProjectBoardBody) => api.post<{ id: Uuid }>(`${PROJECTS}/boards`, body),
    update: (id: Uuid, body: ProjectBoardBody) =>
      api.put<void>(`${PROJECTS}/boards/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/boards/${id}`),
    /** Add a column to the right of a board's existing ones. Lead only. */
    addColumn: (boardId: Uuid, body: ProjectColumnBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/boards/${boardId}/columns`, body),
    /** The board's label vocabulary. */
    labels: (boardId: Uuid, signal?: AbortSignal) =>
      api.get<ProjectLabel[]>(`${PROJECTS}/boards/${boardId}/labels`, signal),
    /** Create a label on the board. Lead only. */
    addLabel: (boardId: Uuid, body: ProjectLabelBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/boards/${boardId}/labels`, body),
  },
  labels: {
    update: (id: Uuid, body: ProjectLabelBody) => api.put<void>(`${PROJECTS}/labels/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/labels/${id}`),
  },
  columns: {
    update: (id: Uuid, body: ProjectColumnBody) =>
      api.put<void>(`${PROJECTS}/columns/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/columns/${id}`),
    /** Add a card to the bottom of a column. Any member may. */
    addCard: (columnId: Uuid, body: ProjectCardBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/columns/${columnId}/cards`, body),
  },
  cards: {
    /** Raw form of a card, for the editor. */
    draft: (id: Uuid, signal?: AbortSignal) =>
      api.get<ProjectCardDraft>(`${PROJECTS}/cards/${id}`, signal),
    update: (id: Uuid, body: ProjectCardBody) => api.put<void>(`${PROJECTS}/cards/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/cards/${id}`),
    /** Drag-and-drop: place the card at an index in a column on the same board. */
    move: (id: Uuid, body: ProjectCardMove) => api.put<void>(`${PROJECTS}/cards/${id}/move`, body),
    /** The card's comment thread, oldest first. */
    comments: (id: Uuid, signal?: AbortSignal) =>
      api.get<ProjectComment[]>(`${PROJECTS}/cards/${id}/comments`, signal),
    comment: (id: Uuid, body: ProjectCommentBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/cards/${id}/comments`, body),
    /** Add a checklist item to the card. */
    addChecklistItem: (id: Uuid, body: ChecklistItemBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/cards/${id}/checklist`, body),
    /** Pin an already-uploaded image (its /uploads/… url) to the card. */
    addAttachment: (id: Uuid, body: AttachmentBody) =>
      api.post<{ id: Uuid }>(`${PROJECTS}/cards/${id}/attachments`, body),
  },
  comments: {
    /** Delete a comment — your own, or any if you are an admin. */
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/comments/${id}`),
  },
  checklist: {
    /** Rename an item and/or tick it (checking a box is this call). */
    update: (id: Uuid, body: ChecklistUpdate) => api.put<void>(`${PROJECTS}/checklist/${id}`, body),
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/checklist/${id}`),
  },
  attachments: {
    remove: (id: Uuid) => api.del<void>(`${PROJECTS}/attachments/${id}`),
  },
};

export const uploads = {
  image: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.upload<UploadResponse>(`${BASE}/upload`, form);
  },
};
