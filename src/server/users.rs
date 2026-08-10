//! Admin user-management server functions (§5.2, §7 Admin). All require
//! `is_admin`.

use leptos::prelude::*;

use crate::models::User;

/// Map a database error to a friendly message for unique-constraint hits.
#[cfg(feature = "ssr")]
fn db_err(e: sqlx::Error, unique_msg: &str) -> ServerFnError {
    if let sqlx::Error::Database(ref dbe) = e {
        if dbe.is_unique_violation() {
            return ServerFnError::new(unique_msg.to_string());
        }
    }
    ServerFnError::new(e.to_string())
}

/// FR-5: create a user with an initial password and permission set.
#[server]
pub async fn create_user(
    username: String,
    password: String,
    is_admin: bool,
    can_read: bool,
    can_write: bool,
    can_edit: bool,
    can_delete: bool,
) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;

    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(ServerFnError::new("Username is required"));
    }
    if password.len() < 6 {
        return Err(ServerFnError::new("Password must be at least 6 characters"));
    }
    let hash = backend::hash_password(&password).map_err(ServerFnError::new)?;

    sqlx::query(
        "INSERT INTO users
            (username, password_hash, is_admin, can_read, can_write, can_edit, can_delete, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&username)
    .bind(&hash)
    .bind(is_admin)
    .bind(can_read)
    .bind(can_write)
    .bind(can_edit)
    .bind(can_delete)
    .bind(admin.id)
    .execute(&backend::pool())
    .await
    .map_err(|e| db_err(e, "That username is already taken"))?;

    Ok(())
}

/// FR-6: change a user's permissions.
#[server]
pub async fn update_permissions(
    user_id: uuid::Uuid,
    can_read: bool,
    can_write: bool,
    can_edit: bool,
    can_delete: bool,
) -> Result<(), ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;
    sqlx::query(
        "UPDATE users SET can_read = $2, can_write = $3, can_edit = $4, can_delete = $5 WHERE id = $1",
    )
    .bind(user_id)
    .bind(can_read)
    .bind(can_write)
    .bind(can_edit)
    .bind(can_delete)
    .execute(&backend::pool())
    .await?;
    Ok(())
}

/// FR-7: block or re-activate a user.
#[server]
pub async fn set_user_active(user_id: uuid::Uuid, active: bool) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;
    if admin.id == user_id && !active {
        return Err(ServerFnError::new("You cannot disable your own account"));
    }
    sqlx::query("UPDATE users SET is_active = $2 WHERE id = $1")
        .bind(user_id)
        .bind(active)
        .execute(&backend::pool())
        .await?;
    Ok(())
}

/// FR-8: reset a user's password.
#[server]
pub async fn reset_password(
    user_id: uuid::Uuid,
    new_password: String,
) -> Result<(), ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;
    if new_password.len() < 6 {
        return Err(ServerFnError::new("Password must be at least 6 characters"));
    }
    let hash = backend::hash_password(&new_password).map_err(ServerFnError::new)?;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(&hash)
        .execute(&backend::pool())
        .await?;
    Ok(())
}

/// List all users (admin panel).
#[server]
pub async fn list_users() -> Result<Vec<User>, ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;
    let users = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, can_read, can_write, can_edit, can_delete, is_active, created_at
         FROM users ORDER BY created_at",
    )
    .fetch_all(&backend::pool())
    .await?;
    Ok(users)
}
