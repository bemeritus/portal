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

use crate::audit::{Audit, audit_now, audit_tx};
use crate::auth::CurrentUser;
use crate::content::render_markdown;
use crate::db::AppState;
use crate::diff::{count_changes, diff_blocks};
use crate::error::{ApiError, ApiResult, db_reference, internal};
use crate::models::{
    DocumentDraft, DocumentSummary, DocumentWithBlocks, FieldChange, QaBlockInput, QaBlockView,
    RevisionBlock, RevisionChanges, RevisionDetail, RevisionSummary, normalize_status,
};
use crate::telegram::DocEvent;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(get_one).put(update).delete(remove))
        .route("/{id}/draft", get(get_draft))
        .route("/{id}/view", axum::routing::post(record_view))
        .route("/{id}/revisions", get(list_revisions))
        .route("/{id}/revisions/{revision}", get(get_revision))
        .route(
            "/{id}/revisions/{revision}/restore",
            axum::routing::post(restore_revision),
        )
        .route(
            "/{id}/bookmark",
            axum::routing::post(add_bookmark).delete(remove_bookmark),
        )
}

#[derive(Deserialize)]
pub struct ListParams {
    /// Free-text query over title *and* every Q&A block body (FR-18). Full-text
    /// match with an ILIKE fallback for partial words typed mid-search.
    q: Option<String>,
    /// Exactly one category (FR-19).
    category: Option<Uuid>,
    /// Narrow to one status: the documents list shows `published`, the drafts
    /// list shows `draft`. Anything else is ignored (all statuses).
    status: Option<String>,
}

#[derive(Deserialize)]
pub struct DocumentBody {
    title: String,
    category_id: Uuid,
    status: String,
    blocks: Vec<QaBlockInput>,
}

#[derive(Serialize)]
pub struct CreatedDocument {
    id: Uuid,
}

#[derive(Deserialize)]
pub struct PreviewBody {
    markdown: String,
}

#[derive(Serialize)]
pub struct PreviewResult {
    html: String,
}

#[derive(Serialize)]
pub struct ViewCount {
    view_count: i64,
}

/// What a restore produces: the number of the new revision that now holds the
/// restored content. The history never rewinds — it grows.
#[derive(Serialize)]
pub struct RestoreResult {
    revision: i32,
}

/// FR-17: the document list, narrowed in SQL to the caller's `READ`
/// categories. Doing it in the query rather than filtering afterwards is what
/// makes SR-9 true for listings and not just for single records.
async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<DocumentSummary>>> {
    let q = params
        .q
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    // Only the two real statuses narrow the list; anything else means "all".
    let status = params.status.filter(|s| s == "published" || s == "draft");

    // Full-text search over the title and, via EXISTS, every Q&A block body,
    // with an ILIKE fallback so a partial word typed mid-search ("postg") still
    // matches before it is a whole token ("postgres"). `websearch_to_tsquery`
    // parses the human input (quotes, OR, -) and never errors on stray syntax.
    let docs = sqlx::query_as::<_, DocumentSummary>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                u.username AS author_username,
                d.created_at
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
              ))
           AND ($2::uuid IS NULL OR d.category_id = $2)
           AND ($3::text IS NULL OR d.status = $3)
         ORDER BY d.created_at DESC",
    )
    .bind(q.clone())
    .bind(params.category)
    .bind(status)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing documents", e))?;

    // A deliberate search that found nothing is a content gap worth recording.
    // The length guard keeps the as-you-type single letters ("p", "po") out of
    // the log; a best-effort insert never fails the listing itself.
    if docs.is_empty()
        && let Some(term) = q.as_deref().filter(|t| t.chars().count() >= 3)
    {
        let _ = sqlx::query("INSERT INTO search_misses (query, user_id) VALUES ($1, $2)")
            .bind(term)
            .bind(user.id)
            .execute(&state.pool)
            .await;
    }

    Ok(Json(docs))
}

/// FR-21: one document with its blocks, answers rendered to sanitized HTML.
async fn get_one(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
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
        view_count: i64,
    }

    let meta = sqlx::query_as::<_, MetaRow>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                d.author_id, u.username AS author_username,
                d.created_at, d.updated_at, d.view_count
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
        view_count: meta.view_count,
        bookmarked,
    }))
}

