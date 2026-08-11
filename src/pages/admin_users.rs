//! `/admin/users` — admin user management (§8, FR-5..FR-8).
//!
//! Access is edited in exactly one place: the per-category R/W/E/D matrix. A
//! user reaches a category only through a tick there, so a user with an empty
//! matrix sees nothing at all. The only thing above it is the admin flag, which
//! grants everything everywhere and makes the matrix irrelevant.

use leptos::prelude::*;
use leptos_meta::Title;

use crate::app::use_user;
use crate::components::ConfirmButton;
use crate::models::{Category, CategoryPermission, User};
use crate::server::categories::list_categories;
use crate::server::users::{
    create_user, list_users, reset_password, set_user_active, update_category_permissions,
};

/// Alphabet for generated passwords. `0/O`, `1/l/I` are left out: an admin has
/// to read these out or retype them, and those are the pairs that get confused.
const PASSWORD_ALPHABET: &[u8] =
    b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Length in characters. 16 over a 56-symbol alphabet is ~93 bits of entropy.
const PASSWORD_LEN: usize = 16;

/// Generate a random initial password.
///
/// The entropy is `Uuid::new_v4`, which under `uuid`'s `js` feature — already
/// enabled for the wasm target in Cargo.toml — binds to `crypto.getRandomValues`
/// in the browser, so this is a real CSPRNG without adding a dependency.
///
/// Bytes at or above `limit` are discarded rather than folded with `%`, which
/// would make the first symbols of the alphabet slightly likelier than the rest.
fn generate_password() -> String {
    let n = PASSWORD_ALPHABET.len();
    let limit = (256 / n) * n;
    let mut out = String::with_capacity(PASSWORD_LEN);
    while out.len() < PASSWORD_LEN {
        for byte in uuid::Uuid::new_v4().as_bytes() {
            if (*byte as usize) < limit {
                out.push(PASSWORD_ALPHABET[*byte as usize % n] as char);
                if out.len() == PASSWORD_LEN {
                    break;
                }
            }
        }
    }
    out
}

/// One editable line of the category matrix: the category plus its four
/// checkboxes.
#[derive(Clone)]
struct CatRow {
    id: uuid::Uuid,
    name: String,
    r: RwSignal<bool>,
    w: RwSignal<bool>,
    e: RwSignal<bool>,
    d: RwSignal<bool>,
}

/// Build one matrix line per category, pre-ticked from any existing grants.
fn build_rows(cats: &[Category], existing: &[CategoryPermission]) -> Vec<CatRow> {
    cats.iter()
        .map(|c| {
            let g = existing.iter().find(|g| g.category_id == c.id).copied();
            CatRow {
                id: c.id,
                name: c.name.clone(),
                r: RwSignal::new(g.map(|g| g.can_read).unwrap_or(false)),
                w: RwSignal::new(g.map(|g| g.can_write).unwrap_or(false)),
                e: RwSignal::new(g.map(|g| g.can_edit).unwrap_or(false)),
                d: RwSignal::new(g.map(|g| g.can_delete).unwrap_or(false)),
            }
        })
        .collect()
}

/// Serialize the ticked lines into the JSON payload the server expects.
fn rows_json(rows: &[CatRow]) -> String {
    let grants: Vec<CategoryPermission> = rows
        .iter()
        .map(|row| CategoryPermission {
            category_id: row.id,
            can_read: row.r.get_untracked(),
            can_write: row.w.get_untracked(),
            can_edit: row.e.get_untracked(),
            can_delete: row.d.get_untracked(),
        })
        .filter(|g| !g.is_empty())
        .collect();
    serde_json::to_string(&grants).unwrap_or_else(|_| "[]".to_string())
}

/// The shared R/W/E/D matrix widget.
fn category_matrix(rows: RwSignal<Vec<CatRow>>) -> impl IntoView {
    view! {
        <Show
            when=move || !rows.get().is_empty()
            fallback=|| {
                view! { <p class="muted">"No categories yet — create some first."</p> }
            }
        >
            <table class="perm-matrix">
                <thead>
                    <tr>
                        <th>"Category"</th>
                        <th>"Read"</th>
                        <th>"Write"</th>
                        <th>"Edit"</th>
                        <th>"Delete"</th>
                    </tr>
                </thead>
                <tbody>
                    <For each=move || rows.get() key=|row| row.id let:row>
                        {
                            let (r, w, e, d) = (row.r, row.w, row.e, row.d);
                            let name = row.name.clone();
                            // A bare checkbox in a grid announces nothing useful,
                            // and the label widens the click target to the cell.
                            let cell = move |flag: RwSignal<bool>, perm: &str, name: &str| {
                                let aria = format!("{perm} in {name}");
                                view! {
                                    <td>
                                        <label aria-label=aria>
                                            <input
                                                type="checkbox"
                                                prop:checked=flag
                                                on:change=move |ev| flag.set(event_target_checked(&ev))
                                            />
                                        </label>
                                    </td>
                                }
                            };
                            view! {
                                <tr>
                                    <td>{row.name.clone()}</td>
                                    {cell(r, "Read", &name)}
                                    {cell(w, "Write", &name)}
                                    {cell(e, "Edit", &name)}
                                    {cell(d, "Delete", &name)}
                                </tr>
                            }
                        }
                    </For>
                </tbody>
            </table>
        </Show>
    }
}

