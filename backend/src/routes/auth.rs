//! `/api/auth` — sign in, sign out, and "who am I" (§5.1, §7 Auth).

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tower_sessions::Session;

use crate::auth::{verify_password, CurrentUser, SESSION_UID};
use crate::db::AppState;
use crate::error::{internal, ApiError, ApiResult};
use crate::models::User;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

/// FR-1: log in with username + password. On success the session cookie is
/// issued and the user is returned, so the client does not need a second
/// round-trip to `/me` before it can render.
async fn login(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<LoginRequest>,
) -> ApiResult<Json<User>> {
    let username = body.username.trim().to_string();
    if username.is_empty() || body.password.is_empty() {
        return Err(ApiError::BadRequest(
            "Please enter a username and password".into(),
        ));
    }

    // FR-2: the same generic error for "no such user" and "wrong password", so
    // the form cannot be used to find out which usernames exist.
    let invalid = || ApiError::Unauthorized("Invalid username or password".into());

    let row: Option<(uuid::Uuid, String, bool)> =
        sqlx::query_as("SELECT id, password_hash, is_active FROM users WHERE username = $1")
            .bind(&username)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("looking up the user logging in", e))?;

    let (id, hash, is_active) = row.ok_or_else(invalid)?;
    if !verify_password(&body.password, &hash) {
        return Err(invalid());
    }
    if !is_active {
        // FR-4. Said plainly rather than folded into `invalid()`: the password
        // was right, and telling someone with valid credentials to keep
        // guessing helps nobody.
        return Err(ApiError::Forbidden("This account is disabled".into()));
    }

    // A fresh id for the authenticated session, so a cookie captured before
    // login cannot be used after it (session fixation).
    session
        .cycle_id()
        .await
        .map_err(|e| internal("cycling the session id on login", e))?;
    session
        .insert(SESSION_UID, id)
        .await
        .map_err(|e| internal("storing the session for a new login", e))?;

    let user = crate::auth::load_user(&state.pool, id)
        .await?
        .ok_or_else(invalid)?;
    Ok(Json(user))
}

/// FR-3: log out — clears the session.
async fn logout(session: Session) -> ApiResult<StatusCode> {
    session
        .flush()
        .await
        .map_err(|e| internal("clearing the session on logout", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The signed-in user. 401 when there is no session — which is how the SPA
/// decides, on first load, whether to show the app or the login page.
async fn me(CurrentUser(user): CurrentUser) -> Json<User> {
    Json(user)
}
