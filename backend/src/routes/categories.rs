//! `/api/categories` — the category CRUD (§5.3, §7 Categories).
//!
//! Per the decided open question §12.2, categories are managed by the admin
//! only; any authenticated user may list the ones they can see, because the
//! home filter and the editor's picker need them.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::audit::{audit_now, Audit};
use crate::auth::{AdminUser, CurrentUser};
use crate::content::{optional_text, slugify};
use crate::db::AppState;
use crate::error::{db_conflict, db_reference, internal, ApiError, ApiResult};
use crate::models::{Category, Permission};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/writable", get(list_writable))
        .route("/{id}", post(update).put(update).delete(remove))
}

#[derive(Deserialize)]
pub struct CategoryBody {
    name: String,
    #[serde(default)]
    description: String,
}

/// List the categories the caller can see: everything for an admin, otherwise
/// only the ones they hold a grant on.
async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> ApiResult<Json<Vec<Category>>> {
    let visible = user.accessible_categories();
    Ok(Json(fetch(&state, user.is_admin, &visible).await?))
}

/// The categories the caller may author or edit documents in — what the
/// editor's picker offers (FR-25).
async fn list_writable(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> ApiResult<Json<Vec<Category>>> {
    let mut writable = user.granted_categories(Permission::Write);
    for id in user.granted_categories(Permission::Edit) {
        if !writable.contains(&id) {
            writable.push(id);
        }
    }
    Ok(Json(fetch(&state, user.is_admin, &writable).await?))
}

/// Shared tail of the two listings above.
async fn fetch(state: &AppState, all: bool, ids: &[Uuid]) -> ApiResult<Vec<Category>> {
    sqlx::query_as::<_, Category>(
        "SELECT id, name, slug, description, created_at
         FROM categories
         WHERE $1::bool OR id = ANY($2::uuid[])
         ORDER BY name",
    )
    .bind(all)
    .bind(ids)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing categories", e))
}

/// FR-9: create a category.
async fn create(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Json(body): Json<CategoryBody>,
) -> ApiResult<(StatusCode, Json<Category>)> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest("Category name is required".into()));
    }
    let slug = slugify(&name);
    let description = optional_text(&body.description);

    let category = sqlx::query_as::<_, Category>(
        "INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3)
         RETURNING id, name, slug, description, created_at",
    )
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        db_conflict(
            "creating a category",
            e,
            "A category with that name already exists",
        )
    })?;

    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: "category.create",
            target_type: "category",
            target_id: Some(category.id),
            target_name: &category.name,
            details: category.description.clone(),
        },
    )
    .await;

    Ok((StatusCode::CREATED, Json(category)))
}

/// FR-9: rename / re-describe a category.
async fn update(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<CategoryBody>,
) -> ApiResult<StatusCode> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest("Category name is required".into()));
    }
    let slug = slugify(&name);
    let description = optional_text(&body.description);

    // The CTE carries the pre-edit row out of the same statement that
    // overwrites it, so the log can say what the name changed *from* without a
    // second read that another admin could slip an edit into.
    let previous: Option<(String, Option<String>)> = sqlx::query_as(
        "WITH before AS (SELECT id, name, description FROM categories WHERE id = $1)
         UPDATE categories SET name = $2, slug = $3, description = $4
         FROM before WHERE categories.id = before.id
         RETURNING before.name, before.description",
    )
    .bind(id)
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        db_conflict(
            "updating a category",
            e,
            "A category with that name already exists",
        )
    })?;
    // Zero rows means it was deleted meanwhile. Reporting success would leave
    // the admin looking at edits that went nowhere.
    let (old_name, old_description) =
        previous.ok_or_else(|| ApiError::NotFound("That category no longer exists".into()))?;

    let mut changes = Vec::new();
    if old_name != name {
        changes.push(format!("renamed from \"{old_name}\""));
    }
    if old_description != description {
        changes.push("description changed".to_string());
    }
    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: "category.update",
            target_type: "category",
            target_id: Some(id),
            target_name: &name,
            details: (!changes.is_empty()).then(|| changes.join("; ")),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// FR-9: delete a category. Fails while documents still reference it (the FK is
/// `ON DELETE RESTRICT`); the grants on it cascade away (FR-24).
async fn remove(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // Only the FK violation means "still has documents". Mapping *every* error
    // to that sentence told admins to go delete documents when the real cause
    // was, say, an unreachable database.
    let deleted: Option<String> =
        sqlx::query_scalar("DELETE FROM categories WHERE id = $1 RETURNING name")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| {
                db_reference(
                    "deleting a category",
                    e,
                    "Cannot delete a category that still has documents",
                )
            })?;
    let name =
        deleted.ok_or_else(|| ApiError::NotFound("That category no longer exists".into()))?;

    // The category is gone, so this entry is now the only place its name is
    // written down — which is exactly why `target_id` carries no foreign key.
    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: "category.delete",
            target_type: "category",
            target_id: Some(id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
