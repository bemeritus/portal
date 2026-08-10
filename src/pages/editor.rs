//! `/docs/new` and `/docs/:id/edit` — the document editor (§8, FR-11..FR-16).
//!
//! Both routes share [`EditorForm`]. Q&A blocks are an editable, reorderable
//! list; on save they are serialized to JSON and sent to the server.

use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_params_map};

use crate::models::{DocumentDraft, QaBlockInput};
use crate::server::categories::list_categories;
use crate::server::documents::{create_document, get_document_draft, update_document};

/// Grow a textarea to fit its content: collapse to `auto` so `scroll_height`
/// reflects the text, then pin the height to that. Keeps the answer box in step
/// with the Markdown as it's typed (and when an existing doc is loaded).
#[cfg(feature = "hydrate")]
fn autosize(el: &web_sys::HtmlTextAreaElement) {
    let style = web_sys::HtmlElement::style(el);
    let _ = style.set_property("height", "auto");
    let _ = style.set_property("height", &format!("{}px", el.scroll_height()));
}

/// `/docs/new`
#[component]
pub fn NewDocumentPage() -> impl IntoView {
    view! { <EditorForm initial=None/> }
}

/// `/docs/:id/edit`
#[component]
pub fn EditDocumentPage() -> impl IntoView {
    let params = use_params_map();
    let draft = Resource::new(
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
            get_document_draft(id).await
        },
    );

    view! {
        <Suspense fallback=|| view! { <p class="muted">"Loading…"</p> }>
            {move || {
                draft
                    .get()
                    .map(|res| match res {
                        Err(e) => view! { <p class="error">{e.to_string()}</p> }.into_any(),
                        Ok(d) => view! { <EditorForm initial=Some(d)/> }.into_any(),
                    })
            }}
        </Suspense>
    }
}

/// One editable Q&A row, keyed by a stable client-side id.
#[derive(Clone, Copy)]
struct BlockRow {
    id: usize,
    question: RwSignal<String>,
    answer: RwSignal<String>,
}

