//! Document server functions (§5.4, §5.5, §7 Documents).
//!
//! Q&A blocks are passed between client and server as a JSON string so that a
//! single simple parameter can carry the whole ordered list.
//!
//! Ownership rule (decided open question §12.1): a user may always edit or
//! delete a document they authored; the `EDIT` / `DELETE` permissions extend
//! that to *other* people's documents.

use leptos::prelude::*;

use crate::models::{DocumentDraft, DocumentSummary, DocumentWithBlocks};

#[cfg(feature = "ssr")]
use crate::models::QaBlockInput;

#[cfg(feature = "ssr")]
fn parse_blocks(blocks_json: &str) -> Result<Vec<QaBlockInput>, ServerFnError> {
    let blocks: Vec<QaBlockInput> = serde_json::from_str(blocks_json)
        .map_err(|e| ServerFnError::new(format!("Invalid blocks: {e}")))?;
    let blocks: Vec<QaBlockInput> = blocks
        .into_iter()
        .filter(|b| !b.question.trim().is_empty() || !b.answer.trim().is_empty())
        .collect();
    if blocks.is_empty() {
        return Err(ServerFnError::new(
            "A document needs at least one Q&A block",
        ));
    }
    Ok(blocks)
}

/// FR-11/FR-12: create a document with its ordered Q&A blocks. Requires `WRITE`.
#[server]
pub async fn create_document(
    title: String,
    category_id: uuid::Uuid,
    status: String,
    blocks_json: String,
) -> Result<uuid::Uuid, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;

    let user = backend::require(Permission::Write).await?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(ServerFnError::new("Title is required"));
    }
    let status = normalize_status(&status);
    let blocks = parse_blocks(&blocks_json)?;

    let pool = backend::pool();
    let mut tx = pool.begin().await?;

    let doc_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO documents (title, category_id, author_id, status)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&title)
    .bind(category_id)
    .bind(user.id)
    .bind(&status)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ServerFnError::new(format!("create document: {e}")))?;

    for (i, block) in blocks.iter().enumerate() {
        sqlx::query(
            "INSERT INTO qa_blocks (document_id, question, answer, position)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(doc_id)
        .bind(block.question.trim())
        .bind(&block.answer)
        .bind(i as i32)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(doc_id)
}

/// FR-15: replace a document's fields and Q&A blocks. Requires `EDIT` or
/// ownership.
#[server]
pub async fn update_document(
    id: uuid::Uuid,
    title: String,
    category_id: uuid::Uuid,
    status: String,
    blocks_json: String,
) -> Result<(), ServerFnError> {
    use crate::backend;
    use crate::models::Permission;

    let user = backend::require_user().await?;
    let author_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT author_id FROM documents WHERE id = $1")
            .bind(id)
            .fetch_optional(&backend::pool())
            .await?;
    let author_id = author_id.ok_or_else(|| ServerFnError::new("Document not found"))?;
    if author_id != user.id && !user.has(Permission::Edit) {
        return Err(ServerFnError::new("403: you cannot edit this document"));
    }

    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(ServerFnError::new("Title is required"));
    }
    let status = normalize_status(&status);
    let blocks = parse_blocks(&blocks_json)?;

    let pool = backend::pool();
    let mut tx = pool.begin().await?;

    sqlx::query(
        "UPDATE documents SET title = $2, category_id = $3, status = $4, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(category_id)
    .bind(&status)
    .execute(&mut *tx)
    .await?;

    // Simplest correct strategy: replace all blocks (FR-14 ordering preserved).
    sqlx::query("DELETE FROM qa_blocks WHERE document_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (i, block) in blocks.iter().enumerate() {
        sqlx::query(
            "INSERT INTO qa_blocks (document_id, question, answer, position)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(block.question.trim())
        .bind(&block.answer)
        .bind(i as i32)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// FR-21: fetch a document and all its Q&A blocks, answers rendered to
/// sanitized HTML. Requires `READ`.
#[server]
pub async fn get_document(id: uuid::Uuid) -> Result<DocumentWithBlocks, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    backend::require(Permission::Read).await?;

    #[derive(sqlx::FromRow)]
    struct MetaRow {
        id: uuid::Uuid,
        title: String,
        status: String,
        category_id: uuid::Uuid,
        category_name: String,
        author_id: uuid::Uuid,
        author_username: String,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }

    let pool = backend::pool();
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
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| ServerFnError::new("Document not found"))?;

    let raw_blocks: Vec<(String, String)> = sqlx::query_as(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&pool)
    .await?;

    let blocks = raw_blocks
        .into_iter()
        .map(|(question, answer)| crate::models::QaBlockView {
            question,
            answer_html: backend::render_markdown(&answer),
        })
        .collect();

    Ok(DocumentWithBlocks {
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
    })
}

/// Fetch a document in raw (markdown) form to populate the editor. Requires
/// `EDIT` or ownership.
#[server]
pub async fn get_document_draft(id: uuid::Uuid) -> Result<DocumentDraft, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    let user = backend::require_user().await?;

    #[derive(sqlx::FromRow)]
    struct Row {
        id: uuid::Uuid,
        title: String,
        status: String,
        category_id: uuid::Uuid,
        author_id: uuid::Uuid,
    }

    let pool = backend::pool();
    let row = sqlx::query_as::<_, Row>(
        "SELECT id, title, status, category_id, author_id FROM documents WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| ServerFnError::new("Document not found"))?;

    if row.author_id != user.id && !user.has(Permission::Edit) {
        return Err(ServerFnError::new("403: you cannot edit this document"));
    }

    let blocks: Vec<QaBlockInput> = sqlx::query_as::<_, (String, String)>(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&pool)
    .await?
    .into_iter()
    .map(|(question, answer)| QaBlockInput { question, answer })
    .collect();

    Ok(DocumentDraft {
        id: row.id,
        title: row.title,
        status: row.status,
        category_id: row.category_id,
        author_id: row.author_id,
        blocks,
    })
}

/// FR-17..FR-20: list documents, optionally filtered by title (ILIKE) and/or
/// category. Requires `READ`.
#[server]
pub async fn list_documents(
    title_filter: Option<String>,
    category_filter: Option<uuid::Uuid>,
) -> Result<Vec<DocumentSummary>, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    backend::require(Permission::Read).await?;

    // Normalize an empty title filter to NULL so the predicate is skipped.
    let title_filter = title_filter.and_then(|t| {
        let t = t.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

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
         ORDER BY d.created_at DESC",
    )
    .bind(title_filter)
    .bind(category_filter)
    .fetch_all(&backend::pool())
    .await?;

    Ok(docs)
}

/// Delete a document (blocks cascade). Requires `DELETE` or ownership.
#[server]
pub async fn delete_document(id: uuid::Uuid) -> Result<(), ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    let user = backend::require_user().await?;

    let author_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT author_id FROM documents WHERE id = $1")
            .bind(id)
            .fetch_optional(&backend::pool())
            .await?;
    let author_id = author_id.ok_or_else(|| ServerFnError::new("Document not found"))?;
    if author_id != user.id && !user.has(Permission::Delete) {
        return Err(ServerFnError::new("403: you cannot delete this document"));
    }

    sqlx::query("DELETE FROM documents WHERE id = $1")
        .bind(id)
        .execute(&backend::pool())
        .await?;
    Ok(())
}

#[cfg(feature = "ssr")]
fn normalize_status(status: &str) -> String {
    match status {
        "published" => "published".to_string(),
        _ => "draft".to_string(),
    }
}
