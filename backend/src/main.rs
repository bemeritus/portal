//! Axum server entrypoint.
//!
//! Boots the database, seeds the admin, wires sessions, mounts the JSON API
//! under `/api`, serves uploaded images from `/uploads`, and — in production —
//! serves the built React app for everything else.
//!
//! The frontend is a separate program (`frontend/`). In development it runs on
//! Vite's own port and proxies `/api` here, which is why `CORS_ORIGINS` exists;
//! in production `STATIC_DIR` points at its build output and the two are one
//! origin again, so no CORS is involved at all.

mod audit;
mod auth;
mod config;
mod content;
mod db;
mod dc;
mod diff;
mod error;
mod models;
mod routes;
mod telegram;
mod tool_access;

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tower_sessions::SessionManagerLayer;
use tower_sessions::cookie::SameSite;
use tower_sessions::session_store::ExpiredDeletion;
use tower_sessions_sqlx_store::PostgresStore;

use crate::auth::SESSION_UID;
use crate::config::Config;
use crate::db::AppState;
use crate::error::ApiError;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let config = Config::from_env();
    let pool = db::init_pool(&config).await;

    // `portal seed-dc`: load the server room and the cooling catalog, then
    // exit. Data, not schema — so it runs when asked, never on startup.
    if std::env::args().nth(1).as_deref() == Some("seed-dc") {
        match dc::seed::run(&pool).await {
            Ok(r) => {
                println!(
                    "catalog: {} added, {} already present; room '{}': {}",
                    r.items_added,
                    r.items_kept,
                    dc::seed::ROOM_NAME,
                    if r.room_added {
                        "created"
                    } else {
                        "already present, left as it is"
                    }
                );
                return;
            }
            Err(e) => {
                eprintln!("seeding the server room failed, nothing was written: {e}");
                std::process::exit(1);
            }
        }
    }

    db::seed_admin(&pool, &config).await;

    // Every upload writes in here and `/uploads` is served straight off it, so
    // a directory that cannot be created is a startup failure, not something to
    // discover one 500 at a time.
    if let Err(e) = tokio::fs::create_dir_all(&config.uploads_dir).await {
        panic!(
            "could not create the uploads directory '{}': {e}\n\
             Set UPLOADS_DIR to a writable path.",
            config.uploads_dir
        );
    }

    // Off unless TELEGRAM_BOT_TOKEN is set. The poller lives for the process:
    // it only serves /start and /stop, so there is nothing to shut down early.
    let telegram = telegram::Telegram::from_config(pool.clone(), &config);
    if let Some(tg) = &telegram {
        tg.spawn_poller();
        tracing::info!("telegram notifications enabled");
    }

    // Sessions live in Postgres, not in this process: an in-memory store loses
    // every login on restart, which signs everyone out on each deploy and fills
    // the log with `record not found in store` from browsers still holding a
    // cookie for a session that died with the old process.
    let session_store = PostgresStore::new(pool.clone());
    // The store owns its own schema and table, so it migrates itself rather
    // than riding along in `migrations/`.
    if let Err(e) = session_store.migrate().await {
        panic!("could not prepare the session table: {e}");
    }

    // Expired rows are not cleaned up by anyone else; without this the table
    // only ever grows. Errors here are not fatal — a failed sweep means stale
    // rows, not broken sessions — so they are logged and the task ends.
    let session_store_for_cleanup = session_store.clone();
    tokio::spawn(async move {
        if let Err(e) = session_store_for_cleanup
            .continuously_delete_expired(tokio::time::Duration::from_secs(60 * 60))
            .await
        {
            tracing::error!("the expired-session sweep stopped: {e}");
        }
    });

    let state = AppState {
        pool,
        config: config.clone(),
        telegram,
    };

    // Session cookies (SR-2). `Secure` comes from the environment rather than
    // from an edit to this file before every production build — the previous
    // arrangement meant a forgotten edit shipped cookies that travel in clear.
    let session_layer = SessionManagerLayer::new(session_store)
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_secure(config.secure_cookie);

    // Uploaded images are behind the session: a `/uploads/…` URL is guessable
    // in principle, and these are internal documents. (Scoping them by category
    // as well is still open — §12.7.)
    let uploads = Router::new()
        .fallback_service(ServeDir::new(config.uploads_dir.clone()))
        .layer(axum::middleware::from_fn(require_session));

    let mut app = Router::new()
        .nest("/api", routes::api(&state))
        .nest("/uploads", uploads)
        .fallback_service(spa_service(&config));

    if let Some(cors) = cors_layer(&config) {
        app = app.layer(cors);
    }

    let app = app
        // Ordering matters: layers added later wrap earlier ones, so the
        // session layer runs first and `Session` is available to the guards.
        .layer(session_layer)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "could not bind {}: {e}\nIs another process already using that port?",
                config.bind_addr
            )
        });
    tracing::info!("listening on http://{}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|e| panic!("the server stopped with an error: {e}"));
}

/// Serve the built frontend, falling back to `index.html` so that a deep link
/// like `/docs/<id>` reaches the SPA's router instead of a 404.
///
/// The fallback is the whole reason this is not a plain `ServeDir`: the client
/// owns the route table, and the server cannot know which paths it claims.
fn spa_service(config: &Config) -> ServeDir<ServeFile> {
    let index = std::path::Path::new(&config.static_dir).join("index.html");
    if !index.exists() {
        tracing::warn!(
            "no frontend build at '{}' — the API will answer but there is no UI to serve. \
             In development that is expected: run the Vite dev server instead.",
            config.static_dir
        );
    }
    ServeDir::new(&config.static_dir).fallback(ServeFile::new(index))
}

/// Allow the Vite dev server to make credentialed requests.
///
/// Returns `None` when `CORS_ORIGINS` is unset, which is the production case:
/// the SPA is served from this origin, so no cross-origin request is involved
/// and the safest header set is no header set. Note the explicit origin list —
/// `Access-Control-Allow-Origin: *` cannot carry credentials, and the whole
/// point here is that the session cookie rides along.
fn cors_layer(config: &Config) -> Option<CorsLayer> {
    if config.cors_origins.is_empty() {
        return None;
    }
    let origins: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|o| match o.parse::<HeaderValue>() {
            Ok(v) => Some(v),
            Err(_) => {
                tracing::warn!("ignoring unparseable CORS origin '{o}'");
                None
            }
        })
        .collect();
    if origins.is_empty() {
        return None;
    }
    tracing::info!("CORS enabled for {:?}", config.cors_origins);
    Some(
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                header::CONTENT_TYPE,
                header::HeaderName::from_static("x-csrf-token"),
            ])
            .allow_credentials(true),
    )
}

/// Refuse anonymous requests for uploaded files.
///
/// This only checks that a session names *someone*; it deliberately does not
/// load the user, because that would be a database round-trip per image on a
/// page full of them. The account may have been disabled a moment ago and its
/// images stay readable until the cookie is dropped — accepted, since the same
/// files were readable to that person a moment ago anyway.
async fn require_session(
    session: tower_sessions::Session,
    request: Request,
    next: Next,
) -> Response {
    match session.get::<uuid::Uuid>(SESSION_UID).await {
        Ok(Some(_)) => next.run(request).await,
        Ok(None) => ApiError::Unauthorized("Not signed in".into()).into_response(),
        Err(e) => {
            tracing::error!("could not read the session while serving an upload: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR).into_response()
        }
    }
}

/// Stop accepting connections on Ctrl-C or SIGTERM, then let in-flight requests
/// finish. Without this a container stop kills mid-transaction requests.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install the Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install the SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
