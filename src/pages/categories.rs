//! `/categories` — admin category management (§8, FR-9).

use leptos::prelude::*;
use leptos_meta::Title;

use crate::app::use_user;
use crate::components::ConfirmButton;
use crate::error::user_message;
use crate::models::Category;
use crate::server::categories::{create_category, delete_category, list_categories};

#[component]
pub fn CategoriesPage() -> impl IntoView {
    let user = use_user();
    let is_admin = move || user.get().flatten().map(|u| u.is_admin).unwrap_or(false);

    // A failed listing used to fall back to an empty list, which rendered the
    // "No categories yet — add one above" empty state. That is advice to create
    // duplicates of categories that are already there.
    let cats = Resource::new(|| (), |_| async move { list_categories().await });

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
        (Some(Err(e)), _) | (_, Some(Err(e))) => Some(user_message(&e)),
        _ => None,
    };
    // Creating a category is otherwise silent — the row just appears somewhere
    // down the table, which is easy to miss.
    let created_ok = move || matches!(create.value().get(), Some(Ok(_)));
    let busy = move || create.pending().get();
    let name_empty = move || name.get().trim().is_empty();
    let delete_pending = Signal::derive(move || delete.pending().get());

    view! {
        // Hoisted above the Suspense: leptos_meta can only write into the
        // streamed <head> before it is flushed, so a title nested inside a
        // suspended branch never makes it into the server response.
        <Title text="Categories · Knowledge Base"/>
        // The admin check has to happen *inside* the Suspense closure, reading
        // the resource there — that is what makes SSR wait for it. Checking it
        // outside renders "administrators only" first and corrects it after
        // hydration, which admins see as a flash of the wrong page.
        <Suspense fallback=|| {
            view! {
                <p class="loading-inline">
                    <span class="spinner"></span>
                    "Loading…"
                </p>
            }
        }>
        {move || user.get().map(|_| view! {
        <Show
            when=is_admin
            fallback=|| {
                view! {
                    <div class="empty">
                        <div class="empty-title">"Administrators only"</div>
                        <p style="margin:0">"Categories are managed by administrators."</p>
                    </div>
                }
            }
        >
            <h1>"Categories"</h1>

            <div class="panel" style="margin:16px 0">
                <h3 style="margin-top:0">"New category"</h3>
                <form on:submit=move |ev| {
                    ev.prevent_default();
                    if !name_empty() && !busy() {
                        create.dispatch(());
                    }
                }>
                    <div class="row">
                        <div>
                            <label for="cat-name">"Name"</label>
                            <input
                                id="cat-name"
                                type="text"
                                placeholder="e.g. Onboarding"
                                prop:value=name
                                on:input=move |ev| set_name.set(event_target_value(&ev))
                            />
                        </div>
                        <div>
                            <label for="cat-desc">"Description (optional)"</label>
                            <input
                                id="cat-desc"
                                type="text"
                                placeholder="What belongs in here?"
                                prop:value=desc
                                on:input=move |ev| set_desc.set(event_target_value(&ev))
                            />
                        </div>
                        <div class="grow-0">
                            <button
                                class="btn"
                                type="submit"
                                prop:disabled=move || busy() || name_empty()
                            >
                                {move || if busy() { "Adding…" } else { "Add" }}
                            </button>
                        </div>
                    </div>
                </form>
                {move || action_error().map(|e| view! { <p class="flash error">{e}</p> })}
                <Show when=created_ok fallback=|| ()>
                    <p class="flash ok">"Category created."</p>
                </Show>
            </div>

            <Suspense fallback=|| {
                view! {
                    <p class="loading-inline">
                        <span class="spinner"></span>
                        "Loading categories…"
                    </p>
                }
            }>
                {move || {
                    cats.get()
                        .map(|res| {
                            let list = match res {
                                Ok(list) => list,
                                Err(e) => {
                                    return view! {
                                        <p class="flash error">{user_message(&e)}</p>
                                    }
                                        .into_any();
                                }
                            };
                            if list.is_empty() {
                                view! {
                                    <div class="empty">
                                        <div class="empty-title">"No categories yet"</div>
                                        <p style="margin:0">
                                            "Add one above — documents must belong to a category."
                                        </p>
                                    </div>
                                }
                                    .into_any()
                            } else {
                                view! {
                                    <div class="table-wrap">
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
                                                {list
                                                    .into_iter()
                                                    .map(|c| category_row(c, delete, delete_pending))
                                                    .collect_view()}
                                            </tbody>
                                        </table>
                                    </div>
                                }
                                    .into_any()
                            }
                        })
                }}
            </Suspense>
        </Show>
        })}
        </Suspense>
    }
}

fn category_row(
    c: Category,
    delete: Action<uuid::Uuid, Result<(), ServerFnError>>,
    delete_pending: Signal<bool>,
) -> impl IntoView {
    let id = c.id;
    let description = c.description.unwrap_or_default();
    view! {
        <tr>
            <td>{c.name}</td>
            <td class="muted">{c.slug}</td>
            <td class="muted wrap">
                {if description.is_empty() {
                    view! { <span class="muted">"—"</span> }.into_any()
                } else {
                    description.into_any()
                }}
            </td>
            <td>
                <ConfirmButton
                    label="Delete"
                    confirm_label="Yes, delete"
                    pending=delete_pending
                    on_confirm=move || {
                        delete.dispatch(id);
                    }
                />
            </td>
        </tr>
    }
}
