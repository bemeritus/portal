//! Writing the change history (§5.6, §6.8).
//!
//! There is deliberately no handler that writes, edits or deletes an entry.
//! Entries are written by the operations they describe, through [`audit_tx`]
//! (inside the transaction that makes the change, so record and change commit
//! together) or [`audit_now`] (after a change that has already committed).
//! A log the platform can rewrite is not evidence of anything.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{internal, ApiResult};
use crate::models::User;

/// What to record about one change. The actor is passed separately because it
/// is the same for every entry a request writes.
pub struct Audit<'a> {
    /// `<subject>.<verb>`, e.g. `"category.delete"`.
    pub action: &'a str,
    /// `"user"` | `"category"` | `"document"` | `"upload"`.
    pub target_type: &'a str,
    /// The row the action was about. Not a foreign key — see the migration.
    pub target_id: Option<Uuid>,
    /// How that row read at the time: a username, a title, a category name.
    pub target_name: &'a str,
    /// One line of specifics ("status: draft → published"), or `None` when the
    /// action name already says everything.
    pub details: Option<String>,
}

/// Insert one entry using whichever executor the caller is already inside.
async fn insert_audit<'c, E>(
    exec: E,
    actor_id: Option<Uuid>,
    actor_name: &str,
    entry: Audit<'_>,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'c, Database = sqlx::Postgres>,
{
    sqlx::query(
        "INSERT INTO audit_log
            (actor_id, actor_name, action, target_type, target_id, target_name, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(actor_id)
    .bind(actor_name)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(entry.target_name)
    .bind(entry.details)
    .execute(exec)
    .await
    .map(|_| ())
}

/// Record a change from inside the transaction that makes it.
///
/// Failing the request on a failed insert is the right call here precisely
/// because nothing has committed yet: the alternative is a change that landed
/// with no record of who made it, which is the one outcome an audit log exists
/// to prevent.
pub async fn audit_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &User,
    entry: Audit<'_>,
) -> ApiResult<()> {
    let action = entry.action.to_string();
    insert_audit(&mut **tx, Some(actor.id), &actor.username, entry)
        .await
        .map_err(|e| internal(&format!("recording '{action}' in the audit log"), e))
}

/// Record a change that has already committed.
///
/// The mirror image of [`audit_tx`]: the write is done and the caller is about
/// to report success, so a failed insert must not turn into an error the user
/// sees — it would name a change that did in fact happen as failed. It goes to
/// the server log instead, which is the same trade the upload row makes.
pub async fn audit_now(pool: &PgPool, actor_id: Option<Uuid>, actor_name: &str, entry: Audit<'_>) {
    let action = entry.action.to_string();
    if let Err(e) = insert_audit(pool, actor_id, actor_name, entry).await {
        tracing::error!("'{action}' happened but could not be recorded in the audit log: {e}");
    }
}
