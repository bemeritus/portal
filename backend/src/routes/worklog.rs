//! `/api/worklog` — the server-room work log.
//!
//! A structured journal to sit beside the Q&A documents: each entry records a
//! piece of work done in the server room — who did it, when, where, what, why,
//! the result, and any photos or clips. Any signed-in user may read and manage
//! entries, the same rule the documents follow; media is uploaded through
//! `/api/media` first and attached here by filename.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::audit::{Audit, audit_now, audit_tx};
use crate::auth::CurrentUser;
use crate::db::AppState;
use crate::error::{ApiError, ApiResult, db_reference, internal};
use crate::models::{
    WorkLogBody, WorkLogDetail, WorkLogMedia, WorkLogMediaInput, WorkLogPerformer, WorkLogSummary,
    normalize_media_kind,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        // Literal path, registered alongside the parameterised one; axum routes
        // the static segment first, so it never collides with `/{id}`.
        .route("/performers", get(performers))
        .route("/{id}", get(get_one).put(update).delete(remove))
}

#[derive(Deserialize)]
pub struct ListParams {
    /// Free-text query over the title, location and the work description.
    q: Option<String>,
}

/// The entries, newest work first, each carrying its performers' names and a
/// media count so the list reads without a request per row.
async fn list(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<WorkLogSummary>>> {
    let q = params
        .q
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let rows = sqlx::query_as::<_, WorkLogSummary>(
        "SELECT w.id, w.title, w.performed_at, w.location, w.work,
                u.username AS author_username, w.created_at,
                COALESCE(p.names, '{}'::text[]) AS performers,
                COALESCE(m.cnt, 0) AS media_count
         FROM work_logs w
         LEFT JOIN users u ON u.id = w.author_id
         LEFT JOIN LATERAL (
             SELECT array_agg(name ORDER BY name) AS names FROM (
                 SELECT pu.username AS name
                 FROM work_log_performers wp JOIN users pu ON pu.id = wp.user_id
                 WHERE wp.work_log_id = w.id
                 UNION ALL
                 SELECT unnest(w.external_performers)
             ) s
         ) p ON TRUE
         LEFT JOIN LATERAL (
             SELECT count(*) AS cnt FROM work_log_media wm WHERE wm.work_log_id = w.id
         ) m ON TRUE
         WHERE ($1::text IS NULL OR (
                    w.title ILIKE '%' || $1 || '%'
                 OR w.location ILIKE '%' || $1 || '%'
                 OR w.work ILIKE '%' || $1 || '%'
               ))
         ORDER BY w.performed_at DESC, w.created_at DESC",
    )
    .bind(q)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing work-log entries", e))?;

    Ok(Json(rows))
}

/// The accounts that may be named as performers — every active user, for the
/// editor's picker. Any signed-in user may read it; the admin-only user list is
/// a different, fuller thing.
async fn performers(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
) -> ApiResult<Json<Vec<WorkLogPerformer>>> {
    let users = sqlx::query_as::<_, WorkLogPerformer>(
        "SELECT id, username FROM users WHERE is_active = TRUE ORDER BY username",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing the performers for the work log", e))?;
    Ok(Json(users))
}

/// One entry in full: its fields, its performers (linked and external), and its
/// media.
async fn get_one(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<WorkLogDetail>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        title: Option<String>,
        performed_at: chrono::DateTime<chrono::Utc>,
        location: String,
        work: String,
        reason: Option<String>,
        result: Option<String>,
        external_performers: Vec<String>,
        author_username: Option<String>,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT w.id, w.title, w.performed_at, w.location, w.work, w.reason, w.result,
                w.external_performers, u.username AS author_username,
                w.created_at, w.updated_at
         FROM work_logs w
         LEFT JOIN users u ON u.id = w.author_id
         WHERE w.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a work-log entry", e))?
    .ok_or_else(|| ApiError::NotFound("Work-log entry not found".into()))?;

    let performers = sqlx::query_as::<_, WorkLogPerformer>(
        "SELECT u.id, u.username
         FROM work_log_performers wp JOIN users u ON u.id = wp.user_id
         WHERE wp.work_log_id = $1
         ORDER BY u.username",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a work-log entry's performers", e))?;

    let media = sqlx::query_as::<_, WorkLogMedia>(
        "SELECT id, kind, '/uploads/' || file_path AS url, original_name
         FROM work_log_media WHERE work_log_id = $1
         ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a work-log entry's media", e))?;

    Ok(Json(WorkLogDetail {
        id: row.id,
        title: row.title,
        performed_at: row.performed_at,
        location: row.location,
        work: row.work,
        reason: row.reason,
        result: row.result,
        author_username: row.author_username,
        created_at: row.created_at,
        updated_at: row.updated_at,
        performers,
        external_performers: row.external_performers,
        media,
    }))
}

/// The cleaned, validated shape of a create/update body: the text fields
/// trimmed, the performers de-duplicated, the media checked. Building it once
/// keeps `create` and `update` from drifting apart on what they accept.
struct Clean {
    title: Option<String>,
    performed_at: chrono::DateTime<chrono::Utc>,
    location: String,
    work: String,
    reason: Option<String>,
    result: Option<String>,
    performer_user_ids: Vec<Uuid>,
    external_performers: Vec<String>,
    media: Vec<WorkLogMediaInput>,
}

/// Trim and validate a body. The rule for "who worked" is that *someone* is
/// named — a linked account or an outside name — because an entry with no
/// performer answers "kim ishladi" with nothing.
fn clean(body: WorkLogBody) -> ApiResult<Clean> {
    let title = body
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let location = body.location.trim().to_string();
    if location.is_empty() {
        return Err(ApiError::BadRequest("Location is required".into()));
    }
    let work = body.work.trim().to_string();
    if work.is_empty() {
        return Err(ApiError::BadRequest(
            "A description of the work is required".into(),
        ));
    }
    let reason = body
        .reason
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let result = body
        .result
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    // De-duplicate the linked accounts, preserving order.
    let mut performer_user_ids: Vec<Uuid> = Vec::new();
    for uid in body.performer_user_ids {
        if !performer_user_ids.contains(&uid) {
            performer_user_ids.push(uid);
        }
    }

    let mut external_performers: Vec<String> = Vec::new();
    for name in body.external_performers {
        let name = name.trim().to_string();
        if !name.is_empty() && !external_performers.contains(&name) {
            external_performers.push(name);
        }
    }

    if performer_user_ids.is_empty() && external_performers.is_empty() {
        return Err(ApiError::BadRequest(
            "Name at least one person who did the work".into(),
        ));
    }

    // Each attachment must be a known kind and a bare filename. Rejecting any
    // path separator or `..` is what stops a crafted body from pointing a row
    // at a file outside the uploads directory.
    let mut media: Vec<WorkLogMediaInput> = Vec::new();
    for item in body.media {
        let kind = normalize_media_kind(&item.kind)
            .ok_or_else(|| ApiError::BadRequest("Unknown media kind".into()))?;
        let file_path = item.file_path.trim().to_string();
        if file_path.is_empty()
            || file_path.contains('/')
            || file_path.contains('\\')
            || file_path.contains("..")
        {
            return Err(ApiError::BadRequest("Invalid media reference".into()));
        }
        media.push(WorkLogMediaInput {
            file_path,
            kind: kind.to_string(),
            original_name: item.original_name.trim().to_string(),
        });
    }

    Ok(Clean {
        title,
        performed_at: body.performed_at,
        location,
        work,
        reason,
        result,
        performer_user_ids,
        external_performers,
        media,
    })
}

/// Write the performers and media of one entry, in order. Shared by `create`
/// and `update`, which both write the same children the same way.
async fn insert_children(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    clean: &Clean,
) -> ApiResult<()> {
    for uid in &clean.performer_user_ids {
        sqlx::query("INSERT INTO work_log_performers (work_log_id, user_id) VALUES ($1, $2)")
            .bind(id)
            .bind(uid)
            .execute(&mut **tx)
            .await
            .map_err(|e| {
                db_reference(
                    "attaching a performer to a work-log entry",
                    e,
                    "One of the chosen users no longer exists. Reload the page and try again.",
                )
            })?;
    }
    for (i, item) in clean.media.iter().enumerate() {
        sqlx::query(
            "INSERT INTO work_log_media (work_log_id, kind, file_path, original_name, position)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(&item.kind)
        .bind(&item.file_path)
        .bind(&item.original_name)
        .bind(i as i32)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("attaching media to a work-log entry", e))?;
    }
    Ok(())
}

/// A one-line summary of who did the work, for the audit log.
fn performer_summary(clean: &Clean) -> String {
    let count = clean.performer_user_ids.len() + clean.external_performers.len();
    format!("{count} performer(s); {} media", clean.media.len())
}

async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<WorkLogBody>,
) -> ApiResult<(StatusCode, Json<CreatedEntry>)> {
    let clean = clean(body)?;

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to create a work-log entry", e))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_logs
            (title, performed_at, location, work, reason, result, external_performers, author_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(&clean.title)
    .bind(clean.performed_at)
    .bind(&clean.location)
    .bind(&clean.work)
    .bind(&clean.reason)
    .bind(&clean.result)
    .bind(&clean.external_performers)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| internal("creating a work-log entry", e))?;

    insert_children(&mut tx, id, &clean).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "worklog.create",
            target_type: "worklog",
            target_id: Some(id),
            target_name: clean.title.as_deref().unwrap_or(&clean.location),
            details: Some(performer_summary(&clean)),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a new work-log entry", e))?;

    Ok((StatusCode::CREATED, Json(CreatedEntry { id })))
}

async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<WorkLogBody>,
) -> ApiResult<StatusCode> {
    let clean = clean(body)?;

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to update a work-log entry", e))?;

    let updated = sqlx::query(
        "UPDATE work_logs
         SET title = $2, performed_at = $3, location = $4, work = $5,
             reason = $6, result = $7, external_performers = $8, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&clean.title)
    .bind(clean.performed_at)
    .bind(&clean.location)
    .bind(&clean.work)
    .bind(&clean.reason)
    .bind(&clean.result)
    .bind(&clean.external_performers)
    .execute(&mut *tx)
    .await
    .map_err(|e| internal("updating a work-log entry", e))?;

    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Work-log entry not found".into()));
    }

    // Children are replaced wholesale, the same strategy the documents use for
    // their blocks: simplest thing that keeps order and set correct.
    sqlx::query("DELETE FROM work_log_performers WHERE work_log_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing a work-log entry's performers", e))?;
    sqlx::query("DELETE FROM work_log_media WHERE work_log_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing a work-log entry's media", e))?;
    insert_children(&mut tx, id, &clean).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "worklog.update",
            target_type: "worklog",
            target_id: Some(id),
            target_name: clean.title.as_deref().unwrap_or(&clean.location),
            details: Some(performer_summary(&clean)),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing an edited work-log entry", e))?;

    Ok(StatusCode::NO_CONTENT)
}

async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // Read the label before the delete, so the audit line names the entry
    // rather than a bare id (performers and media cascade away with it).
    let existing: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT title, location FROM work_logs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading the work-log entry being deleted", e))?;
    let (title, location) =
        existing.ok_or_else(|| ApiError::NotFound("Work-log entry not found".into()))?;

    sqlx::query("DELETE FROM work_logs WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("deleting a work-log entry", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "worklog.delete",
            target_type: "worklog",
            target_id: Some(id),
            target_name: title.as_deref().unwrap_or(&location),
            details: None,
        },
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
pub struct CreatedEntry {
    id: Uuid,
}
