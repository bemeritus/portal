//! Server-only support code: configuration, database pool, the seed admin,
//! password hashing, permission guards, markdown rendering and helpers.
//!
//! Everything here is compiled only under the `ssr` feature and is reached
//! exclusively from the bodies of `#[server]` functions (which the Leptos
//! macro also compiles server-side only) and from `main.rs`.

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use leptos::prelude::*;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower_sessions::Session;
use uuid::Uuid;

use crate::models::{CategoryPermission, Permission, User};

/// Session key under which the authenticated user id is stored.
pub const SESSION_UID: &str = "uid";

// --- Failures the user should not see ---------------------------------------

/// What the client is told when the cause is ours rather than theirs.
const INTERNAL_MESSAGE: &str = "Something went wrong. Please try again.";

/// Log a failure with its context and return an error that is safe to send on.
///
/// A `ServerFnError` produced by `?` from a `sqlx::Error` carries the
/// database's own words — constraint names, column names, the host it failed to
/// reach — and every page in this app renders the error text straight into a
/// flash message. Anything the user cannot act on belongs in the server log,
/// and they get one sentence (see `crate::error::user_message`).
pub fn internal(context: &str, error: impl std::fmt::Display) -> ServerFnError {
    leptos::logging::error!("{context}: {error}");
    ServerFnError::new(INTERNAL_MESSAGE)
}

/// [`internal`], except that a unique-constraint violation *is* something the
/// user can fix, so it gets `conflict_message` instead.
pub fn db_conflict(context: &str, error: sqlx::Error, conflict_message: &str) -> ServerFnError {
    match &error {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            ServerFnError::new(conflict_message.to_string())
        }
        _ => internal(context, error),
    }
}

/// [`internal`], except that a foreign-key violation — a row pointing at
/// something absent, or still being pointed at — gets `reference_message`.
///
/// Matching the constraint kind rather than mapping every error is the point:
/// a dropped connection is not "that category still has documents".
pub fn db_reference(context: &str, error: sqlx::Error, reference_message: &str) -> ServerFnError {
    match &error {
        sqlx::Error::Database(db) if db.is_foreign_key_violation() => {
            ServerFnError::new(reference_message.to_string())
        }
        _ => internal(context, error),
    }
}

/// Runtime configuration, read from the environment on startup.
#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub admin_username: String,
    pub admin_password: String,
    pub uploads_dir: String,
    pub max_upload_bytes: usize,
}

impl Config {
    pub fn from_env() -> Self {
        // Best-effort: load a local .env if present.
        let _ = dotenvy::dotenv();
        Config {
            database_url: std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set (see .env.example)"),
            admin_username: std::env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into()),
            admin_password: std::env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin".into()),
            uploads_dir: std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "uploads".into()),
            max_upload_bytes: std::env::var("MAX_UPLOAD_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5 * 1024 * 1024),
        }
    }
}

/// Application state shared with Axum handlers (the upload endpoint) and, via
/// Leptos context, with every server function.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
}

/// Build the Postgres connection pool and run pending migrations.
///
/// Both steps are preconditions for serving anything at all, so a failure here
/// stops the process — but with a message that names what to check, because
/// sqlx's own (`PoolTimedOut`, most often) does not.
pub async fn init_pool(config: &Config) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "could not connect to Postgres: {e}\n\
                 Check that the server is running and that DATABASE_URL points at it \
                 (host, port, database and user must all match)."
            )
        });

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "could not apply the migrations in ./migrations: {e}\n\
                 The database is reachable but its schema could not be brought up to date."
            )
        });

    pool
}

/// Create the seed admin the first time the platform boots (empty `users`
/// table). There is no signup, so without this nobody could ever log in (§4.3).
pub async fn seed_admin(pool: &PgPool, config: &Config) {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("could not count the existing users: {e}"));
    if count > 0 {
        return;
    }
    let hash = hash_password(&config.admin_password)
        .unwrap_or_else(|e| panic!("could not hash ADMIN_PASSWORD: {e}"));
    sqlx::query(
        "INSERT INTO users (username, password_hash, is_admin, can_read, can_write, can_edit, can_delete, is_active)
         VALUES ($1, $2, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)",
    )
    .bind(&config.admin_username)
    .bind(&hash)
    .execute(pool)
    .await
    .unwrap_or_else(|e| {
        panic!(
            "could not create the seed admin '{}': {e}\n\
             Without it nobody can log in, since the platform has no signup.",
            config.admin_username
        )
    });
    leptos::logging::log!("Seeded admin user '{}'.", config.admin_username);
}

// --- Password hashing (SR-1) ------------------------------------------------

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
        Err(_) => false,
    }
}

// --- Context accessors ------------------------------------------------------

/// The connection pool, provided into context by the route/server-fn handlers.
pub fn pool() -> PgPool {
    expect_context::<AppState>().pool
}

pub fn config() -> Config {
    expect_context::<AppState>().config
}

/// Extract the tower-sessions `Session` for the current request.
pub async fn session() -> Result<Session, ServerFnError> {
    leptos_axum::extract::<Session>()
        .await
        .map_err(|e| internal("extracting the session", e))
}

// --- Auth guards (SR-3) -----------------------------------------------------

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

/// The currently logged-in user, if any and still active. Fetches fresh from
/// the DB so permission changes take effect immediately.
pub async fn current_user_opt() -> Result<Option<User>, ServerFnError> {
    let session = session().await?;
    let uid: Option<Uuid> = session
        .get(SESSION_UID)
        .await
        .map_err(|e| internal("reading the session", e))?;
    let Some(uid) = uid else {
        return Ok(None);
    };
    let pool = pool();
    let user = sqlx::query_as::<_, User>(
        "SELECT id, username, is_admin, can_read, can_write, can_edit, can_delete, is_active, created_at
         FROM users WHERE id = $1",
    )
    .bind(uid)
    .fetch_optional(&pool)
    .await
    .map_err(|e| internal("loading the current user", e))?;

    Ok(match user {
        Some(mut u) if u.is_active => {
            u.category_perms = category_perms_for(&pool, u.id)
                .await
                .map_err(|e| internal("loading the current user's category grants", e))?;
            Some(u)
        }
        _ => None,
    })
}

/// Require an authenticated, active user or return a 401-style error.
pub async fn require_user() -> Result<User, ServerFnError> {
    current_user_opt()
        .await?
        .ok_or_else(|| ServerFnError::new("401: not authenticated"))
}

/// Require the given permission *on a specific category* — the only way to
/// authorize anything for a non-admin. There is deliberately no category-less
/// variant: a permission with no category attached is what used to let a
/// global flag reach into categories the user was never granted.
pub async fn require_in_category(
    perm: Permission,
    category_id: Uuid,
) -> Result<User, ServerFnError> {
    let user = require_user().await?;
    if user.has_in(category_id, perm) {
        Ok(user)
    } else {
        Err(ServerFnError::new(
            "403: permission denied for this category",
        ))
    }
}

/// Require admin rights (§4.2).
pub async fn require_admin() -> Result<User, ServerFnError> {
    let user = require_user().await?;
    if user.is_admin {
        Ok(user)
    } else {
        Err(ServerFnError::new("403: admin only"))
    }
}

// --- Content helpers --------------------------------------------------------

/// Render (untrusted) markdown to sanitized HTML (FR-13 + defense in depth).
pub fn render_markdown(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(markdown, options);
    let mut unsafe_html = String::new();
    html::push_html(&mut unsafe_html, parser);
    ammonia::clean(&unsafe_html)
}

/// A URL-safe slug for a category name.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        trimmed
    }
}