#[component]
pub fn AdminUsersPage() -> impl IntoView {
    let me = use_user();
    let is_admin = move || me.get().flatten().map(|u| u.is_admin).unwrap_or(false);

    let users = Resource::new(
        || (),
        |_| async move { list_users().await.unwrap_or_default() },
    );
    let categories = Resource::new(
        || (),
        |_| async move { list_categories().await.unwrap_or_default() },
    );

    // --- Create user form ---------------------------------------------------
    let (cu_name, set_cu_name) = signal(String::new());
    let (cu_pass, set_cu_pass) = signal(String::new());
    let (cu_admin, set_cu_admin) = signal(false);

    // The create form's matrix, (re)built once the category list arrives.
    let cu_rows: RwSignal<Vec<CatRow>> = RwSignal::new(Vec::new());
    Effect::new(move |_| {
        if let Some(cats) = categories.get() {
            cu_rows.set(build_rows(&cats, &[]));
        }
    });

    let create = Action::new(move |_: &()| {
        let payload = (
            cu_name.get_untracked(),
            cu_pass.get_untracked(),
            cu_admin.get_untracked(),
            rows_json(&cu_rows.get_untracked()),
        );
        async move {
            let (n, p, a, cats) = payload;
            create_user(n, p, a, cats).await
        }
    });

    // Shared actions used by the rows.
    let cat_perms = Action::new(|args: &(uuid::Uuid, String)| {
        let (id, json) = args.clone();
        async move { update_category_permissions(id, json).await }
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
            for row in cu_rows.get_untracked() {
                row.r.set(false);
                row.w.set(false);
                row.e.set(false);
                row.d.set(false);
            }
            users.refetch();
        }
    });
    Effect::new(move |_| {
        if matches!(active.value().get(), Some(Ok(()))) {
            users.refetch();
        }
    });
    Effect::new(move |_| {
        if matches!(cat_perms.value().get(), Some(Ok(()))) {
            users.refetch();
        }
    });

    let create_error = move || match create.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };
    let create_ok = move || matches!(create.value().get(), Some(Ok(())));
    let create_busy = move || create.pending().get();
    let create_incomplete =
        move || cu_name.get().trim().is_empty() || cu_pass.get().trim().is_empty();

    // The row-level actions used to fail silently — a click that did nothing
    // and said nothing. Surface whichever one broke.
    let row_error = move || {
        [cat_perms.value().get(), active.value().get()]
            .into_iter()
            .find_map(|v| match v {
                Some(Err(e)) => Some(e.to_string()),
                _ => None,
            })
    };

    view! {
        // Hoisted above the Suspense: leptos_meta can only write into the
        // streamed <head> before it is flushed, so a title nested inside a
        // suspended branch never makes it into the server response.
        <Title text="Users · Knowledge Base"/>
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
        {move || me.get().map(|_| view! {
        <Show
            when=is_admin
            fallback=|| {
                view! {
                    <div class="empty">
                        <div class="empty-title">"Administrators only"</div>
                        <p style="margin:0">"This area is for administrators."</p>
                    </div>
                }
            }
        >
            <h1>"Users"</h1>

            <div class="panel" style="margin:16px 0">
                <h3 style="margin-top:0">"Create user"</h3>
                <form on:submit=move |ev| {
                    ev.prevent_default();
                    if !create_incomplete() && !create_busy() {
                        create.dispatch(());
                    }
                }>
                    <div class="row">
                        <div>
                            <label for="cu-name">"Username"</label>
                            <input
                                id="cu-name"
                                type="text"
                                autocomplete="off"
                                prop:value=cu_name
                                on:input=move |ev| set_cu_name.set(event_target_value(&ev))
                            />
                        </div>
                        <div>
                            <label for="cu-pass">"Initial password"</label>
                            <div style="display:flex;gap:8px">
                                <input
                                    id="cu-pass"
                                    type="text"
                                    autocomplete="off"
                                    prop:value=cu_pass
                                    on:input=move |ev| set_cu_pass.set(event_target_value(&ev))
                                />
                                <button
                                    type="button"
                                    class="btn secondary grow-0"
                                    title="Generate a random password"
                                    on:click=move |_| set_cu_pass.set(generate_password())
                                >
                                    "Generate"
                                </button>
                            </div>
                            <p class="hint">"Shown in the clear so you can pass it on."</p>
                        </div>
                    </div>
                    <label style="margin-top:14px">"Role"</label>
                    <div style="margin-top:6px">
                        <label class="chk">
                            <input
                                type="checkbox"
                                prop:checked=cu_admin
                                on:change=move |ev| set_cu_admin.set(event_target_checked(&ev))
                            />
                            " Admin"
                        </label>
                    </div>

                    <label style="margin-top:18px">"Per-category permissions"</label>
                    <p class="muted" style="margin:4px 0 10px">
                        "This is the whole of a user's access: they can only reach the categories
                        ticked below. Leave it empty and they see nothing."
                    </p>
                    // Admin bypasses the matrix entirely, so say so instead of
                    // presenting boxes that will not be consulted.
                    <Show when=move || cu_admin.get() fallback=|| ()>
                        <p class="flash error">
                            "Admins hold every permission in every category. The matrix below has
                            no effect."
                        </p>
                    </Show>
                    <Suspense fallback=|| view! { <p class="muted">"Loading categories…"</p> }>
                        {move || category_matrix(cu_rows)}
                    </Suspense>

                    <div style="margin-top:14px">
                        <button
                            class="btn"
                            type="submit"
                            prop:disabled=move || create_busy() || create_incomplete()
                        >
                            <Show when=create_busy fallback=|| ()>
                                <span class="spinner"></span>
                            </Show>
                            {move || if create_busy() { "Creating…" } else { "Create user" }}
                        </button>
                    </div>
                    {move || create_error().map(|e| view! { <p class="flash error">{e}</p> })}
                    <Show when=create_ok fallback=|| ()>
                        <p class="flash ok">"User created."</p>
                    </Show>
                </form>
            </div>

            {move || row_error().map(|e| view! { <p class="flash error">{e}</p> })}
            <p class="hint" style="margin-bottom:8px">
                "R = read, W = write, E = edit, D = delete, per category. A user reaches a category
                only through a tick here — there is no permission that applies across categories,
                and authoring a document does not grant access to its category."
            </p>

            <Suspense fallback=|| {
                view! {
                    <p class="loading-inline">
                        <span class="spinner"></span>
                        "Loading users…"
                    </p>
                }
            }>
                {move || {
                    let cats = categories.get().unwrap_or_default();
                    users
                        .get()
                        .map(|list| {
                            view! {
                                <div class="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>"Username"</th>
                                                <th>"Role"</th>
                                                <th>"Categories"</th>
                                                <th>"Status"</th>
                                                <th>"Reset password"</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {list
                                                .into_iter()
                                                .map(|u| user_row(u, cats.clone(), cat_perms, active))
                                                .collect_view()}
                                        </tbody>
                                    </table>
                                </div>
                            }
                        })
                }}
            </Suspense>
        </Show>
        })}
        </Suspense>
    }
}