/// Count one view. Deliberately **not** done by `get_one`: that handler also
/// serves a page refresh and a back-button return, neither of which is someone
/// choosing to read the document. The client calls this only when the reader
/// arrived by clicking through to the document, so the number answers "how
/// often was this opened" rather than "how often was it fetched".
async fn record_view(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ViewCount>> {
    let view_count: Option<i64> = sqlx::query_scalar(
        "UPDATE documents SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("counting a document view", e))?;

    let view_count = view_count.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;
    Ok(Json(ViewCount { view_count }))
}

/// Bookmark this document for the caller, or remove the bookmark.
async fn add_bookmark(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM documents WHERE id = $1)")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| internal("loading a document to bookmark", e))?;
    if !exists {
        return Err(ApiError::NotFound("Document not found".into()));
    }

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
    CurrentUser(user): CurrentUser,
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

/// The caller's bookmarked documents, newest bookmark first.
pub async fn list_bookmarks(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> ApiResult<Json<Vec<DocumentSummary>>> {
    let docs = sqlx::query_as::<_, DocumentSummary>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                u.username AS author_username,
                d.created_at
         FROM bookmarks b
         JOIN documents d ON d.id = b.document_id
         JOIN categories c ON c.id = d.category_id
         JOIN users u ON u.id = d.author_id
         WHERE b.user_id = $1
         ORDER BY b.created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing bookmarks", e))?;
    Ok(Json(docs))
}

/// The same document as raw markdown, for the editor.
async fn get_draft(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
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

    Ok(Json(DocumentDraft {
        id: row.id,
        title: row.title,
        status: row.status,
        category_id: row.category_id,
        author_id: row.author_id,
        blocks,
    }))
}

/// FR-11/FR-12: create a document with its ordered Q&A blocks.
async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<DocumentBody>,
) -> ApiResult<(StatusCode, Json<CreatedDocument>)> {
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest("Title is required".into()));
    }
    let status = normalize_status(&body.status);
    let blocks = body.blocks;

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

    // Revision 1 is the document as created: the history has a floor, and the
    // first edit has something to be a diff against.
    write_revision(
        &mut tx,
        doc_id,
        "created",
        None,
        &title,
        body.category_id,
        &status,
        &blocks,
        user.id,
    )
    .await?;

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

    // After the commit, never before: subscribers must not hear about a save
    // that then rolled back. Fire-and-forget — a down Telegram cannot fail this.
    if let Some(tg) = &state.telegram {
        tg.notify_document(DocEvent::Created, doc_id, &title, &status, &user.username);
    }

    Ok((StatusCode::CREATED, Json(CreatedDocument { id: doc_id })))
}

/// FR-15: replace a document's fields and Q&A blocks.
async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<DocumentBody>,
) -> ApiResult<StatusCode> {
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest("Title is required".into()));
    }
    let status = normalize_status(&body.status);
    let blocks = body.blocks;

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

    // The state before this save, read before the blocks are replaced: it is
    // what decides whether this edit is worth a revision of its own.
    let previous = latest_revision(&mut tx, id).await?;

    // Simplest correct strategy: replace all blocks (FR-14 ordering preserved).
    sqlx::query("DELETE FROM qa_blocks WHERE document_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing the old Q&A blocks", e))?;
    insert_blocks(&mut tx, id, &blocks, "an edited document").await?;

    // A save that changed nothing (opened the editor, pressed Save) must not
    // add a revision: the history would fill with entries that diff to nothing
    // and bury the edits that matter.
    let snapshot: Vec<RevisionBlock> = blocks
        .iter()
        .map(|b| RevisionBlock {
            question: b.question.trim().to_string(),
            answer: b.answer.clone(),
        })
        .collect();
    let unchanged = previous.as_ref().is_some_and(|prev| {
        prev.title == title
            && prev.status == status
            && prev.category_id == Some(body.category_id)
            && prev.blocks() == snapshot
    });
    if !unchanged {
        write_revision(
            &mut tx,
            id,
            "edited",
            None,
            &title,
            body.category_id,
            &status,
            &blocks,
            user.id,
        )
        .await?;
    }

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

    // Same rule as in `create`: only a committed edit is worth announcing.
    if let Some(tg) = &state.telegram {
        tg.notify_document(DocEvent::Updated, id, &title, &status, &user.username);
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Delete a document (blocks cascade).
async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
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
    let (_category_id, title, category_name) =
        existing.ok_or_else(|| ApiError::NotFound("Document not found".into()))?;

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
    CurrentUser(_user): CurrentUser,
    Json(body): Json<PreviewBody>,
) -> Json<PreviewResult> {
    Json(PreviewResult {
        html: render_markdown(&body.markdown),
    })
}

