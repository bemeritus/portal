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
    ProjectBoardBody, ProjectBoardSummary, ProjectBoardView, ProjectCardBody, ProjectCardDraft,
    ProjectCardMove, ProjectCardView, ProjectColumnBody, ProjectColumnView, ProjectMember,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/members", get(list_members))
        .route("/boards", get(list_boards).post(create_board))
        .route("/boards/{id}", get(get_board).put(update_board).delete(remove_board))
        .route("/boards/{id}/columns", post(create_column))
        .route("/columns/{id}", put(update_column).delete(remove_column))
        .route("/columns/{id}/cards", post(create_card))
        .route("/cards/{id}", get(get_card_draft).put(update_card).delete(remove_card))
        .route("/cards/{id}/move", put(move_card))
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

    let column_rows: Vec<(Uuid, String, i32)> = sqlx::query_as(
        "SELECT id, name, position FROM project_columns
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
        position: i32,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }
    let card_rows = sqlx::query_as::<_, CardRow>(
        "SELECT c.id, c.column_id, c.title, c.description,
                c.assignee_id, u.username AS assignee_username,
                c.due_date, c.position, c.created_at, c.updated_at
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

    let columns = column_rows
        .into_iter()
        .map(|(id, name, position)| ProjectColumnView {
            id,
            name,
            position,
            cards: card_rows
                .iter()
                .filter(|c| c.column_id == id)
                .map(|c| ProjectCardView {
                    id: c.id,
                    column_id: c.column_id,
                    title: c.title.clone(),
                    description_html: c.description.as_deref().map(render_markdown),
                    assignee_id: c.assignee_id,
                    assignee_username: c.assignee_username.clone(),
                    due_date: c.due_date,
                    position: c.position,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
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
        "INSERT INTO project_columns (board_id, name, position)
         VALUES ($1, $2,
                 (SELECT COALESCE(MAX(position) + 1, 0)
                    FROM project_columns WHERE board_id = $1))
         RETURNING id",
    )
    .bind(board_id)
    .bind(&name)
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

    let updated = sqlx::query("UPDATE project_columns SET name = $2 WHERE id = $1")
        .bind(column_id)
        .bind(&name)
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

    // The column must exist; the card lands after the last one in it. A missing
    // column, or an assignee id that resolves to nobody, is a foreign-key
    // violation the caller can fix, not a server fault.
    let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM project_columns WHERE id = $1")
        .bind(column_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| internal("loading a column to add a card", e))?;
    exists.ok_or_else(|| ApiError::NotFound("Column not found".into()))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_cards (column_id, title, description, assignee_id, due_date, position, created_by)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT COALESCE(MAX(position) + 1, 0)
                    FROM project_cards WHERE column_id = $1),
                 $6)
         RETURNING id",
    )
    .bind(column_id)
    .bind(&title)
    .bind(&description)
    .bind(body.assignee_id)
    .bind(body.due_date)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        db_reference(
            "creating a project card",
            e,
            "That column or assignee no longer exists. Reload the page and try again.",
        )
    })?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.card.create",
            target_type: "project_card",
            target_id: Some(id),
            target_name: &title,
            details: None,
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

/// The raw form of a card, for the editor — the counterpart to a document draft.
async fn get_card_draft(
    State(state): State<AppState>,
    InProjects(_user): InProjects,
    Path(card_id): Path<Uuid>,
) -> ApiResult<Json<ProjectCardDraft>> {
    let card = sqlx::query_as::<_, ProjectCardDraft>(
        "SELECT id, column_id, title, description, assignee_id, due_date
         FROM project_cards WHERE id = $1",
    )
    .bind(card_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a card draft", e))?
    .ok_or_else(|| ApiError::NotFound("Card not found".into()))?;
    Ok(Json(card))
}

/// Update a card's fields (title, description, assignee, due date). Moving it
/// between columns is the separate `/move` route.
async fn update_card(
    State(state): State<AppState>,
    InProjects(user): InProjects,
    Path(card_id): Path<Uuid>,
    Json(body): Json<ProjectCardBody>,
) -> ApiResult<StatusCode> {
    let title = require_name(&body.title, "Card title")?;
    let description = optional_text(&body.description);

    let updated = sqlx::query(
        "UPDATE project_cards
         SET title = $2, description = $3, assignee_id = $4, due_date = $5, updated_at = now()
         WHERE id = $1",
    )
    .bind(card_id)
    .bind(&title)
    .bind(&description)
    .bind(body.assignee_id)
    .bind(body.due_date)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        db_reference(
            "updating a project card",
            e,
            "That assignee no longer exists. Reload the page and try again.",
        )
    })?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Card not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "project.card.update",
            target_type: "project_card",
            target_id: Some(card_id),
            target_name: &title,
            details: None,
        },
    )
    .await;
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
