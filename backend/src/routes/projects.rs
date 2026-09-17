//! `/api/projects` — the projects section: Kanban boards, columns and cards.
//!
//! Two grants run through the module, the same two-level shape learning uses:
//!
//!   * **Membership** ([`InProjects`]) is the work. A member sees every board
//!     and may create, edit, move, assign and delete *cards* — the units of
//!     work on a shared board.
//!   * **Management** ([`ProjectManager`]) is the structure. A lead may create
//!     boards and add, rename or remove their *columns*.
//!
//! Neither is per-row ownership: any manager may edit any board, any member any
//! card, exactly as a learning author may edit any test. `created_by` records
//! who made a thing; it never gates who may change it.
//!
//! Card descriptions are authored markdown and rendered to sanitized HTML on the
//! server for the board view (SR-13), like a document's answer; the raw source
//! comes back only from a card's edit endpoint.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::audit::{audit_now, audit_tx, Audit};
use crate::auth::{InProjects, ProjectManager};
use crate::content::{optional_text, render_markdown};
use crate::db::AppState;
use crate::error::{db_reference, internal, ApiError, ApiResult};
use crate::models::{
    normalize_color, normalize_priority, AttachmentBody, CalendarCard, CardAttachment,
    ChecklistItem, ChecklistItemBody, ChecklistUpdate, MyCard, ProjectBoardBody,
    ProjectBoardSummary, ProjectBoardView, ProjectCardBody, ProjectCardDraft, ProjectCardMove,
    ProjectCardView, ProjectColumnBody, ProjectColumnView, ProjectComment, ProjectCommentBody,
    ProjectLabel, ProjectLabelBody, ProjectMember,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/members", get(list_members))
        .route("/my-cards", get(my_cards))
        .route("/calendar", get(calendar))
        .route("/boards", get(list_boards).post(create_board))
        .route("/boards/{id}", get(get_board).put(update_board).delete(remove_board))
        .route("/boards/{id}/columns", post(create_column))
        .route("/boards/{id}/labels", get(list_labels).post(create_label))
        .route("/labels/{id}", put(update_label).delete(remove_label))
        .route("/columns/{id}", put(update_column).delete(remove_column))
        .route("/columns/{id}/cards", post(create_card))
        .route("/cards/{id}", get(get_card_draft).put(update_card).delete(remove_card))
        .route("/cards/{id}/move", put(move_card))
        .route("/cards/{id}/comments", get(list_comments).post(create_comment))
        .route("/comments/{id}", axum::routing::delete(remove_comment))
        .route("/cards/{id}/checklist", post(add_checklist_item))
        .route("/checklist/{id}", put(update_checklist_item).delete(remove_checklist_item))
        .route("/cards/{id}/attachments", post(add_attachment))
        .route("/attachments/{id}", axum::routing::delete(remove_attachment))
}

#[derive(Serialize)]
struct CreatedId {
    id: Uuid,
}

/// Trim a name and reject an empty one — the same rule the other sections use.
fn require_name(raw: &str, what: &str) -> ApiResult<String> {
    let name = raw.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest(format!("{what} is required")));
    }
    Ok(name)
}

// --- Members ----------------------------------------------------------------

/// The people a card can be assigned to: active users who hold the projects
/// section, plus admins. Readable by any member so the assignee picker works
/// without handing out the admin-only full user list.
async fn list_members(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
) -> ApiResult<Json<Vec<ProjectMember>>> {
    let members = sqlx::query_as::<_, ProjectMember>(
        "SELECT DISTINCT u.id, u.username
         FROM users u
         LEFT JOIN user_sections s ON s.user_id = u.id AND s.section = 'projects'
         WHERE u.is_active AND (u.is_admin OR s.user_id IS NOT NULL)
         ORDER BY u.username",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing project members", e))?;
    Ok(Json(members))
}

// --- Boards -----------------------------------------------------------------

