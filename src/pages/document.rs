//! `/docs/:id` — single document, Q&A blocks in sequence (§8, FR-21).

use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_params_map};

use crate::app::use_user;
use crate::models::DocumentWithBlocks;
use crate::server::documents::{delete_document, get_document};

#[component]
pub fn DocumentPage() -> impl IntoView {
    let params = use_params_map();
    let user = use_user();
    let navigate = use_navigate();

    let doc = Resource::new(
        move || {
            params
                .read()
                .get("id")
                .map(|s| s.to_string())
                .unwrap_or_default()
        },
        |id_str| async move {
            let id = uuid::Uuid::parse_str(&id_str)
                .map_err(|_| ServerFnError::new("Invalid document id"))?;
            get_document(id).await
        },
    );

    let delete_action = Action::new(|id: &uuid::Uuid| {
        let id = *id;
        async move { delete_document(id).await }
    });

    Effect::new(move |_| {
        if matches!(delete_action.value().get(), Some(Ok(()))) {
            navigate("/", Default::default());
        }
    });

    view! {
        <Suspense fallback=|| view! { <p class="muted">"Loading…"</p> }>
            {move || {
                doc.get()
                    .map(|res| match res {
                        Err(e) => view! { <p class="error">{e.to_string()}</p> }.into_any(),
                        Ok(d) => {
                            let can_edit = user
                                .get()
                                .flatten()
                                .map(|u| u.is_admin || u.can_edit || u.id == d.author_id)
                                .unwrap_or(false);
                            let can_delete = user
                                .get()
                                .flatten()
                                .map(|u| u.is_admin || u.can_delete || u.id == d.author_id)
                                .unwrap_or(false);
                            render_document(d, can_edit, can_delete, delete_action).into_any()
                        }
                    })
            }}
        </Suspense>
    }
}

fn render_document(
    d: DocumentWithBlocks,
    can_edit: bool,
    can_delete: bool,
    delete_action: Action<uuid::Uuid, Result<(), ServerFnError>>,
) -> impl IntoView {
    let id = d.id;
    let edit_href = format!("/docs/{}/edit", id);
    let date = d.created_at.format("%Y-%m-%d").to_string();
    let status_class = if d.status == "published" {
        "badge published"
    } else {
        "badge draft"
    };

    view! {
        <div class="doc-header" style="display:flex;align-items:flex-start;gap:12px">
            <div style="flex:1">
                <h1>{d.title}</h1>
                <div class="meta">
                    <span class="badge">{d.category_name}</span>
                    " · by " {d.author_username} " · " {date} " · "
                    <span class=status_class>{d.status}</span>
                </div>
            </div>
            {can_edit.then(|| view! { <a class="btn secondary small" href=edit_href>"Edit"</a> })}
            {can_delete
                .then(|| {
                    view! {
                        <button
                            class="btn danger small"
                            on:click=move |_| {
                                delete_action.dispatch(id);
                            }
                        >
                            "Delete"
                        </button>
                    }
                })}
        </div>

        <div>
            {d
                .blocks
                .into_iter()
                .map(|b| {
                    view! {
                        <div class="qa">
                            <div class="q">{b.question}</div>
                            <div class="a" inner_html=b.answer_html></div>
                        </div>
                    }
                })
                .collect_view()}
        </div>
    }
}
