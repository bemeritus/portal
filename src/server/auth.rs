//! Authentication server functions (§7 Auth, §5.1).

use leptos::prelude::*;

use crate::models::User;

/// Log in with username + password (FR-1). On success a session cookie is
/// issued and the client is redirected home.
#[server]
pub async fn login(username: String, password: String) -> Result<(), ServerFnError> {
    use crate::backend;

    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err(ServerFnError::new("Please enter a username and password"));
    }

    // FR-2: the same generic error for "no such user" and "wrong password".
    let invalid = || ServerFnError::new("Invalid username or password");

    let row: Option<(uuid::Uuid, String, bool)> =
        sqlx::query_as("SELECT id, password_hash, is_active FROM users WHERE username = $1")
            .bind(&username)
            .fetch_optional(&backend::pool())
            .await
            .map_err(|e| backend::internal("looking up the user logging in", e))?;

    let (id, hash, is_active) = row.ok_or_else(invalid)?;
    if !backend::verify_password(&password, &hash) {
        return Err(invalid());
    }
    if !is_active {
        // FR-4: blocked users cannot log in.
        return Err(ServerFnError::new("This account is disabled"));
    }

    let session = backend::session().await?;
    session
        .insert(backend::SESSION_UID, id)
        .await
        .map_err(|e| backend::internal("storing the session for a new login", e))?;

    leptos_axum::redirect("/");
    Ok(())
}

/// Log out — clears the session (FR-3).
#[server]
pub async fn logout() -> Result<(), ServerFnError> {
    use crate::backend;
    let session = backend::session().await?;
    session
        .flush()
        .await
        .map_err(|e| backend::internal("clearing the session on logout", e))?;
    leptos_axum::redirect("/login");
    Ok(())
}

/// The currently authenticated user, or `None` (§7).
#[server]
pub async fn current_user() -> Result<Option<User>, ServerFnError> {
    crate::backend::current_user_opt().await
}
