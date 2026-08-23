//! The API surface, assembled.
//!
//! Everything lives under `/api`. The one thing outside it is `/uploads/*`,
//! which serves files from disk and is wired up in `main.rs` next to the
//! frontend's static files, since both are `ServeDir`s.

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::db::AppState;
use crate::error::ApiError;

pub mod analytics;
pub mod audit;
pub mod auth;
pub mod categories;
pub mod documents;
pub mod learning;
pub mod templates;
pub mod uploads;
pub mod users;

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

/// Cheap liveness probe: it does not touch the database, so it answers while
/// Postgres is down — which is the state you most want to be able to ask about.
async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

/// A 404 for unmatched paths *under `/api`*.
///
/// Without this the router's outer fallback answers, and that one serves the
/// SPA's `index.html` — so a mistyped or removed endpoint came back as HTML
/// with status 200. The client would then try to parse a document as its
/// response body and throw `Unexpected token '<'`, which says nothing about
/// the actual mistake. Every path under `/api` returns JSON, including this
/// one.
async fn not_found() -> ApiError {
    ApiError::NotFound("No such endpoint".into())
}

pub fn api(state: &AppState) -> Router<AppState> {
    // Headroom over the configured maximum so that a file at exactly the limit
    // is rejected by the size check (with its own clear message) rather than by
    // the body limit (with a bare 413).
    let upload_limit = state.config.max_upload_bytes + 4096;

    Router::new()
        .route("/health", get(health))
        .nest("/auth", auth::routes())
        .nest("/templates", templates::routes())
        .nest("/learning", learning::routes())
        .nest("/users", users::routes())
        .nest("/audit", audit::routes())
        .nest("/analytics", analytics::routes())
        .nest(
            "/upload",
            uploads::routes().layer(DefaultBodyLimit::max(upload_limit)),
        )
        .fallback(not_found)
}
