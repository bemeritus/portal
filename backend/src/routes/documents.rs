//! `/api/documents` — the Q&A documents (§5.4, §5.5, §7 Documents).
//!
//! Every handler here resolves its permission against **the document's
//! category** (§4.2.1). None of them has an ownership fallback: authorship is
//! not a permission, so the guard is the same for the author as for anyone
//! else.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audit::{audit_now, audit_tx, Audit};
use crate::auth::{require_in_category, InTemplates};
use crate::content::render_markdown;
use crate::db::AppState;
use crate::error::{db_reference, internal, ApiError, ApiResult};
use crate::models::{
    normalize_status, DocumentDraft, DocumentSummary, DocumentWithBlocks, FeedbackSummary,
    Permission, QaBlockInput, QaBlockView,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(get_one).put(update).delete(remove))
        .route("/{id}/draft", get(get_draft))
        .route("/{id}/feedback", axum::routing::post(set_feedback).delete(clear_feedback))
        .route("/{id}/bookmark", axum::routing::post(add_bookmark).delete(remove_bookmark))
}

#[derive(Deserialize)]
pub struct ListParams {
    /// Free-text query over title *and* every Q&A block body (FR-18). Full-text
    /// match with an ILIKE fallback for partial words typed mid-search.
    q: Option<String>,
    /// Exactly one category (FR-19).
    category: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct DocumentBody {
    title: String,
    category_id: Uuid,
    status: String,
    blocks: Vec<QaBlockInput>,
    /// Free-form labels, normalised server-side. Optional so an older client
    /// (or a hand-written request) that omits them just clears them.
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Serialize)]
pub struct CreatedDocument {
    id: Uuid,
}

#[derive(Deserialize)]
pub struct FeedbackBody {
    /// `true` for 👍, `false` for 👎. Clearing a vote is the DELETE route.
    helpful: bool,
}

#[derive(Deserialize)]
pub struct PreviewBody {
    markdown: String,
}

#[derive(Serialize)]
pub struct PreviewResult {
    html: String,
}

/// FR-17: the document list, narrowed in SQL to the caller's `READ`
/// categories. Doing it in the query rather than filtering afterwards is what
/// makes SR-9 true for listings and not just for single records.
async fn list(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<DocumentSummary>>> {
    let q = params
        .q
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let readable = user.granted_categories(Permission::Read);

    // Full-text search over the title and, via EXISTS, every Q&A block body,
    // with an ILIKE fallback so a partial word typed mid-search ("postg") still
    // matches before it is a whole token ("postgres"). `websearch_to_tsquery`
    // parses the human input (quotes, OR, -) and never errors on stray syntax.
    let docs = sqlx::query_as::<_, DocumentSummary>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                u.username AS author_username,
                d.created_at,
                COALESCE(
                    ARRAY(
                        SELECT t.name FROM document_tags dt
                        JOIN tags t ON t.id = dt.tag_id
                        WHERE dt.document_id = d.id
                        ORDER BY t.name
                    ),
                    '{}'
                ) AS tags
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         JOIN users u ON u.id = d.author_id
         WHERE ($1::text IS NULL OR (
                   d.search @@ websearch_to_tsquery('simple', $1)
                OR d.title ILIKE '%' || $1 || '%'
                OR EXISTS (
                     SELECT 1 FROM qa_blocks b
                     WHERE b.document_id = d.id
                       AND (b.search @@ websearch_to_tsquery('simple', $1)
                            OR b.question ILIKE '%' || $1 || '%'
                            OR b.answer ILIKE '%' || $1 || '%')
                   )
                OR EXISTS (
                     SELECT 1 FROM document_tags dt
                     JOIN tags t ON t.id = dt.tag_id
                     WHERE dt.document_id = d.id
                       AND t.name ILIKE '%' || $1 || '%'
                   )
              ))
           AND ($2::uuid IS NULL OR d.category_id = $2)
           AND ($3::bool OR d.category_id = ANY($4::uuid[]))
         ORDER BY d.created_at DESC",
    )
    .bind(q.clone())
    .bind(params.category)
    .bind(user.is_admin)
    .bind(&readable)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing documents", e))?;

    // A deliberate search that found nothing is a content gap worth recording.
    // The length guard keeps the as-you-type single letters ("p", "po") out of
    // the log; a best-effort insert never fails the listing itself.
    if docs.is_empty() {
        if let Some(term) = q.as_deref().filter(|t| t.chars().count() >= 3) {
            let _ = sqlx::query("INSERT INTO search_misses (query, user_id) VALUES ($1, $2)")
                .bind(term)
                .bind(user.id)
                .execute(&state.pool)
                .await;
        }
    }

    Ok(Json(docs))
}

