//! The worker's side of `dc_airflow_runs` (migration 0030): claim a queued
//! run, report progress (and learn about a cancel), store the outcome. The
//! database is the only link with the API.

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;

/// A run whose worker has not reported for this long is taken over.
pub const STALE_SECS: i64 = 300;

pub struct Claimed {
    pub id: i64,
    pub input: Value,
}

/// Say the worker is alive: without a recent one, the UI says the
/// calculation is unavailable.
pub async fn heartbeat(pool: &PgPool, name: &str, image: &str, processes: i32) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO dc_airflow_workers (name, image, processes, seen_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (name) DO UPDATE SET image = $2, processes = $3, seen_at = now()",
    )
    .bind(name)
    .bind(image)
    .bind(processes)
    .execute(pool)
    .await?;
    Ok(())
}

/// The oldest queued run, or one whose worker went silent, now ours.
/// Stale runs with a cancel request are closed as cancelled instead.
pub async fn claim(pool: &PgPool, worker: &str) -> sqlx::Result<Option<Claimed>> {
    sqlx::query(
        "UPDATE dc_airflow_runs SET status = 'cancelled', finished_at = now()
         WHERE status = 'running' AND cancel_requested
           AND heartbeat_at < now() - make_interval(secs => $1)",
    )
    .bind(STALE_SECS as f64)
    .execute(pool)
    .await?;
    let row: Option<(i64, Value)> = sqlx::query_as(
        "UPDATE dc_airflow_runs r
            SET status = 'running', worker = $1, started_at = now(), heartbeat_at = now(),
                progress = NULL
          WHERE r.id = (
                SELECT id FROM dc_airflow_runs
                 WHERE NOT cancel_requested
                   AND (status = 'queued'
                        OR (status = 'running' AND heartbeat_at < now() - make_interval(secs => $2)))
                 ORDER BY created_at, id
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED)
         RETURNING r.id, r.input",
    )
    .bind(worker)
    .bind(STALE_SECS as f64)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, input)| Claimed { id, input }))
}

/// Store progress; `false` when the run was cancelled or taken away.
pub async fn progress(
    pool: &PgPool,
    id: i64,
    worker: &str,
    progress: &Value,
) -> sqlx::Result<bool> {
    let cancel: Option<bool> = sqlx::query_scalar(
        "UPDATE dc_airflow_runs SET progress = $3, heartbeat_at = now()
          WHERE id = $1 AND status = 'running' AND worker = $2
         RETURNING cancel_requested",
    )
    .bind(id)
    .bind(worker)
    .bind(Json(progress))
    .fetch_optional(pool)
    .await?;
    Ok(cancel == Some(false))
}

pub struct Finish<'a> {
    pub status: &'a str,
    pub reason: Option<&'a str>,
    pub detail: Option<&'a str>,
    pub summary: Option<Value>,
    pub grid: Option<Vec<u8>>,
    pub streamlines: Option<Vec<u8>>,
}

pub async fn finish(pool: &PgPool, id: i64, worker: &str, f: Finish<'_>) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE dc_airflow_runs
            SET status = $3, reason = $4, detail = $5, summary = $6, grid = $7, streamlines = $8,
                finished_at = now(), heartbeat_at = now()
          WHERE id = $1 AND worker = $2 AND status = 'running'",
    )
    .bind(id)
    .bind(worker)
    .bind(f.status)
    .bind(f.reason)
    .bind(f.detail)
    .bind(f.summary.map(Json))
    .bind(f.grid)
    .bind(f.streamlines)
    .execute(pool)
    .await?;
    Ok(())
}
