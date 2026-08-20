//! The one error type every handler returns, and how it becomes a response.
//!
//! The Leptos version of this app carried the HTTP status inside the error
//! *string* (`"403: permission denied"`) because server functions had no other
//! channel for it, and the client parsed that prefix back out. A JSON API has
//! status codes, so the status is a variant here and the body is always
//! `{"error": "..."}` — one shape for the frontend to handle, whatever failed.
//!
//! The split that matters is between failures the caller can act on (a taken
//! username, a wrong password, a file too large) and failures that are ours.
//! The first kind carries its sentence to the client. The second logs the
//! real cause — constraint names, hosts, driver messages — and sends back one
//! generic line, because none of that is actionable and some of it is a hint
//! about the inside of the system.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// What the client is told when the cause is ours rather than theirs.
const INTERNAL_MESSAGE: &str = "Something went wrong. Please try again.";

#[derive(Debug)]
pub enum ApiError {
    /// 400 — the request itself is wrong (empty title, short password).
    BadRequest(String),
    /// 401 — no session, or one that no longer resolves to an active user.
    Unauthorized(String),
    /// 403 — authenticated, but without the permission this needs.
    Forbidden(String),
    /// 404 — no such row, or one the caller may not learn about.
    NotFound(String),
    /// 409 — a unique or foreign-key constraint the caller can resolve.
    Conflict(String),
    /// 413 — over `MAX_UPLOAD_BYTES`.
    PayloadTooLarge(String),
    /// 500 — already logged; the caller gets [`INTERNAL_MESSAGE`].
    Internal,
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ApiError::BadRequest(m)
            | ApiError::Unauthorized(m)
            | ApiError::Forbidden(m)
            | ApiError::NotFound(m)
            | ApiError::Conflict(m)
            | ApiError::PayloadTooLarge(m) => m,
            ApiError::Internal => INTERNAL_MESSAGE,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(ErrorBody {
                error: self.message(),
            }),
        )
            .into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// Log a failure with its context and return an error safe to send on.
///
/// `context` is a phrase, not a sentence: "listing documents", "hashing a new
/// user's password". It is what turns a bare `PoolTimedOut` in the log into a
/// line that says which query gave up.
pub fn internal(context: &str, error: impl std::fmt::Display) -> ApiError {
    tracing::error!("{context}: {error}");
    ApiError::Internal
}

/// [`internal`], except that a unique-constraint violation *is* something the
/// caller can fix, so it becomes a 409 carrying `conflict_message`.
pub fn db_conflict(context: &str, error: sqlx::Error, conflict_message: &str) -> ApiError {
    match &error {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            ApiError::Conflict(conflict_message.to_string())
        }
        _ => internal(context, error),
    }
}

/// [`internal`], except that a foreign-key violation — a row pointing at
/// something absent, or still being pointed at — becomes a 409.
///
/// Matching the constraint kind rather than mapping every error is the point:
/// a dropped connection is not "that category still has documents".
pub fn db_reference(context: &str, error: sqlx::Error, reference_message: &str) -> ApiError {
    match &error {
        sqlx::Error::Database(db) if db.is_foreign_key_violation() => {
            ApiError::Conflict(reference_message.to_string())
        }
        _ => internal(context, error),
    }
}
