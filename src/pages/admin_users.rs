//! `/admin/users` — admin user management (§8, FR-5..FR-8).

use leptos::prelude::*;

use crate::app::use_user;
use crate::models::User;
use crate::server::users::{
    create_user, list_users, reset_password, set_user_active, update_permissions,
};

#[component]
pub fn AdminUsersPage() -> impl IntoView {
    let me = use_user();
    let is_admin = move || me.get().flatten().map(|u| u.is_admin).unwrap_or(false);

    let users = Resource::new(
        || (),
        |_| async move { list_users().await.unwrap_or_default() },
    );

    // --- Create user form ---------------------------------------------------
    let (cu_name, set_cu_name) = signal(String::new());
    let (cu_pass, set_cu_pass) = signal(String::new());
    let (cu_admin, set_cu_admin) = signal(false);
    let (cu_read, set_cu_read) = signal(true);
    let (cu_write, set_cu_write) = signal(false);
    let (cu_edit, set_cu_edit) = signal(false);
    let (cu_delete, set_cu_delete) = signal(false);

    let create = Action::new(move |_: &()| {
        let payload = (
            cu_name.get_untracked(),
            cu_pass.get_untracked(),
            cu_admin.get_untracked(),
            cu_read.get_untracked(),
            cu_write.get_untracked(),
            cu_edit.get_untracked(),
            cu_delete.get_untracked(),
        );
        async move {
            let (n, p, a, r, w, e, d) = payload;
            create_user(n, p, a, r, w, e, d).await
        }
    });

    // Shared actions used by the rows.
    let perms = Action::new(|args: &(uuid::Uuid, bool, bool, bool, bool)| {
        let (id, r, w, e, d) = *args;
        async move { update_permissions(id, r, w, e, d).await }
    });
    let active = Action::new(|args: &(uuid::Uuid, bool)| {
        let (id, a) = *args;
        async move { set_user_active(id, a).await }
    });

    // Refresh the table after any mutation.
    Effect::new(move |_| {
        if matches!(create.value().get(), Some(Ok(()))) {
            set_cu_name.set(String::new());
            set_cu_pass.set(String::new());
            users.refetch();
        }
    });
    Effect::new(move |_| {
        if matches!(active.value().get(), Some(Ok(()))) {
            users.refetch();
        }
    });

    let create_error = move || match create.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };

    view! {
        <Show
            when=is_admin
            fallback=|| view! { <p class="muted">"This area is for administrators."</p> }
        >
            <h1>"Users"</h1>

            <div class="panel" style="margin:16px 0">
                <h3>"Create user"</h3>
                <form on:submit=move |ev| {
                    ev.prevent_default();
                    create.dispatch(());
                }>
                    <div class="row">
                        <div>
                            <label>"Username"</label>
                            <input
                                type="text"
                                prop:value=cu_name
                                on:input=move |ev| set_cu_name.set(event_target_value(&ev))
                            />
                        </div>
                        <div>
                            <label>"Initial password"</label>
                            <input
                                type="text"
                                prop:value=cu_pass
                                on:input=move |ev| set_cu_pass.set(event_target_value(&ev))
                            />
                        </div>
                    </div>
                    <div style="margin-top:12px;display:flex;gap:18px;flex-wrap:wrap">
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_admin
                                on:change=move |ev| set_cu_admin.set(event_target_checked(&ev))
                            />
                            " Admin"
                        </label>
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_read
                                on:change=move |ev| set_cu_read.set(event_target_checked(&ev))
                            />
                            " Read"
                        </label>
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_write
                                on:change=move |ev| set_cu_write.set(event_target_checked(&ev))
                            />
                            " Write"
                        </label>
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_edit
                                on:change=move |ev| set_cu_edit.set(event_target_checked(&ev))
                            />
                            " Edit"
                        </label>
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_delete
                                on:change=move |ev| set_cu_delete.set(event_target_checked(&ev))
                            />
                            " Delete"
                        </label>
                    </div>
                    <div style="margin-top:14px">
                        <button class="btn" type="submit">"Create user"</button>
                    </div>
                    {move || create_error().map(|e| view! { <p class="error">{e}</p> })}
                </form>
            </div>

            <Suspense fallback=|| view! { <p class="muted">"Loading…"</p> }>
                {move || {
                    users
                        .get()
                        .map(|list| {
                            view! {
                                <table>
                                    <thead>
                                        <tr>
                                            <th>"Username"</th>
                                            <th>"Role"</th>
                                            <th>"Permissions"</th>
                                            <th>"Status"</th>
                                            <th>"Reset password"</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {list
                                            .into_iter()
                                            .map(|u| user_row(u, perms, active))
                                            .collect_view()}
                                    </tbody>
                                </table>
                            }
                        })
                }}
            </Suspense>
        </Show>
    }
}

