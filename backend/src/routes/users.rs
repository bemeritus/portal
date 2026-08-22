//! `/api/users` — admin user management (§5.2, §7 Admin). All admin-only,
//! which the [`AdminUser`] extractor enforces before any body runs.
//!
//! There is no endpoint for the global `can_*` flags. They no longer grant
//! anything (§4.2.1), so an endpoint that wrote them would only invite the
//! impression that they did.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audit::{audit_now, audit_tx, Audit};
use crate::auth::{hash_password, AdminUser};
use crate::db::AppState;
use crate::error::{db_conflict, db_reference, internal, ApiError, ApiResult};
use crate::models::{CategoryPermission, Section, SectionAccess, User};

/// Shortest password the platform accepts, for creation and for resets alike.
const MIN_PASSWORD_LEN: usize = 6;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}/permissions", put(set_permissions))
        .route("/{id}/active", put(set_active))
        .route("/{id}/password", put(reset_password))
}

#[derive(Deserialize)]
pub struct CreateUserBody {
    username: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
    /// Grants to apply at creation; `[]` is a user who can see nothing until
    /// an admin gives them a category.
    #[serde(default)]
    category_perms: Vec<CategoryPermission>,
    /// Sections to open at creation. A category grant implies the `templates`
    /// section regardless (see [`clean_sections`]), so the two matrices cannot
    /// disagree into a dead grant.
    #[serde(default)]
    sections: Vec<SectionAccess>,
}

#[derive(Deserialize)]
pub struct PermissionsBody {
    category_perms: Vec<CategoryPermission>,
    /// Section access is edited on the same screen as the category matrix, so
    /// it is set in the same request — one write, one audit entry.
    #[serde(default)]
    sections: Vec<SectionAccess>,
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

/// Drop the grants with nothing ticked and collapse duplicate rows for the same
/// category, so what is stored is what the matrix actually meant.
fn clean_grants(grants: Vec<CategoryPermission>) -> Vec<CategoryPermission> {
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
    seen
}

/// Normalize the section list an admin submitted, and close the one gap that
/// would recreate a dead grant.
///
/// Two things happen here. First, `can_author` is cleared for every section but
/// `learning` — the database forbids it elsewhere, so this turns what would be
/// a 500 into the harmless truth. Second, if the user holds any category grant
/// they are given the `templates` section whether or not the box was ticked: a
/// grant with no door is exactly the dead state this layer exists to prevent,
/// and the admin UI must not be able to produce it.
fn clean_sections(
    sections: Vec<SectionAccess>,
    category_grants: &[CategoryPermission],
) -> Vec<SectionAccess> {
    let mut seen: Vec<SectionAccess> = Vec::new();
    for s in sections {
        let can_author = s.can_author && s.section == Section::Learning;
        match seen.iter_mut().find(|x| x.section == s.section) {
            Some(existing) => existing.can_author |= can_author,
            None => seen.push(SectionAccess {
                section: s.section,
                can_author,
            }),
        }
    }
    let has_grant = category_grants.iter().any(|g| !g.is_empty());
    if has_grant && !seen.iter().any(|s| s.section == Section::Templates) {
        seen.push(SectionAccess {
            section: Section::Templates,
            can_author: false,
        });
    }
    seen
}

/// Replace a user's section access inside an existing transaction.
async fn replace_sections(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    granted_by: Uuid,
    sections: &[SectionAccess],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM user_sections WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("clearing a user's section access", e))?;

    for s in sections {
        sqlx::query(
            "INSERT INTO user_sections (user_id, section, can_author, granted_by)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user_id)
        .bind(s.section.as_str())
        .bind(s.can_author)
        .bind(granted_by)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("granting section access", e))?;
    }
    Ok(())
}

