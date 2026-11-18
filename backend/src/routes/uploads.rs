//! `POST /api/upload` — multipart image upload (§7 Files, SR-5).
//! `POST /api/media` — the same, but also accepts video, for the work log.

use axum::extract::{Multipart, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::audit::{Audit, audit_now};
use crate::auth::CurrentUser;
use crate::db::AppState;
use crate::error::{ApiError, ApiResult, internal};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", post(upload))
}

/// The work log's uploads, mounted apart from `/upload` because its body limit
/// is a thousand times larger — a video, not a screenshot.
pub fn media_routes() -> Router<AppState> {
    Router::new().route("/", post(upload_media))
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
                });
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
                });
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

#[derive(Serialize)]
pub struct MediaUploadResponse {
    /// `"image"` or `"video"` — decided from the validated MIME type.
    kind: &'static str,
    /// Where the file can be fetched, e.g. `/uploads/<uuid>.mp4`.
    url: String,
    /// The bare filename the work-log body sends back to attach this file.
    /// Not a path and not a URL, so there is nothing in it to point elsewhere.
    file_path: String,
    original_name: String,
}

/// Map an allowed media MIME type to `(kind, extension)`.
///
/// Like [`image_extension`], the extension comes from the validated type, never
/// from the client's filename. Videos are limited to the two formats a browser
/// `<video>` plays everywhere, so an uploaded clip is always watchable in place.
fn media_kind(content_type: &str) -> Option<(&'static str, &'static str)> {
    match content_type {
        "image/png" => Some(("image", "png")),
        "image/jpeg" | "image/jpg" => Some(("image", "jpg")),
        "image/gif" => Some(("image", "gif")),
        "image/webp" => Some(("image", "webp")),
        "video/mp4" => Some(("video", "mp4")),
        "video/webm" => Some(("video", "webm")),
        _ => None,
    }
}

/// Upload one photo or clip for a work-log entry.
///
/// Streamed to disk a chunk at a time rather than buffered whole: a video can
/// be up to `MAX_VIDEO_BYTES` (a gigabyte by default), and holding that in
/// memory per upload is how a handful of concurrent uploads take the process
/// down. The per-kind size limit is enforced as the bytes arrive, so an
/// oversized file is cut off and its partial write removed, not accepted and
/// then rejected.
async fn upload_media(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> ApiResult<Json<MediaUploadResponse>> {
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => return Err(multipart_error(e)),
        };
        if field.name() != Some("file") {
            continue;
        }

        let original = field.file_name().unwrap_or("upload").to_string();
        let content_type = field.content_type().unwrap_or_default().to_string();
        let Some((kind, ext)) = media_kind(&content_type) else {
            return Err(ApiError::BadRequest(
                "Only images (PNG, JPEG, GIF, WebP) or videos (MP4, WebM) are allowed".into(),
            ));
        };
        let max = if kind == "video" {
            state.config.max_video_bytes
        } else {
            state.config.max_upload_bytes
        } as u64;

        let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
        let path = std::path::Path::new(&state.config.uploads_dir).join(&filename);
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|e| internal(&format!("creating the upload file {}", path.display()), e))?;

        // Remove the half-written file on any failure, so a cut-off or failed
        // upload does not leave an unplayable stub on disk.
        let mut written: u64 = 0;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    written += chunk.len() as u64;
                    if written > max {
                        discard(file, &path).await;
                        return Err(ApiError::PayloadTooLarge(
                            "File exceeds the size limit".into(),
                        ));
                    }
                    if let Err(e) = file.write_all(&chunk).await {
                        discard(file, &path).await;
                        return Err(internal(
                            &format!("writing the upload to {}", path.display()),
                            e,
                        ));
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    discard(file, &path).await;
                    return Err(multipart_error(e));
                }
            }
        }
        if let Err(e) = file.flush().await {
            discard(file, &path).await;
            return Err(internal(
                &format!("flushing the upload to {}", path.display()),
                e,
            ));
        }

        let url = format!("/uploads/{filename}");

        // Same trade as `upload`: the file is on disk and usable, so a failed
        // tracking row is logged rather than failing the request.
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
                details: Some(format!("{url}; {kind}; {written} bytes")),
            },
        )
        .await;

        return Ok(Json(MediaUploadResponse {
            kind,
            url,
            file_path: filename,
            original_name: original,
        }));
    }

    Err(ApiError::BadRequest(
        "No 'file' field in the request".into(),
    ))
}

/// Turn a multipart read failure into the error the client should see: a body
/// over the limit is a 413, anything else is a bad request carrying its reason.
fn multipart_error(e: axum::extract::multipart::MultipartError) -> ApiError {
    match e.status() {
        axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
            ApiError::PayloadTooLarge("File exceeds the size limit".into())
        }
        _ => ApiError::BadRequest(e.body_text()),
    }
}

/// Drop a part-written upload and delete it, best-effort. A file left behind on
/// a failed upload is clutter, not a correctness problem, so a failed delete is
/// logged and no more.
async fn discard(file: tokio::fs::File, path: &std::path::Path) {
    drop(file);
    if let Err(e) = tokio::fs::remove_file(path).await {
        tracing::warn!(
            "could not remove the abandoned upload {}: {e}",
            path.display()
        );
    }
}