fn user_row(
    u: User,
    cats: Vec<Category>,
    cat_perms: Action<(uuid::Uuid, String), Result<(), ServerFnError>>,
    active: Action<(uuid::Uuid, bool), Result<(), ServerFnError>>,
) -> impl IntoView {
    let id = u.id;
    let is_admin_user = u.is_admin;
    let currently_active = u.is_active;

    let cat_rows = RwSignal::new(build_rows(&cats, &u.category_perms));
    let granted = u.category_perms.iter().filter(|g| !g.is_empty()).count();
    let summary = if is_admin_user {
        "all categories".to_string()
    } else if granted == 0 {
        "none".to_string()
    } else {
        format!("{granted} granted")
    };

    let (pw, set_pw) = signal(String::new());
    let (reset_done, set_reset_done) = signal(false);
    let reset = Action::new(move |_: &()| {
        let (id, np) = (id, pw.get_untracked());
        async move { reset_password(id, np).await }
    });
    Effect::new(move |_| match reset.value().get() {
        Some(Ok(())) => {
            set_pw.set(String::new());
            // The field emptying is the only thing that happened otherwise —
            // indistinguishable from a click that did nothing.
            set_reset_done.set(true);
        }
        Some(Err(_)) => set_reset_done.set(false),
        None => {}
    });
    let reset_busy = move || reset.pending().get();
    let reset_error = move || match reset.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };
    let cat_busy = Signal::derive(move || cat_perms.pending().get());
    let active_busy = Signal::derive(move || active.pending().get());

    view! {
        <tr>
            <td>{u.username}</td>
            <td>{if is_admin_user { "admin" } else { "user" }}</td>
            <td>
                {if is_admin_user {
                    view! { <span class="muted">"all"</span> }.into_any()
                } else {
                    view! {
                        <details class="cat-perms">
                            <summary>{summary}</summary>
                            {category_matrix(cat_rows)}
                            <button
                                class="btn small secondary"
                                style="margin-top:8px"
                                prop:disabled=move || cat_busy.get()
                                on:click=move |_| {
                                    cat_perms.dispatch((id, rows_json(&cat_rows.get_untracked())));
                                }
                            >
                                {move || {
                                    if cat_busy.get() { "Saving…" } else { "Save categories" }
                                }}
                            </button>
                        </details>
                    }
                        .into_any()
                }}
            </td>
            <td>
                {if currently_active {
                    view! {
                        // Blocking someone locks them out immediately — worth a
                        // second click.
                        <ConfirmButton
                            label="Block"
                            confirm_label="Yes, block"
                            pending=active_busy
                            on_confirm=move || {
                                active.dispatch((id, false));
                            }
                        />
                    }
                        .into_any()
                } else {
                    view! {
                        <div class="actions" style="gap:6px">
                            <span class="badge">"blocked"</span>
                            <button
                                class="btn small secondary"
                                prop:disabled=move || active_busy.get()
                                on:click=move |_| {
                                    active.dispatch((id, true));
                                }
                            >
                                "Activate"
                            </button>
                        </div>
                    }
                        .into_any()
                }}
            </td>
            <td>
                <div style="display:flex;gap:6px">
                    <input
                        type="text"
                        placeholder="new password"
                        aria-label="New password"
                        autocomplete="off"
                        prop:value=pw
                        on:input=move |ev| {
                            set_pw.set(event_target_value(&ev));
                            set_reset_done.set(false);
                        }
                    />
                    <button
                        type="button"
                        class="btn small secondary"
                        title="Generate a random password"
                        aria-label="Generate a random password"
                        on:click=move |_| {
                            set_pw.set(generate_password());
                            set_reset_done.set(false);
                        }
                    >
                        "Generate"
                    </button>
                    <button
                        type="button"
                        class="btn small secondary"
                        prop:disabled=move || reset_busy() || pw.get().trim().is_empty()
                        on:click=move |_| {
                            reset.dispatch(());
                        }
                    >
                        {move || if reset_busy() { "Setting…" } else { "Set" }}
                    </button>
                </div>
                <Show when=move || reset_done.get() fallback=|| ()>
                    <span class="success" style="font-size:12px">"Password updated"</span>
                </Show>
                {move || {
                    reset_error()
                        .map(|e| view! { <span class="error" style="font-size:12px">{e}</span> })
                }}
            </td>
        </tr>
    }
}

