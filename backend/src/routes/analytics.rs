//! `/api/analytics` — the admin's read-only view of how the knowledge base is
//! actually used (§5.6 neighbourhood): what gets read, what readers mark as
//! unhelpful, and which searches come up empty.
//!
//! Admin only, like the audit log: it aggregates across every category,
//! including ones a given admin was never granted, so the guard is the role
//! rather than a per-category check.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

use crate::auth::AdminUser;
use crate::db::AppState;
use crate::error::{internal, ApiResult};
use crate::models::{AnalyticsOverview, PopularDoc, SearchMiss};

/// How many rows each ranked list returns — enough to act on, short enough to
/// scan.
const TOP_N: i64 = 10;
const MISSES_N: i64 = 20;

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(overview))
}

async fn overview(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
) -> ApiResult<Json<AnalyticsOverview>> {
    let total_documents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| internal("counting documents", e))?;

    // SUM over a bigint column comes back NUMERIC in Postgres; cast it back so
    // it decodes as i64.
    let total_views: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(view_count), 0)::bigint FROM documents")
            .fetch_one(&state.pool)
            .await
            .map_err(|e| internal("summing views", e))?;

    // The counts join is the same for both rankings; only the ORDER BY and the
    // filter differ, so they share the shape.
    let popular = sqlx::query_as::<_, PopularDoc>(
        "SELECT d.id, d.title, c.name AS category_name, d.view_count,
                COUNT(f.*) FILTER (WHERE f.helpful) AS helpful_count,
                COUNT(f.*) FILTER (WHERE NOT f.helpful) AS not_helpful_count
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         LEFT JOIN document_feedback f ON f.document_id = d.id
         GROUP BY d.id, c.name
         ORDER BY d.view_count DESC, d.created_at DESC
         LIMIT $1",
    )
    .bind(TOP_N)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("ranking popular documents", e))?;

    let needs_work = sqlx::query_as::<_, PopularDoc>(
        "SELECT d.id, d.title, c.name AS category_name, d.view_count,
                COUNT(f.*) FILTER (WHERE f.helpful) AS helpful_count,
                COUNT(f.*) FILTER (WHERE NOT f.helpful) AS not_helpful_count
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         JOIN document_feedback f ON f.document_id = d.id
         GROUP BY d.id, c.name
         HAVING COUNT(f.*) FILTER (WHERE NOT f.helpful) > 0
         ORDER BY COUNT(f.*) FILTER (WHERE NOT f.helpful) DESC, d.view_count DESC
         LIMIT $1",
    )
    .bind(TOP_N)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("ranking documents needing work", e))?;

    let search_misses = sqlx::query_as::<_, SearchMiss>(
        "SELECT lower(query) AS query, COUNT(*) AS count, MAX(at) AS last_at
         FROM search_misses
         GROUP BY lower(query)
         ORDER BY COUNT(*) DESC, MAX(at) DESC
         LIMIT $1",
    )
    .bind(MISSES_N)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("ranking search misses", e))?;

    Ok(Json(AnalyticsOverview {
        total_documents,
        total_views,
        popular,
        needs_work,
        search_misses,
    }))
}
