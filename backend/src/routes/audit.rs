//! `/api/audit` — reading the change history (§5.6, §7 Admin).
//!
//! Read-only by construction. Entries are written by the operations they
//! describe (see `crate::audit`); nothing here, and nothing anywhere else,
//! edits or deletes one (FR-29).

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::AdminUser;
use crate::db::AppState;
use crate::error::{internal, ApiResult};
use crate::models::AuditEntry;

/// The client decides how much of the table to pull in one request, within
/// these bounds — "everything", over a log that only grows, is a query that
/// gets slower every day.
const MIN_LIMIT: i64 = 1;
const MAX_LIMIT: i64 = 500;
const DEFAULT_LIMIT: i64 = 100;

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(list))
}

#[derive(Deserialize)]
pub struct AuditParams {
    /// Narrow to one kind: `user` | `category` | `document` | `upload`.
    target_type: Option<String>,
    /// Free text over the actor, target, action and details.
    search: Option<String>,
    limit: Option<i64>,
}

/// The newest entries first, admin only (SR-11): the log names who did what to
/// accounts a non-admin cannot otherwise see.
async fn list(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
    Query(params): Query<AuditParams>,
) -> ApiResult<Json<Vec<AuditEntry>>> {
    let limit = params
        .limit
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(MIN_LIMIT, MAX_LIMIT);
    let target_type = params.target_type.filter(|t| !t.trim().is_empty());
    let search = params
        .search
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let entries = sqlx::query_as::<_, AuditEntry>(
        "SELECT id, at, actor_name, action, target_type, target_id, target_name, details
         FROM audit_log
         WHERE ($1::text IS NULL OR target_type = $1)
           AND ($2::text IS NULL
                OR actor_name ILIKE '%' || $2 || '%'
                OR target_name ILIKE '%' || $2 || '%'
                OR action ILIKE '%' || $2 || '%'
                OR coalesce(details, '') ILIKE '%' || $2 || '%')
         ORDER BY at DESC
         LIMIT $3",
    )
    .bind(target_type)
    .bind(search)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing the audit log", e))?;

    Ok(Json(entries))
}
