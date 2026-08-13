//! Document server functions (§5.4, §5.5, §7 Documents).
//!
//! Q&A blocks are passed between client and server as a JSON string so that a
//! single simple parameter can carry the whole ordered list.
//!
//! Ownership rule (decided open question §12.1): a user may always edit or
//! delete a document they authored; the `EDIT` / `DELETE` permissions extend
//! that to *other* people's documents.
//!
//! Permissions are category-scoped: every check below asks whether the user
//! holds the permission *in the document's category*, which is true when the
//! global flag is set (all categories) or a grant covers that one category.

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

    let user = backend::require_in_category(Permission::Write, category_id).await?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(ServerFnError::new("Title is required"));
    }
    let status = normalize_status(&status);
    let blocks = parse_blocks(&blocks_json)?;

    let pool = backend::pool();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| backend::internal("opening a transaction to create a document", e))?;

    // The category comes from a picker, but nothing stops a crafted request
    // naming one that was deleted since — that is a foreign-key violation, not
    // a server fault.
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
    .map_err(|e| {
        backend::db_reference(
            "creating a document",
            e,
            "That category no longer exists. Reload the page and pick another.",
        )
    })?;

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
        .await
        .map_err(|e| backend::internal("inserting a Q&A block for a new document", e))?;
    }

    let category_name: String = sqlx::query_scalar("SELECT name FROM categories WHERE id = $1")
        .bind(category_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| backend::internal("naming the category a document was created in", e))?;
    backend::audit_tx(
        &mut tx,
        &user,
        backend::Audit {
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
    // be reported: the client must not be told a document it cannot open.
    tx.commit()
        .await
        .map_err(|e| backend::internal("committing a new document", e))?;
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
    // Title and status come along for the audit entry: "what changed" is only
    // answerable against what was there before the write.
    let existing: Option<(uuid::Uuid, String, String)> =
        sqlx::query_as("SELECT category_id, title, status FROM documents WHERE id = $1")
            .bind(id)
            .fetch_optional(&backend::pool())
            .await
            .map_err(|e| backend::internal("loading the document being edited", e))?;
    let (current_category, old_title, old_status) =
        existing.ok_or_else(|| ServerFnError::new("Document not found"))?;

    // Edit rights are judged against the category the document is in today.
    if !user.has_in(current_category, Permission::Edit) {
        return Err(ServerFnError::new("403: you cannot edit this document"));
    }
    // Moving it elsewhere additionally requires rights in the destination,
    // otherwise a user could push documents into categories they can't touch.
    if category_id != current_category
        && !user.has_in(category_id, Permission::Write)
        && !user.has_in(category_id, Permission::Edit)
    {
        return Err(ServerFnError::new(
            "403: you cannot move this document into that category",
        ));
    }

    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(ServerFnError::new("Title is required"));
    }
    let status = normalize_status(&status);
    let blocks = parse_blocks(&blocks_json)?;

    let pool = backend::pool();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| backend::internal("opening a transaction to update a document", e))?;

    let updated = sqlx::query(
        "UPDATE documents SET title = $2, category_id = $3, status = $4, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(category_id)
    .bind(&status)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        backend::db_reference(
            "updating a document",
            e,
            "That category no longer exists. Reload the page and pick another.",
        )
    })?;

    // Someone else may have deleted it between the check above and this write.
    if updated.rows_affected() == 0 {
        return Err(ServerFnError::new("Document not found"));
    }

    // Simplest correct strategy: replace all blocks (FR-14 ordering preserved).
    sqlx::query("DELETE FROM qa_blocks WHERE document_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| backend::internal("clearing the old Q&A blocks", e))?;
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
        .await
        .map_err(|e| backend::internal("inserting a Q&A block for an edited document", e))?;
    }

    let mut changes = Vec::new();
    if old_title != title {
        changes.push(format!("title: \"{old_title}\" → \"{title}\""));
    }
    if old_status != status {
        changes.push(format!("status: {old_status} → {status}"));
    }
    if category_id != current_category {
        // Two names for one line, fetched together rather than one query each.
        let names: Vec<(uuid::Uuid, String)> =
            sqlx::query_as("SELECT id, name FROM categories WHERE id = ANY($1::uuid[])")
                .bind(vec![current_category, category_id])
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| {
                    backend::internal("naming the categories a document moved between", e)
                })?;
        let name_of = |wanted: uuid::Uuid| {
            names
                .iter()
                .find(|(id, _)| *id == wanted)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| "(deleted category)".to_string())
        };
        changes.push(format!(
            "moved: {} → {}",
            name_of(current_category),
            name_of(category_id)
        ));
    }
    // Blocks are replaced wholesale on every save, so their count is the only
    // honest thing to say about them without diffing the text itself.
    changes.push(format!("{} Q&A block(s)", blocks.len()));

    backend::audit_tx(
        &mut tx,
        &user,
        backend::Audit {
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
        .map_err(|e| backend::internal("committing an edited document", e))?;
    Ok(())
}

/// FR-21: fetch a document and all its Q&A blocks, answers rendered to
/// sanitized HTML. Requires `READ`.
#[server]
pub async fn get_document(id: uuid::Uuid) -> Result<DocumentWithBlocks, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    let user = backend::require_user().await?;

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
    .await
    .map_err(|e| backend::internal("loading a document", e))?
    .ok_or_else(|| ServerFnError::new("Document not found"))?;

    // READ is decided solely by the document's category — authoring it does
    // not grant a way back in once the category is withheld.
    if !user.has_in(meta.category_id, Permission::Read) {
        return Err(ServerFnError::new("403: you cannot read this document"));
    }

    let raw_blocks: Vec<(String, String)> = sqlx::query_as(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(|e| backend::internal("loading a document's Q&A blocks", e))?;

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
    .await
    .map_err(|e| backend::internal("loading a document draft", e))?
    .ok_or_else(|| ServerFnError::new("Document not found"))?;

    if !user.has_in(row.category_id, Permission::Edit) {
        return Err(ServerFnError::new("403: you cannot edit this document"));
    }

    let blocks: Vec<QaBlockInput> = sqlx::query_as::<_, (String, String)>(
        "SELECT question, answer FROM qa_blocks WHERE document_id = $1 ORDER BY position, created_at",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(|e| backend::internal("loading a draft's Q&A blocks", e))?
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
    let user = backend::require_user().await?;

    // Normalize an empty title filter to NULL so the predicate is skipped.
    let title_filter = title_filter.and_then(|t| {
        let t = t.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    // Only admins see across categories. For everyone else the listing is the
    // categories they were granted READ on — nothing else gets in, not even
    // documents they wrote themselves.
    let reads_all = user.is_admin;
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
    .bind(title_filter)
    .bind(category_filter)
    .bind(reads_all)
    .bind(&readable)
    .fetch_all(&backend::pool())
    .await
    .map_err(|e| backend::internal("listing documents", e))?;

    Ok(docs)
}

/// Delete a document (blocks cascade). Requires `DELETE` or ownership.
#[server]
pub async fn delete_document(id: uuid::Uuid) -> Result<(), ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    let user = backend::require_user().await?;

    let pool = backend::pool();
    // The title is read before the delete because afterwards there is nowhere
    // left to read it from, and "document deleted: <uuid>" is not a log entry
    // anyone can use.
    let existing: Option<(uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT d.category_id, d.title, c.name
         FROM documents d JOIN categories c ON c.id = d.category_id
         WHERE d.id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| backend::internal("loading the document being deleted", e))?;
    let (category_id, title, category_name) =
        existing.ok_or_else(|| ServerFnError::new("Document not found"))?;
    if !user.has_in(category_id, Permission::Delete) {
        return Err(ServerFnError::new("403: you cannot delete this document"));
    }

    sqlx::query("DELETE FROM documents WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| backend::internal("deleting a document", e))?;

    backend::audit_now(
        &pool,
        Some(user.id),
        &user.username,
        backend::Audit {
            action: "document.delete",
            target_type: "document",
            target_id: Some(id),
            target_name: &title,
            details: Some(format!("in {category_name}")),
        },
    )
    .await;
    Ok(())
}

#[cfg(feature = "ssr")]
fn normalize_status(status: &str) -> String {
    match status {
        "published" => "published".to_string(),
        _ => "draft".to_string(),
    }
}