/// Every board, newest first, with the count of cards on it. Boards are shared
/// across the section, so every member sees the same list.
async fn list_boards(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
) -> ApiResult<Json<Vec<ProjectBoardSummary>>> {
    let boards = sqlx::query_as::<_, ProjectBoardSummary>(
        "SELECT b.id, b.name, b.description,
                (SELECT count(*)
                   FROM project_cards c
                   JOIN project_columns col ON col.id = c.column_id
                  WHERE col.board_id = b.id) AS card_count,
                b.created_at
         FROM project_boards b
         ORDER BY b.created_at DESC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing project boards", e))?;
    Ok(Json(boards))
}

/// One board with its columns in order, each carrying its cards in order.
async fn get_board(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(board_id): Path<Uuid>,
) -> ApiResult<Json<ProjectBoardView>> {
    #[derive(sqlx::FromRow)]
    struct BoardRow {
        id: Uuid,
        name: String,
        description: Option<String>,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }
    let board = sqlx::query_as::<_, BoardRow>(
        "SELECT id, name, description, created_at, updated_at
         FROM project_boards WHERE id = $1",
    )
    .bind(board_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a project board", e))?
    .ok_or_else(|| ApiError::NotFound("Board not found".into()))?;

    let column_rows: Vec<(Uuid, String, i32, Option<i32>)> = sqlx::query_as(
        "SELECT id, name, position, wip_limit FROM project_columns
         WHERE board_id = $1 ORDER BY position, created_at",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a board's columns", e))?;

    // Every card on the board in one query, ordered so that grouping preserves
    // each column's top-to-bottom order.
    #[derive(sqlx::FromRow)]
    struct CardRow {
        id: Uuid,
        column_id: Uuid,
        title: String,
        description: Option<String>,
        assignee_id: Option<Uuid>,
        assignee_username: Option<String>,
        due_date: Option<chrono::NaiveDate>,
        priority: String,
        position: i32,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }
    let card_rows = sqlx::query_as::<_, CardRow>(
        "SELECT c.id, c.column_id, c.title, c.description,
                c.assignee_id, u.username AS assignee_username,
                c.due_date, c.priority, c.position, c.created_at, c.updated_at
         FROM project_cards c
         JOIN project_columns col ON col.id = c.column_id
         LEFT JOIN users u ON u.id = c.assignee_id
         WHERE col.board_id = $1
         ORDER BY c.position, c.created_at",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a board's cards", e))?;

    // Every label on every card of the board, in one query, keyed by card so the
    // grouping below is a lookup rather than a query per card.
    let label_rows: Vec<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT cl.card_id, l.id, l.name, l.color
         FROM project_card_labels cl
         JOIN project_labels l ON l.id = cl.label_id
         JOIN project_cards c ON c.id = cl.card_id
         JOIN project_columns col ON col.id = c.column_id
         WHERE col.board_id = $1
         ORDER BY l.name",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a board's card labels", e))?;

    let labels_of = |card_id: Uuid| -> Vec<ProjectLabel> {
        label_rows
            .iter()
            .filter(|(cid, ..)| *cid == card_id)
            .map(|(_, id, name, color)| ProjectLabel {
                id: *id,
                name: name.clone(),
                color: color.clone(),
            })
            .collect()
    };

    // Checklist progress per card (done / total) in one grouped query.
    let checklist_rows: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT ci.card_id,
                COUNT(*) FILTER (WHERE ci.done) AS done,
                COUNT(*) AS total
         FROM project_card_checklist_items ci
         JOIN project_cards c ON c.id = ci.card_id
         JOIN project_columns col ON col.id = c.column_id
         WHERE col.board_id = $1
         GROUP BY ci.card_id",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("counting a board's checklist items", e))?;

    // Attachment counts per card, same shape.
    let attachment_rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT a.card_id, COUNT(*)
         FROM project_card_attachments a
         JOIN project_cards c ON c.id = a.card_id
         JOIN project_columns col ON col.id = c.column_id
         WHERE col.board_id = $1
         GROUP BY a.card_id",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("counting a board's attachments", e))?;

    let columns = column_rows
        .into_iter()
        .map(|(id, name, position, wip_limit)| ProjectColumnView {
            id,
            name,
            position,
            wip_limit,
            cards: card_rows
                .iter()
                .filter(|c| c.column_id == id)
                .map(|c| {
                    let (checklist_done, checklist_total) = checklist_rows
                        .iter()
                        .find(|(cid, ..)| *cid == c.id)
                        .map(|(_, done, total)| (*done, *total))
                        .unwrap_or((0, 0));
                    let attachment_count = attachment_rows
                        .iter()
                        .find(|(cid, _)| *cid == c.id)
                        .map(|(_, n)| *n)
                        .unwrap_or(0);
                    ProjectCardView {
                        id: c.id,
                        column_id: c.column_id,
                        title: c.title.clone(),
                        description_html: c.description.as_deref().map(render_markdown),
                        assignee_id: c.assignee_id,
                        assignee_username: c.assignee_username.clone(),
                        due_date: c.due_date,
                        priority: c.priority.clone(),
                        labels: labels_of(c.id),
                        checklist_done,
                        checklist_total,
                        attachment_count,
                        position: c.position,
                        created_at: c.created_at,
                        updated_at: c.updated_at,
                    }
                })
                .collect(),
        })
        .collect();

    Ok(Json(ProjectBoardView {
        id: board.id,
        name: board.name,
        description: board.description,
        columns,
        created_at: board.created_at,
        updated_at: board.updated_at,
    }))
}

