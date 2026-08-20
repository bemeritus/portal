//! `POST /api/upload` — multipart image upload (§7 Files, SR-5).

use axum::extract::{Multipart, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;

use crate::audit::{audit_now, Audit};
use crate::auth::CurrentUser;
use crate::db::AppState;
use crate::error::{internal, ApiError, ApiResult};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", post(upload))
}

#[derive(Serialize)]
pub struct UploadResponse {
    /// Where the image can be fetched from, e.g. `/uploads/<uuid>.png`.
    url: String,
    /// The snippet to paste into an answer, so the editor does not have to
    /// know how to spell Markdown image syntax.
    markdown: String,
}

/// Map an allowed image MIME type to a file extension (SR-5 whitelist).
///
/// The extension comes from the *validated* type, never from the name the
/// client sent — that is what keeps `evil.php` from being stored as `.php`.
fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

async fn upload(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> ApiResult<Json<UploadResponse>> {
    let max = state.config.max_upload_bytes;

    loop {
        // `while let Ok(Some(_))` would swallow every multipart failure into
        // the loop's exit condition, so a body over the size limit — or any
        // malformed request — came back as "No 'file' field in the request".
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                return Err(match e.status() {
                    axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
                        ApiError::PayloadTooLarge("File exceeds the size limit".into())
                    }
                    _ => ApiError::BadRequest(e.body_text()),
                })
            }
        };
        if field.name() != Some("file") {
            continue;
        }

        let original = field.file_name().unwrap_or("upload").to_string();
        let content_type = field.content_type().unwrap_or_default().to_string();
        let Some(ext) = image_extension(&content_type) else {
            return Err(ApiError::BadRequest(
                "Only PNG, JPEG, GIF or WebP images are allowed".into(),
            ));
        };

        let data = match field.bytes().await {
            Ok(b) => b,
            Err(e) => {
                return Err(match e.status() {
                    axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
                        ApiError::PayloadTooLarge("File exceeds the size limit".into())
                    }
                    _ => ApiError::BadRequest(e.body_text()),
                })
            }
        };
        if data.len() > max {
            return Err(ApiError::PayloadTooLarge(
                "File exceeds the size limit".into(),
            ));
        }

        let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
        let path = std::path::Path::new(&state.config.uploads_dir).join(&filename);
        tokio::fs::write(&path, &data)
            .await
            .map_err(|e| internal(&format!("writing the upload to {}", path.display()), e))?;

        let url = format!("/uploads/{filename}");

        // The file is already written and usable, so a failed row does not fail
        // the request — but it leaves an untracked file on disk and has to be
        // visible somewhere.
        if let Err(e) = sqlx::query(
            "INSERT INTO uploads (file_path, original_name, uploaded_by) VALUES ($1, $2, $3)",
        )
        .bind(&url)
        .bind(&original)
        .bind(user.id)
        .execute(&state.pool)
        .await
        {
            tracing::error!("stored {url} but could not record the upload row: {e}");
        }

        audit_now(
            &state.pool,
            Some(user.id),
            &user.username,
            Audit {
                action: "upload.create",
                target_type: "upload",
                target_id: None,
                target_name: &original,
                details: Some(format!("{url}; {} bytes", data.len())),
            },
        )
        .await;

        let markdown = format!("![{original}]({url})");
        return Ok(Json(UploadResponse { url, markdown }));
    }

    Err(ApiError::BadRequest(
        "No 'file' field in the request".into(),
    ))
}
