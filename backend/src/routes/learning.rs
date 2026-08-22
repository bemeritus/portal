//! `/api/learning` — the learning section: resources, tests and labs.
//!
//! The section door is the [`InLearning`] extractor; authoring content needs
//! the finer [`LearningAuthor`]. Two rules run through the whole module:
//!
//!   * **Authoring is section-wide, not per-row ownership.** Any learning author
//!     may edit or delete any learning content, the same way a category grant —
//!     not authorship — decides everything in templates. `author_id` records who
//!     wrote a thing; it never gates who may change it.
//!   * **Drafts are visible only to authors.** A learner in the section sees
//!     published content; a draft answers 404 to them, so an unfinished test
//!     cannot be found by guessing its id.
//!
//! Test scoring happens here and nowhere else: the take view never carries
//! `is_correct`, so the only place a score can be computed is the server.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use uuid::Uuid;

use crate::audit::{audit_now, audit_tx, Audit};
use crate::auth::{AdminUser, InLearning, LearningAuthor};
use crate::content::render_markdown;
use crate::db::AppState;
use crate::error::{db_reference, internal, ApiError, ApiResult};
use crate::models::{
    normalize_lab_state, normalize_status, AttemptAnswer, AttemptResult, AttemptRow,
    AttemptSubmit, LabProgressSubmit, LabProgressView, LabSubmissionRow, LearningLabBody,
    LearningLabSummary, LearningLabView, LearningResourceBody, LearningResourceSummary,
    LearningResourceView, LearningTestBody, LearningTestSummary, LearningTestView, Section,
    TestOptionView, TestQuestionView,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .nest("/resources", resource_routes())
        .nest("/tests", test_routes())
        .nest("/labs", lab_routes())
}

// --- Resources --------------------------------------------------------------

fn resource_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list_resources).post(create_resource))
        .route("/{id}", get(get_resource).put(update_resource).delete(remove_resource))
}

/// List resources: published for everyone in the section, plus drafts for those
/// who may author.
async fn list_resources(
    State(state): State<AppState>,
    InLearning(user): InLearning,
) -> ApiResult<Json<Vec<LearningResourceSummary>>> {
    let include_drafts = user.can_author(Section::Learning);
    let rows = sqlx::query_as::<_, LearningResourceSummary>(
        "SELECT r.id, r.title, r.status, u.username AS author_username, r.created_at
         FROM learning_resources r
         JOIN users u ON u.id = r.author_id
         WHERE $1::bool OR r.status = 'published'
         ORDER BY r.created_at DESC",
    )
    .bind(include_drafts)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing learning resources", e))?;
    Ok(Json(rows))
}

