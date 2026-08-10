//! `/categories` — admin category management (§8, FR-9).

use leptos::prelude::*;

use crate::app::use_user;
use crate::models::Category;
use crate::server::categories::{create_category, delete_category, list_categories};

#[component]
pub fn CategoriesPage() -> impl IntoView {
    let user = use_user();
    let is_admin = move || user.get().flatten().map(|u| u.is_admin).unwrap_or(false);

    let cats = Resource::new(
        || (),
        |_| async move { list_categories().await.unwrap_or_default() },
    );

    let (name, set_name) = signal(String::new());
    let (desc, set_desc) = signal(String::new());

    let create = Action::new(move |_: &()| {
        let (n, d) = (name.get_untracked(), desc.get_untracked());
        async move { create_category(n, d).await }
    });
    let delete = Action::new(|id: &uuid::Uuid| {
        let id = *id;
        async move { delete_category(id).await }
    });

    // Refresh the list and clear the form after a successful create/delete.
    Effect::new(move |_| {
        if matches!(create.value().get(), Some(Ok(_))) {
            set_name.set(String::new());
            set_desc.set(String::new());
            cats.refetch();
        }
    });
    Effect::new(move |_| {
        if matches!(delete.value().get(), Some(Ok(()))) {
            cats.refetch();
        }
    });

    let action_error = move || match (create.value().get(), delete.value().get()) {
        (Some(Err(e)), _) | (_, Some(Err(e))) => Some(e.to_string()),
        _ => None,
    };

    view! {
        <Show
            when=is_admin
            fallback=|| view! { <p class="muted">"Categories are managed by administrators."</p> }
        >
            <h1>"Categories"</h1>

            <div class="panel" style="margin:16px 0">
                <h3>"New category"</h3>
                <form on:submit=move |ev| {
                    ev.prevent_default();
                    create.dispatch(());
                }>
                    <div class="row">
                        <div>
                            <label>"Name"</label>
                            <input
                                type="text"
                                prop:value=name
                                on:input=move |ev| set_name.set(event_target_value(&ev))
                            />
                        </div>
                        <div>
                            <label>"Description (optional)"</label>
                            <input
                                type="text"
                                prop:value=desc
                                on:input=move |ev| set_desc.set(event_target_value(&ev))
                            />
                        </div>
                        <div class="grow-0">
                            <button class="btn" type="submit">"Add"</button>
                        </div>
                    </div>
                </form>
                {move || action_error().map(|e| view! { <p class="error">{e}</p> })}
            </div>

            <Suspense fallback=|| view! { <p class="muted">"Loading…"</p> }>
                {move || {
                    cats.get()
                        .map(|list| {
                            if list.is_empty() {
                                view! { <p class="muted">"No categories yet."</p> }.into_any()
                            } else {
                                view! {
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>"Name"</th>
                                                <th>"Slug"</th>
                                                <th>"Description"</th>
                                                <th></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {list.into_iter().map(|c| category_row(c, delete)).collect_view()}
                                        </tbody>
                                    </table>
                                }
                                    .into_any()
                            }
                        })
                }}
            </Suspense>
        </Show>
    }
}

fn category_row(
    c: Category,
    delete: Action<uuid::Uuid, Result<(), ServerFnError>>,
) -> impl IntoView {
    let id = c.id;
    view! {
        <tr>
            <td>{c.name}</td>
            <td class="muted">{c.slug}</td>
            <td class="muted">{c.description.unwrap_or_default()}</td>
            <td>
                <button
                    class="btn small danger"
                    on:click=move |_| {
                        delete.dispatch(id);
                    }
                >
                    "Delete"
                </button>
            </td>
        </tr>
    }
}
