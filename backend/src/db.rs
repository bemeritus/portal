//! The connection pool, migrations, and the seed admin.

use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::auth::hash_password;
use crate::config::Config;

/// Everything a handler needs, handed out by Axum's `State`.
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
    tracing::info!("seeded admin user '{}'", config.admin_username);
}