/// FR-21: one document with its blocks, answers rendered to sanitized HTML.
async fn get_one(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DocumentWithBlocks>> {
    #[derive(sqlx::FromRow)]
    struct MetaRow {
        id: Uuid,
        title: String,
        status: String,
        category_id: Uuid,
        category_name: String,
        author_id: Uuid,
        author_username: String,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }

    let meta = sqlx::query_as::<_, MetaRow>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                d.author_id, u.username AS author_username,
                d.created_at, d.updated_at
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         JOIN users u ON u.id = d.author_id
         WHERE d.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a document", e))?
    .ok_or_else(|| ApiError::NotFound("Document not found".into()))?;

    // READ is decided solely by the document's category — authoring it does
    // not grant a way back in once the category is withheld.
    require_in_category(&user, Permission::Read, meta.category_id)?;

    let raw_blocks: Vec<(String, String)> = sqlx::query_as(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a document's Q&A blocks", e))?;

    let blocks = raw_blocks
        .into_iter()
        .map(|(question, answer)| QaBlockView {
            question,
            answer_html: render_markdown(&answer),
        })
        .collect();

    let tags = fetch_tags(&state.pool, id).await?;

    // Opening a document is what "a view" counts. Refreshes included: an
    // internal tool wants the honest "what gets read", not a deduplicated one.
    let view_count: i64 =
        sqlx::query_scalar("UPDATE documents SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count")
            .bind(id)
            .fetch_one(&state.pool)
            .await
            .map_err(|e| internal("counting a document view", e))?;

    let (helpful_count, not_helpful_count, my_vote) =
        feedback_summary(&state.pool, id, user.id).await?;

    let bookmarked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM bookmarks WHERE document_id = $1 AND user_id = $2)",
    )
    .bind(id)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("checking a bookmark", e))?;

    Ok(Json(DocumentWithBlocks {
        id: meta.id,
        title: meta.title,
        status: meta.status,
        category_id: meta.category_id,
        category_name: meta.category_name,
        author_id: meta.author_id,
        author_username: meta.author_username,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        blocks,
        tags,
        view_count,
        helpful_count,
        not_helpful_count,
        my_vote,
        bookmarked,
    }))
}

