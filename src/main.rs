//! Axum + Leptos server entrypoint (§10, Phase 1).
//!
//! Boots the database, seeds the admin, wires sessions, serves the Leptos app
//! and server functions, exposes the multipart image-upload endpoint, and
//! statically serves the `uploads/` directory.

#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() {
    use axum::extract::{DefaultBodyLimit, Extension};
    use axum::routing::post;
    use axum::Router;
    use leptos::logging::log;
    use leptos::prelude::*;
    use leptos_axum::{generate_route_list, LeptosRoutes};
    use portal::app::{shell, App};
    use portal::backend::{self, AppState, Config};
    use tower_http::services::ServeDir;
    use tower_sessions::cookie::SameSite;
    use tower_sessions::{MemoryStore, SessionManagerLayer};

    let config = Config::from_env();
    let pool = backend::init_pool(&config).await;
    backend::seed_admin(&pool, &config).await;
    tokio::fs::create_dir_all(&config.uploads_dir).await.ok();

    let state = AppState {
        pool,
        config: config.clone(),
    };

    // Leptos runtime configuration (site addr, pkg dir, …) from the environment.
    let conf = get_configuration(None).expect("leptos configuration");
    let leptos_options = conf.leptos_options;
    let addr = leptos_options.site_addr;
    let routes = generate_route_list(App);

    // Session cookies (SR-2). `secure` is off for local HTTP; enable it behind
    // TLS in production.
    let session_layer = SessionManagerLayer::new(MemoryStore::default())
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_secure(false);

    let max_body = config.max_upload_bytes + 4096;

    let app = Router::new()
        .route(
            "/api/upload",
            post(upload_handler).layer(DefaultBodyLimit::max(max_body)),
        )
        .leptos_routes_with_context(
            &leptos_options,
            routes,
            {
                let state = state.clone();
                move || provide_context(state.clone())
            },
            {
                let leptos_options = leptos_options.clone();
                move || shell(leptos_options.clone())
            },
        )
        .nest_service("/uploads", ServeDir::new(config.uploads_dir.clone()))
        .fallback(leptos_axum::file_and_error_handler(shell))
        .layer(Extension(state))
        .layer(session_layer)
        .with_state(leptos_options);

    log!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind listener");
    axum::serve(listener, app.into_make_service())
        .await
        .expect("server error");
}

/// Multipart image upload (§7 Files, SR-5): validate content type + size, store
/// under `uploads/`, record a row, and return the URL/markdown snippet.
#[cfg(feature = "ssr")]
async fn upload_handler(
    axum::extract::Extension(state): axum::extract::Extension<portal::backend::AppState>,
    session: tower_sessions::Session,
    mut multipart: axum::extract::Multipart,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use portal::backend::SESSION_UID;

    let max = state.config.max_upload_bytes;

    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let original = field.file_name().unwrap_or("upload").to_string();
        let content_type = field.content_type().unwrap_or_default().to_string();
        let Some(ext) = image_extension(&content_type) else {
            return (
                StatusCode::BAD_REQUEST,
                "Only PNG, JPEG, GIF or WebP images are allowed",
            )
                .into_response();
        };

        let data = match field.bytes().await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_REQUEST, "Could not read upload").into_response(),
        };
        if data.len() > max {
            return (StatusCode::PAYLOAD_TOO_LARGE, "File exceeds the size limit").into_response();
        }

        let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
        let path = std::path::Path::new(&state.config.uploads_dir).join(&filename);
        if tokio::fs::write(&path, &data).await.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store file").into_response();
        }

        let url = format!("/uploads/{filename}");
        let uploaded_by: Option<uuid::Uuid> = session.get(SESSION_UID).await.ok().flatten();
        let _ = sqlx::query(
            "INSERT INTO uploads (file_path, original_name, uploaded_by) VALUES ($1, $2, $3)",
        )
        .bind(&url)
        .bind(&original)
        .bind(uploaded_by)
        .execute(&state.pool)
        .await;

        let body = format!("Uploaded.\nURL: {url}\nMarkdown: ![{original}]({url})\n");
        return (StatusCode::OK, body).into_response();
    }

    (StatusCode::BAD_REQUEST, "No 'file' field in the request").into_response()
}

/// Map an allowed image MIME type to a file extension (SR-5 whitelist).
#[cfg(feature = "ssr")]
fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

#[cfg(not(feature = "ssr"))]
fn main() {
    // The binary is a no-op when built for the browser (hydrate) target.
}
