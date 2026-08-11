//! `/docs/:id` — single document, Q&A blocks in sequence (§8, FR-21).

use leptos::prelude::*;
use leptos_meta::Title;
use leptos_router::hooks::{use_navigate, use_params_map};

use crate::app::use_user;
use crate::components::ConfirmButton;
use crate::models::{DocumentWithBlocks, Permission};
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

    let delete_error = move || match delete_action.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };

    view! {
        <Suspense fallback=|| {
            view! {
                <p class="loading-inline">
                    <span class="spinner"></span>
                    "Loading document…"
                </p>
            }
        }>
            {move || {
                doc.get()
                    .map(|res| match res {
                        Err(e) => {
                            view! {
                                <a class="backlink" href="/">"← All documents"</a>
                                <p class="flash error">{e.to_string()}</p>
                            }
                                .into_any()
                        }
                        Ok(d) => {
                            // Mirrors the server exactly: the category decides,
                            // authorship grants nothing extra.
                            let can_edit = user
                                .get()
                                .flatten()
                                .map(|u| u.has_in(d.category_id, Permission::Edit))
                                .unwrap_or(false);
                            let can_delete = user
                                .get()
                                .flatten()
                                .map(|u| u.has_in(d.category_id, Permission::Delete))
                                .unwrap_or(false);
                            render_document(d, can_edit, can_delete, delete_action).into_any()
                        }
                    })
            }}
            {move || delete_error().map(|e| view! { <p class="flash error">{e}</p> })}
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
    let pending = Signal::derive(move || delete_action.pending().get());

    // A long document is hard to skim; anything past a couple of questions gets
    // a collapsible jump list.
    let show_toc = d.blocks.len() > 2;
    let toc: Vec<(String, String)> = d
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (format!("#q{}", i + 1), b.question.clone()))
        .collect();

    view! {
        <Title text=format!("{} · Knowledge Base", d.title)/>
        <a class="backlink" href="/">"← All documents"</a>
        <div class="doc-header" style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:240px">
                <h1>{d.title}</h1>
                <div class="meta">
                    <span class="badge">{d.category_name}</span>
                    <span>{d.author_username}</span>
                    <span aria-hidden="true">"·"</span>
                    <span>{date}</span>
                    <span class=status_class>{d.status}</span>
                </div>
            </div>
            <div class="actions">
                {can_edit
                    .then(|| view! { <a class="btn secondary small" href=edit_href>"Edit"</a> })}
                {can_delete
                    .then(|| {
                        view! {
                            <ConfirmButton
                                label="Delete"
                                confirm_label="Yes, delete"
                                pending=pending
                                on_confirm=move || {
                                    delete_action.dispatch(id);
                                }
                            />
                        }
                    })}
            </div>
        </div>

        <Show when=move || show_toc fallback=|| ()>
            <details class="toc" open>
                <summary>{format!("{} questions in this document", toc.len())}</summary>
                <ol>
                    {toc
                        .iter()
                        .map(|(href, q)| {
                            view! {
                                <li>
                                    <a href=href.clone()>{q.clone()}</a>
                                </li>
                            }
                        })
                        .collect_view()}
                </ol>
            </details>
        </Show>

        <div>
            {d
                .blocks
                .into_iter()
                .enumerate()
                .map(|(i, b)| {
                    let n = i + 1;
                    view! {
                        <div class="qa" id=format!("q{n}")>
                            <div class="q">
                                <span class="qnum">{format!("{n}.")}</span>
                                {b.question}
                            </div>
                            <div class="a" inner_html=b.answer_html></div>
                        </div>
                    }
                })
                .collect_view()}
        </div>
    }
}
