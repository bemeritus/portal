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

/**
 * A user account, minus any secret material. There is no per-category
 * permission model: any signed-in user may read and manage every document, and
 * `is_admin` alone gates the admin-only screens.
 */
export interface User {
  id: Uuid;
  username: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: Timestamp;
}

export interface Category {
  id: Uuid;
  name: string;
  slug: string;
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
  view_count: number;
  bookmarked: boolean;
}

export interface PopularDoc {
  id: Uuid;
  title: string;
  category_name: string;
  view_count: number;
}

export interface SearchMiss {
  query: string;
  count: number;
  last_at: Timestamp;
}

export interface AnalyticsOverview {
  total_documents: number;
  total_views: number;
  popular: PopularDoc[];
  search_misses: SearchMiss[];
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
}

export interface CreateUserBody {
  username: string;
  password: string;
  is_admin: boolean;
}
