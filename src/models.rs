//! Data types shared between the server (`ssr`) and the browser (`hydrate`).
//!
//! On the server these double as `sqlx::FromRow` targets; on the client they
//! are the (de)serialized payloads returned by server functions. Note that
//! [`User`] deliberately does **not** carry the password hash — the hash never
//! leaves the server (SR-1).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A user account, minus any secret material.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ssr", derive(sqlx::FromRow))]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub is_admin: bool,
    pub can_read: bool,
    pub can_write: bool,
    pub can_edit: bool,
    pub can_delete: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

impl User {
    /// Whether this user holds the given permission. Admins hold everything.
    pub fn has(&self, perm: Permission) -> bool {
        if self.is_admin {
            return true;
        }
        match perm {
            Permission::Read => self.can_read,
            Permission::Write => self.can_write,
            Permission::Edit => self.can_edit,
            Permission::Delete => self.can_delete,
        }
    }
}

/// The four independent capabilities from §4.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Permission {
    Read,
    Write,
    Edit,
    Delete,
}

/// The permission flags as a set, used when creating or updating a user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Permissions {
    pub can_read: bool,
    pub can_write: bool,
    pub can_edit: bool,
    pub can_delete: bool,
}

/// A content category (§6.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ssr", derive(sqlx::FromRow))]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// One row of the document list / filter view (§5.5, FR-17).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ssr", derive(sqlx::FromRow))]
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
