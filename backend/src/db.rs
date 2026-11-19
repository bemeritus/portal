//! The connection pool, migrations, and the seed admin.

use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::auth::hash_password;
use crate::config::Config;
use crate::telegram::Telegram;

/// Everything a handler needs, handed out by Axum's `State`.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    /// `None` unless TELEGRAM_BOT_TOKEN is configured.
    pub telegram: Option<Telegram>,
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    /// Two files with one version number compile and pass a psql run of the
    /// directory, but sqlx refuses them at startup: a fresh database fails on
    /// the second insert into `_sqlx_migrations`, and one that has either
    /// file applied reports the other as "previously applied but modified".
    #[test]
    fn migration_versions_are_unique() {
        let mut seen: BTreeMap<i64, Vec<String>> = BTreeMap::new();
        for m in sqlx::migrate!("./migrations").iter() {
            seen.entry(m.version)
                .or_default()
                .push(m.description.to_string());
        }
        let dupes: Vec<_> = seen.into_iter().filter(|(_, d)| d.len() > 1).collect();
        assert!(
            dupes.is_empty(),
            "migration versions used more than once: {dupes:?}"
        );
    }
}