fn user_row(
    u: User,
    perms: Action<(uuid::Uuid, bool, bool, bool, bool), Result<(), ServerFnError>>,
    active: Action<(uuid::Uuid, bool), Result<(), ServerFnError>>,
) -> impl IntoView {
    let id = u.id;
    let is_admin_user = u.is_admin;
    // Per-row editable permission signals, seeded from the current values.
    let r = RwSignal::new(u.can_read);
    let w = RwSignal::new(u.can_write);
    let e = RwSignal::new(u.can_edit);
    let d = RwSignal::new(u.can_delete);
    let currently_active = u.is_active;

    let (pw, set_pw) = signal(String::new());
    let reset = Action::new(move |_: &()| {
        let (id, np) = (id, pw.get_untracked());
        async move { reset_password(id, np).await }
    });
    Effect::new(move |_| {
        if matches!(reset.value().get(), Some(Ok(()))) {
            set_pw.set(String::new());
        }
    });

    view! {
        <tr>
            <td>{u.username}</td>
            <td>{if is_admin_user { "admin" } else { "user" }}</td>
            <td>
                {if is_admin_user {
                    view! { <span class="muted">"all"</span> }.into_any()
                } else {
                    view! {
                        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                            <label class="chk">
                                <input
                                    type="checkbox"
                                    prop:checked=r
                                    on:change=move |ev| r.set(event_target_checked(&ev))
                                />
                                " R"
                            </label>
                            <label class="chk">
                                <input
                                    type="checkbox"
                                    prop:checked=w
                                    on:change=move |ev| w.set(event_target_checked(&ev))
                                />
                                " W"
                            </label>
                            <label class="chk">
                                <input
                                    type="checkbox"
                                    prop:checked=e
                                    on:change=move |ev| e.set(event_target_checked(&ev))
                                />
                                " E"
                            </label>
                            <label class="chk">
                                <input
                                    type="checkbox"
                                    prop:checked=d
                                    on:change=move |ev| d.set(event_target_checked(&ev))
                                />
                                " D"
                            </label>
                            <button
                                class="btn small secondary"
                                on:click=move |_| {
                                    perms
                                        .dispatch((
                                            id,
                                            r.get_untracked(),
                                            w.get_untracked(),
                                            e.get_untracked(),
                                            d.get_untracked(),
                                        ));
                                }
                            >
                                "Save"
                            </button>
                        </div>
                    }
                        .into_any()
                }}
            </td>
            <td>
                {if currently_active {
                    view! {
                        <button
                            class="btn small danger"
                            on:click=move |_| {
                                active.dispatch((id, false));
                            }
                        >
                            "Block"
                        </button>
                    }
                        .into_any()
                } else {
                    view! {
                        <span class="badge">"blocked"</span>
                        <button
                            class="btn small secondary"
                            on:click=move |_| {
                                active.dispatch((id, true));
                            }
                        >
                            "Activate"
                        </button>
                    }
                        .into_any()
                }}
            </td>
            <td>
                <div style="display:flex;gap:8px">
                    <input
                        type="text"
                        placeholder="new password"
                        prop:value=pw
                        on:input=move |ev| set_pw.set(event_target_value(&ev))
                    />
                    <button
                        class="btn small secondary"
                        on:click=move |_| {
                            reset.dispatch(());
                        }
                    >
                        "Set"
                    </button>
                </div>
            </td>
        </tr>
    }
}