async fn create_board(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Json(body): Json<ProjectBoardBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let name = require_name(&body.name, "Board name")?;
    let description = optional_text(&body.description);

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_boards (name, description, created_by)
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&name)
    .bind(&description)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("creating a project board", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.board.create",
            target_type: "project_board",
            target_id: Some(id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn update_board(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(board_id): Path<Uuid>,
    Json(body): Json<ProjectBoardBody>,
) -> ApiResult<StatusCode> {
    let name = require_name(&body.name, "Board name")?;
    let description = optional_text(&body.description);

    let updated = sqlx::query(
        "UPDATE project_boards SET name = $2, description = $3, updated_at = now()
         WHERE id = $1",
    )
    .bind(board_id)
    .bind(&name)
    .bind(&description)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("updating a project board", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Board not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.board.update",
            target_type: "project_board",
            target_id: Some(board_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a board — its columns and their cards cascade away.
async fn remove_board(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(board_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let name: Option<String> =
        sqlx::query_scalar("DELETE FROM project_boards WHERE id = $1 RETURNING name")
            .bind(board_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a project board", e))?;
    let name = name.ok_or_else(|| ApiError::NotFound("Board not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.board.delete",
            target_type: "project_board",
            target_id: Some(board_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Columns ----------------------------------------------------------------

/// Add a column to the right of a board's existing ones.
async fn create_column(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(board_id): Path<Uuid>,
    Json(body): Json<ProjectColumnBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let name = require_name(&body.name, "Column name")?;
    let wip = body.wip_limit.filter(|n| *n >= 0);

    // The board must exist, and the new column goes after the last one. The
    // subquery for the next position races another add on the same board, but
    // the only cost of a tie is two columns sharing an index — cosmetic, and
    // the next reorder settles it.
    let board_name: Option<String> =
        sqlx::query_scalar("SELECT name FROM project_boards WHERE id = $1")
            .bind(board_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a board to add a column", e))?;
    let board_name = board_name.ok_or_else(|| ApiError::NotFound("Board not found".into()))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_columns (board_id, name, position, wip_limit)
         VALUES ($1, $2,
                 (SELECT COALESCE(MAX(position) + 1, 0)
                    FROM project_columns WHERE board_id = $1),
                 $3)
         RETURNING id",
    )
    .bind(board_id)
    .bind(&name)
    .bind(wip)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("creating a project column", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.column.create",
            target_type: "project_column",
            target_id: Some(id),
            target_name: &name,
            details: Some(format!("on board {board_name}")),
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn update_column(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(column_id): Path<Uuid>,
    Json(body): Json<ProjectColumnBody>,
) -> ApiResult<StatusCode> {
    let name = require_name(&body.name, "Column name")?;
    let wip = body.wip_limit.filter(|n| *n >= 0);

    let updated = sqlx::query("UPDATE project_columns SET name = $2, wip_limit = $3 WHERE id = $1")
        .bind(column_id)
        .bind(&name)
        .bind(wip)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("updating a project column", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Column not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.column.update",
            target_type: "project_column",
            target_id: Some(column_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a column — its cards cascade away with it.
async fn remove_column(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(column_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let name: Option<String> =
        sqlx::query_scalar("DELETE FROM project_columns WHERE id = $1 RETURNING name")
            .bind(column_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a project column", e))?;
    let name = name.ok_or_else(|| ApiError::NotFound("Column not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.column.delete",
            target_type: "project_column",
            target_id: Some(column_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Cards ------------------------------------------------------------------

/// Create a card at the bottom of a column. Any member may add work.
async fn create_card(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(column_id): Path<Uuid>,
    Json(body): Json<ProjectCardBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let title = require_name(&body.title, "Card title")?;
    let description = optional_text(&body.description);
    let priority = normalize_priority(&body.priority);

    // The column must exist, and it fixes the board whose labels the card may
    // carry — a label from another board is silently dropped by the sync below.
    let board_id: Option<Uuid> =
        sqlx::query_scalar("SELECT board_id FROM project_columns WHERE id = $1")
            .bind(column_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a column to add a card", e))?;
    let board_id = board_id.ok_or_else(|| ApiError::NotFound("Column not found".into()))?;

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to create a card", e))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_cards (column_id, title, description, assignee_id, due_date, priority, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6,
                 (SELECT COALESCE(MAX(position) + 1, 0)
                    FROM project_cards WHERE column_id = $1),
                 $7)
         RETURNING id",
    )
    .bind(column_id)
    .bind(&title)
    .bind(&description)
    .bind(body.assignee_id)
    .bind(body.due_date)
    .bind(&priority)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        db_reference(
            "creating a project card",
            e,
            "That column or assignee no longer exists. Reload the page and try again.",
        )
    })?;

    sync_card_labels(&mut tx, id, board_id, &body.label_ids).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "project.card.create",
            target_type: "project_card",
            target_id: Some(id),
            target_name: &title,
            details: None,
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a new card", e))?;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

/// Point a card at exactly `label_ids`, keeping only those that belong to
/// `board_id` — a crafted request naming another board's label is dropped rather
/// than trusted. Called by create and update, so the set is replaced wholesale.
async fn sync_card_labels(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    card_id: Uuid,
    board_id: Uuid,
    label_ids: &[Uuid],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM project_card_labels WHERE card_id = $1")
        .bind(card_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| internal("clearing a card's labels", e))?;

    if label_ids.is_empty() {
        return Ok(());
    }
    // One insert, filtered to the board's own labels — no loop, no per-label
    // round trip, and no way to attach a foreign board's label.
    sqlx::query(
        "INSERT INTO project_card_labels (card_id, label_id)
         SELECT $1, l.id FROM project_labels l
         WHERE l.id = ANY($2::uuid[]) AND l.board_id = $3",
    )
    .bind(card_id)
    .bind(label_ids)
    .bind(board_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| internal("attaching a card's labels", e))?;
    Ok(())
}

/// The raw form of a card, for the editor — the counterpart to a document draft.
async fn get_card_draft(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(card_id): Path<Uuid>,
) -> ApiResult<Json<ProjectCardDraft>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        column_id: Uuid,
        title: String,
        description: Option<String>,
        assignee_id: Option<Uuid>,
        due_date: Option<chrono::NaiveDate>,
        priority: String,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT id, column_id, title, description, assignee_id, due_date, priority
         FROM project_cards WHERE id = $1",
    )
    .bind(card_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a card draft", e))?
    .ok_or_else(|| ApiError::NotFound("Card not found".into()))?;

    let label_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT label_id FROM project_card_labels WHERE card_id = $1")
            .bind(card_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| internal("loading a card's labels", e))?;

    let checklist = sqlx::query_as::<_, ChecklistItem>(
        "SELECT id, text, done, position FROM project_card_checklist_items
         WHERE card_id = $1 ORDER BY position, id",
    )
    .bind(card_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a card's checklist", e))?;

    let attachments = sqlx::query_as::<_, CardAttachment>(
        "SELECT id, url, name, created_at FROM project_card_attachments
         WHERE card_id = $1 ORDER BY created_at",
    )
    .bind(card_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading a card's attachments", e))?;

    Ok(Json(ProjectCardDraft {
        id: row.id,
        column_id: row.column_id,
        title: row.title,
        description: row.description,
        assignee_id: row.assignee_id,
        due_date: row.due_date,
        priority: row.priority,
        label_ids,
        checklist,
        attachments,
    }))
}

/// Update a card's fields (title, description, assignee, due date, priority,
/// labels). Moving it between columns is the separate `/move` route.
async fn update_card(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<ProjectCardBody>,
) -> ApiResult<StatusCode> {
    let title = require_name(&body.title, "Card title")?;
    let description = optional_text(&body.description);
    let priority = normalize_priority(&body.priority);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to update a card", e))?;

    // The card's board fixes which labels it may carry; fetching it also doubles
    // as the "does this card exist" check.
    let board_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT col.board_id
         FROM project_cards c JOIN project_columns col ON col.id = c.column_id
         WHERE c.id = $1",
    )
    .bind(card_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal("loading a card to update", e))?;
    let board_id = board_id.ok_or_else(|| ApiError::NotFound("Card not found".into()))?;

    sqlx::query(
        "UPDATE project_cards
         SET title = $2, description = $3, assignee_id = $4, due_date = $5,
             priority = $6, updated_at = now()
         WHERE id = $1",
    )
    .bind(card_id)
    .bind(&title)
    .bind(&description)
    .bind(body.assignee_id)
    .bind(body.due_date)
    .bind(&priority)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        db_reference(
            "updating a project card",
            e,
            "That assignee no longer exists. Reload the page and try again.",
        )
    })?;

    sync_card_labels(&mut tx, card_id, board_id, &body.label_ids).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "project.card.update",
            target_type: "project_card",
            target_id: Some(card_id),
            target_name: &title,
            details: None,
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing an updated card", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The drag-and-drop: place a card at a new index in a column (its own or
/// another on the same board), and renumber the affected column(s) so their
/// positions stay a clean 0..n. Done in a transaction so a board is never seen
/// mid-move.
async fn move_card(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<ProjectCardMove>,
) -> ApiResult<StatusCode> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to move a card", e))?;

    // Where the card is now, and which board that column belongs to.
    let source: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT c.column_id, col.board_id, c.title
         FROM project_cards c
         JOIN project_columns col ON col.id = c.column_id
         WHERE c.id = $1",
    )
    .bind(card_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| internal("loading a card to move", e))?;
    let (source_column, source_board, title) =
        source.ok_or_else(|| ApiError::NotFound("Card not found".into()))?;

    // The destination column must exist and sit on the same board — a card
    // cannot hop boards, and a crafted request naming a foreign column is a 404,
    // not a silent cross-board move.
    let dest_board: Option<Uuid> =
        sqlx::query_scalar("SELECT board_id FROM project_columns WHERE id = $1")
            .bind(body.column_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| internal("loading the destination column", e))?;
    let dest_board = dest_board.ok_or_else(|| ApiError::NotFound("Column not found".into()))?;
    if dest_board != source_board {
        return Err(ApiError::BadRequest(
            "A card can only move within its own board".into(),
        ));
    }

    // The destination column's cards in order, without the one being moved, then
    // the moved card spliced in at the requested (clamped) index.
    let mut order: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM project_cards
         WHERE column_id = $1 AND id <> $2
         ORDER BY position, created_at",
    )
    .bind(body.column_id)
    .bind(card_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| internal("reading the destination column order", e))?;
    let index = (body.position.max(0) as usize).min(order.len());
    order.insert(index, card_id);

    // Point the card at its destination, then lay down 0..n over that column.
    sqlx::query("UPDATE project_cards SET column_id = $2, updated_at = now() WHERE id = $1")
        .bind(card_id)
        .bind(body.column_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("moving a card to its column", e))?;
    renumber(&mut tx, &order).await?;

    // A move out of a column leaves a gap in the source; close it so its
    // positions stay 0..n as well.
    if source_column != body.column_id {
        let source_order: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM project_cards WHERE column_id = $1 ORDER BY position, created_at",
        )
        .bind(source_column)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| internal("reading the source column order", e))?;
        renumber(&mut tx, &source_order).await?;
    }

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "project.card.move",
            target_type: "project_card",
            target_id: Some(card_id),
            target_name: &title,
            details: None,
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a card move", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Write positions 0..n over the given card ids, in the order given.
async fn renumber(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ordered_ids: &[Uuid],
) -> ApiResult<()> {
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE project_cards SET position = $2 WHERE id = $1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut **tx)
            .await
            .map_err(|e| internal("renumbering cards in a column", e))?;
    }
    Ok(())
}

async fn remove_card(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(card_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let title: Option<String> =
        sqlx::query_scalar("DELETE FROM project_cards WHERE id = $1 RETURNING title")
            .bind(card_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a project card", e))?;
    let title = title.ok_or_else(|| ApiError::NotFound("Card not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.card.delete",
            target_type: "project_card",
            target_id: Some(card_id),
            target_name: &title,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Labels -----------------------------------------------------------------

/// A board's label vocabulary. Any member reads it (to filter and to tag);
/// creating and editing labels is the lead's job.
async fn list_labels(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(board_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ProjectLabel>>> {
    let labels = sqlx::query_as::<_, ProjectLabel>(
        "SELECT id, name, color FROM project_labels WHERE board_id = $1 ORDER BY name",
    )
    .bind(board_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing board labels", e))?;
    Ok(Json(labels))
}

async fn create_label(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(board_id): Path<Uuid>,
    Json(body): Json<ProjectLabelBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let name = require_name(&body.name, "Label name")?;
    let color = normalize_color(&body.color);

    // The board must exist (FK), and its label names are unique — a repeat is a
    // conflict the lead can resolve, not a server fault.
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_labels (board_id, name, color) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(board_id)
    .bind(&name)
    .bind(&color)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        if matches!(&e, sqlx::Error::Database(db) if db.is_unique_violation()) {
            ApiError::Conflict("A label with that name already exists on this board".into())
        } else {
            db_reference("creating a label", e, "That board no longer exists.")
        }
    })?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.label.create",
            target_type: "project_label",
            target_id: Some(id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn update_label(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(label_id): Path<Uuid>,
    Json(body): Json<ProjectLabelBody>,
) -> ApiResult<StatusCode> {
    let name = require_name(&body.name, "Label name")?;
    let color = normalize_color(&body.color);

    let updated = sqlx::query("UPDATE project_labels SET name = $2, color = $3 WHERE id = $1")
        .bind(label_id)
        .bind(&name)
        .bind(&color)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            if matches!(&e, sqlx::Error::Database(db) if db.is_unique_violation()) {
                ApiError::Conflict("A label with that name already exists on this board".into())
            } else {
                internal("updating a label", e)
            }
        })?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Label not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.label.update",
            target_type: "project_label",
            target_id: Some(label_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a label — it drops off every card that carried it (cascade).
async fn remove_label(
    State(state): State<AppState>,
    ProjectManager(user): ProjectManager,
    Path(label_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let name: Option<String> =
        sqlx::query_scalar("DELETE FROM project_labels WHERE id = $1 RETURNING name")
            .bind(label_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a label", e))?;
    let name = name.ok_or_else(|| ApiError::NotFound("Label not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.label.delete",
            target_type: "project_label",
            target_id: Some(label_id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Comments ---------------------------------------------------------------

/// A card's comment thread, oldest first, each body rendered to sanitized HTML.
async fn list_comments(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(card_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ProjectComment>>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        author_id: Option<Uuid>,
        author_username: Option<String>,
        body: String,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT k.id, k.author_id, u.username AS author_username, k.body, k.created_at
         FROM project_card_comments k
         LEFT JOIN users u ON u.id = k.author_id
         WHERE k.card_id = $1
         ORDER BY k.created_at",
    )
    .bind(card_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing card comments", e))?;

    let comments = rows
        .into_iter()
        .map(|r| ProjectComment {
            id: r.id,
            author_id: r.author_id,
            author_username: r.author_username,
            body_html: render_markdown(&r.body),
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(comments))
}

async fn create_comment(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<ProjectCommentBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let text = body.body.trim();
    if text.is_empty() {
        return Err(ApiError::BadRequest("A comment cannot be empty".into()));
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_card_comments (card_id, author_id, body)
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(card_id)
    .bind(user.id)
    .bind(text)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| db_reference("posting a comment", e, "That card no longer exists."))?;

    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

/// Delete a comment. The author may remove their own; an admin may remove any
/// (moderation). A lead's board rights do not extend to editing what someone
/// else said — that is the author's or an admin's call.
async fn remove_comment(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(comment_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let author_id: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT author_id FROM project_card_comments WHERE id = $1")
            .bind(comment_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a comment to delete", e))?;
    let author_id =
        author_id.ok_or_else(|| ApiError::NotFound("Comment not found".into()))?;

    if !user.is_admin && author_id != Some(user.id) {
        return Err(ApiError::Forbidden("You can only delete your own comments".into()));
    }

    sqlx::query("DELETE FROM project_card_comments WHERE id = $1")
        .bind(comment_id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("deleting a comment", e))?;
    Ok(StatusCode::NO_CONTENT)
}

// --- My cards ---------------------------------------------------------------

/// Every card assigned to the caller, across all boards — the personal work
/// queue. Ordered so the soonest-due, highest-priority work floats up.
async fn my_cards(
    State(state): State<AppState>,
    InProjects(user): InProjects,
) -> ApiResult<Json<Vec<MyCard>>> {
    let cards = sqlx::query_as::<_, MyCard>(
        "SELECT c.id, c.title, b.id AS board_id, b.name AS board_name,
                col.name AS column_name, c.priority, c.due_date
         FROM project_cards c
         JOIN project_columns col ON col.id = c.column_id
         JOIN project_boards b ON b.id = col.board_id
         WHERE c.assignee_id = $1
         ORDER BY c.due_date ASC NULLS LAST,
                  CASE c.priority
                       WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'medium' THEN 2 ELSE 3 END,
                  c.created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing the caller's assigned cards", e))?;
    Ok(Json(cards))
}

// --- Checklists -------------------------------------------------------------

/// Add a checklist item to the bottom of a card's list. Any member may.
async fn add_checklist_item(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<ChecklistItemBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::BadRequest("A checklist item cannot be empty".into()));
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_card_checklist_items (card_id, text, position)
         VALUES ($1, $2,
                 (SELECT COALESCE(MAX(position) + 1, 0)
                    FROM project_card_checklist_items WHERE card_id = $1))
         RETURNING id",
    )
    .bind(card_id)
    .bind(text)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| db_reference("adding a checklist item", e, "That card no longer exists."))?;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

/// Rename a checklist item and/or tick it. The common case — checking a box — is
/// this same call with the text unchanged.
async fn update_checklist_item(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(item_id): Path<Uuid>,
    Json(body): Json<ChecklistUpdate>,
) -> ApiResult<StatusCode> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::BadRequest("A checklist item cannot be empty".into()));
    }
    let updated = sqlx::query(
        "UPDATE project_card_checklist_items SET text = $2, done = $3 WHERE id = $1",
    )
    .bind(item_id)
    .bind(text)
    .bind(body.done)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("updating a checklist item", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Checklist item not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_checklist_item(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(item_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let deleted = sqlx::query("DELETE FROM project_card_checklist_items WHERE id = $1")
        .bind(item_id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("deleting a checklist item", e))?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound("Checklist item not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// --- Attachments ------------------------------------------------------------

/// Pin an already-uploaded image to a card. The image itself goes up through the
/// shared `/api/upload` endpoint (which enforces the SR-5 image whitelist); this
/// only records the url it returned against the card, so nothing here trusts a
/// path the client made up beyond storing it for display.
async fn add_attachment(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<AttachmentBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let url = body.url.trim();
    let name = body.name.trim();
    // The url must be an upload path this server issued, not an arbitrary link —
    // an attachment is a pointer at our own storage, not an open redirect.
    if !url.starts_with("/uploads/") {
        return Err(ApiError::BadRequest("That is not a valid upload".into()));
    }
    let name = if name.is_empty() { "attachment" } else { name };

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_card_attachments (card_id, url, name, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(card_id)
    .bind(url)
    .bind(name)
    .bind(_user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| db_reference("attaching an image", e, "That card no longer exists."))?;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn remove_attachment(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(attachment_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let deleted = sqlx::query("DELETE FROM project_card_attachments WHERE id = $1")
        .bind(attachment_id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal("removing an attachment", e))?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound("Attachment not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// --- Calendar ---------------------------------------------------------------

/// Every due-dated card across all boards — what the calendar view lays out on a
/// month grid. Undated cards have no place on a calendar, so they are left out.
async fn calendar(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
) -> ApiResult<Json<Vec<CalendarCard>>> {
    let cards = sqlx::query_as::<_, CalendarCard>(
        "SELECT c.id, c.title, b.id AS board_id, b.name AS board_name, c.due_date, c.priority
         FROM project_cards c
         JOIN project_columns col ON col.id = c.column_id
         JOIN project_boards b ON b.id = col.board_id
         WHERE c.due_date IS NOT NULL
         ORDER BY c.due_date",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing calendar cards", e))?;
    Ok(Json(cards))
}
