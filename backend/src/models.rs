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
/// Access is decided **per category only**: a non-admin may act on a document
/// exactly when [`User::category_perms`] grants that action on the document's
/// category. The `can_*` columns are legacy global flags that no longer grant
/// anything — they used to mean "in every category", which let a user read
/// categories an admin had deliberately withheld. Admins still hold everything.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    /// Loaded by a second query, never by `FromRow` — hence `skip`.
    #[sqlx(skip)]
    #[serde(default)]
    pub category_perms: Vec<CategoryPermission>,
    /// The sections this user may enter. Like `category_perms`, loaded by a
    /// separate query rather than by `FromRow`.
    #[sqlx(skip)]
    #[serde(default)]
    pub sections: Vec<SectionAccess>,
}

impl User {
    /// Whether this user holds the permission in the given category. For a
    /// non-admin this is *only* the grant on that category — there is no
    /// global flag and no author exemption that can widen it.
    pub fn has_in(&self, category_id: Uuid, perm: Permission) -> bool {
        self.is_admin
            || self
                .category_perms
                .iter()
                .any(|c| c.category_id == category_id && c.allows(perm))
    }

    /// The categories this user was granted `perm` on. Only meaningful for a
    /// non-admin; an admin reaches every category regardless.
    pub fn granted_categories(&self, perm: Permission) -> Vec<Uuid> {
        self.category_perms
            .iter()
            .filter(|c| c.allows(perm))
            .map(|c| c.category_id)
            .collect()
    }

    /// The categories this user can see at all — those with any grant on them.
    pub fn accessible_categories(&self) -> Vec<Uuid> {
        self.category_perms
            .iter()
            .filter(|c| !c.is_empty())
            .map(|c| c.category_id)
            .collect()
    }

    /// Whether this user may enter a section — the outer door of the two-level
    /// model. Admin, or a row in `user_sections`. There is no third term.
    pub fn in_section(&self, section: Section) -> bool {
        self.is_admin || self.sections.iter().any(|s| s.section == section)
    }

    /// Whether this user may author content in a section. Only ever true for
    /// `Learning` (the database forbids the authoring bit on any other section).
    pub fn can_author(&self, section: Section) -> bool {
        self.is_admin
            || self
                .sections
                .iter()
                .any(|s| s.section == section && s.can_author)
    }
}

/// A section — the code-level, fixed top layer above categories (§ sections).
///
/// This is deliberately a Rust enum, not a database lookup table: a new section
/// is always new tables, new endpoints and new UI, so it is always a code
/// change. Making it data would only invite the impression that a row alone
/// could add one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Section {
    Templates,
    Learning,
}

impl Section {
    /// The string stored in `user_sections.section` (must match the CHECK).
    pub fn as_str(self) -> &'static str {
        match self {
            Section::Templates => "templates",
            Section::Learning => "learning",
        }
    }

    /// Parse the stored string back, ignoring anything the CHECK would reject.
    pub fn from_db(value: &str) -> Option<Section> {
        match value {
            "templates" => Some(Section::Templates),
            "learning" => Some(Section::Learning),
            _ => None,
        }
    }
}

/// One user's access to one section. Doubles as the payload the admin UI sends
/// when assigning sections, exactly as [`CategoryPermission`] does for grants.
///
/// `can_author` is only honored for [`Section::Learning`]; the database rejects
/// it on any other section, and the admin handler clears it defensively before
/// it ever gets there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionAccess {
    pub section: Section,
    #[serde(default)]
    pub can_author: bool,
}

/// One user's permissions on one category (§4.2.1, §6.6). Doubles as the
/// payload the admin UI sends when assigning permissions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, FromRow)]
pub struct CategoryPermission {
    pub category_id: Uuid,
    pub can_read: bool,
    pub can_write: bool,
    pub can_edit: bool,
    pub can_delete: bool,
}

impl CategoryPermission {
    pub fn allows(&self, perm: Permission) -> bool {
        match perm {
            Permission::Read => self.can_read,
            Permission::Write => self.can_write,
            Permission::Edit => self.can_edit,
            Permission::Delete => self.can_delete,
        }
    }

    /// A grant with nothing ticked is the same as no grant at all.
    pub fn is_empty(&self) -> bool {
        !(self.can_read || self.can_write || self.can_edit || self.can_delete)
    }
}

/// The four independent capabilities from §4.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
    Edit,
    Delete,
}

/// A content category (§6.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
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
    /// The document's tags, alphabetical. Aggregated in the list query.
    pub tags: Vec<String>,
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
    pub tags: Vec<String>,
    pub view_count: i64,
    pub helpful_count: i64,
    pub not_helpful_count: i64,
    /// This viewer's own vote: `Some(true)` 👍, `Some(false)` 👎, `None` none.
    pub my_vote: Option<bool>,
}

/// The tally returned after a reader votes (or clears their vote) on a document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedbackSummary {
    pub helpful_count: i64,
    pub not_helpful_count: i64,
    pub my_vote: Option<bool>,
}

