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
use crate::models::{CategoryPermission, Permission, Section, SectionAccess, User};

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

/// The sections one user may enter — the door half of the two-level model.
pub async fn sections_for(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<SectionAccess>, sqlx::Error> {
    let rows: Vec<(String, bool)> =
        sqlx::query_as("SELECT section, can_author FROM user_sections WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    // A row whose `section` string does not parse can only be one written
    // before a code change removed that section; drop it rather than fail the
    // whole load over a value the enum no longer knows.
    Ok(rows
        .into_iter()
        .filter_map(|(section, can_author)| {
            Section::from_db(&section).map(|section| SectionAccess {
                section,
                can_author,
            })
        })
        .collect())
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
            // The grants and the section access are independent of each other
            // and both keyed only on the user id, so they go out together
            // rather than one after the other. This runs on every authenticated
            // request (SR-10), so the round-trip saved here is saved everywhere.
            let (category_perms, sections) =
                tokio::try_join!(category_perms_for(pool, u.id), sections_for(pool, u.id))
                    .map_err(|e| {
                        internal("loading the current user's grants and section access", e)
                    })?;
            u.category_perms = category_perms;
            u.sections = sections;
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

// --- Section doors ----------------------------------------------------------
//
// Unlike the category (which the handler can only learn from the request body,
// so [`require_in_category`] stays an explicit call), a section is fixed per
// route tree — known before the body runs. That is exactly what an extractor
// can decide, so these *are* extractors, and nesting a router under one closes
// its door once instead of asking every handler to remember the check. A
// handler that also needs the finer category grant still calls
// `require_in_category` inside; the two-level AND is the extractor AND that
// call, mirroring how `AdminUser` and `require_in_category` already compose.

/// A user who may enter the `templates` section.
pub struct InTemplates(pub User);

impl<S> FromRequestParts<S> for InTemplates
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.in_section(Section::Templates) {
            Ok(InTemplates(user))
        } else {
            Err(ApiError::Forbidden(
                "You do not have access to this section".into(),
            ))
        }
    }
}

/// A user who may enter the `learning` section (read resources, take tests, do
/// labs). Authoring is a further step — see [`LearningAuthor`].
pub struct InLearning(pub User);

impl<S> FromRequestParts<S> for InLearning
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.in_section(Section::Learning) {
            Ok(InLearning(user))
        } else {
            Err(ApiError::Forbidden(
                "You do not have access to this section".into(),
            ))
        }
    }
}

/// A learning user who may *create* resources, tests and labs — the teacher.
///
/// This is the learning section's finer grant, the counterpart to a category
/// grant in templates. It is not a results role: who may *see* an attempt is
/// decided separately (the solver sees their own, an admin sees all), so a
/// teacher authors content without gaining any view of other users' scores.
pub struct LearningAuthor(pub User);

impl<S> FromRequestParts<S> for LearningAuthor
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.can_author(Section::Learning) {
            Ok(LearningAuthor(user))
        } else {
            Err(ApiError::Forbidden(
                "You do not have permission to create learning content".into(),
            ))
        }
    }
}

/// A user who may enter the `projects` section: see the boards and do the work
/// on them — create, move, assign and close cards. Managing the board structure
/// itself is the further [`ProjectManager`] grant.
pub struct InProjects(pub User);

impl<S> FromRequestParts<S> for InProjects
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.in_section(Section::Projects) {
            Ok(InProjects(user))
        } else {
            Err(ApiError::Forbidden(
                "You do not have access to this section".into(),
            ))
        }
    }
}

/// A projects user who may *manage boards* — create them, and add, rename or
/// remove their columns. The project lead, mirroring [`LearningAuthor`]: the
/// finer authoring grant over the section's structure, above the member who only
/// works the cards.
pub struct ProjectManager(pub User);

impl<S> FromRequestParts<S> for ProjectManager
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.can_author(Section::Projects) {
            Ok(ProjectManager(user))
        } else {
            Err(ApiError::Forbidden(
                "You do not have permission to manage project boards".into(),
            ))
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