// --- History ---------------------------------------------------------------
//
// The rule the three handlers below and the two write paths above share: a
// document's highest-numbered revision *is* the document. Nothing rewrites or
// deletes a revision, so "restore" means "write the old content again as a new
// revision" — the same shape as reverting a commit, and for the same reason:
// the record of what happened is itself worth keeping.

/// A revision as it comes out of the database, before it is summarised or
/// diffed. One row is one complete state of the document.
#[derive(sqlx::FromRow)]
struct RevisionRow {
    revision: i32,
    kind: String,
    restored_from: Option<i32>,
    title: String,
    status: String,
    category_id: Option<Uuid>,
    category_name: Option<String>,
    edited_by: Option<String>,
    edited_at: chrono::DateTime<chrono::Utc>,
    blocks: serde_json::Value,
}

/// The columns every revision read needs, joined to the names a reader sees.
const REVISION_SELECT: &str = "SELECT r.revision, r.kind, r.restored_from, r.title, r.status,
                r.category_id, c.name AS category_name,
                u.username AS edited_by, r.edited_at, r.blocks
         FROM document_revisions r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN users u ON u.id = r.edited_by";

impl RevisionRow {
    /// The stored blocks, or an empty list if the JSON is somehow not the shape
    /// this table writes. A revision that cannot be parsed must still be
    /// listable — losing the whole history to one bad row would be worse.
    fn blocks(&self) -> Vec<RevisionBlock> {
        serde_json::from_value(self.blocks.clone()).unwrap_or_default()
    }
}

/// Record the state a document is now in as its next revision.
///
/// Call this inside the same transaction as the write it describes: a revision
/// that commits without its document (or the other way round) breaks the
/// invariant that the newest revision is the live content.
#[allow(clippy::too_many_arguments)]
async fn write_revision(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    document_id: Uuid,
    kind: &str,
    restored_from: Option<i32>,
    title: &str,
    category_id: Uuid,
    status: &str,
    blocks: &[QaBlockInput],
    editor: Uuid,
) -> ApiResult<i32> {
    // Mirror `insert_blocks`: the question is stored trimmed, so the snapshot
    // has to be trimmed too or every later diff opens with phantom whitespace.
    let snapshot: Vec<RevisionBlock> = blocks
        .iter()
        .map(|b| RevisionBlock {
            question: b.question.trim().to_string(),
            answer: b.answer.clone(),
        })
        .collect();
    let snapshot = serde_json::to_value(&snapshot)
        .map_err(|e| internal("encoding a document revision", std::io::Error::other(e)))?;

    // MAX + 1 under the row lock the caller's UPDATE already holds; the table's
    // UNIQUE (document_id, revision) is the backstop if two writers ever race.
    sqlx::query_scalar(
        "INSERT INTO document_revisions
             (document_id, revision, kind, restored_from, title, category_id, status, blocks, edited_by)
         SELECT $1, COALESCE(MAX(revision), 0) + 1, $2, $3, $4, $5, $6, $7, $8
         FROM document_revisions WHERE document_id = $1
         RETURNING revision",
    )
    .bind(document_id)
    .bind(kind)
    .bind(restored_from)
    .bind(title)
    .bind(category_id)
    .bind(status)
    .bind(snapshot)
    .bind(editor)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| internal("recording a document revision", e))
}

