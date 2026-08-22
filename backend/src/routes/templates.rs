//! `/api/templates` — the original category + Q&A world, now the first section.
//!
//! Nothing here changed in substance: the categories and documents modules are
//! exactly as they were, only mounted one level deeper and reached through the
//! `InTemplates` door their handlers now extract. The section check lives on
//! those handlers rather than as a layer here so a request is loaded once, not
//! once for the door and again for the body.

use axum::Router;

use crate::db::AppState;

use super::{categories, documents};

pub fn routes() -> Router<AppState> {
    Router::new()
        .nest("/categories", categories::routes())
        .nest("/documents", documents::routes())
}