/// Bookmark this document for the caller, or remove the bookmark. Requires READ
/// in the document's category — the same right that let them open it.
async fn add_bookmark(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let category: Option<Uuid> = sqlx::query_scalar("SELECT category_id FROM documents WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| internal("loading a document to bookmark", e))?;
    let category = category.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;
    require_in_category(&user, Permission::Read, category)?;

    sqlx::query(
        "INSERT INTO bookmarks (user_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(user.id)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("adding a bookmark", e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_bookmark(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM bookmarks WHERE user_id = $1 AND document_id = $2")
        .bind(user.id)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("removing a bookmark", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The caller's bookmarked documents, newest bookmark first, still narrowed to
/// the categories they may READ (a bookmark does not outlive lost access).
pub async fn list_bookmarks(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
) -> ApiResult<Json<Vec<DocumentSummary>>> {
    let readable = user.granted_categories(Permission::Read);
    let docs = sqlx::query_as::<_, DocumentSummary>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                u.username AS author_username,
                d.created_at,
                COALESCE(
                    ARRAY(
                        SELECT t.name FROM document_tags dt
                        JOIN tags t ON t.id = dt.tag_id
                        WHERE dt.document_id = d.id
                        ORDER BY t.name
                    ),
                    '{}'
                ) AS tags
         FROM bookmarks b
         JOIN documents d ON d.id = b.document_id
         JOIN categories c ON c.id = d.category_id
         JOIN users u ON u.id = d.author_id
         WHERE b.user_id = $1
           AND ($2::bool OR d.category_id = ANY($3::uuid[]))
         ORDER BY b.created_at DESC",
    )
    .bind(user.id)
    .bind(user.is_admin)
    .bind(&readable)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing bookmarks", e))?;
    Ok(Json(docs))
}

/// Vote 👍/👎 on a document, or change an earlier vote. Requires READ in the
/// document's category — the same right that let the reader open it.
async fn set_feedback(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
    Json(body): Json<FeedbackBody>,
) -> ApiResult<Json<FeedbackSummary>> {
    let category: Option<Uuid> = sqlx::query_scalar("SELECT category_id FROM documents WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| internal("loading a document to vote on", e))?;
    let category = category.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;
    require_in_category(&user, Permission::Read, category)?;

    sqlx::query(
        "INSERT INTO document_feedback (document_id, user_id, helpful)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, user_id)
         DO UPDATE SET helpful = EXCLUDED.helpful, updated_at = now()",
    )
    .bind(id)
    .bind(user.id)
    .bind(body.helpful)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("recording document feedback", e))?;

    let (helpful_count, not_helpful_count, my_vote) =
        feedback_summary(&state.pool, id, user.id).await?;
    Ok(Json(FeedbackSummary {
        helpful_count,
        not_helpful_count,
        my_vote,
    }))
}

/// Clear this reader's vote (pressing the active thumb again). Idempotent: no
/// row to delete is not an error.
async fn clear_feedback(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<FeedbackSummary>> {
    sqlx::query("DELETE FROM document_feedback WHERE document_id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("clearing document feedback", e))?;

    let (helpful_count, not_helpful_count, my_vote) =
        feedback_summary(&state.pool, id, user.id).await?;
    Ok(Json(FeedbackSummary {
        helpful_count,
        not_helpful_count,
        my_vote,
    }))
}

/// The 👍/👎 tally for a document plus `viewer`'s own vote, in one round trip.
async fn feedback_summary(
    pool: &sqlx::PgPool,
    document_id: Uuid,
    viewer: Uuid,
) -> ApiResult<(i64, i64, Option<bool>)> {
    #[derive(sqlx::FromRow)]
    struct Row {
        helpful_count: i64,
        not_helpful_count: i64,
        my_vote: Option<bool>,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT
             COUNT(*) FILTER (WHERE helpful) AS helpful_count,
             COUNT(*) FILTER (WHERE NOT helpful) AS not_helpful_count,
             (SELECT helpful FROM document_feedback
              WHERE document_id = $1 AND user_id = $2) AS my_vote
         FROM document_feedback
         WHERE document_id = $1",
    )
    .bind(document_id)
    .bind(viewer)
    .fetch_one(pool)
    .await
    .map_err(|e| internal("tallying document feedback", e))?;
    Ok((row.helpful_count, row.not_helpful_count, row.my_vote))
}

/// The same document as raw markdown, for the editor. Requires `EDIT`, because
/// that is what the caller is about to do with it.
async fn get_draft(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DocumentDraft>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        title: String,
        status: String,
        category_id: Uuid,
        author_id: Uuid,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT id, title, status, category_id, author_id FROM documents WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a document draft", e))?
    .ok_or_else(|| ApiError::NotFound("Document not found".into()))?;

    require_in_category(&user, Permission::Edit, row.category_id)?;

    let blocks: Vec<QaBlockInput> = sqlx::query_as::<_, (String, String)>(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a draft's Q&A blocks", e))?
    .into_iter()
    .map(|(question, answer)| QaBlockInput { question, answer })
    .collect();

    let tags = fetch_tags(&state.pool, id).await?;

    Ok(Json(DocumentDraft {
        id: row.id,
        title: row.title,
        status: row.status,
        category_id: row.category_id,
        author_id: row.author_id,
        blocks,
        tags,
    }))
}

/// FR-11/FR-12: create a document with its ordered Q&A blocks. Requires
/// `WRITE` **in the chosen category**.
async fn create(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Json(body): Json<DocumentBody>,
) -> ApiResult<(StatusCode, Json<CreatedDocument>)> {
    require_in_category(&user, Permission::Write, body.category_id)?;

    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest("Title is required".into()));
    }
    let status = normalize_status(&body.status);
    let blocks = body.blocks;
    let tags = normalize_tags(&body.tags);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to create a document", e))?;

    // The category comes from a picker, but nothing stops a crafted request
    // naming one that was deleted since — that is a foreign-key violation, not
    // a server fault.
    let doc_id: Uuid = sqlx::query_scalar(
        "INSERT INTO documents (title, category_id, author_id, status)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&title)
    .bind(body.category_id)
    .bind(user.id)
    .bind(&status)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        db_reference(
            "creating a document",
            e,
            "That category no longer exists. Reload the page and pick another.",
        )
    })?;

    insert_blocks(&mut tx, doc_id, &blocks, "a new document").await?;
    sync_tags(&mut tx, doc_id, &tags).await?;

    let category_name: String = sqlx::query_scalar("SELECT name FROM categories WHERE id = $1")
        .bind(body.category_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| internal("naming the category a document was created in", e))?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "document.create",
            target_type: "document",
            target_id: Some(doc_id),
            target_name: &title,
            details: Some(format!(
                "in {category_name}; {status}; {} Q&A block(s)",
                blocks.len()
            )),
        },
    )
    .await?;

    // Dropping `tx` unread would roll back silently, so a failed commit has to
    // be reported: the client must not be told about a document it cannot open.
    tx.commit()
        .await
        .map_err(|e| internal("committing a new document", e))?;

    Ok((StatusCode::CREATED, Json(CreatedDocument { id: doc_id })))
}

