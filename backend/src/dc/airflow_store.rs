//! Airflow runs in the database (migration 0030): the API's side of the
//! queue. The API enqueues and cancels; `portal-cfd-worker` claims, runs and
//! stores the result. The two never talk to each other directly.

use chrono::{DateTime, Utc};
use portal_cfd::input::CaseInput;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use sqlx::types::Json;

use super::airflow;
use super::model::RoomView;
use crate::audit::{Audit, audit_tx};
use crate::error::{ApiError, ApiResult, internal};
use crate::models::User;

type Tx<'a> = sqlx::Transaction<'a, sqlx::Postgres>;

/// A worker seen this recently can take a run.
pub const WORKER_FRESH_SECS: f64 = 60.0;

/// One run as the API shows it.
#[derive(Clone, Debug, Serialize)]
pub struct RunInfo {
    pub id: i64,
    pub revision: i32,
    /// queued, running, done, not_converged, failed, cancelled.
    pub status: String,
    pub cancel_requested: bool,
    pub progress: Option<Value>,
    /// Why it is not a result; a code the UI translates.
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Its input is not the room's as it stands now.
    pub outdated: bool,
}

type RunRow = (
    i64,
    i32,
    String,
    bool,
    Option<Value>,
    Option<String>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    bool,
);

const RUN_COLUMNS: &str = "id, revision, status, cancel_requested, progress, reason, created_at, \
     started_at, finished_at, input IS DISTINCT FROM $2::jsonb AS outdated";

fn run_info(r: RunRow) -> RunInfo {
    RunInfo {
        id: r.0,
        revision: r.1,
        status: r.2,
        cancel_requested: r.3,
        progress: r.4,
        reason: r.5,
        created_at: r.6,
        started_at: r.7,
        finished_at: r.8,
        outdated: r.9,
    }
}

/// The input a run of the room as it stands would take, or why there can
/// be none (e.g. a room that is not a box).
pub fn input_of(view: &RoomView, processes: usize) -> Result<CaseInput, String> {
    airflow::case_input(view, processes)
}

fn json_of(input: &CaseInput) -> ApiResult<Value> {
    serde_json::to_value(input).map_err(|e| internal("encoding an airflow input", e))
}

pub async fn worker_available(conn: &mut PgConnection) -> ApiResult<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM dc_airflow_workers
                         WHERE seen_at > now() - make_interval(secs => $1))",
    )
    .bind(WORKER_FRESH_SECS)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| internal("looking for an airflow worker", e))
}

/// The room's latest run, and its latest run that converged; `outdated`
/// against `current` (the input of the room as it stands).
pub async fn latest(
    conn: &mut PgConnection,
    room_id: i64,
    current: &Value,
) -> ApiResult<(Option<RunInfo>, Option<RunInfo>)> {
    let last: Option<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM dc_airflow_runs WHERE room_id = $1 ORDER BY id DESC LIMIT 1"
    ))
    .bind(room_id)
    .bind(Json(current))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading airflow runs", e))?;
    let done: Option<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM dc_airflow_runs
          WHERE room_id = $1 AND status = 'done' ORDER BY id DESC LIMIT 1"
    ))
    .bind(room_id)
    .bind(Json(current))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading airflow runs", e))?;
    Ok((last.map(run_info), done.map(run_info)))
}

pub async fn run(
    conn: &mut PgConnection,
    room_id: i64,
    id: i64,
    current: &Value,
) -> ApiResult<RunInfo> {
    let row: Option<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM dc_airflow_runs WHERE room_id = $1 AND id = $3"
    ))
    .bind(room_id)
    .bind(Json(current))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading an airflow run", e))?;
    row.map(run_info)
        .ok_or_else(|| ApiError::NotFound("No such airflow run.".into()))
}

/// Has the room ever had a run? Edits then start new ones on their own.
pub async fn has_runs(conn: &mut PgConnection, room_id: i64) -> ApiResult<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM dc_airflow_runs WHERE room_id = $1)")
        .bind(room_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| internal("loading airflow runs", e))
}

