//! Admin user-management server functions (§5.2, §7 Admin). All require
//! `is_admin`.

use leptos::prelude::*;

use crate::models::User;

#[cfg(feature = "ssr")]
use crate::models::CategoryPermission;

/// Parse the per-category grants the admin UI sends as JSON, dropping the ones
/// with nothing ticked and collapsing duplicate rows for the same category.
#[cfg(feature = "ssr")]
fn parse_grants(json: &str) -> Result<Vec<CategoryPermission>, ServerFnError> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let grants: Vec<CategoryPermission> = serde_json::from_str(json)
        .map_err(|e| ServerFnError::new(format!("Invalid category permissions: {e}")))?;

    let mut seen: Vec<CategoryPermission> = Vec::new();
    for g in grants.into_iter().filter(|g| !g.is_empty()) {
        match seen.iter_mut().find(|s| s.category_id == g.category_id) {
            Some(existing) => {
                existing.can_read |= g.can_read;
                existing.can_write |= g.can_write;
                existing.can_edit |= g.can_edit;
                existing.can_delete |= g.can_delete;
            }
            None => seen.push(g),
        }
    }
    Ok(seen)
}

/// Spell out a set of grants for the audit log: "Onboarding: read, write".
///
/// The category *names* are looked up rather than logged as ids, because the
/// point of the entry is that an admin can read what changed a month later
/// without going and resolving uuids by hand.
#[cfg(feature = "ssr")]
async fn describe_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    grants: &[CategoryPermission],
) -> Result<String, ServerFnError> {
    use crate::backend;

    if grants.is_empty() {
        return Ok("no category access".to_string());
    }
    let ids: Vec<uuid::Uuid> = grants.iter().map(|g| g.category_id).collect();
    let names: Vec<(uuid::Uuid, String)> =
        sqlx::query_as("SELECT id, name FROM categories WHERE id = ANY($1::uuid[])")
            .bind(&ids)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| backend::internal("naming the categories being granted", e))?;

    let described: Vec<String> = grants
        .iter()
        .map(|g| {
            let name = names
                .iter()
                .find(|(id, _)| *id == g.category_id)
                .map(|(_, n)| n.as_str())
                .unwrap_or("(deleted category)");
            let mut allowed = Vec::new();
            if g.can_read {
                allowed.push("read");
            }
            if g.can_write {
                allowed.push("write");
            }
            if g.can_edit {
                allowed.push("edit");
            }
            if g.can_delete {
                allowed.push("delete");
            }
            format!("{name}: {}", allowed.join(", "))
        })
        .collect();
    Ok(described.join("; "))
}