/// Describe section access for the audit log: "templates; learning (author)".
/// The section names are fixed strings, so — unlike categories — there is
/// nothing to look up.
fn describe_sections(sections: &[SectionAccess]) -> String {
    if sections.is_empty() {
        return "no sections".to_string();
    }
    sections
        .iter()
        .map(|s| {
            if s.can_author {
                format!("{} (author)", s.section.as_str())
            } else {
                s.section.as_str().to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Spell out a set of grants for the audit log: "Onboarding: read, write".
///
/// The category *names* are looked up rather than logged as ids, because the
/// point of the entry is that an admin can read what changed a month later
/// without going and resolving uuids by hand.
async fn describe_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    grants: &[CategoryPermission],
) -> ApiResult<String> {
    if grants.is_empty() {
        return Ok("no category access".to_string());
    }
    let ids: Vec<Uuid> = grants.iter().map(|g| g.category_id).collect();
    let names: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, name FROM categories WHERE id = ANY($1::uuid[])")
            .bind(&ids)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| internal("naming the categories being granted", e))?;

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
async fn replace_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    granted_by: Uuid,
    grants: &[CategoryPermission],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM user_category_permissions WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("clearing a user's category grants", e))?;

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
            // Only a foreign-key violation means the category is gone. A
            // blanket mapping would report a connection failure as a bad
            // permission list, sending the admin to fix the wrong thing.
            db_reference(
                "granting category permissions",
                e,
                "One of those categories no longer exists. Reload the page and try again.",
            )
        })?;
    }
    Ok(())
}

/// List all users with their per-category grants (FR-23).
async fn list(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
) -> ApiResult<Json<Vec<User>>> {
    let mut users = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, is_active, created_at FROM users ORDER BY created_at",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing users", e))?;

    // One extra round-trip for everyone's grants, then fan them out.
    let grants: Vec<(Uuid, Uuid, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT user_id, category_id, can_read, can_write, can_edit, can_delete
         FROM user_category_permissions",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing every user's category grants", e))?;

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

    // The same fan-out for section access, so the admin matrix arrives with the
    // section boxes already reflecting reality.
    let sections: Vec<(Uuid, String, bool)> =
        sqlx::query_as("SELECT user_id, section, can_author FROM user_sections")
            .fetch_all(&state.pool)
            .await
            .map_err(|e| internal("listing every user's section access", e))?;

    for (user_id, section, can_author) in sections {
        if let (Some(u), Some(section)) = (
            users.iter_mut().find(|u| u.id == user_id),
            Section::from_db(&section),
        ) {
            u.sections.push(SectionAccess {
                section,
                can_author,
            });
        }
    }

    Ok(Json(users))
}

/// FR-5: create a user with an initial password and per-category grants.
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
    let grants = clean_grants(body.category_perms);
    let sections = clean_sections(body.sections, &grants);
    let hash =
        hash_password(&body.password).map_err(|e| internal("hashing a new user's password", e))?;

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to create a user", e))?;

    // The legacy global `can_*` columns are left at their FALSE default: they
    // no longer grant anything, access comes from the grants below.
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, is_admin, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&username)
    .bind(&hash)
    .bind(body.is_admin)
    .bind(admin.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| db_conflict("creating a user", e, "That username is already taken"))?;

    replace_grants(&mut tx, user_id, admin.id, &grants).await?;
    replace_sections(&mut tx, user_id, admin.id, &sections).await?;

    let granted = describe_grants(&mut tx, &grants).await?;
    let granted_sections = describe_sections(&sections);
    audit_tx(
        &mut tx,
        &admin,
        Audit {
            action: "user.create",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: Some(format!(
                "{}; sections: {granted_sections}; {granted}",
                if body.is_admin {
                    "administrator"
                } else {
                    "regular user"
                }
            )),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a new user", e))?;

    Ok((StatusCode::CREATED, Json(CreatedUser { id: user_id })))
}

/// FR-22: replace a user's per-category grants wholesale. Categories absent
/// from the body (or with nothing ticked) lose all grants.
async fn set_permissions(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<PermissionsBody>,
) -> ApiResult<StatusCode> {
    let grants = clean_grants(body.category_perms);
    let sections = clean_sections(body.sections, &grants);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to set category grants", e))?;

    // Without this check the grants are cleared and re-inserted for nobody,
    // and the panel reports success.
    let username: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| internal("naming the user whose grants are being set", e))?;
    let username =
        username.ok_or_else(|| ApiError::NotFound("That user no longer exists".into()))?;

    replace_grants(&mut tx, user_id, admin.id, &grants).await?;
    replace_sections(&mut tx, user_id, admin.id, &sections).await?;

    let granted = describe_grants(&mut tx, &grants).await?;
    let granted_sections = describe_sections(&sections);
    audit_tx(
        &mut tx,
        &admin,
        Audit {
            action: "user.permissions",
            target_type: "user",
            target_id: Some(user_id),
            target_name: &username,
            details: Some(format!("sections: {granted_sections}; {granted}")),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing category grants", e))?;
    Ok(StatusCode::NO_CONTENT)
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
