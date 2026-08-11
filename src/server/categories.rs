//! Category server functions (§5.3, §7 Categories).
//!
//! Per the decided open question §12.2, categories are managed by the admin
//! only; any authenticated user with `READ` may list them (needed by filters).

use leptos::prelude::*;

use crate::models::Category;

#[cfg(feature = "ssr")]
fn db_err(e: sqlx::Error, unique_msg: &str) -> ServerFnError {
    if let sqlx::Error::Database(ref dbe) = e {
        if dbe.is_unique_violation() {
            return ServerFnError::new(unique_msg.to_string());
        }
    }
    ServerFnError::new(e.to_string())
}

/// FR-9: create a category.
#[server]
pub async fn create_category(name: String, description: String) -> Result<Category, ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;

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

    let category = sqlx::query_as::<_, Category>(
        "INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3)
         RETURNING id, name, slug, description, created_at",
    )
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .fetch_one(&backend::pool())
    .await
    .map_err(|e| db_err(e, "A category with that name already exists"))?;

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
    backend::require_admin().await?;

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

    sqlx::query("UPDATE categories SET name = $2, slug = $3, description = $4 WHERE id = $1")
        .bind(id)
        .bind(&name)
        .bind(&slug)
        .bind(&description)
        .execute(&backend::pool())
        .await
        .map_err(|e| db_err(e, "A category with that name already exists"))?;
    Ok(())
}

/// FR-9: delete a category. Fails if documents still reference it (the FK is
/// `ON DELETE RESTRICT`).
#[server]
pub async fn delete_category(id: uuid::Uuid) -> Result<(), ServerFnError> {
    use crate::backend;
    backend::require_admin().await?;
    sqlx::query("DELETE FROM categories WHERE id = $1")
        .bind(id)
        .execute(&backend::pool())
        .await
        .map_err(|_| ServerFnError::new("Cannot delete a category that still has documents"))?;
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
async fn fetch_categories(
    all: bool,
    ids: &[uuid::Uuid],
) -> Result<Vec<Category>, ServerFnError> {
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
    .await?;
    Ok(cats)
}