#[component]
fn EditorForm(initial: Option<DocumentDraft>) -> impl IntoView {
    let navigate = use_navigate();
    let is_edit = initial.is_some();
    let doc_id: Option<uuid::Uuid> = initial.as_ref().map(|d| d.id);

    let (title, set_title) = signal(
        initial
            .as_ref()
            .map(|d| d.title.clone())
            .unwrap_or_default(),
    );
    let (status, set_status) = signal(
        initial
            .as_ref()
            .map(|d| d.status.clone())
            .unwrap_or_else(|| "draft".into()),
    );
    let (cat, set_cat) = signal(
        initial
            .as_ref()
            .map(|d| d.category_id.to_string())
            .unwrap_or_default(),
    );

    // Seed the block list from the draft (or one empty block for a new doc).
    let seed = initial
        .as_ref()
        .map(|d| d.blocks.clone())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| vec![QaBlockInput::default()]);
    let next_id = RwSignal::new(seed.len());
    let blocks = RwSignal::new(
        seed.into_iter()
            .enumerate()
            .map(|(i, b)| BlockRow {
                id: i,
                question: RwSignal::new(b.question),
                answer: RwSignal::new(b.answer),
            })
            .collect::<Vec<_>>(),
    );

    let add_block = move || {
        let id = next_id.get_untracked();
        next_id.set(id + 1);
        blocks.update(|v| {
            v.push(BlockRow {
                id,
                question: RwSignal::new(String::new()),
                answer: RwSignal::new(String::new()),
            })
        });
    };

    let categories = Resource::new(
        || (),
        |_| async move { list_categories().await.unwrap_or_default() },
    );

    let save = Action::new(move |_: &()| {
        let title_v = title.get_untracked().trim().to_string();
        let cat_v = cat.get_untracked();
        let status_v = status.get_untracked();
        let blocks_v: Vec<QaBlockInput> = blocks
            .get_untracked()
            .iter()
            .map(|b| QaBlockInput {
                question: b.question.get_untracked(),
                answer: b.answer.get_untracked(),
            })
            .collect();
        let json = serde_json::to_string(&blocks_v).unwrap_or_default();
        async move {
            if title_v.is_empty() {
                return Err(ServerFnError::new("Title is required"));
            }
            let category_id = uuid::Uuid::parse_str(&cat_v)
                .map_err(|_| ServerFnError::new("Please choose a category"))?;
            match doc_id {
                Some(id) => {
                    update_document(id, title_v, category_id, status_v, json).await?;
                    Ok(id)
                }
                None => create_document(title_v, category_id, status_v, json).await,
            }
        }
    });

    // On success, go to the document view.
    Effect::new(move |_| {
        if let Some(Ok(id)) = save.value().get() {
            navigate(&format!("/docs/{id}"), Default::default());
        }
    });

    let error = move || match save.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };

    let heading = if is_edit {
        "Edit document"
    } else {
        "New document"
    };

    view! {
        <h1>{heading}</h1>
        <form on:submit=move |ev| {
            ev.prevent_default();
            save.dispatch(());
        }>
            <div class="panel">
                <label for="title">"Title"</label>
                <input
                    id="title"
                    type="text"
                    prop:value=title
                    on:input=move |ev| set_title.set(event_target_value(&ev))
                />
                <div class="row">
                    <div>
                        <label for="cat">"Category"</label>
                        <select
                            id="cat"
                            prop:value=cat
                            on:change=move |ev| set_cat.set(event_target_value(&ev))
                        >
                            <option value="">"— choose —"</option>
                            <Suspense fallback=|| ()>
                                {move || {
                                    categories
                                        .get()
                                        .map(|cats| {
                                            cats.into_iter()
                                                .map(|c| {
                                                    view! {
                                                        <option value=c.id
                                                            .to_string()>{c.name}</option>
                                                    }
                                                })
                                                .collect_view()
                                        })
                                }}
                            </Suspense>
                        </select>
                    </div>
                    <div>
                        <label for="status">"Status"</label>
                        <select
                            id="status"
                            prop:value=status
                            on:change=move |ev| set_status.set(event_target_value(&ev))
                        >
                            <option value="draft">"Draft"</option>
                            <option value="published">"Published"</option>
                        </select>
                    </div>
                </div>
            </div>

            <h3 style="margin-top:24px">"Q&A blocks"</h3>
            <p class="muted">
                "Answers accept Markdown. Embed an uploaded image with " <code>"![alt](/uploads/…)"</code>
                "."
            </p>

            <For each=move || blocks.get() key=|b| b.id let:block>
                {
                    let bid = block.id;
                    let answer_ref = NodeRef::<leptos::html::Textarea>::new();
                    #[cfg(feature = "hydrate")]
                    answer_ref.on_load(|el| autosize(&el));
                    view! {
                        <div class="block-editor">
                            <div class="block-head">
                                <strong>"Question"</strong>
                                <div class="grow-0">
                                    <button
                                        type="button"
                                        class="btn small secondary"
                                        on:click=move |_| {
                                            blocks
                                                .update(|v| {
                                                    if let Some(i) = v.iter().position(|x| x.id == bid) {
                                                        if i > 0 {
                                                            v.swap(i, i - 1);
                                                        }
                                                    }
                                                });
                                        }
                                    >
                                        "↑"
                                    </button>
                                    <button
                                        type="button"
                                        class="btn small secondary"
                                        on:click=move |_| {
                                            blocks
                                                .update(|v| {
                                                    if let Some(i) = v.iter().position(|x| x.id == bid) {
                                                        if i + 1 < v.len() {
                                                            v.swap(i, i + 1);
                                                        }
                                                    }
                                                });
                                        }
                                    >
                                        "↓"
                                    </button>
                                    <button
                                        type="button"
                                        class="btn small danger"
                                        on:click=move |_| {
                                            blocks.update(|v| v.retain(|x| x.id != bid));
                                        }
                                    >
                                        "Remove"
                                    </button>
                                </div>
                            </div>
                            <input
                                type="text"
                                placeholder="Question"
                                prop:value=block.question
                                on:input=move |ev| block.question.set(event_target_value(&ev))
                            />
                            <label>"Answer (Markdown)"</label>
                            <textarea
                                node_ref=answer_ref
                                prop:value=block.answer
                                on:input=move |ev| {
                                    block.answer.set(event_target_value(&ev));
                                    #[cfg(feature = "hydrate")]
                                    if let Some(el) = answer_ref.get() {
                                        autosize(&el);
                                    }
                                }
                            ></textarea>
                        </div>
                    }
                }
            </For>

            <button type="button" class="btn secondary" on:click=move |_| add_block()>
                "+ Add block"
            </button>

            {move || error().map(|e| view! { <p class="error">{e}</p> })}

            <div style="margin-top:20px;display:flex;gap:10px">
                <button class="btn" type="submit" prop:disabled=move || save.pending().get()>
                    "Save"
                </button>
                <a class="btn secondary" href="/">"Cancel"</a>
            </div>
        </form>

        <ImageUploader/>
    }
}

/// A small standalone image uploader. It posts to the Axum `/api/upload`
/// endpoint (multipart, validated server-side per SR-5) and shows the returned
/// URL/markdown so the author can paste it into an answer.
#[component]
fn ImageUploader() -> impl IntoView {
    view! {
        <div class="panel" style="margin-top:28px">
            <h3>"Upload an image"</h3>
            <p class="muted">
                "Choose a file and submit; the response shows the URL to paste into an answer as "
                <code>"![alt](URL)"</code> "."
            </p>
            <form action="/api/upload" method="post" enctype="multipart/form-data" target="_blank">
                <input type="file" name="file" accept="image/*"/>
                <div style="margin-top:10px">
                    <button class="btn secondary" type="submit">"Upload"</button>
                </div>
            </form>
        </div>
    }
}