/// FR-15: replace a document's fields and Q&A blocks. Requires `EDIT` in the
/// document's current category; moving it additionally requires `WRITE` or
/// `EDIT` in the destination (SR-8).
async fn update(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
    Json(body): Json<DocumentBody>,
) -> ApiResult<StatusCode> {
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest("Title is required".into()));
    }
    let status = normalize_status(&body.status);
    let blocks = body.blocks;
    let tags = normalize_tags(&body.tags);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to update a document", e))?;

    // Title and status come along for the audit entry: "what changed" is only
    // answerable while the old values are still readable.
    let current: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT category_id, title, status FROM documents WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| internal("loading the document being edited", e))?;
    let (current_category, old_title, old_status) =
        current.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;

    require_in_category(&user, Permission::Edit, current_category)?;

    // Moving a document is a write into the destination as much as an edit of
    // the source (SR-8). Either right there is enough — WRITE to put content
    // in, EDIT to maintain what is already there.
    if body.category_id != current_category
        && !user.has_in(body.category_id, Permission::Write)
        && !user.has_in(body.category_id, Permission::Edit)
    {
        return Err(ApiError::Forbidden(
            "You cannot move a document into that category".into(),
        ));
    }

    let updated = sqlx::query(
        "UPDATE documents SET title = $2, category_id = $3, status = $4, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(body.category_id)
    .bind(&status)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        db_reference(
            "updating a document",
            e,
            "That category no longer exists. Reload the page and pick another.",
        )
    })?;

    // Someone else may have deleted it between the check above and this write.
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Document not found".into()));
    }

    // Simplest correct strategy: replace all blocks (FR-14 ordering preserved).
    sqlx::query("DELETE FROM qa_blocks WHERE document_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing the old Q&A blocks", e))?;
    insert_blocks(&mut tx, id, &blocks, "an edited document").await?;
    sync_tags(&mut tx, id, &tags).await?;

    let mut changes = Vec::new();
    if old_title != title {
        changes.push(format!("title: \"{old_title}\" → \"{title}\""));
    }
    if old_status != status {
        changes.push(format!("status: {old_status} → {status}"));
    }
    if body.category_id != current_category {
        // Two names for one line, fetched together rather than one query each.
        let names: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, name FROM categories WHERE id = ANY($1::uuid[])")
                .bind(vec![current_category, body.category_id])
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| internal("naming the categories a document moved between", e))?;
        let name_of = |wanted: Uuid| {
            names
                .iter()
                .find(|(id, _)| *id == wanted)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| "(deleted category)".to_string())
        };
        changes.push(format!(
            "moved: {} → {}",
            name_of(current_category),
            name_of(body.category_id)
        ));
    }
    // Blocks are replaced wholesale on every save, so their count is the only
    // honest thing to say about them without diffing the text itself.
    changes.push(format!("{} Q&A block(s)", blocks.len()));

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "document.update",
            target_type: "document",
            target_id: Some(id),
            target_name: &title,
            details: Some(changes.join("; ")),
        },
    )
    .await?;

    // A failed commit means none of the above landed — reporting success here
    // would send the author back to the unchanged document as if it had saved.
    tx.commit()
        .await
        .map_err(|e| internal("committing an edited document", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a document (blocks cascade). Requires `DELETE` in its category.
async fn remove(
    State(state): State<AppState>,
    InTemplates(user): InTemplates,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // The title is read before the delete because afterwards there is nowhere
    // left to read it from, and "document deleted: <uuid>" is not a log entry
    // anyone can use.
    let existing: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT d.category_id, d.title, c.name
         FROM documents d JOIN categories c ON c.id = d.category_id
         WHERE d.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading the document being deleted", e))?;
    let (category_id, title, category_name) =
        existing.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;

    require_in_category(&user, Permission::Delete, category_id)?;

    sqlx::query("DELETE FROM documents WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("deleting a document", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "document.delete",
            target_type: "document",
            target_id: Some(id),
            target_name: &title,
            details: Some(format!("in {category_name}")),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Render a snippet of the author's markdown to the same sanitized HTML the
/// document view will show — the editor's live preview. Runs through the one
/// `render_markdown` path so the preview can never diverge from the real render
/// (or skip the sanitizer). Any signed-in templates user may call it.
pub async fn preview_markdown(
    InTemplates(_user): InTemplates,
    Json(body): Json<PreviewBody>,
) -> Json<PreviewResult> {
    Json(PreviewResult {
        html: render_markdown(&body.markdown),
    })
}

/// The whole tag vocabulary, alphabetical — feeds the editor's suggestions.
/// Any signed-in templates user may read it; the names are not sensitive and
/// the per-category guard on documents is what actually protects content.
pub async fn list_tags(
    State(state): State<AppState>,
    InTemplates(_user): InTemplates,
) -> ApiResult<Json<Vec<String>>> {
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM tags ORDER BY name")
        .fetch_all(&state.pool)
        .await
        .map_err(|e| internal("listing tags", e))?;
    Ok(Json(names))
}

/// Trim, lower-case and de-duplicate the tags off a request, dropping empties.
/// Lower-casing is what makes "Network" and "network" the one tag (the unique
/// index is on `lower(name)`); a cap keeps a crafted request from writing
/// thousands of rows against one document.
fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in raw {
        let name = tag.trim().to_lowercase();
        if name.is_empty() || name.len() > 40 {
            continue;
        }
        if !out.contains(&name) {
            out.push(name);
        }
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// Point a document at exactly `tags`: create any missing tag rows, then
/// rewrite the join table to match. Called by both create and update, so the
/// set is always replaced wholesale rather than diffed.
async fn sync_tags(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    document_id: Uuid,
    tags: &[String],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM document_tags WHERE document_id = $1")
        .bind(document_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("clearing a document's tags", e))?;

    for name in tags {
        // Upsert the tag, then read its id whether it was just inserted or
        // already existed (ON CONFLICT ... DO NOTHING returns no row).
        let tag_id: Uuid = sqlx::query_scalar(
            "WITH ins AS (
                 INSERT INTO tags (name) VALUES ($1)
                 ON CONFLICT (lower(name)) DO NOTHING
                 RETURNING id
             )
             SELECT id FROM ins
             UNION ALL
             SELECT id FROM tags WHERE lower(name) = lower($1)
             LIMIT 1",
        )
        .bind(name)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| internal("creating or finding a tag", e))?;

        sqlx::query(
            "INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(document_id)
        .bind(tag_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("tagging a document", e))?;
    }
    Ok(())
}

/// One document's tags, alphabetical — for the single-document and draft views.
async fn fetch_tags(pool: &sqlx::PgPool, document_id: Uuid) -> ApiResult<Vec<String>> {
    sqlx::query_scalar(
        "SELECT t.name FROM document_tags dt
         JOIN tags t ON t.id = dt.tag_id
         WHERE dt.document_id = $1
         ORDER BY t.name",
    )
    .bind(document_id)
    .fetch_all(pool)
    .await
    .map_err(|e| internal("loading a document's tags", e))
}

/// Write the blocks of one document in array order, which is what FR-14's
/// `position` means.
async fn insert_blocks(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    document_id: Uuid,
    blocks: &[QaBlockInput],
    context: &str,
) -> ApiResult<()> {
    for (i, block) in blocks.iter().enumerate() {
        sqlx::query(
            "INSERT INTO qa_blocks (document_id, question, answer, position)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(document_id)
        .bind(block.question.trim())
        .bind(&block.answer)
        .bind(i as i32)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal(&format!("inserting a Q&A block for {context}"), e))?;
    }
    Ok(())
}
