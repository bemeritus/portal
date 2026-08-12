//! `/docs/new` and `/docs/:id/edit` — the document editor (§8, FR-11..FR-16).
//!
//! Both routes share [`EditorForm`]. Q&A blocks are an editable, reorderable
//! list; on save they are serialized to JSON and sent to the server.

use leptos::prelude::*;
use leptos_meta::Title;
use leptos_router::hooks::{use_navigate, use_params_map};

use crate::components::ConfirmButton;
use crate::error::user_message;
use crate::models::{DocumentDraft, QaBlockInput};
use crate::server::categories::list_writable_categories;
use crate::server::documents::{create_document, get_document_draft, update_document};

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
        <Suspense fallback=|| {
            view! {
                <p class="loading-inline">
                    <span class="spinner"></span>
                    "Loading document…"
                </p>
            }
        }>
            {move || {
                draft
                    .get()
                    .map(|res| match res {
                        Err(e) => view! { <p class="flash error">{user_message(&e)}</p> }.into_any(),
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

    // Only categories the author may write to / edit in — picking any other
    // would be rejected by the server anyway.
    //
    // The failure is kept rather than defaulted to an empty list: with no
    // category to choose, Save stays disabled behind "Choose a category to
    // save" and there is no category to choose. That has to say why.
    let categories = Resource::new(|| (), |_| async move { list_writable_categories().await });
    let categories_error = move || match categories.get() {
        Some(Err(e)) => Some(user_message(&e)),
        _ => None,
    };

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
        async move {
            if title_v.is_empty() {
                return Err(ServerFnError::new("Title is required"));
            }
            let category_id = uuid::Uuid::parse_str(&cat_v)
                .map_err(|_| ServerFnError::new("Please choose a category"))?;
            // Defaulting to `""` here sent the server an empty payload, which
            // came back as a JSON parser message about column 0.
            let json = serde_json::to_string(&blocks_v)
                .map_err(|_| ServerFnError::new("Could not prepare the Q&A blocks for saving"))?;
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
        Some(Err(e)) => Some(user_message(&e)),
        _ => None,
    };

    let heading = if is_edit {
        "Edit document"
    } else {
        "New document"
    };
    let busy = move || save.pending().get();
    // The two things the server will reject anyway; say so before the round-trip.
    let title_missing = move || title.get().trim().is_empty();
    let cat_missing = move || cat.get().is_empty();
    let back_href = match doc_id {
        Some(id) => format!("/docs/{id}"),
        None => "/".to_string(),
    };
    let back_label = if is_edit {
        "← Back to document"
    } else {
        "← All documents"
    };

    view! {
        <Title text=format!("{heading} · Knowledge Base")/>
        <a class="backlink" href=back_href.clone()>
            {back_label}
        </a>
        <h1>{heading}</h1>
        <form on:submit=move |ev| {
            ev.prevent_default();
            if !busy() {
                save.dispatch(());
            }
        }>
            <div class="panel">
                <label for="title">"Title"</label>
                <input
                    id="title"
                    type="text"
                    placeholder="What is this document about?"
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
                                        .and_then(Result::ok)
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
                        {move || {
                            categories_error()
                                .map(|e| view! { <p class="flash error">{e}</p> })
                        }}
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
                        <p class="hint">
                            {move || {
                                if status.get() == "published" {
                                    "Visible to everyone who can read this category."
                                } else {
                                    "Drafts stay hidden from other readers."
                                }
                            }}
                        </p>
                    </div>
                </div>
            </div>

            <h3 style="margin-top:24px">
                "Q&A blocks"
                <span class="muted" style="font-weight:400;font-size:14px">
                    {move || format!(" ({})", blocks.get().len())}
                </span>
            </h3>
            <p class="muted">
                "Answers accept Markdown. Embed an uploaded image with " <code>"![alt](/uploads/…)"</code>
                "."
            </p>

            <For each=move || blocks.get() key=|b| b.id let:block>
                {
                    let bid = block.id;
                    // Recomputed on every reorder, so the numbering and the
                    // enabled/disabled arrows always match what you see.
                    let position = move || blocks.get().iter().position(|x| x.id == bid);
                    let number = move || position().map(|i| i + 1).unwrap_or(0);
                    let is_first = move || position() == Some(0);
                    let is_last = move || {
                        let list = blocks.get();
                        position().map(|i| i + 1 >= list.len()).unwrap_or(true)
                    };
                    let only_one = move || blocks.get().len() <= 1;
                    let q_id = format!("q-{bid}");
                    let a_id = format!("a-{bid}");
                    view! {
                        <div class="block-editor">
                            <div class="block-head">
                                <strong>{move || format!("Question {}", number())}</strong>
                                <div class="grow-0">
                                    <button
                                        type="button"
                                        class="btn icon secondary"
                                        title="Move up"
                                        aria-label="Move this block up"
                                        prop:disabled=is_first
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
                                        class="btn icon secondary"
                                        title="Move down"
                                        aria-label="Move this block down"
                                        prop:disabled=is_last
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
                                    // A block can hold a lot of typing — never
                                    // drop it on a single stray click.
                                    <span class="danger" style="margin-left:12px">
                                        <Show
                                            when=only_one
                                            fallback=move || {
                                                view! {
                                                    <ConfirmButton
                                                        label="Remove"
                                                        confirm_label="Yes, remove"
                                                        on_confirm=move || {
                                                            blocks.update(|v| v.retain(|x| x.id != bid));
                                                        }
                                                    />
                                                }
                                            }
                                        >
                                            <button
                                                type="button"
                                                class="btn small danger"
                                                title="A document needs at least one block"
                                                disabled
                                            >
                                                "Remove"
                                            </button>
                                        </Show>
                                    </span>
                                </div>
                            </div>
                            <label for=q_id.clone()>"Question"</label>
                            <input
                                id=q_id
                                type="text"
                                placeholder="e.g. How do I reset my password?"
                                prop:value=block.question
                                on:input=move |ev| block.question.set(event_target_value(&ev))
                            />
                            <label for=a_id.clone()>"Answer (Markdown)"</label>
                            <textarea
                                id=a_id
                                class="md-editor"
                                placeholder="Write the answer here. **Markdown** works."
                                prop:value=block.answer
                                on:input=move |ev| block.answer.set(event_target_value(&ev))
                            ></textarea>
                        </div>
                    }
                }
            </For>

            <button type="button" class="btn secondary" on:click=move |_| add_block()>
                "+ Add block"
            </button>

            {move || error().map(|e| view! { <p class="flash error">{e}</p> })}

            <div class="form-bar">
                <button
                    class="btn"
                    type="submit"
                    prop:disabled=move || busy() || title_missing() || cat_missing()
                >
                    <Show when=busy fallback=|| ()>
                        <span class="spinner"></span>
                    </Show>
                    {move || if busy() { "Saving…" } else { "Save" }}
                </button>
                <a class="btn secondary" href=back_href>
                    "Cancel"
                </a>
                // Explains a disabled Save instead of leaving it a mystery.
                <Show when=move || title_missing() || cat_missing() fallback=|| ()>
                    <span class="muted" style="font-size:13px">
                        {move || {
                            if title_missing() && cat_missing() {
                                "Add a title and choose a category to save."
                            } else if title_missing() {
                                "Add a title to save."
                            } else {
                                "Choose a category to save."
                            }
                        }}
                    </span>
                </Show>
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
            // Collapsed by default: most edits never touch it, and an open file
            // picker under the save bar reads like part of the document form.
            <details>
                <summary style="cursor:pointer;font-weight:600">"Upload an image"</summary>
                <p class="hint" style="margin-top:10px">
                    "Pick a file and submit. The upload opens in a new tab and shows the URL to
                    paste into an answer as " <code>"![alt](URL)"</code>
                    ". Uploading does not save the document."
                </p>
                <form
                    action="/api/upload"
                    method="post"
                    enctype="multipart/form-data"
                    target="_blank"
                >
                    <input type="file" name="file" accept="image/*" aria-label="Image file"/>
                    <div style="margin-top:10px">
                        <button class="btn secondary" type="submit">"Upload"</button>
                    </div>
                </form>
            </details>
        </div>
    }
}
