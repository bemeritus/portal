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

use crate::audit::{Audit, audit_now, audit_tx};
use crate::auth::{AdminUser, hash_password};
use crate::db::AppState;
use crate::error::{ApiError, ApiResult, db_conflict, internal};
use crate::models::User;
use crate::tool_access::{ToolGrant, ToolInfo, registry, stored_grants};

/// Shortest password the platform accepts, for creation and for resets alike.
const MIN_PASSWORD_LEN: usize = 6;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}/active", put(set_active))
        .route("/{id}/password", put(reset_password))
        .route("/tool-registry", get(tool_registry))
        .route("/{id}/tools", get(get_tools).put(set_tools))
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
        "SELECT id, username, is_admin, is_active, created_at, language FROM users ORDER BY created_at",
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

// --- «Внутренние инструменты» ----------------------------------------------

/// Every tool and the levels it can be granted at, for the admin page.
async fn tool_registry(AdminUser(_): AdminUser) -> Json<Vec<ToolInfo>> {
    Json(registry())
}

/// A user's stored grants (not the effective set: an admin's list is what was
/// granted to them, which matters if they are later demoted).
async fn get_tools(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
    Path(user_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ToolGrant>>> {
    Ok(Json(stored_grants(&state.pool, user_id).await?))
}

#[derive(Deserialize)]
pub struct ToolsBody {
    grants: Vec<ToolGrant>,
}

/// Replace a user's tool grants with exactly `grants`. One audit entry per
/// grant added or removed, written in the same transaction as the change.
async fn set_tools(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<ToolsBody>,
) -> ApiResult<Json<Vec<ToolGrant>>> {
    let mut wanted = body.grants;
    for g in &wanted {
        if !g.tool.levels().contains(&g.level) {
            return Err(ApiError::BadRequest(
                "That tool cannot be granted at that level".into(),
            ));
        }
    }
    wanted.sort();
    wanted.dedup();

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("starting a tool-permission change", e))?;
    let username: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| internal("locking a user for a tool-permission change", e))?;
    let username =
        username.ok_or_else(|| ApiError::NotFound("That user no longer exists".into()))?;

    let current = stored_grants(&state.pool, user_id).await?;
    let added: Vec<_> = wanted
        .iter()
        .filter(|g| !current.contains(g))
        .copied()
        .collect();
    let removed: Vec<_> = current
        .iter()
        .filter(|g| !wanted.contains(g))
        .copied()
        .collect();

    for g in &removed {
        sqlx::query(
            "DELETE FROM user_tool_permissions WHERE user_id = $1 AND tool = $2 AND level = $3",
        )
        .bind(user_id)
        .bind(g.tool.key())
        .bind(g.level.key())
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("revoking a tool permission", e))?;
    }
    for g in &added {
        sqlx::query("INSERT INTO user_tool_permissions (user_id, tool, level) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(g.tool.key())
            .bind(g.level.key())
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("granting a tool permission", e))?;
    }
    for (action, g) in added
        .iter()
        .map(|g| ("tool_permission.grant", g))
        .chain(removed.iter().map(|g| ("tool_permission.revoke", g)))
    {
        audit_tx(
            &mut tx,
            &admin,
            Audit {
                action,
                target_type: "user",
                target_id: Some(user_id),
                target_name: &username,
                details: Some(format!("{}:{}", g.tool.key(), g.level.key())),
            },
        )
        .await?;
    }
    tx.commit()
        .await
        .map_err(|e| internal("committing a tool-permission change", e))?;
    Ok(Json(wanted))
}
