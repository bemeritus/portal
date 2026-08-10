//! `/` — document list with title + category filters (§8, FR-17..FR-20).

use leptos::prelude::*;

use crate::app::use_user;
use crate::models::DocumentSummary;
use crate::server::categories::list_categories;
use crate::server::documents::list_documents;

#[component]
pub fn HomePage() -> impl IntoView {
    let user = use_user();
    let (title, set_title) = signal(String::new());
    let (cat, set_cat) = signal(String::new()); // "" = all, else category uuid

    let categories = Resource::new(
        || (),
        |_| async move { list_categories().await.unwrap_or_default() },
    );

    // Re-runs whenever either filter changes (FR-20: filters combine).
    let docs = Resource::new(
        move || (title.get(), cat.get()),
        |(t, c)| async move {
            let title_filter = if t.trim().is_empty() { None } else { Some(t) };
            let category_filter = uuid::Uuid::parse_str(&c).ok();
            list_documents(title_filter, category_filter).await
        },
    );

    let can_write = move || {
        user.get()
            .flatten()
            .map(|u| u.is_admin || u.can_write)
            .unwrap_or(false)
    };

    view! {
        <div class="doc-header" style="display:flex;align-items:center;gap:12px">
            <h1 style="flex:1">"Documents"</h1>
            <Show when=can_write fallback=|| ()>
                <a class="btn" href="/docs/new">"New document"</a>
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
                        prop:value=title
                        on:input=move |ev| set_title.set(event_target_value(&ev))
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
                </div>
            </div>
        </div>

        <Suspense fallback=|| view! { <p class="muted">"Loading…"</p> }>
            {move || {
                docs.get()
                    .map(|res| match res {
                        Err(e) => view! { <p class="error">{e.to_string()}</p> }.into_any(),
                        Ok(list) if list.is_empty() => {
                            view! { <p class="muted">"No documents match your filters."</p> }
                                .into_any()
                        }
                        Ok(list) => {
                            list.into_iter().map(document_card).collect_view().into_any()
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
                " · by " {d.author_username} " · " {date} " · "
                <span class=status_class>{d.status}</span>
            </div>
        </a>
    }
}
