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
use crate::auth::{require_in_category, CurrentUser};
use crate::content::render_markdown;
use crate::db::AppState;
use crate::error::{db_reference, internal, ApiError, ApiResult};
use crate::models::{
    normalize_status, DocumentDraft, DocumentSummary, DocumentWithBlocks, Permission, QaBlockInput,
    QaBlockView,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(get_one).put(update).delete(remove))
        .route("/{id}/draft", get(get_draft))
}

#[derive(Deserialize)]
pub struct ListParams {
    /// Substring match on the title (FR-18).
    title: Option<String>,
    /// Exactly one category (FR-19).
    category: Option<Uuid>,
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

/// FR-17: the document list, narrowed in SQL to the caller's `READ`
/// categories. Doing it in the query rather than filtering afterwards is what
/// makes SR-9 true for listings and not just for single records.
async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<DocumentSummary>>> {
    let title = params
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let readable = user.granted_categories(Permission::Read);

    let docs = sqlx::query_as::<_, DocumentSummary>(
        "SELECT d.id, d.title, d.status, d.category_id,
                c.name AS category_name,
                u.username AS author_username,
                d.created_at
         FROM documents d
         JOIN categories c ON c.id = d.category_id
         JOIN users u ON u.id = d.author_id
         WHERE ($1::text IS NULL OR d.title ILIKE '%' || $1 || '%')
           AND ($2::uuid IS NULL OR d.category_id = $2)
           AND ($3::bool OR d.category_id = ANY($4::uuid[]))
         ORDER BY d.created_at DESC",
    )
    .bind(title)
    .bind(params.category)
    .bind(user.is_admin)
    .bind(&readable)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing documents", e))?;

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
    }))
}

/// The same document as raw markdown, for the editor. Requires `EDIT`, because
/// that is what the caller is about to do with it.
async fn get_draft(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
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

    Ok(Json(DocumentDraft {
        id: row.id,
        title: row.title,
        status: row.status,
        category_id: row.category_id,
        author_id: row.author_id,
        blocks,
    }))
}

/// FR-11/FR-12: create a document with its ordered Q&A blocks. Requires
/// `WRITE` **in the chosen category**.
async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<DocumentBody>,
) -> ApiResult<(StatusCode, Json<CreatedDocument>)> {
    require_in_category(&user, Permission::Write, body.category_id)?;

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
