//! Category server functions (§5.3, §7 Categories).
//!
//! Per the decided open question §12.2, categories are managed by the admin
//! only; any authenticated user with `READ` may list them (needed by filters).

use leptos::prelude::*;

use crate::models::Category;

/// FR-9: create a category.
#[server]
pub async fn create_category(name: String, description: String) -> Result<Category, ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;

    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(ServerFnError::new("Category name is required"));
    }
    let slug = backend::slugify(&name);
    let description = {
        let d = description.trim();
        if d.is_empty() {
            None
        } else {
            Some(d.to_string())
        }
    };

    let pool = backend::pool();
    let category = sqlx::query_as::<_, Category>(
        "INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3)
         RETURNING id, name, slug, description, created_at",
    )
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        backend::db_conflict(
            "creating a category",
            e,
            "A category with that name already exists",
        )
    })?;

    backend::audit_now(
        &pool,
        Some(admin.id),
        &admin.username,
        backend::Audit {
            action: "category.create",
            target_type: "category",
            target_id: Some(category.id),
            target_name: &category.name,
            details: category.description.clone(),
        },
    )
    .await;

    Ok(category)
}

/// FR-9: rename / re-describe a category.
#[server]
pub async fn update_category(
    id: uuid::Uuid,
    name: String,
    description: String,
) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;

    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(ServerFnError::new("Category name is required"));
    }
    let slug = backend::slugify(&name);
    let description = {
        let d = description.trim();
        if d.is_empty() {
            None
        } else {
            Some(d.to_string())
        }
    };

    let pool = backend::pool();
    // The CTE carries the pre-edit row out of the same statement that
    // overwrites it, so the log can say what the name changed *from* without a
    // second read that another admin could slip an edit into.
    let previous: Option<(String, Option<String>)> = sqlx::query_as(
        "WITH before AS (SELECT id, name, description FROM categories WHERE id = $1)
         UPDATE categories SET name = $2, slug = $3, description = $4
         FROM before WHERE categories.id = before.id
         RETURNING before.name, before.description",
    )
    .bind(id)
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .fetch_optional(&pool)
    .await
    .map_err(|e| {
        backend::db_conflict(
            "updating a category",
            e,
            "A category with that name already exists",
        )
    })?;
    // Zero rows means it was deleted meanwhile. Reporting success would leave
    // the admin looking at edits that went nowhere.
    let (old_name, old_description) =
        previous.ok_or_else(|| ServerFnError::new("That category no longer exists"))?;

    let mut changes = Vec::new();
    if old_name != name {
        changes.push(format!("renamed from \"{old_name}\""));
    }
    if old_description != description {
        changes.push("description changed".to_string());
    }
    backend::audit_now(
        &pool,
        Some(admin.id),
        &admin.username,
        backend::Audit {
            action: "category.update",
            target_type: "category",
            target_id: Some(id),
            target_name: &name,
            details: (!changes.is_empty()).then(|| changes.join("; ")),
        },
    )
    .await;
    Ok(())
}

/// FR-9: delete a category. Fails if documents still reference it (the FK is
/// `ON DELETE RESTRICT`).
#[server]
pub async fn delete_category(id: uuid::Uuid) -> Result<(), ServerFnError> {
    use crate::backend;
    let admin = backend::require_admin().await?;
    let pool = backend::pool();
    // Only the FK violation means "still has documents". Mapping *every* error
    // to that sentence told admins to go delete documents when the real cause
    // was, say, an unreachable database.
    let deleted: Option<String> =
        sqlx::query_scalar("DELETE FROM categories WHERE id = $1 RETURNING name")
            .bind(id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| {
                backend::db_reference(
                    "deleting a category",
                    e,
                    "Cannot delete a category that still has documents",
                )
            })?;
    let name = deleted.ok_or_else(|| ServerFnError::new("That category no longer exists"))?;

    // The category is gone, so this entry is now the only place its name is
    // written down — which is exactly why `target_id` carries no foreign key.
    backend::audit_now(
        &pool,
        Some(admin.id),
        &admin.username,
        backend::Audit {
            action: "category.delete",
            target_type: "category",
            target_id: Some(id),
            target_name: &name,
            details: None,
        },
    )
    .await;
    Ok(())
}

/// List the categories the caller can see: everything for an admin or for
/// anyone holding a global flag, otherwise only the categories they have been
/// granted something on. Used by the admin screens and the home filter.
#[server]
pub async fn list_categories() -> Result<Vec<Category>, ServerFnError> {
    use crate::backend;
    let user = backend::require_user().await?;

    // Only admins see every category. Everyone else sees exactly the ones
    // they hold a grant on.
    let sees_all = user.is_admin;
    let visible = user.accessible_categories();

    fetch_categories(sees_all, &visible).await
}

/// List the categories the caller may author or edit documents in — what the
/// editor's category picker should offer.
#[server]
pub async fn list_writable_categories() -> Result<Vec<Category>, ServerFnError> {
    use crate::backend;
    use crate::models::Permission;
    let user = backend::require_user().await?;

    let sees_all = user.is_admin;
    let mut writable = user.granted_categories(Permission::Write);
    for id in user.granted_categories(Permission::Edit) {
        if !writable.contains(&id) {
            writable.push(id);
        }
    }

    fetch_categories(sees_all, &writable).await
}

/// Shared tail of the two listings above.
#[cfg(feature = "ssr")]
async fn fetch_categories(all: bool, ids: &[uuid::Uuid]) -> Result<Vec<Category>, ServerFnError> {
    use crate::backend;
    let cats = sqlx::query_as::<_, Category>(
        "SELECT id, name, slug, description, created_at
         FROM categories
         WHERE $1::bool OR id = ANY($2::uuid[])
         ORDER BY name",
    )
    .bind(all)
    .bind(ids)
    .fetch_all(&backend::pool())
    .await
    .map_err(|e| backend::internal("listing categories", e))?;
    Ok(cats)
}