/// One document as the analytics dashboard ranks it — by reads, or by the
/// 👎 that mark it as due for a rewrite.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct PopularDoc {
    pub id: Uuid,
    pub title: String,
    pub category_name: String,
    pub view_count: i64,
    pub helpful_count: i64,
    pub not_helpful_count: i64,
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
    /// Documents readers have marked unhelpful — likeliest to be stale.
    pub needs_work: Vec<PopularDoc>,
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
    pub tags: Vec<String>,
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

// --- Learning section -------------------------------------------------------
//
// An independent world (no categories, no documents). Content types carry an
// author; the per-user state types (attempts, lab progress) carry the solver.

/// One row of the resource list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LearningResourceSummary {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub author_username: String,
    pub created_at: DateTime<Utc>,
}

/// A resource to read, its markdown body rendered to sanitized HTML server-side.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LearningResourceView {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub author_id: Uuid,
    pub author_username: String,
    pub body_html: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// The authoring payload for a resource (raw markdown body).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LearningResourceBody {
    pub title: String,
    pub body: String,
    pub status: String,
}

/// The raw (markdown) form of a resource, used to populate the editor — the
/// author-only counterpart to a document's draft. Readers get the rendered
/// view; only an author fetches the source back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LearningResourceDraft {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub status: String,
}

/// One row of the test list. `question_count` lets the list say how long a test
/// is without loading its questions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LearningTestSummary {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub author_username: String,
    pub question_count: i64,
    pub created_at: DateTime<Utc>,
}

/// A test as a taker sees it: questions and options, but **never** which option
/// is correct — scoring is the server's job (see the migration note).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LearningTestView {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub questions: Vec<TestQuestionView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TestQuestionView {
    pub id: Uuid,
    pub prompt: String,
    pub options: Vec<TestOptionView>,
}

/// Deliberately no `is_correct` — that field exists only on the server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TestOptionView {
    pub id: Uuid,
    pub label: String,
}

/// The authoring payload for a whole test, questions and answers included.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LearningTestBody {
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub pass_score: Option<i32>,
    pub questions: Vec<TestQuestionInput>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TestQuestionInput {
    pub prompt: String,
    pub options: Vec<TestOptionInput>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TestOptionInput {
    pub label: String,
    #[serde(default)]
    pub is_correct: bool,
}

/// The raw form of a test for its author's editor — the take view plus the
/// `is_correct` flags it deliberately hides, so the author can see and change
/// which option is right.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LearningTestDraft {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub pass_score: Option<i32>,
    pub questions: Vec<TestQuestionDraft>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TestQuestionDraft {
    pub prompt: String,
    pub options: Vec<TestOptionDraft>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TestOptionDraft {
    pub label: String,
    pub is_correct: bool,
}

/// A test submission: one chosen option per question (or none).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AttemptSubmit {
    pub answers: Vec<AttemptAnswer>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct AttemptAnswer {
    pub question_id: Uuid,
    pub option_id: Option<Uuid>,
}

/// The graded result of one attempt, returned right after submitting and listed
/// in the taker's own history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct AttemptResult {
    pub id: Uuid,
    pub score: i32,
    pub max_score: i32,
    pub passed: Option<bool>,
    pub submitted_at: DateTime<Utc>,
}

/// One line of an admin's view of everyone's attempts on a test.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct AttemptRow {
    pub username: String,
    pub score: i32,
    pub max_score: i32,
    pub passed: Option<bool>,
    pub submitted_at: DateTime<Utc>,
}

/// One row of the lab list, carrying the caller's own state on it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LearningLabSummary {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub author_username: String,
    /// The caller's own progress state, or `null` if they have not started.
    pub my_state: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A lab to work on, its brief rendered, plus the caller's own progress.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LearningLabView {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub brief_html: String,
    pub author_username: String,
    pub my_progress: Option<LabProgressView>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One user's state on one lab, as they see it themselves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LabProgressView {
    pub state: String,
    pub submission: Option<String>,
    pub grade: Option<i32>,
}

/// The authoring payload for a lab (raw markdown brief).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LearningLabBody {
    pub title: String,
    pub brief: String,
    pub status: String,
}

/// The raw (markdown) form of a lab, used to populate the editor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LearningLabDraft {
    pub id: Uuid,
    pub title: String,
    pub brief: String,
    pub status: String,
}

/// A learner advancing their own lab: the new state and their submission text.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LabProgressSubmit {
    pub state: String,
    pub submission: Option<String>,
}

/// One line of an admin's view of everyone's progress on a lab.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromRow)]
pub struct LabSubmissionRow {
    pub username: String,
    pub state: String,
    pub submission: Option<String>,
    pub grade: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

/// A lab progress state a learner may set. `reviewed` is an admin-only verdict,
/// so a learner's own update cannot claim it; anything unknown falls back to
/// `in_progress` rather than trusting a crafted value.
pub fn normalize_lab_state(state: &str) -> String {
    match state {
        "not_started" => "not_started",
        "submitted" => "submitted",
        _ => "in_progress",
    }
    .to_string()
}

/// Anything not exactly `"published"` is a draft. The editor sends a select's
/// value; a crafted request can send anything at all.
pub fn normalize_status(status: &str) -> String {
    match status {
        "published" => "published".to_string(),
        _ => "draft".to_string(),
    }
}
