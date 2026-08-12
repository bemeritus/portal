//! Reading the change history (§7 Admin).
//!
//! There is deliberately no server function that writes here: entries are
//! written by the operations they describe, through [`crate::backend::audit_tx`]
//! / [`crate::backend::audit_now`]. Nothing edits or deletes an entry either —
//! a log the platform can rewrite is not evidence of anything.

use leptos::prelude::*;

use crate::models::AuditEntry;

/// The newest entries first, optionally narrowed to one kind of target and/or a
/// search over the actor, target and details text.
///
/// Admin only: the log names who did what, which is exactly the shape of thing
/// a non-admin should not be able to read about accounts they cannot see.
#[server]
pub async fn list_audit_log(
    target_type: Option<String>,
    search: Option<String>,
    limit: i64,
) -> Result<Vec<AuditEntry>, ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;

    // The client sends the limit, so it decides how much of the table it can
    // pull in one request — clamped, because "everything" over a log that only
    // grows is a query that gets slower every day.
    let limit = limit.clamp(1, 500);
    let target_type = target_type.filter(|t| !t.trim().is_empty());
    let search = search
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let entries = sqlx::query_as::<_, AuditEntry>(
        "SELECT id, at, actor_name, action, target_type, target_id, target_name, details
         FROM audit_log
         WHERE ($1::text IS NULL OR target_type = $1)
           AND ($2::text IS NULL
                OR actor_name ILIKE '%' || $2 || '%'
                OR target_name ILIKE '%' || $2 || '%'
                OR action ILIKE '%' || $2 || '%'
                OR coalesce(details, '') ILIKE '%' || $2 || '%')
         ORDER BY at DESC
         LIMIT $3",
    )
    .bind(target_type)
    .bind(search)
    .bind(limit)
    .fetch_all(&backend::pool())
    .await
    .map_err(|e| backend::internal("listing the audit log", e))?;

    Ok(entries)
}