/// One resource, its markdown rendered. A draft is invisible to non-authors.
async fn get_resource(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<LearningResourceView>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        title: String,
        status: String,
        author_id: Uuid,
        author_username: String,
        body: String,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT r.id, r.title, r.status, r.author_id, u.username AS author_username,
                r.body, r.created_at, r.updated_at
         FROM learning_resources r
         JOIN users u ON u.id = r.author_id
         WHERE r.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a learning resource", e))?
    .ok_or_else(|| ApiError::NotFound("Resource not found".into()))?;

    if row.status != "published" && !user.can_author(Section::Learning) {
        return Err(ApiError::NotFound("Resource not found".into()));
    }

    Ok(Json(LearningResourceView {
        id: row.id,
        title: row.title,
        status: row.status,
        author_id: row.author_id,
        author_username: row.author_username,
        body_html: render_markdown(&row.body),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

async fn create_resource(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Json(body): Json<LearningResourceBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO learning_resources (title, body, author_id, status)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&title)
    .bind(&body.body)
    .bind(user.id)
    .bind(&status)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("creating a learning resource", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.resource.create",
            target_type: "learning_resource",
            target_id: Some(id),
            target_name: &title,
            details: Some(status),
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn update_resource(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
    Json(body): Json<LearningResourceBody>,
) -> ApiResult<StatusCode> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let updated = sqlx::query(
        "UPDATE learning_resources
         SET title = $2, body = $3, status = $4, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(&body.body)
    .bind(&status)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("updating a learning resource", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Resource not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.resource.update",
            target_type: "learning_resource",
            target_id: Some(id),
            target_name: &title,
            details: Some(status),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_resource(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let title: Option<String> =
        sqlx::query_scalar("DELETE FROM learning_resources WHERE id = $1 RETURNING title")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a learning resource", e))?;
    let title = title.ok_or_else(|| ApiError::NotFound("Resource not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.resource.delete",
            target_type: "learning_resource",
            target_id: Some(id),
            target_name: &title,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Tests ------------------------------------------------------------------

fn test_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list_tests).post(create_test))
        .route("/{id}", get(get_test).put(update_test).delete(remove_test))
        .route("/{id}/attempts", get(my_attempts).post(submit_attempt))
        .route("/{id}/results", get(test_results))
}

async fn list_tests(
    State(state): State<AppState>,
    InLearning(user): InLearning,
) -> ApiResult<Json<Vec<LearningTestSummary>>> {
    let include_drafts = user.can_author(Section::Learning);
    let rows = sqlx::query_as::<_, LearningTestSummary>(
        "SELECT t.id, t.title, t.description, t.status, u.username AS author_username,
                (SELECT count(*) FROM learning_test_questions q WHERE q.test_id = t.id)
                    AS question_count,
                t.created_at
         FROM learning_tests t
         JOIN users u ON u.id = t.author_id
         WHERE $1::bool OR t.status = 'published'
         ORDER BY t.created_at DESC",
    )
    .bind(include_drafts)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing learning tests", e))?;
    Ok(Json(rows))
}

/// The take view — questions and options, no correct flags. A draft answers 404
/// to a non-author.
async fn get_test(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<LearningTestView>> {
    let meta: Option<(String, Option<String>, String)> =
        sqlx::query_as("SELECT title, description, status FROM learning_tests WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a learning test", e))?;
    let (title, description, status) =
        meta.ok_or_else(|| ApiError::NotFound("Test not found".into()))?;
    if status != "published" && !user.can_author(Section::Learning) {
        return Err(ApiError::NotFound("Test not found".into()));
    }

    let questions = load_take_questions(&state, id).await?;
    Ok(Json(LearningTestView {
        id,
        title,
        description,
        status,
        questions,
    }))
}

/// Questions + options for the take view, correct flags stripped.
async fn load_take_questions(state: &AppState, test_id: Uuid) -> ApiResult<Vec<TestQuestionView>> {
    let question_rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, prompt FROM learning_test_questions WHERE test_id = $1 ORDER BY position, id",
    )
    .bind(test_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading test questions", e))?;

    let option_rows: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT o.question_id, o.id, o.label
         FROM learning_test_options o
         JOIN learning_test_questions q ON q.id = o.question_id
         WHERE q.test_id = $1
         ORDER BY o.position, o.id",
    )
    .bind(test_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading test options", e))?;

    let mut by_question: HashMap<Uuid, Vec<TestOptionView>> = HashMap::new();
    for (question_id, option_id, label) in option_rows {
        by_question
            .entry(question_id)
            .or_default()
            .push(TestOptionView {
                id: option_id,
                label,
            });
    }

    Ok(question_rows
        .into_iter()
        .map(|(qid, prompt)| TestQuestionView {
            id: qid,
            prompt,
            options: by_question.remove(&qid).unwrap_or_default(),
        })
        .collect())
}

async fn create_test(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Json(body): Json<LearningTestBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to create a test", e))?;

    let test_id: Uuid = sqlx::query_scalar(
        "INSERT INTO learning_tests (title, description, author_id, status, pass_score)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(&title)
    .bind(&body.description)
    .bind(user.id)
    .bind(&status)
    .bind(body.pass_score)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| internal("creating a test", e))?;

    insert_test_questions(&mut tx, test_id, &body).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "learning.test.create",
            target_type: "learning_test",
            target_id: Some(test_id),
            target_name: &title,
            details: Some(format!("{status}; {} question(s)", body.questions.len())),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a new test", e))?;
    Ok((StatusCode::CREATED, Json(CreatedId { id: test_id })))
}

async fn update_test(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
    Json(body): Json<LearningTestBody>,
) -> ApiResult<StatusCode> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to update a test", e))?;

    let updated = sqlx::query(
        "UPDATE learning_tests
         SET title = $2, description = $3, status = $4, pass_score = $5, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(&body.description)
    .bind(&status)
    .bind(body.pass_score)
    .execute(&mut *tx)
    .await
    .map_err(|e| internal("updating a test", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Test not found".into()));
    }

    // Questions are replaced wholesale, the same strategy documents use for
    // their blocks. Old attempts keep their recorded scores; their answer rows
    // point at options that cascade away, which is why the answer FK is
    // ON DELETE SET NULL rather than RESTRICT.
    sqlx::query("DELETE FROM learning_test_questions WHERE test_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("clearing old test questions", e))?;
    insert_test_questions(&mut tx, id, &body).await?;

    audit_tx(
        &mut tx,
        &user,
        Audit {
            action: "learning.test.update",
            target_type: "learning_test",
            target_id: Some(id),
            target_name: &title,
            details: Some(format!("{status}; {} question(s)", body.questions.len())),
        },
    )
    .await?;

    tx.commit()
        .await
        .map_err(|e| internal("committing an updated test", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Write a test's questions and options in array order.
async fn insert_test_questions(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    test_id: Uuid,
    body: &LearningTestBody,
) -> ApiResult<()> {
    for (qi, q) in body.questions.iter().enumerate() {
        let question_id: Uuid = sqlx::query_scalar(
            "INSERT INTO learning_test_questions (test_id, prompt, position)
             VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(test_id)
        .bind(q.prompt.trim())
        .bind(qi as i32)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| internal("inserting a test question", e))?;

        for (oi, o) in q.options.iter().enumerate() {
            sqlx::query(
                "INSERT INTO learning_test_options (question_id, label, is_correct, position)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(question_id)
            .bind(o.label.trim())
            .bind(o.is_correct)
            .bind(oi as i32)
            .execute(&mut **tx)
            .await
            .map_err(|e| internal("inserting a test option", e))?;
        }
    }
    Ok(())
}

async fn remove_test(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let title: Option<String> =
        sqlx::query_scalar("DELETE FROM learning_tests WHERE id = $1 RETURNING title")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a test", e))?;
    let title = title.ok_or_else(|| ApiError::NotFound("Test not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.test.delete",
            target_type: "learning_test",
            target_id: Some(id),
            target_name: &title,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Submit a test and get the graded result. Scoring is done here from the stored
/// correct options, which never left the server.
async fn submit_attempt(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(test_id): Path<Uuid>,
    Json(body): Json<AttemptSubmit>,
) -> ApiResult<Json<AttemptResult>> {
    // Only a published test can be taken; a draft answers 404 as everywhere.
    let row: Option<(String, Option<i32>)> =
        sqlx::query_as("SELECT status, pass_score FROM learning_tests WHERE id = $1")
            .bind(test_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a test to submit", e))?;
    let (status, pass_score) = row.ok_or_else(|| ApiError::NotFound("Test not found".into()))?;
    if status != "published" {
        return Err(ApiError::NotFound("Test not found".into()));
    }

    // The questions of this test, and the correct option(s) of each. A question
    // is right when the chosen option is one of its correct ones.
    let question_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM learning_test_questions WHERE test_id = $1")
            .bind(test_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| internal("loading question ids to score", e))?;
    let correct_rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT o.question_id, o.id
         FROM learning_test_options o
         JOIN learning_test_questions q ON q.id = o.question_id
         WHERE q.test_id = $1 AND o.is_correct",
    )
    .bind(test_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("loading correct options to score", e))?;

    let valid_questions: HashSet<Uuid> = question_ids.iter().copied().collect();
    let mut correct: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    for (question_id, option_id) in correct_rows {
        correct.entry(question_id).or_default().insert(option_id);
    }

    // Keep only the last answer given for each question, and only for questions
    // that belong to this test — a crafted body cannot inflate the denominator.
    let mut chosen: HashMap<Uuid, Option<Uuid>> = HashMap::new();
    for AttemptAnswer {
        question_id,
        option_id,
    } in body.answers
    {
        if valid_questions.contains(&question_id) {
            chosen.insert(question_id, option_id);
        }
    }

    let max_score = question_ids.len() as i32;
    let mut score = 0i32;
    for qid in &question_ids {
        if let Some(Some(picked)) = chosen.get(qid) {
            if correct.get(qid).is_some_and(|set| set.contains(picked)) {
                score += 1;
            }
        }
    }
    let passed = pass_score.map(|threshold| score >= threshold);

    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("opening a transaction to record an attempt", e))?;

    let attempt_id: Uuid = sqlx::query_scalar(
        "INSERT INTO learning_test_attempts (test_id, user_id, score, max_score, passed)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(test_id)
    .bind(user.id)
    .bind(score)
    .bind(max_score)
    .bind(passed)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| internal("recording a test attempt", e))?;

    for (question_id, option_id) in &chosen {
        sqlx::query(
            "INSERT INTO learning_test_attempt_answers (attempt_id, question_id, option_id)
             VALUES ($1, $2, $3)",
        )
        .bind(attempt_id)
        .bind(question_id)
        .bind(*option_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("recording an attempt answer", e))?;
    }

    let submitted_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT submitted_at FROM learning_test_attempts WHERE id = $1")
            .bind(attempt_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| internal("reading back the attempt time", e))?;

    tx.commit()
        .await
        .map_err(|e| internal("committing a test attempt", e))?;

    Ok(Json(AttemptResult {
        id: attempt_id,
        score,
        max_score,
        passed,
        submitted_at,
    }))
}

/// The caller's own attempts on a test, newest first.
async fn my_attempts(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(test_id): Path<Uuid>,
) -> ApiResult<Json<Vec<AttemptResult>>> {
    let rows = sqlx::query_as::<_, AttemptResult>(
        "SELECT id, score, max_score, passed, submitted_at
         FROM learning_test_attempts
         WHERE test_id = $1 AND user_id = $2
         ORDER BY submitted_at DESC",
    )
    .bind(test_id)
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing the caller's attempts", e))?;
    Ok(Json(rows))
}

/// Everyone's attempts on a test — admin only, the one view that crosses the
/// per-user boundary (the teacher who authored it does not get it).
async fn test_results(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
    Path(test_id): Path<Uuid>,
) -> ApiResult<Json<Vec<AttemptRow>>> {
    let rows = sqlx::query_as::<_, AttemptRow>(
        "SELECT u.username, a.score, a.max_score, a.passed, a.submitted_at
         FROM learning_test_attempts a
         JOIN users u ON u.id = a.user_id
         WHERE a.test_id = $1
         ORDER BY a.submitted_at DESC",
    )
    .bind(test_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing every attempt on a test", e))?;
    Ok(Json(rows))
}

// --- Labs -------------------------------------------------------------------

fn lab_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list_labs).post(create_lab))
        .route("/{id}", get(get_lab).put(update_lab).delete(remove_lab))
        .route("/{id}/progress", put(save_progress))
        .route("/{id}/submissions", get(lab_submissions))
}

async fn list_labs(
    State(state): State<AppState>,
    InLearning(user): InLearning,
) -> ApiResult<Json<Vec<LearningLabSummary>>> {
    let include_drafts = user.can_author(Section::Learning);
    let rows = sqlx::query_as::<_, LearningLabSummary>(
        "SELECT l.id, l.title, l.status, u.username AS author_username,
                p.state AS my_state, l.created_at
         FROM learning_labs l
         JOIN users u ON u.id = l.author_id
         LEFT JOIN learning_lab_progress p ON p.lab_id = l.id AND p.user_id = $2
         WHERE $1::bool OR l.status = 'published'
         ORDER BY l.created_at DESC",
    )
    .bind(include_drafts)
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing learning labs", e))?;
    Ok(Json(rows))
}

async fn get_lab(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<LearningLabView>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        title: String,
        status: String,
        author_username: String,
        brief: String,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT l.title, l.status, u.username AS author_username, l.brief,
                l.created_at, l.updated_at
         FROM learning_labs l
         JOIN users u ON u.id = l.author_id
         WHERE l.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading a learning lab", e))?
    .ok_or_else(|| ApiError::NotFound("Lab not found".into()))?;

    if row.status != "published" && !user.can_author(Section::Learning) {
        return Err(ApiError::NotFound("Lab not found".into()));
    }

    let my_progress = sqlx::query_as::<_, LabProgressView>(
        "SELECT state, submission, grade
         FROM learning_lab_progress WHERE lab_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| internal("loading the caller's lab progress", e))?;

    Ok(Json(LearningLabView {
        id,
        title: row.title,
        status: row.status,
        brief_html: render_markdown(&row.brief),
        author_username: row.author_username,
        my_progress,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

async fn create_lab(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Json(body): Json<LearningLabBody>,
) -> ApiResult<(StatusCode, Json<CreatedId>)> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO learning_labs (title, brief, author_id, status)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&title)
    .bind(&body.brief)
    .bind(user.id)
    .bind(&status)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal("creating a learning lab", e))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.lab.create",
            target_type: "learning_lab",
            target_id: Some(id),
            target_name: &title,
            details: Some(status),
        },
    )
    .await;
    Ok((StatusCode::CREATED, Json(CreatedId { id })))
}

async fn update_lab(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
    Json(body): Json<LearningLabBody>,
) -> ApiResult<StatusCode> {
    let title = require_title(&body.title)?;
    let status = normalize_status(&body.status);

    let updated = sqlx::query(
        "UPDATE learning_labs SET title = $2, brief = $3, status = $4, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(&title)
    .bind(&body.brief)
    .bind(&status)
    .execute(&state.pool)
    .await
    .map_err(|e| internal("updating a learning lab", e))?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound("Lab not found".into()));
    }

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.lab.update",
            target_type: "learning_lab",
            target_id: Some(id),
            target_name: &title,
            details: Some(status),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_lab(
    State(state): State<AppState>,
    LearningAuthor(user): LearningAuthor,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let title: Option<String> =
        sqlx::query_scalar("DELETE FROM learning_labs WHERE id = $1 RETURNING title")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("deleting a learning lab", e))?;
    let title = title.ok_or_else(|| ApiError::NotFound("Lab not found".into()))?;

    audit_now(
        &state.pool,
        Some(user.id),
        &user.username,
        Audit {
            action: "learning.lab.delete",
            target_type: "learning_lab",
            target_id: Some(id),
            target_name: &title,
            details: None,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Advance the caller's own progress on a lab. Upserts their single row; the
/// `reviewed` state is admin-only, so [`normalize_lab_state`] refuses it here.
async fn save_progress(
    State(state): State<AppState>,
    InLearning(user): InLearning,
    Path(lab_id): Path<Uuid>,
    Json(body): Json<LabProgressSubmit>,
) -> ApiResult<StatusCode> {
    let state_value = normalize_lab_state(&body.state);

    // The lab must exist and be published for a learner to record work on it.
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM learning_labs WHERE id = $1")
            .bind(lab_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("loading a lab to save progress", e))?;
    let status = status.ok_or_else(|| ApiError::NotFound("Lab not found".into()))?;
    if status != "published" && !user.can_author(Section::Learning) {
        return Err(ApiError::NotFound("Lab not found".into()));
    }

    sqlx::query(
        "INSERT INTO learning_lab_progress (lab_id, user_id, state, submission, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (lab_id, user_id)
         DO UPDATE SET state = EXCLUDED.state,
                       submission = EXCLUDED.submission,
                       updated_at = now()",
    )
    .bind(lab_id)
    .bind(user.id)
    .bind(&state_value)
    .bind(&body.submission)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        db_reference(
            "saving lab progress",
            e,
            "That lab no longer exists. Reload the page.",
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Everyone's progress on a lab — admin only.
async fn lab_submissions(
    State(state): State<AppState>,
    AdminUser(_): AdminUser,
    Path(lab_id): Path<Uuid>,
) -> ApiResult<Json<Vec<LabSubmissionRow>>> {
    let rows = sqlx::query_as::<_, LabSubmissionRow>(
        "SELECT u.username, p.state, p.submission, p.grade, p.updated_at
         FROM learning_lab_progress p
         JOIN users u ON u.id = p.user_id
         WHERE p.lab_id = $1
         ORDER BY p.updated_at DESC",
    )
    .bind(lab_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing every submission on a lab", e))?;
    Ok(Json(rows))
}

// --- Shared -----------------------------------------------------------------

#[derive(serde::Serialize)]
struct CreatedId {
    id: Uuid,
}

/// Trim a title and reject an empty one — the same rule documents use.
fn require_title(raw: &str) -> ApiResult<String> {
    let title = raw.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest("Title is required".into()));
    }
    Ok(title)
}