/// The newest revision of a document — by the invariant, its current content.
async fn latest_revision(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    document_id: Uuid,
) -> ApiResult<Option<RevisionRow>> {
    sqlx::query_as::<_, RevisionRow>(&format!(
        "{REVISION_SELECT} WHERE r.document_id = $1 ORDER BY r.revision DESC LIMIT 1"
    ))
    .bind(document_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| internal("loading the latest document revision", e))
}

/// Field-level changes between two revisions: the parts of a document that are
/// not Q&A text. Category names are compared, not ids — the reader is told
/// "moved from X to Y", and a deleted category has no name left to show.
fn field_changes(old: &RevisionRow, new: &RevisionRow) -> Vec<FieldChange> {
    let mut out = Vec::new();
    if old.title != new.title {
        out.push(FieldChange {
            field: "title".into(),
            old: old.title.clone(),
            new: new.title.clone(),
        });
    }
    if old.status != new.status {
        out.push(FieldChange {
            field: "status".into(),
            old: old.status.clone(),
            new: new.status.clone(),
        });
    }
    if old.category_id != new.category_id {
        out.push(FieldChange {
            field: "category".into(),
            old: old.category_name.clone().unwrap_or_default(),
            new: new.category_name.clone().unwrap_or_default(),
        });
    }
    out
}

/// FR-21-adjacent: one document's history, newest first.
///
/// Each entry carries a summary of itself against the entry below it, so the
/// list answers "what happened here" without a request per revision.
async fn list_revisions(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<RevisionSummary>>> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM documents WHERE id = $1)")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| internal("checking a document before listing its history", e))?;
    if !exists {
        return Err(ApiError::NotFound("Document not found".into()));
    }

    let rows = sqlx::query_as::<_, RevisionRow>(&format!(
        "{REVISION_SELECT} WHERE r.document_id = $1 ORDER BY r.revision DESC"
    ))
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing a document's history", e))?;

    // Newest first, so the revision each entry is compared against is the next
    // element — and the last entry, the oldest, has nothing behind it.
    let summaries = rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let changes = match rows.get(i + 1) {
                Some(prev) => {
                    let (added, removed, edited) =
                        count_changes(&diff_blocks(&prev.blocks(), &row.blocks()));
                    RevisionChanges {
                        fields: field_changes(prev, row)
                            .into_iter()
                            .map(|c| c.field)
                            .collect(),
                        blocks_added: added,
                        blocks_removed: removed,
                        blocks_edited: edited,
                    }
                }
                None => RevisionChanges::default(),
            };
            RevisionSummary {
                revision: row.revision,
                kind: row.kind.clone(),
                restored_from: row.restored_from,
                title: row.title.clone(),
                status: row.status.clone(),
                category_name: row.category_name.clone(),
                edited_by: row.edited_by.clone(),
                edited_at: row.edited_at,
                block_count: row.blocks().len() as i64,
                is_current: i == 0,
                changes,
            }
        })
        .collect();

    Ok(Json(summaries))
}

/// One revision: what it changed against the one before it, and the content it
/// holds, rendered the same way the document view renders it.
async fn get_revision(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Path((id, revision)): Path<(Uuid, i32)>,
) -> ApiResult<Json<RevisionDetail>> {
    let row = sqlx::query_as::<_, RevisionRow>(&format!(
        "{REVISION_SELECT} WHERE r.document_id = $1 AND r.revision = $2"
    ))
    .bind(id)
    .bind(revision)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a document revision", e))?
    .ok_or_else(|| ApiError::NotFound("Revision not found".into()))?;

    // `revision - 1` would do while nothing deletes revisions, but asking for
    // "the highest one below this" keeps the handler correct if anything ever
    // does (a retention policy, say).
    let previous = sqlx::query_as::<_, RevisionRow>(&format!(
        "{REVISION_SELECT} WHERE r.document_id = $1 AND r.revision < $2
         ORDER BY r.revision DESC LIMIT 1"
    ))
    .bind(id)
    .bind(revision)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading the revision before a document revision", e))?;

    let is_current: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(
             SELECT 1 FROM document_revisions WHERE document_id = $1 AND revision > $2
         )",
    )
    .bind(id)
    .bind(revision)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("checking whether a revision is the current one", e))?;

    let blocks = row.blocks();
    // The first revision has nothing behind it, so it diffs against nothing and
    // every block reads as an addition — which is honest: that is when the
    // content appeared.
    let before: Vec<RevisionBlock> = previous.as_ref().map(|p| p.blocks()).unwrap_or_default();
    let diffed = diff_blocks(&before, &blocks);

    Ok(Json(RevisionDetail {
        revision: row.revision,
        kind: row.kind.clone(),
        restored_from: row.restored_from,
        title: row.title.clone(),
        status: row.status.clone(),
        category_name: row.category_name.clone(),
        edited_by: row.edited_by.clone(),
        edited_at: row.edited_at,
        is_current,
        compared_to: previous.as_ref().map(|p| p.revision),
        fields: previous
            .as_ref()
            .map(|p| field_changes(p, &row))
            .unwrap_or_default(),
        blocks: diffed,
        rendered: blocks
            .iter()
            .map(|b| QaBlockView {
                question: b.question.clone(),
                answer_html: render_markdown(&b.answer),
            })
            .collect(),
    }))
}

