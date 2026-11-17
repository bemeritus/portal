//! The types that cross the wire, and the permission rule that governs them.
//!
//! These are the API's contract: `frontend/src/api/types.ts` mirrors them field
//! for field. [`User`] deliberately does **not** carry the password hash — the
//! hash never leaves the server (SR-1).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A user account, minus any secret material.
///
/// There is no per-category permission model: any authenticated, active user
/// may read and manage every document. `is_admin` is the one distinction left —
/// it gates the admin-only screens (users, categories, analytics, audit log).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

/// A content category (§6.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_at: DateTime<Utc>,
}

/// One row of the document list / filter view (§5.5, FR-17).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub category_id: Uuid,
    pub category_name: String,
    pub author_username: String,
    pub created_at: DateTime<Utc>,
}

/// A single question/answer pair, with the answer pre-rendered to sanitized
/// HTML by the server (§5.4, FR-12/FR-13).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QaBlockView {
    pub question: String,
    /// Sanitized HTML rendered from the markdown answer.
    pub answer_html: String,
}

/// A full document plus its ordered Q&A blocks (§5.5, FR-21).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocumentWithBlocks {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub category_id: Uuid,
    pub category_name: String,
    pub author_id: Uuid,
    pub author_username: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub blocks: Vec<QaBlockView>,
    pub view_count: i64,
    /// Whether this viewer has bookmarked the document.
    pub bookmarked: bool,
}

/// One document as the analytics dashboard ranks it — by reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct PopularDoc {
    pub id: Uuid,
    pub title: String,
    pub category_name: String,
    pub view_count: i64,
}

/// A search term that has come up empty, and how often — a question the
/// knowledge base cannot yet answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct SearchMiss {
    pub query: String,
    pub count: i64,
    pub last_at: DateTime<Utc>,
}

/// Everything the admin analytics page shows, in one payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsOverview {
    pub total_documents: i64,
    pub total_views: i64,
    /// Most-read documents.
    pub popular: Vec<PopularDoc>,
    /// Recent searches that found nothing, most frequent first.
    pub search_misses: Vec<SearchMiss>,
}

/// The raw (markdown) form of a document, used to populate the editor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocumentDraft {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub category_id: Uuid,
    pub author_id: Uuid,
    pub blocks: Vec<QaBlockInput>,
}

/// A Q&A block as authored (question + raw markdown answer), ordered by array
/// position (§5.4, FR-14).
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct QaBlockInput {
    pub question: String,
    pub answer: String,
}

/// A Q&A block as a revision stores it: the question and the raw markdown, in
/// display order. This is the shape frozen into `document_revisions.blocks`,
/// which is why it is deserialized from JSON as well as serialized to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RevisionBlock {
    pub question: String,
    pub answer: String,
}

/// What a revision changed, as counts and field names rather than as a
/// sentence: the wording belongs to the client, which knows the reader's
/// language.
///
/// Computed on read from the two snapshots rather than stored, so it can never
/// drift from the content it describes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RevisionChanges {
    /// Which document fields moved: `title`, `status`, `category`.
    pub fields: Vec<String>,
    pub blocks_added: i64,
    pub blocks_removed: i64,
    pub blocks_edited: i64,
}

/// One entry in a document's history list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RevisionSummary {
    pub revision: i32,
    /// `created` | `edited` | `restored` | `baseline` — see the migration.
    pub kind: String,
    pub restored_from: Option<i32>,
    pub title: String,
    pub status: String,
    /// `None` once the category has been deleted.
    pub category_name: Option<String>,
    /// `None` once the editor's account has been deleted.
    pub edited_by: Option<String>,
    pub edited_at: DateTime<Utc>,
    pub block_count: i64,
    /// Whether this is the document as it stands now.
    pub is_current: bool,
    pub changes: RevisionChanges,
}

/// One field of the document that this revision changed (title, status or
/// category) — the part of a diff that is not Q&A text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    /// `title` | `status` | `category`.
    pub field: String,
    pub old: String,
    pub new: String,
}

/// One line of a unified diff.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiffLine {
    /// `context` | `added` | `removed` | `skip`.
    pub kind: String,
    /// The line itself, or — for `skip` — how many unchanged lines were folded
    /// away, as a bare number the client words in its own language.
    pub text: String,
}

/// How one Q&A block differs between two revisions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlockDiff {
    /// `unchanged` | `added` | `removed` | `changed`.
    pub kind: String,
    /// The question as this revision has it (for `removed`, as it had it).
    pub question: String,
    /// Set only when the question itself was rewritten.
    pub question_old: Option<String>,
    /// The answer's line diff. Empty when the answer did not change; for an
    /// added or removed block, every line is an addition or a removal.
    pub lines: Vec<DiffLine>,
}

/// One revision in full: what it changed, and the content it holds.
///
/// Both halves travel together because the history page offers both views of
/// the same revision — "what changed" and "what it said" — and a reader flips
/// between them constantly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RevisionDetail {
    pub revision: i32,
    pub kind: String,
    pub restored_from: Option<i32>,
    pub title: String,
    pub status: String,
    pub category_name: Option<String>,
    pub edited_by: Option<String>,
    pub edited_at: DateTime<Utc>,
    pub is_current: bool,
    /// The revision this one is compared against — the previous one, or `None`
    /// for the first, which has nothing behind it.
    pub compared_to: Option<i32>,
    pub fields: Vec<FieldChange>,
    pub blocks: Vec<BlockDiff>,
    /// The revision's own content, rendered for reading.
    pub rendered: Vec<QaBlockView>,
}

/// One recorded change to the platform, as the admin log shows it.
///
/// The names are the ones stored with the entry rather than looked up now, so a
/// line keeps saying what it said when it was written even after the user,
/// category or document it names has been renamed or deleted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct AuditEntry {
    pub id: Uuid,
    pub at: DateTime<Utc>,
    pub actor_name: String,
    /// `<subject>.<verb>`, e.g. `document.create`.
    pub action: String,
    pub target_type: String,
    pub target_id: Option<Uuid>,
    pub target_name: String,
    pub details: Option<String>,
}

/// Anything not exactly `"published"` is a draft. The editor sends a select's
/// value; a crafted request can send anything at all.
pub fn normalize_status(status: &str) -> String {
    match status {
        "published" => "published".to_string(),
        _ => "draft".to_string(),
    }
}