#[cfg(test)]
mod tests {
    use super::{generate_password, PASSWORD_ALPHABET, PASSWORD_LEN};
    use std::collections::HashSet;

    #[test]
    fn alphabet_excludes_ambiguous_characters() {
        for bad in b"0O1lI" {
            assert!(
                !PASSWORD_ALPHABET.contains(bad),
                "{} is easy to misread and must not be in the alphabet",
                *bad as char
            );
        }
        let unique: HashSet<&u8> = PASSWORD_ALPHABET.iter().collect();
        assert_eq!(unique.len(), PASSWORD_ALPHABET.len(), "duplicate symbol");
    }

    #[test]
    fn generated_passwords_have_the_right_shape() {
        for _ in 0..200 {
            let password = generate_password();
            assert_eq!(password.chars().count(), PASSWORD_LEN);
            assert!(
                password.bytes().all(|b| PASSWORD_ALPHABET.contains(&b)),
                "unexpected symbol in {password}"
            );
        }
    }

    #[test]
    fn generated_passwords_do_not_repeat() {
        let seen: HashSet<String> = (0..500).map(|_| generate_password()).collect();
        assert_eq!(seen.len(), 500, "generator produced a collision");
    }

    /// The rejection sampling should leave every symbol reachable; a modulo
    /// fold would still pass the tests above while quietly biasing the result.
    #[test]
    fn every_symbol_is_reachable() {
        let mut seen = HashSet::new();
        for _ in 0..2000 {
            seen.extend(generate_password().bytes());
        }
        assert_eq!(seen.len(), PASSWORD_ALPHABET.len());
    }
}
