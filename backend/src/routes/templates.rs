//! `/api/templates` — the category + Q&A world: categories, documents, the tag-
//! free bookmarks list and the markdown preview, grouped under one prefix.
//!
//! Every handler here takes only `CurrentUser`: any signed-in user may read and
//! manage documents, and the admin-only actions (managing categories) carry
//! their own `AdminUser` guard.

use axum::routing::{get, post};
use axum::Router;

use crate::db::AppState;

use super::{categories, documents};

pub fn routes() -> Router<AppState> {
    Router::new()
        .nest("/categories", categories::routes())
        .nest("/documents", documents::routes())
        // The caller's own bookmarked documents.
        .route("/bookmarks", get(documents::list_bookmarks))
        // The editor's live markdown preview, rendered by the one sanitized path.
        .route("/preview", post(documents::preview_markdown))
}
