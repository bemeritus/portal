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
 * A section — the fixed top layer above categories. A closed set, mirroring the
 * Rust `Section` enum; a new value here is always a new backend enum variant.
 */
export type Section = "templates" | "learning" | "projects";

/**
 * One user's access to one section. `can_author` is only meaningful for
 * `learning` and `projects` (the server clears it elsewhere) — the teacher bit
 * that lets a non-admin create learning content, and the lead bit that lets one
 * manage project boards.
 */
export interface SectionAccess {
  section: Section;
  can_author: boolean;
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
  sections: SectionAccess[];
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
  tags: string[];
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
  tags: string[];
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  /** This viewer's vote: true 👍, false 👎, null none. */
  my_vote: boolean | null;
  bookmarked: boolean;
}

export interface FeedbackSummary {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

export interface PopularDoc {
  id: Uuid;
  title: string;
  category_name: string;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
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
  needs_work: PopularDoc[];
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
  tags: string[];
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
  tags: string[];
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
  sections: SectionAccess[];
}

// --- Learning section -------------------------------------------------------
// Mirrors the learning types in `backend/src/models.rs`. The take view of a
// test (`TestQuestionView`/`TestOptionView`) deliberately has no `is_correct`:
// the correct answer never leaves the server.

export interface LearningResourceSummary {
  id: Uuid;
  title: string;
  status: string;
  author_username: string;
  created_at: Timestamp;
}

export interface LearningResourceView {
  id: Uuid;
  title: string;
  status: string;
  author_id: Uuid;
  author_username: string;
  body_html: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LearningResourceBody {
  title: string;
  body: string;
  status: string;
}

/** Raw source of a resource, for the author's editor. */
export interface LearningResourceDraft {
  id: Uuid;
  title: string;
  body: string;
  status: string;
}

export interface LearningTestSummary {
  id: Uuid;
  title: string;
  description: string | null;
  status: string;
  author_username: string;
  question_count: number;
  created_at: Timestamp;
}

export interface TestOptionView {
  id: Uuid;
  label: string;
}

export interface TestQuestionView {
  id: Uuid;
  prompt: string;
  options: TestOptionView[];
}

export interface LearningTestView {
  id: Uuid;
  title: string;
  description: string | null;
  status: string;
  questions: TestQuestionView[];
}

export interface TestOptionInput {
  label: string;
  is_correct: boolean;
}

export interface TestQuestionInput {
  prompt: string;
  options: TestOptionInput[];
}

export interface LearningTestBody {
  title: string;
  description: string | null;
  status: string;
  pass_score: number | null;
  questions: TestQuestionInput[];
}

/** Raw form of a test for its author's editor — options carry `is_correct`. */
export interface LearningTestDraft {
  id: Uuid;
  title: string;
  description: string | null;
  status: string;
  pass_score: number | null;
  questions: TestQuestionInput[];
}

export interface AttemptAnswer {
  question_id: Uuid;
  option_id: Uuid | null;
}

export interface AttemptSubmit {
  answers: AttemptAnswer[];
}

export interface AttemptResult {
  id: Uuid;
  score: number;
  max_score: number;
  passed: boolean | null;
  submitted_at: Timestamp;
}

export interface AttemptRow {
  username: string;
  score: number;
  max_score: number;
  passed: boolean | null;
  submitted_at: Timestamp;
}

export interface LearningLabSummary {
  id: Uuid;
  title: string;
  status: string;
  author_username: string;
  my_state: string | null;
  created_at: Timestamp;
}

export interface LabProgressView {
  state: string;
  submission: string | null;
  grade: number | null;
}

export interface LearningLabView {
  id: Uuid;
  title: string;
  status: string;
  brief_html: string;
  author_username: string;
  my_progress: LabProgressView | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LearningLabBody {
  title: string;
  brief: string;
  status: string;
}

/** Raw source of a lab, for the author's editor. */
export interface LearningLabDraft {
  id: Uuid;
  title: string;
  brief: string;
  status: string;
}

export interface LabProgressSubmit {
  state: string;
  submission: string | null;
}

export interface LabSubmissionRow {
  username: string;
  state: string;
  submission: string | null;
  grade: number | null;
  updated_at: Timestamp;
}

// --- Projects section -------------------------------------------------------
// Mirrors the project types in `backend/src/models.rs`. Boards hold ordered
// columns, columns hold ordered cards; a card's description arrives as
// server-rendered sanitized HTML for the board, and as raw markdown from the
// card's edit endpoint.

/** An assignable person — id + name, for the assignee picker. */
export interface ProjectMember {
  id: Uuid;
  username: string;
}

/** Card priority, lowest to highest. */
export type ProjectPriority = "low" | "medium" | "high" | "urgent";

/** A label's palette color — a fixed token, mirroring the schema's CHECK. */
export type LabelColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink";

export interface ProjectLabel {
  id: Uuid;
  name: string;
  color: LabelColor;
}

export interface ProjectBoardSummary {
  id: Uuid;
  name: string;
  description: string | null;
  card_count: number;
  created_at: Timestamp;
}

export interface ProjectCardView {
  id: Uuid;
  column_id: Uuid;
  title: string;
  description_html: string | null;
  assignee_id: Uuid | null;
  assignee_username: string | null;
  /** ISO date (YYYY-MM-DD), or null. */
  due_date: string | null;
  priority: ProjectPriority;
  labels: ProjectLabel[];
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProjectColumnView {
  id: Uuid;
  name: string;
  position: number;
  cards: ProjectCardView[];
}

export interface ProjectBoardView {
  id: Uuid;
  name: string;
  description: string | null;
  columns: ProjectColumnView[];
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Raw form of a card, for its editor. */
export interface ProjectCardDraft {
  id: Uuid;
  column_id: Uuid;
  title: string;
  description: string | null;
  assignee_id: Uuid | null;
  due_date: string | null;
  priority: ProjectPriority;
  label_ids: Uuid[];
}

/** One comment on a card, body already rendered to sanitized HTML. */
export interface ProjectComment {
  id: Uuid;
  author_id: Uuid | null;
  author_username: string | null;
  body_html: string;
  created_at: Timestamp;
}

/** One of the caller's assigned cards, with where it lives. */
export interface MyCard {
  id: Uuid;
  title: string;
  board_id: Uuid;
  board_name: string;
  column_name: string;
  priority: ProjectPriority;
  due_date: string | null;
}

export interface ProjectBoardBody {
  name: string;
  description: string;
}

export interface ProjectColumnBody {
  name: string;
}

export interface ProjectCardBody {
  title: string;
  description: string;
  assignee_id: Uuid | null;
  due_date: string | null;
  priority: ProjectPriority;
  label_ids: Uuid[];
}

export interface ProjectCardMove {
  column_id: Uuid;
  position: number;
}

export interface ProjectLabelBody {
  name: string;
  color: LabelColor;
}

export interface ProjectCommentBody {
  body: string;
}