/// Put an older revision back, as a *new* revision.
///
/// Nothing is rewound: the restored content is written again at the head of the
/// history, carrying `restored_from` so the record says where it came from. A
/// mistaken restore is therefore itself undoable.
async fn restore_revision(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, revision)): Path<(Uuid, i32)>,
) -> ApiResult<Json<RestoreResult>> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to restore a revision", e))?;

    // Lock the document row first, so a concurrent save cannot land between
    // reading the target revision and writing the restored one.
    let locked: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM documents WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| internal("locking a document to restore it", e))?;
    if locked.is_none() {
        return Err(ApiError::NotFound("Document not found".into()));
    }

    let target = sqlx::query_as::<_, RevisionRow>(&format!(
        "{REVISION_SELECT} WHERE r.document_id = $1 AND r.revision = $2"
    ))
    .bind(id)
    .bind(revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal("loading the revision being restored", e))?
    .ok_or_else(|| ApiError::NotFound("Revision not found".into()))?;

    // The category was deleted after this revision was written, so there is no
    // home to put the document back into. Say that rather than guessing one.
    let category_id = target.category_id.ok_or_else(|| {
        ApiError::BadRequest(
            "The category this version belonged to has been deleted. Edit the document and pick a category instead.".into(),
        )
    })?;

    let current = latest_revision(&mut tx, id).await?;
    let blocks: Vec<QaBlockInput> = target
        .blocks()
        .into_iter()
        .map(|b| QaBlockInput {
            question: b.question,
            answer: b.answer,
        })
        .collect();

    // Restoring what is already there would add a revision that changed
    // nothing. Report the head instead — the document is in the asked-for
    // state, which is what the caller wanted.
    if let Some(current) = &current
        && current.title == target.title
        && current.status == target.status
        && current.category_id == target.category_id
        && current.blocks() == target.blocks()
    {
        return Ok(Json(RestoreResult {
            revision: current.revision,
        }));
    }

    sqlx::query(
        "UPDATE documents SET title = $2, category_id = $3, status = $4, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&target.title)
    .bind(category_id)
    .bind(&target.status)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        db_reference(
            "restoring a document revision",
            e,
            "That category no longer exists. Reload the page and pick another.",
        )
    })?;

    sqlx::query("DELETE FROM qa_blocks WHERE document_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing the Q&A blocks of a restored document", e))?;
    insert_blocks(&mut tx, id, &blocks, "a restored document").await?;

    let new_revision = write_revision(
        &mut tx,
        id,
        "restored",
        Some(revision),
        &target.title,
        category_id,
        &target.status,
        &blocks,
        user.id,
    )
    .await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "document.restore",
            target_type: "document",
            target_id: Some(id),
            target_name: &target.title,
            details: Some(format!("restored #{revision} as #{new_revision}")),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a restored document revision", e))?;

    // A restore changes the published document, so it is announced like any
    // other edit — subscribers care about the content, not the mechanism.
    if let Some(tg) = &state.telegram {
        tg.notify_document(
            DocEvent::Updated,
            id,
            &target.title,
            &target.status,
            &user.username,
        );
    }

    Ok(Json(RestoreResult {
        revision: new_revision,
    }))
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