/// Queue a run of `input` for the room at `revision`, unless a run of the
/// same input is queued, running, or finished as a result (or as not
/// converged: the same input would not converge again). Older runs of the
/// room still waiting or running are cancelled. Returns the run and
/// whether it is new. Call inside a transaction.
pub async fn enqueue(
    tx: &mut Tx<'_>,
    room_id: i64,
    room_name: &str,
    revision: i32,
    input: &CaseInput,
    user: &User,
) -> ApiResult<(RunInfo, bool)> {
    let value = json_of(input)?;
    let same: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM dc_airflow_runs
          WHERE room_id = $1 AND input = $2::jsonb
            AND status IN ('queued', 'running', 'done', 'not_converged') AND NOT cancel_requested
          ORDER BY id DESC LIMIT 1",
    )
    .bind(room_id)
    .bind(Json(&value))
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| internal("looking for an airflow run", e))?;
    if let Some(id) = same {
        return Ok((run(tx, room_id, id, &value).await?, false));
    }
    cancel_active(tx, room_id).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO dc_airflow_runs (room_id, revision, input, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(room_id)
    .bind(revision)
    .bind(Json(&value))
    .bind(user.id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => ApiError::Conflict(
            "A run of this revision is still stopping. Try again in a minute.".into(),
        ),
        e => internal("queueing an airflow run", e),
    })?;
    audit(
        tx,
        user,
        "dc.airflow.run",
        room_name,
        format!("revision {revision}: run {id} queued"),
    )
    .await?;
    Ok((run(tx, room_id, id, &value).await?, true))
}

/// Cancel what is waiting at once; ask the worker to stop what is running.
async fn cancel_active(conn: &mut PgConnection, room_id: i64) -> ApiResult<()> {
    sqlx::query(
        "UPDATE dc_airflow_runs
            SET cancel_requested = TRUE,
                status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
                finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
          WHERE room_id = $1 AND status IN ('queued', 'running') AND NOT cancel_requested",
    )
    .bind(room_id)
    .execute(&mut *conn)
    .await
    .map_err(|e| internal("cancelling airflow runs", e))?;
    Ok(())
}

/// Cancel one run. Call inside a transaction.
pub async fn cancel(
    tx: &mut Tx<'_>,
    room_id: i64,
    room_name: &str,
    id: i64,
    user: &User,
) -> ApiResult<()> {
    let status: Option<String> = sqlx::query_scalar(
        "UPDATE dc_airflow_runs
            SET cancel_requested = TRUE,
                status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
                finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
          WHERE room_id = $1 AND id = $2 AND status IN ('queued', 'running')
         RETURNING status",
    )
    .bind(room_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| internal("cancelling an airflow run", e))?;
    if status.is_none() {
        return Err(ApiError::Conflict(
            "This run is not waiting or running.".into(),
        ));
    }
    audit(
        tx,
        user,
        "dc.airflow.cancel",
        room_name,
        format!("run {id}"),
    )
    .await
}

async fn audit(
    tx: &mut Tx<'_>,
    user: &User,
    action: &str,
    room_name: &str,
    details: String,
) -> ApiResult<()> {
    audit_tx(
        tx,
        user,
        Audit {
            action,
            target_type: "dc",
            target_id: None,
            target_name: room_name,
            details: Some(details),
        },
    )
    .await
}

/// A run's stored summary and status.
pub async fn summary(
    conn: &mut PgConnection,
    room_id: i64,
    id: i64,
) -> ApiResult<(String, Option<String>, Option<Value>)> {
    let row: Option<(String, Option<String>, Option<Value>)> = sqlx::query_as(
        "SELECT status, reason, summary FROM dc_airflow_runs WHERE room_id = $1 AND id = $2",
    )
    .bind(room_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading an airflow summary", e))?;
    row.ok_or_else(|| ApiError::NotFound("No such airflow run.".into()))
}

/// A converged run's gzipped grid or streamlines.
pub async fn blob(
    conn: &mut PgConnection,
    room_id: i64,
    id: i64,
    column: Blob,
) -> ApiResult<Vec<u8>> {
    let col = match column {
        Blob::Grid => "grid",
        Blob::Streamlines => "streamlines",
    };
    let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as(&format!(
        "SELECT status, {col} FROM dc_airflow_runs WHERE room_id = $1 AND id = $2"
    ))
    .bind(room_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading an airflow result", e))?;
    match row {
        None => Err(ApiError::NotFound("No such airflow run.".into())),
        Some((_, Some(b))) => Ok(b),
        Some(_) => Err(ApiError::Conflict(
            "This run has no result: it did not finish and converge.".into(),
        )),
    }
}

#[derive(Clone, Copy)]
pub enum Blob {
    Grid,
    Streamlines,
}
