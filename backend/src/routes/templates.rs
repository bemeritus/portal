//! `/api/templates` — the original category + Q&A world, now the first section.
//!
//! Nothing here changed in substance: the categories and documents modules are
//! exactly as they were, only mounted one level deeper and reached through the
//! `InTemplates` door their handlers now extract. The section check lives on
//! those handlers rather than as a layer here so a request is loaded once, not
//! once for the door and again for the body.

use axum::routing::{get, post};
use axum::Router;

use crate::db::AppState;

use super::{categories, documents};

pub fn routes() -> Router<AppState> {
    Router::new()
        .nest("/categories", categories::routes())
        .nest("/documents", documents::routes())
        // The tag vocabulary is document-wide, not per-document, so it sits
        // beside `/documents` rather than under it.
        .route("/tags", get(documents::list_tags))
        // The caller's own bookmarked documents.
        .route("/bookmarks", get(documents::list_bookmarks))
        // The editor's live markdown preview, rendered by the one sanitized path.
        .route("/preview", post(documents::preview_markdown))
}
