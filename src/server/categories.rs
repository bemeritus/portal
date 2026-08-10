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

/// List all categories (used by filters and the editor).
#[server]
pub async fn list_categories() -> Result<Vec<Category>, ServerFnError> {
    use crate::backend;
    backend::require_user().await?;
    let cats = sqlx::query_as::<_, Category>(
        "SELECT id, name, slug, description, created_at FROM categories ORDER BY name",
    )
    .fetch_all(&backend::pool())
    .await?;
    Ok(cats)
}
