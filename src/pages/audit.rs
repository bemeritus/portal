//! `/admin/logs` — the platform's change history (§8, admin only).
//!
//! Read-only by construction: entries are written by the operations they
//! describe and there is no server function that edits or removes one.

use leptos::prelude::*;
use leptos_meta::Title;

use crate::app::use_user;
use crate::error::user_message;
use crate::models::AuditEntry;
use crate::server::audit::list_audit_log;

/// How many entries the first query asks for, and how many each "Load more"
/// adds. The server clamps the total (see `list_audit_log`).
const PAGE: i64 = 100;

#[component]
pub fn AuditLogPage() -> impl IntoView {
    let user = use_user();
    let is_admin = move || user.get().flatten().map(|u| u.is_admin).unwrap_or(false);

    let (target_type, set_target_type) = signal(String::new()); // "" = everything
    let (search, set_search) = signal(String::new());
    let (limit, set_limit) = signal(PAGE);

    // Re-runs whenever a filter or the limit changes.
    let entries = Resource::new(
        move || (target_type.get(), search.get(), limit.get()),
        |(target_type, search, limit)| async move {
            let target_type = (!target_type.is_empty()).then_some(target_type);
            let search = (!search.trim().is_empty()).then_some(search);
            list_audit_log(target_type, search, limit).await
        },
    );

    // A new filter starts from the first page again — keeping a raised limit
    // would re-run the widest possible query on every keystroke.
    let reset_and = move |set: WriteSignal<String>, value: String| {
        set_limit.set(PAGE);
        set.set(value);
    };

    view! {
        // Hoisted above the Suspense: leptos_meta can only write into the
        // streamed <head> before it is flushed.
        <Title text="Logs · Knowledge Base"/>
        // The admin check reads the user resource *inside* the Suspense so SSR
        // waits for it — otherwise admins see a flash of "administrators only".
        <Suspense fallback=|| {
            view! {
                <p class="loading-inline">
                    <span class="spinner"></span>
                    "Loading…"
                </p>
            }
        }>
            {move || {
                user.get()
                    .map(|_| {
                        view! {
                            <Show
                                when=is_admin
                                fallback=|| {
                                    view! {
                                        <div class="empty">
                                            <div class="empty-title">"Administrators only"</div>
                                            <p style="margin:0">
                                                "The change history is visible to administrators."
                                            </p>
                                        </div>
                                    }
                                }
                            >
                                <h1>"Logs"</h1>
                                <p class="muted" style="margin-top:0">
                                    "Every change made on the platform, newest first."
                                </p>

                                <div class="panel" style="margin:16px 0">
                                    <div class="row">
                                        <div>
                                            <label for="log-q">"Search"</label>
                                            <input
                                                id="log-q"
                                                type="search"
                                                placeholder="user, title, action…"
                                                prop:value=search
                                                on:change=move |ev| {
                                                    reset_and(set_search, event_target_value(&ev));
                                                }
                                            />
                                        </div>
                                        <div>
                                            <label for="log-type">"Kind"</label>
                                            <select
                                                id="log-type"
                                                prop:value=target_type
                                                on:change=move |ev| {
                                                    reset_and(set_target_type, event_target_value(&ev));
                                                }
                                            >
                                                <option value="">"Everything"</option>
                                                <option value="user">"Users"</option>
                                                <option value="category">"Categories"</option>
                                                <option value="document">"Documents"</option>
                                                <option value="upload">"Uploads"</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                <Suspense fallback=|| {
                                    view! {
                                        <p class="loading-inline">
                                            <span class="spinner"></span>
                                            "Loading the log…"
                                        </p>
                                    }
                                }>
                                    {move || {
                                        entries
                                            .get()
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
                                                    return view! {
                                                        <div class="empty">
                                                            <div class="empty-title">"Nothing recorded yet"</div>
                                                            <p style="margin:0">
                                                                "Changes appear here as soon as anyone makes one."
                                                            </p>
                                                        </div>
                                                    }
                                                        .into_any();
                                                }
                                                // A full page back means there is probably more
                                                // behind it; a short one is the end of the log.
                                                let maybe_more = list.len() as i64 >= limit.get();
                                                let shown = list.len();
                                                view! {
                                                    <div class="table-wrap">
                                                        <table>
                                                            <thead>
                                                                <tr>
                                                                    <th>"When (UTC)"</th>
                                                                    <th>"Who"</th>
                                                                    <th>"Action"</th>
                                                                    <th>"Target"</th>
                                                                    <th>"Details"</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {list.into_iter().map(entry_row).collect_view()}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                    <div class="actions" style="margin-top:12px">
                                                        <span class="muted">
                                                            {format!("{shown} entr{}", if shown == 1 { "y" } else { "ies" })}
                                                        </span>
                                                        <Show when=move || maybe_more fallback=|| ()>
                                                            <button
                                                                class="btn secondary small"
                                                                on:click=move |_| set_limit.update(|l| *l += PAGE)
                                                            >
                                                                "Load more"
                                                            </button>
                                                        </Show>
                                                    </div>
                                                }
                                                    .into_any()
                                            })
                                    }}
                                </Suspense>
                            </Show>
                        }
                    })
            }}
        </Suspense>
    }
}

fn entry_row(e: AuditEntry) -> impl IntoView {
    // Stored in UTC and shown in UTC, with the column saying so: the browser's
    // offset is not the server's, and a log that quietly shifts times is worse
    // than one that is explicit about the zone.
    let when = e.at.format("%Y-%m-%d %H:%M").to_string();
    // Documents are the one target worth linking: users and categories have no
    // page of their own, and a deleted document's link would 404.
    let target = match (e.target_type.as_str(), e.target_id) {
        ("document", Some(id)) if e.action != "document.delete" => {
            view! { <a href=format!("/docs/{id}")>{e.target_name.clone()}</a> }.into_any()
        }
        _ => e.target_name.clone().into_any(),
    };
    view! {
        <tr>
            <td class="muted">{when}</td>
            <td>{e.actor_name}</td>
            <td>
                <span class="log-action">{e.action}</span>
            </td>
            <td>{target}</td>
            <td class="muted wrap">
                {e.details.unwrap_or_else(|| "—".to_string())}
            </td>
        </tr>
    }
}
