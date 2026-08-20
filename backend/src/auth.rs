//! Passwords, the session, and the guards every protected handler goes through.
//!
//! The guards are Axum extractors rather than functions you remember to call.
//! That is the whole design: a handler that takes [`CurrentUser`] cannot run
//! without a session, and one that takes [`AdminUser`] cannot run for a
//! non-admin, because the request never reaches the body otherwise. The Leptos
//! version had to open every server function with `require_user().await?` and
//! trust that nobody forgot.
//!
//! What no extractor can decide is the *category* — that depends on which
//! document the request names, which the handler has to read first. So
//! [`require_in_category`] stays an explicit call, and like its predecessor it
//! has no category-less variant.

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use sqlx::PgPool;
use tower_sessions::Session;
use uuid::Uuid;

use crate::db::AppState;
use crate::error::{internal, ApiError, ApiResult};
use crate::models::{CategoryPermission, Permission, User};

/// Session key under which the authenticated user id is stored.
pub const SESSION_UID: &str = "uid";

// --- Passwords (SR-1) -------------------------------------------------------

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        // A hash the parser rejects is a corrupt row, not a wrong password. It
        // still fails the login — there is no safe way to let it through — but
        // it must be visible, or the account simply stops working for reasons
        // nobody can see.
        Err(e) => {
            tracing::error!("stored password hash could not be parsed: {e}");
            false
        }
    }
}

// --- Loading the caller -----------------------------------------------------

/// The per-category grants held by one user.
pub async fn category_perms_for(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<CategoryPermission>, sqlx::Error> {
    sqlx::query_as::<_, CategoryPermission>(
        "SELECT category_id, can_read, can_write, can_edit, can_delete
         FROM user_category_permissions WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// The user behind a session id, if they still exist and are still active.
///
/// Read fresh from the database on every request (SR-10), so a revoked grant or
/// a disabled account takes effect immediately rather than at the next login.
pub async fn load_user(pool: &PgPool, uid: Uuid) -> ApiResult<Option<User>> {
    let user = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, is_active, created_at FROM users WHERE id = $1",
    )
    .bind(uid)
    .fetch_optional(pool)
    .await
    .map_err(|e| internal("loading the current user", e))?;

    match user {
        Some(mut u) if u.is_active => {
            u.category_perms = category_perms_for(pool, u.id)
                .await
                .map_err(|e| internal("loading the current user's category grants", e))?;
            Ok(Some(u))
        }
        _ => Ok(None),
    }
}

/// Read the session's user id, treating an unreadable store as "not logged in".
///
/// That is the safe direction, but it is a fault rather than a visitor without
/// a cookie, so it is not allowed to pass unrecorded.
async fn session_uid(session: &Session) -> Option<Uuid> {
    match session.get::<Uuid>(SESSION_UID).await {
        Ok(uid) => uid,
        Err(e) => {
            tracing::error!("could not read the session while guarding a request: {e}");
            None
        }
    }
}

// --- Extractors -------------------------------------------------------------

/// An authenticated, active user. Extracting it *is* the 401 guard.
pub struct CurrentUser(pub User);

impl<S> FromRequestParts<S> for CurrentUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app = AppState::from_ref(state);
        let session = Session::from_request_parts(parts, state)
            .await
            // The session layer is applied to the whole router, so its absence
            // is a wiring mistake, not a request problem.
            .map_err(|e| internal("extracting the session", format!("{e:?}")))?;

        let uid = session_uid(&session)
            .await
            .ok_or_else(|| ApiError::Unauthorized("Not signed in".into()))?;

        match load_user(&app.pool, uid).await? {
            Some(user) => Ok(CurrentUser(user)),
            // The id resolved to nobody usable — deleted or deactivated
            // mid-session. Drop the cookie's contents so the browser stops
            // presenting a session that will never work again.
            None => {
                let _ = session.flush().await;
                Err(ApiError::Unauthorized("Your session has ended".into()))
            }
        }
    }
}

/// An authenticated user who is an administrator (§4.1).
pub struct AdminUser(pub User);

impl<S> FromRequestParts<S> for AdminUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.is_admin {
            Ok(AdminUser(user))
        } else {
            Err(ApiError::Forbidden("Administrators only".into()))
        }
    }
}

/// Require a permission *on a specific category* — the only way to authorize
/// anything for a non-admin (§4.2.1, SR-3).
///
/// There is deliberately no category-less variant: a permission with no
/// category attached is what used to let a global flag reach into categories
/// the user was never granted.
pub fn require_in_category(user: &User, perm: Permission, category_id: Uuid) -> ApiResult<()> {
    if user.has_in(category_id, perm) {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "You do not have permission in this category".into(),
        ))
    }
}
