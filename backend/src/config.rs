//! Runtime configuration, read from the environment once at startup.

/// Where the built frontend lives, relative to the working directory.
const DEFAULT_STATIC_DIR: &str = "static";

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub admin_username: String,
    pub admin_password: String,
    pub uploads_dir: String,
    pub max_upload_bytes: usize,
    pub bind_addr: String,
    /// The `frontend/dist` output to serve. Absent in development, where Vite
    /// serves the app itself and proxies `/api` here.
    pub static_dir: String,
    /// Origins allowed to send credentialed requests. Only needed in
    /// development, where the frontend is on another port; in production the
    /// SPA is served from this same origin and this stays empty.
    pub cors_origins: Vec<String>,
    /// `Secure` on the session cookie. Off for local HTTP, on behind TLS.
    pub secure_cookie: bool,
}

impl Config {
    pub fn from_env() -> Self {
        // Best-effort: load a local .env if present.
        let _ = dotenvy::dotenv();

        let cors_origins = std::env::var("CORS_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

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
            bind_addr: std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into()),
            static_dir: std::env::var("STATIC_DIR")
                .unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string()),
            cors_origins,
            // Defaults to off, like the Leptos version did, so `just dev` over
            // plain HTTP works out of the box. DEPLOY.md sets it for TLS —
            // which is now an environment variable rather than an edit to the
            // source before every production build.
            secure_cookie: std::env::var("SECURE_COOKIE")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        }
    }
}
