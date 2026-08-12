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
        // Ordering matters: layers added later wrap earlier ones, so the
        // session layer runs first and `Session` is available to the guard.
        .layer(axum::middleware::from_fn(require_login))
        .layer(session_layer)
        .with_state(leptos_options);

    log!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            panic!("could not bind {addr}: {e}\nIs another process already using that port?")
        });
    axum::serve(listener, app.into_make_service())
        .await
        .unwrap_or_else(|e| panic!("the server stopped with an error: {e}"));
}

/// Paths an anonymous visitor may still reach: the login page itself, the
/// client bundle that renders it, and the Leptos server functions — those
/// authorize themselves and must stay callable, otherwise logging in would be
/// impossible. `/api/upload` is a plain Axum handler with no such check of its
/// own, so it is deliberately *not* exempt.
#[cfg(feature = "ssr")]
fn is_public_path(path: &str) -> bool {
    path == "/login"
        || path.starts_with("/pkg/")
        || (path.starts_with("/api/") && path != "/api/upload")
}

/// Send anonymous visitors to `/login` before anything is rendered.
///
/// Guarding here rather than inside the app means an unauthenticated visitor
/// never receives another page's markup at all. A client-side check would have
/// to let the server stream the page first and correct it after hydration,
/// which both leaks the content and shows a visible flash of the wrong page.
#[cfg(feature = "ssr")]
async fn require_login(
    session: tower_sessions::Session,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::{IntoResponse, Redirect};
    use portal::backend::SESSION_UID;

    if is_public_path(request.uri().path()) {
        return next.run(request).await;
    }

    // A session store that cannot answer is treated as "not logged in" — the
    // safe direction — but it is a fault, not a visitor without a cookie, so it
    // is not allowed to pass unrecorded.
    let uid: Option<uuid::Uuid> = match session.get(SESSION_UID).await {
        Ok(uid) => uid,
        Err(e) => {
            leptos::logging::error!("could not read the session while guarding a request: {e}");
            None
        }
    };
    match uid {
        Some(_) => next.run(request).await,
        None => Redirect::to("/login").into_response(),
    }
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

    loop {
        // `while let Ok(Some(_))` swallowed every multipart failure into the
        // loop's exit condition, so a body over the size limit — or any
        // malformed request — came back as "No 'file' field in the request".
        // Axum already knows the right status and wording for each of them.
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => return (e.status(), e.body_text()).into_response(),
        };
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
            // 413 when the body limit is what stopped it, 400 for a truncated
            // or malformed field — "Could not read upload" said neither.
            Err(e) => return (e.status(), e.body_text()).into_response(),
        };
        if data.len() > max {
            return (StatusCode::PAYLOAD_TOO_LARGE, "File exceeds the size limit").into_response();
        }

        let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
        let path = std::path::Path::new(&state.config.uploads_dir).join(&filename);
        if let Err(e) = tokio::fs::write(&path, &data).await {
            leptos::logging::error!("could not write the upload to {}: {e}", path.display());
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store file").into_response();
        }

        let url = format!("/uploads/{filename}");
        let uploaded_by: Option<uuid::Uuid> = match session.get(SESSION_UID).await {
            Ok(uid) => uid,
            Err(e) => {
                leptos::logging::error!("could not read the session for an upload: {e}");
                None
            }
        };
        // The file is already written and usable, so a failed audit row does
        // not fail the request — but it leaves an untracked file on disk and
        // has to be visible somewhere.
        if let Err(e) = sqlx::query(
            "INSERT INTO uploads (file_path, original_name, uploaded_by) VALUES ($1, $2, $3)",
        )
        .bind(&url)
        .bind(&original)
        .bind(uploaded_by)
        .execute(&state.pool)
        .await
        {
            leptos::logging::error!("stored {url} but could not record the upload row: {e}");
        }

        // Same entry the server functions write, so an upload shows up in the
        // one timeline with everything else. The handler only has the session's
        // user id, so the name is resolved here rather than at read time (the
        // log stores names as they were — see migration 0003).
        let uploader_name: String = match uploaded_by {
            Some(uid) => sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
                .bind(uid)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or_default()
                .unwrap_or_else(|| "unknown".to_string()),
            None => "unknown".to_string(),
        };
        portal::backend::audit_now(
            &state.pool,
            uploaded_by,
            &uploader_name,
            portal::backend::Audit {
                action: "upload.create",
                target_type: "upload",
                target_id: None,
                target_name: &original,
                details: Some(format!("{url}; {} bytes", data.len())),
            },
        )
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