/// Replace a user's per-category grants inside an existing transaction.
#[cfg(feature = "ssr")]
async fn replace_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: uuid::Uuid,
    granted_by: uuid::Uuid,
    grants: &[CategoryPermission],
) -> Result<(), ServerFnError> {
    use crate::backend;

    sqlx::query("DELETE FROM user_category_permissions WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| backend::internal("clearing a user's category grants", e))?;

    for g in grants {
        sqlx::query(
            "INSERT INTO user_category_permissions
                (user_id, category_id, can_read, can_write, can_edit, can_delete, granted_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(user_id)
        .bind(g.category_id)
        .bind(g.can_read)
        .bind(g.can_write)
        .bind(g.can_edit)
        .bind(g.can_delete)
        .bind(granted_by)
        .execute(&mut **tx)
        .await
        .map_err(|e| {
            // Only a foreign-key violation means the category is gone. The
            // previous blanket mapping reported a connection failure as a bad
            // permission list, sending the admin to fix the wrong thing.
            backend::db_reference(
                "granting category permissions",
                e,
                "One of those categories no longer exists. Reload the page and try again.",
            )
        })?;
    }
    Ok(())
}

/// FR-5: create a user with an initial password and per-category grants.
/// `category_perms_json` is a JSON array of [`CategoryPermission`]; pass `"[]"`
/// for none, which is a user who can see nothing until granted a category.
#[server]
pub async fn create_user(
    username: String,
    password: String,
    is_admin: bool,
    category_perms_json: String,
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
    let grants = parse_grants(&category_perms_json)?;
    let hash = backend::hash_password(&password)
        .map_err(|e| backend::internal("hashing a new user's password", e))?;

    let pool = backend::pool();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| backend::internal("opening a transaction to create a user", e))?;

    // The legacy global `can_*` columns are left at their FALSE default: they
    // no longer grant anything, access comes from the grants below.
    let user_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, is_admin, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&username)
    .bind(&hash)
    .bind(is_admin)
    .bind(admin.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| backend::db_conflict("creating a user", e, "That username is already taken"))?;

    replace_grants(&mut tx, user_id, admin.id, &grants).await?;

    let granted = describe_grants(&mut tx, &grants).await?;
    backend::audit_tx(
        &mut tx,
        &admin,
        backend::Audit {
            action: "user.create",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: Some(format!(
                "{}; {granted}",
                if is_admin { "administrator" } else { "regular user" }
            )),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| backend::internal("committing a new user", e))?;

    Ok(())
}

// `update_permissions` (the global R/W/E/D setter) was removed along with the
// global-flag model: it wrote columns nothing reads any more, so keeping the
// endpoint would only invite the impression that it still granted something.
// FR-6 is now served entirely by `update_category_permissions` below.

/// Replace a user's per-category grants wholesale. `category_perms_json` is a
/// JSON array of [`CategoryPermission`]; categories absent from it (or with
/// nothing ticked) lose all grants.
#[server]
pub async fn update_category_permissions(
    user_id: uuid::Uuid,
    category_perms_json: String,
) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;
    let grants = parse_grants(&category_perms_json)?;

    let pool = backend::pool();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| backend::internal("opening a transaction to set category grants", e))?;

    // Also the existence check this never had: without a row here the grants
    // are cleared and re-inserted for nobody, and the panel reports success.
    let username: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| backend::internal("naming the user whose grants are being set", e))?;
    let username = username.ok_or_else(|| ServerFnError::new("That user no longer exists"))?;

    replace_grants(&mut tx, user_id, admin.id, &grants).await?;

    let granted = describe_grants(&mut tx, &grants).await?;
    backend::audit_tx(
        &mut tx,
        &admin,
        backend::Audit {
            action: "user.permissions",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: Some(granted),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| backend::internal("committing category grants", e))?;
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
    let pool = backend::pool();
    // RETURNING doubles as the rows-affected check and gives the log a name to
    // print instead of a uuid.
    let username: Option<String> =
        sqlx::query_scalar("UPDATE users SET is_active = $2 WHERE id = $1 RETURNING username")
            .bind(user_id)
            .bind(active)
            .fetch_optional(&pool)
            .await
            .map_err(|e| backend::internal("changing a user's active state", e))?;
    // An id that matches nothing is not a success: the admin panel would
    // re-render the row exactly as it was and look like a click that did
    // nothing (which is the bug the row-level error display was added for).
    let username = username.ok_or_else(|| ServerFnError::new("That user no longer exists"))?;

    backend::audit_now(
        &pool,
        Some(admin.id),
        &admin.username,
        backend::Audit {
            action: if active {
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
    Ok(())
}

/// FR-8: reset a user's password.
#[server]
pub async fn reset_password(
    user_id: uuid::Uuid,
    new_password: String,
) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;
    if new_password.len() < 6 {
        return Err(ServerFnError::new("Password must be at least 6 characters"));
    }
    let hash = backend::hash_password(&new_password)
        .map_err(|e| backend::internal("hashing a reset password", e))?;
    let pool = backend::pool();
    let username: Option<String> = sqlx::query_scalar(
        "UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING username",
    )
    .bind(user_id)
    .bind(&hash)
    .fetch_optional(&pool)
    .await
    .map_err(|e| backend::internal("resetting a password", e))?;
    // Otherwise the panel reports "Password reset." for a password that was
    // never written anywhere.
    let username = username.ok_or_else(|| ServerFnError::new("That user no longer exists"))?;

    // The new password is not in the entry, obviously — that it was reset, by
    // whom and when is the whole of what an admin needs to see later.
    backend::audit_now(
        &pool,
        Some(admin.id),
        &admin.username,
        backend::Audit {
            action: "user.password_reset",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: None,
        },
    )
    .await;
    Ok(())
}

/// List all users with their per-category grants (admin panel).
#[server]
pub async fn list_users() -> Result<Vec<User>, ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;
    let pool = backend::pool();

    let mut users = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, can_read, can_write, can_edit, can_delete, is_active, created_at
         FROM users ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| backend::internal("listing users", e))?;

    // One extra round-trip for everyone's grants, then fan them out.
    let grants: Vec<(uuid::Uuid, uuid::Uuid, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT user_id, category_id, can_read, can_write, can_edit, can_delete
         FROM user_category_permissions",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| backend::internal("listing every user's category grants", e))?;

    for (user_id, category_id, can_read, can_write, can_edit, can_delete) in grants {
        if let Some(u) = users.iter_mut().find(|u| u.id == user_id) {
            u.category_perms.push(CategoryPermission {
                category_id,
                can_read,
                can_write,
                can_edit,
                can_delete,
            });
        }
    }

    Ok(users)
}
