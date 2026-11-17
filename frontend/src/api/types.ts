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
  /** UI language, saved with the user (`users.language`). */
  language: Lang;
}

/** The three UI languages; mirrors `models::Language`. */
export type Lang = "ru" | "uz" | "en";

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

/**
 * What a revision changed, as counts and field names. The server deliberately
 * sends no wording: this page says it in the reader's language.
 */
export interface RevisionChanges {
  fields: FieldChange["field"][];
  blocks_added: number;
  blocks_removed: number;
  blocks_edited: number;
}

/** One entry in a document's history, newest first. */
export interface RevisionSummary {
  revision: number;
  kind: "created" | "edited" | "restored" | "baseline";
  restored_from: number | null;
  title: string;
  status: string;
  category_name: string | null;
  edited_by: string | null;
  edited_at: Timestamp;
  block_count: number;
  is_current: boolean;
  changes: RevisionChanges;
}

/** A change to a document field rather than to its Q&A text. */
export interface FieldChange {
  field: "title" | "status" | "category";
  old: string;
  new: string;
}

/** One line of a unified diff. For `skip`, `text` is a count of folded lines. */
export interface DiffLine {
  kind: "context" | "added" | "removed" | "skip";
  text: string;
}

export interface BlockDiff {
  kind: "unchanged" | "added" | "removed" | "changed";
  question: string;
  /** Set only when the question itself was rewritten. */
  question_old: string | null;
  lines: DiffLine[];
}

/** One revision in full: what it changed, and what it said. */
export interface RevisionDetail {
  revision: number;
  kind: RevisionSummary["kind"];
  restored_from: number | null;
  title: string;
  status: string;
  category_name: string | null;
  edited_by: string | null;
  edited_at: Timestamp;
  is_current: boolean;
  /** The revision diffed against, or null for the first one. */
  compared_to: number | null;
  fields: FieldChange[];
  blocks: BlockDiff[];
  rendered: QaBlockView[];
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

/** One TCP connect attempt, as seen from the app server. */
export interface PortCheckResult {
  host: string;
  port: number;
  resolved_ip: string;
  state: "open" | "closed" | "timeout" | "unreachable";
  elapsed_ms: number;
}

// --- «Внутренние инструменты» (mirrors `tool_access.rs`) -------------------

export type ToolKey = "port_checker" | "mail_tester" | "online_pinger" | "dns_checker" | "dc_room";
export type ToolLevel = "use" | "edit";

export interface ToolGrant {
  tool: ToolKey;
  level: ToolLevel;
}

export interface ToolInfo {
  tool: ToolKey;
  levels: ToolLevel[];
}
