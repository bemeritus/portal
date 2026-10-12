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

