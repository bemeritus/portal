//! `/api/analytics` — the admin's read-only view of how the knowledge base is
//! actually used (§5.6 neighbourhood): what gets read, and which searches come
//! up empty.
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
    // These figures are independent aggregations over different tables, so they
    // go out together rather than one after the other. The page is admin-only
    // and infrequent, but there is no reason to pay serial round-trips when one
    // wall-clock's worth of them will do.
    let total_documents = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM documents")
        .fetch_one(&state.pool);

    // SUM over a bigint column comes back NUMERIC in Postgres; cast it back so
    // it decodes as i64.
    let total_views = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(view_count), 0)::bigint FROM documents",
    )
    .fetch_one(&state.pool);

    // Most-read documents.
    let popular = sqlx::query_as::<_, PopularDoc>(
        "SELECT d.id, d.title, c.name AS category_name, d.view_count
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         ORDER BY d.view_count DESC, d.created_at DESC
         LIMIT $1",
    )
    .bind(TOP_N)
    .fetch_all(&state.pool);

    let search_misses = sqlx::query_as::<_, SearchMiss>(
        "SELECT lower(query) AS query, COUNT(*) AS count, MAX(at) AS last_at
         FROM search_misses
         GROUP BY lower(query)
         ORDER BY COUNT(*) DESC, MAX(at) DESC
         LIMIT $1",
    )
    .bind(MISSES_N)
    .fetch_all(&state.pool);

    let (total_documents, total_views, popular, search_misses) =
        tokio::try_join!(total_documents, total_views, popular, search_misses)
            .map_err(|e| internal("building the analytics overview", e))?;

    Ok(Json(AnalyticsOverview {
        total_documents,
        total_views,
        popular,
        search_misses,
    }))
}
