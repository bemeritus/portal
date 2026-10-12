//! `/api/users` — admin user management (§5.2, §7 Admin). All admin-only,
//! which the [`AdminUser`] extractor enforces before any body runs.
//!
//! There are no per-category grants or sections to manage any more: a user is
//! just a username, a password, and whether they are an admin.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audit::{audit_now, Audit};
use crate::auth::{hash_password, AdminUser};
use crate::db::AppState;
use crate::error::{db_conflict, internal, ApiError, ApiResult};
use crate::models::User;

/// Shortest password the platform accepts, for creation and for resets alike.
const MIN_PASSWORD_LEN: usize = 6;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}/active", put(set_active))
        .route("/{id}/password", put(reset_password))
}

#[derive(Deserialize)]
pub struct CreateUserBody {
    username: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
}

#[derive(Deserialize)]
pub struct ActiveBody {
    active: bool,
}

#[derive(Deserialize)]
pub struct PasswordBody {
    new_password: String,
}

#[derive(Serialize)]
pub struct CreatedUser {
    id: Uuid,
}

/// List all users (FR-23).
async fn list(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
) -> ApiResult<Json<Vec<User>>> {
    let users = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, is_active, created_at FROM users ORDER BY created_at",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing users", e))?;
    Ok(Json(users))
}

/// FR-5: create a user with an initial password. Access beyond that is uniform —
/// any signed-in user can read and manage documents — so the only choice left is
/// whether the account is an administrator.
async fn create(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Json(body): Json<CreateUserBody>,
) -> ApiResult<(StatusCode, Json<CreatedUser>)> {
    let username = body.username.trim().to_string();
    if username.is_empty() {
        return Err(ApiError::BadRequest("Username is required".into()));
    }
    if body.password.len() < MIN_PASSWORD_LEN {
        return Err(ApiError::BadRequest(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    let hash =
        hash_password(&body.password).map_err(|e| internal("hashing a new user's password", e))?;

    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, is_admin, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&username)
    .bind(&hash)
    .bind(body.is_admin)
    .bind(admin.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| db_conflict("creating a user", e, "That username is already taken"))?;

    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: "user.create",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: Some(
                if body.is_admin {
                    "administrator"
                } else {
                    "regular user"
                }
                .to_string(),
            ),
        },
    )
    .await;

    Ok((StatusCode::CREATED, Json(CreatedUser { id: user_id })))
}

/// FR-7: block or re-activate a user.
async fn set_active(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<ActiveBody>,
) -> ApiResult<StatusCode> {
    if admin.id == user_id && !body.active {
        return Err(ApiError::BadRequest(
            "You cannot disable your own account".into(),
        ));
    }
    // RETURNING doubles as the rows-affected check and gives the log a name to
    // print instead of a uuid.
    let username: Option<String> =
        sqlx::query_scalar("UPDATE users SET is_active = $2 WHERE id = $1 RETURNING username")
            .bind(user_id)
            .bind(body.active)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("changing a user's active state", e))?;
    // An id that matches nothing is not a success: the admin panel would
    // re-render the row exactly as it was and look like a click that did
    // nothing.
    let username =
        username.ok_or_else(|| ApiError::NotFound("That user no longer exists".into()))?;

    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: if body.active {
                "user.activate"
            } else {
                "user.deactivate"
            },
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// FR-8: reset a user's password.
async fn reset_password(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<PasswordBody>,
) -> ApiResult<StatusCode> {
    if body.new_password.len() < MIN_PASSWORD_LEN {
        return Err(ApiError::BadRequest(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    let hash =
        hash_password(&body.new_password).map_err(|e| internal("hashing a reset password", e))?;
    let username: Option<String> =
        sqlx::query_scalar("UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING username")
            .bind(user_id)
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("resetting a password", e))?;
    // Otherwise the panel reports "Password reset." for a password that was
    // never written anywhere.
    let username =
        username.ok_or_else(|| ApiError::NotFound("That user no longer exists".into()))?;

    // The new password is not in the entry, obviously — that it was reset, by
    // whom and when is the whole of what an admin needs to see later (SR-12).
    audit_now(
        &state.pool,
        Some(admin.id),
        &admin.username,
        Audit {
            action: "user.password_reset",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
