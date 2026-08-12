//! Left-hand section rail: Documents / Categories / Users, with logging out
//! parked at its foot (§8).
//!
//! The links used to live in the top bar; they sit here instead so the sections
//! read as a list you scan down rather than a row that runs out of room. It is
//! only rendered for a signed-in user — anonymous visitors have nowhere to go
//! but `/login`, which hides the whole chrome anyway.

use leptos::prelude::*;
use leptos_router::hooks::{use_location, use_navigate};

use crate::app::{use_sidebar, use_user};
use crate::server::auth::logout;

/// One section link that knows whether it points at the current page and
/// closes the mobile rail when followed.
fn side_link(href: &'static str, label: &'static str, open: RwSignal<bool>) -> impl IntoView {
    let path = use_location().pathname;
    view! {
        <a
            href=href
            aria-current=move || if path.get() == href { Some("page") } else { None }
            on:click=move |_| open.set(false)
        >
            {label}
        </a>
    }
}

#[component]
pub fn Sidebar() -> impl IntoView {
    let user = use_user();
    let open = use_sidebar();
    let path = use_location().pathname;
    let logout_action = Action::new(|_: &()| async move { logout().await });
    let navigate = use_navigate();

    // After a successful logout, refresh the user resource and go to /login.
    Effect::new(move |_| {
        if matches!(logout_action.value().get(), Some(Ok(()))) {
            open.set(false);
            user.refetch();
            navigate("/login", Default::default());
        }
    });

    view! {
        <Suspense fallback=|| ()>
            {move || {
                if path.get() == "/login" {
                    return None;
                }
                user.get()
                    .flatten()
                    .map(|u| {
                        let is_admin = u.is_admin;
                        view! {
                            <aside
                                class=move || if open.get() { "sidebar open" } else { "sidebar" }
                                aria-label="Sections"
                            >
                                <nav class="side-links">
                                    {side_link("/", "Documents", open)}
                                    {is_admin.then(|| side_link("/categories", "Categories", open))}
                                    {is_admin.then(|| side_link("/admin/users", "Users", open))}
                                </nav>
                                <div class="side-foot">
                                    <button
                                        class="btn danger"
                                        prop:disabled=move || logout_action.pending().get()
                                        on:click=move |_| {
                                            logout_action.dispatch(());
                                        }
                                    >
                                        {move || {
                                            if logout_action.pending().get() {
                                                "Logging out…"
                                            } else {
                                                "Log out"
                                            }
                                        }}
                                    </button>
                                </div>
                            </aside>
                        }
                    })
            }}
        </Suspense>
    }
}
