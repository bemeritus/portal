/**
 * The API's contract, mirroring `backend/src/models.rs` field for field.
 *
 * These are hand-written rather than generated. If you change a struct there,
 * change it here — `npm run typecheck` will not catch a drift, because the
 * wire format is JSON and TypeScript believes whatever the annotation says.
 */

export type Uuid = string;
/** RFC 3339, always UTC — what `chrono::DateTime<Utc>` serializes to. */
export type Timestamp = string;

export type DocumentStatus = "draft" | "published";

/** The four independent capabilities from §4.2. */
export type Permission = "read" | "write" | "edit" | "delete";

/** One user's permissions on one category (§4.2.1, §6.6). */
export interface CategoryPermission {
  category_id: Uuid;
  can_read: boolean;
  can_write: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

/**
 * A user account, minus any secret material.
 *
 * Note what is *not* here: the legacy global `can_*` flags. They grant nothing
 * on the server (§4.2.1), so the API stopped sending them — a field the client
 * could read would eventually become a field the client branched on.
 */
export interface User {
  id: Uuid;
  username: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: Timestamp;
  category_perms: CategoryPermission[];
}

export interface Category {
  id: Uuid;
  name: string;
  slug: string;
  description: string | null;
  created_at: Timestamp;
}

export interface DocumentSummary {
  id: Uuid;
  title: string;
  status: string;
  category_id: Uuid;
  category_name: string;
  author_username: string;
  created_at: Timestamp;
}

/** A question with its answer already rendered and sanitized by the server. */
export interface QaBlockView {
  question: string;
  answer_html: string;
}

export interface DocumentWithBlocks {
  id: Uuid;
  title: string;
  status: string;
  category_id: Uuid;
  category_name: string;
  author_id: Uuid;
  author_username: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  blocks: QaBlockView[];
}

/** A question with its answer as raw Markdown, for the editor. */
export interface QaBlockInput {
  question: string;
  answer: string;
}

export interface DocumentDraft {
  id: Uuid;
  title: string;
  status: string;
  category_id: Uuid;
  author_id: Uuid;
  blocks: QaBlockInput[];
}

export interface AuditEntry {
  id: Uuid;
  at: Timestamp;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: Uuid | null;
  target_name: string;
  details: string | null;
}

export interface UploadResponse {
  url: string;
  markdown: string;
}

// --- Request bodies ---------------------------------------------------------

export interface DocumentBody {
  title: string;
  category_id: Uuid;
  status: string;
  blocks: QaBlockInput[];
}

export interface CategoryBody {
  name: string;
  description: string;
}

export interface CreateUserBody {
  username: string;
  password: string;
  is_admin: boolean;
  category_perms: CategoryPermission[];
}
