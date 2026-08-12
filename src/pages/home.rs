//! `/` — document list with title + category filters (§8, FR-17..FR-20).

use leptos::prelude::*;
use leptos_meta::Title;

use crate::app::use_user;
use crate::error::user_message;
use crate::models::{DocumentSummary, Permission};
use crate::server::categories::list_categories;
use crate::server::documents::list_documents;

/// Handle of the pending debounce timer. There is no `setTimeout` off the
/// browser, and event handlers never run during SSR, so on the server the slot
/// is a handle that can never exist.
#[cfg(feature = "hydrate")]
type Timer = Option<TimeoutHandle>;
#[cfg(not(feature = "hydrate"))]
type Timer = Option<std::convert::Infallible>;

/// Publish `value` to the filter signal once typing pauses, cancelling any
/// still-pending publish. Without this every keystroke fires its own query.
#[cfg(feature = "hydrate")]
fn debounce(timer: StoredValue<Timer>, set: WriteSignal<String>, value: String) {
    timer.update_value(|handle| {
        if let Some(handle) = handle.take() {
            handle.clear();
        }
    });
    if let Ok(handle) = set_timeout_with_handle(
        move || set.set(value),
        std::time::Duration::from_millis(250),
    ) {
        timer.set_value(Some(handle));
    }
}

#[cfg(not(feature = "hydrate"))]
fn debounce(_timer: StoredValue<Timer>, set: WriteSignal<String>, value: String) {
    set.set(value);
}

#[component]
pub fn HomePage() -> impl IntoView {
    let user = use_user();
    // `typed` mirrors the box as you type; `title` is the debounced value the
    // query actually runs on.
    let (typed, set_typed) = signal(String::new());
    let (title, set_title) = signal(String::new());
    let (cat, set_cat) = signal(String::new()); // "" = all, else category uuid
    let timer: StoredValue<Timer> = StoredValue::new(Default::default());

    // Kept as a `Result`: a failed lookup and a user with no categories both
    // produce an empty dropdown, and only one of them is worth saying anything
    // about.
    let categories = Resource::new(|| (), |_| async move { list_categories().await });
    let categories_error = move || match categories.get() {
        Some(Err(e)) => Some(user_message(&e)),
        _ => None,
    };

    // Re-runs whenever either filter changes (FR-20: filters combine).
    let docs = Resource::new(
        move || (title.get(), cat.get()),
        |(t, c)| async move {
            let title_filter = if t.trim().is_empty() { None } else { Some(t) };
            let category_filter = uuid::Uuid::parse_str(&c).ok();
            list_documents(title_filter, category_filter).await
        },
    );

    // Writing anywhere at all — globally or in a single granted category — is
    // enough to offer the "New document" button.
    let can_write = move || {
        user.get()
            .flatten()
            .map(|u| u.has_anywhere(Permission::Write))
            .unwrap_or(false)
    };

    let filtered = move || !typed.get().trim().is_empty() || !cat.get().is_empty();
    let clear_filters = move || {
        set_typed.set(String::new());
        set_title.set(String::new());
        set_cat.set(String::new());
    };

    view! {
        <Title text="Documents · Knowledge Base"/>
        <div class="doc-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <h1 style="flex:1;min-width:0">"Documents"</h1>
            <Show when=can_write fallback=|| ()>
                <a class="btn" href="/docs/new">"+ New document"</a>
            </Show>
        </div>

        <div class="panel" style="margin:16px 0">
            <div class="row">
                <div>
                    <label for="q">"Search by title"</label>
                    <input
                        id="q"
                        type="search"
                        placeholder="Type to filter…"
                        prop:value=typed
                        on:input=move |ev| {
                            let value = event_target_value(&ev);
                            set_typed.set(value.clone());
                            debounce(timer, set_title, value);
                        }
                    />
                </div>
                <div>
                    <label for="c">"Category"</label>
                    <select
                        id="c"
                        on:change=move |ev| set_cat.set(event_target_value(&ev))
                        prop:value=cat
                    >
                        <option value="">"All categories"</option>
                        <Suspense fallback=|| ()>
                            {move || {
                                categories
                                    .get()
                                    .and_then(Result::ok)
                                    .map(|cats| {
                                        cats.into_iter()
                                            .map(|c| {
                                                view! {
                                                    <option value=c.id.to_string()>{c.name}</option>
                                                }
                                            })
                                            .collect_view()
                                    })
                            }}
                        </Suspense>
                    </select>
                    {move || {
                        categories_error()
                            .map(|e| view! { <p class="flash error">{e}</p> })
                    }}
                </div>
                <Show when=filtered fallback=|| ()>
                    <div class="grow-0">
                        <button
                            type="button"
                            class="btn secondary"
                            on:click=move |_| clear_filters()
                        >
                            "Clear filters"
                        </button>
                    </div>
                </Show>
            </div>
        </div>

        <Suspense fallback=|| {
            view! {
                <div class="skeleton"></div>
                <div class="skeleton"></div>
                <div class="skeleton"></div>
            }
        }>
            {move || {
                docs.get()
                    .map(|res| match res {
                        Err(e) => view! { <p class="flash error">{user_message(&e)}</p> }.into_any(),
                        Ok(list) if list.is_empty() => {
                            let filtered_now = filtered();
                            view! {
                                <div class="empty">
                                    <div class="empty-title">
                                        {if filtered_now {
                                            "No documents match your filters"
                                        } else {
                                            "No documents yet"
                                        }}
                                    </div>
                                    <p style="margin:0 0 12px">
                                        {if filtered_now {
                                            "Try a shorter search term, or a different category."
                                        } else {
                                            "Documents you are allowed to read will show up here."
                                        }}
                                    </p>
                                    <Show when=move || filtered_now fallback=|| ()>
                                        <button
                                            type="button"
                                            class="btn secondary"
                                            on:click=move |_| clear_filters()
                                        >
                                            "Clear filters"
                                        </button>
                                    </Show>
                                </div>
                            }
                                .into_any()
                        }
                        Ok(list) => {
                            let count = list.len();
                            view! {
                                <div
                                    class="loading-inline"
                                    aria-live="polite"
                                    style="margin-bottom:10px"
                                >
                                    {if count == 1 {
                                        "1 document".to_string()
                                    } else {
                                        format!("{count} documents")
                                    }}
                                    // While the debounce is still holding a
                                    // keystroke the list below is stale — say so
                                    // rather than showing it as if it were final.
                                    <Show
                                        when=move || typed.get().trim() != title.get().trim()
                                        fallback=|| ()
                                    >
                                        <span class="spinner"></span>
                                    </Show>
                                </div>
                                {list.into_iter().map(document_card).collect_view()}
                            }
                                .into_any()
                        }
                    })
            }}
        </Suspense>
    }
}

fn document_card(d: DocumentSummary) -> impl IntoView {
    let href = format!("/docs/{}", d.id);
    let date = d.created_at.format("%Y-%m-%d").to_string();
    let status_class = if d.status == "published" {
        "badge published"
    } else {
        "badge draft"
    };
    view! {
        <a class="card" href=href>
            <h3>{d.title}</h3>
            <div class="meta">
                <span class="badge">{d.category_name}</span>
                <span>{d.author_username}</span>
                <span aria-hidden="true">"·"</span>
                <span>{date}</span>
                <span class=status_class>{d.status}</span>
            </div>
        </a>
    }
}
