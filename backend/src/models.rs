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
}

impl Section {
    /// The string stored in `user_sections.section` (must match the CHECK).
    pub fn as_str(self) -> &'static str {
        match self {
            Section::Templates => "templates",
        }
    }

    /// Parse the stored string back, ignoring anything the CHECK would reject.
    pub fn from_db(value: &str) -> Option<Section> {
        match value {
            "templates" => Some(Section::Templates),
            _ => None,
        }
    }
}

/// One user's access to one section. Doubles as the payload the admin UI sends
/// when assigning sections, exactly as [`CategoryPermission`] does for grants.
///
/// `can_author` is kept for wire-compatibility but is never honored: the only
/// section left is `templates`, whose write access comes entirely from category
/// grants, and the database rejects the authoring bit on it.
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

