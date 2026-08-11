//! Top navigation bar. Reads the shared current-user resource and shows links
//! gated by role/permission (§8).
//!
//! On narrow screens the links collapse behind a toggle so the bar never
//! overflows; the current route is marked with `aria-current="page"`, which
//! both screen readers and the stylesheet pick up.

use leptos::prelude::*;
use leptos_router::hooks::{use_location, use_navigate};

use crate::app::use_user;
use crate::components::ThemeSwitcher;
use crate::server::auth::logout;

/// One navigation link that knows whether it points at the current page and
/// closes the mobile menu when followed.
fn nav_link(href: &'static str, label: &'static str, open: RwSignal<bool>) -> impl IntoView {
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
pub fn Navbar() -> impl IntoView {
    let user = use_user();
    let logout_action = Action::new(|_: &()| async move { logout().await });
    let navigate = use_navigate();
    let open = RwSignal::new(false);

    // After a successful logout, refresh the user resource and go to /login.
    Effect::new(move |_| {
        if matches!(logout_action.value().get(), Some(Ok(()))) {
            open.set(false);
            user.refetch();
            navigate("/login", Default::default());
        }
    });

    view! {
        <nav class=move || if open.get() { "navbar open" } else { "navbar" }>
            <a class="brand" href="/" on:click=move |_| open.set(false)>
                "📚 Knowledge Base"
            </a>
            <div class="spacer"></div>
            <div class="nav-tools">
                <ThemeSwitcher/>
                <button
                    type="button"
                    class="nav-toggle"
                    aria-label="Toggle navigation"
                    aria-expanded=move || if open.get() { "true" } else { "false" }
                    on:click=move |_| open.update(|o| *o = !*o)
                >
                    "☰"
                </button>
            </div>
            <div class="nav-links">
                <Suspense fallback=|| ()>
                    {move || {
                        user.get()
                            .map(|maybe| match maybe {
                                None => nav_link("/login", "Log in", open).into_any(),
                                Some(u) => {
                                    let can_write = u.has_anywhere(crate::models::Permission::Write);
                                    let is_admin = u.is_admin;
                                    let username = u.username.clone();
                                    view! {
                                        {nav_link("/", "Documents", open)}
                                        {can_write.then(|| nav_link("/docs/new", "New", open))}
                                        {is_admin.then(|| nav_link("/categories", "Categories", open))}
                                        {is_admin.then(|| nav_link("/admin/users", "Users", open))}
                                        <span class="who" title="Signed in as">
                                            {username}
                                        </span>
                                        <button
                                            class="btn small secondary"
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
                                    }
                                        .into_any()
                                }
                            })
                    }}
                </Suspense>
            </div>
        </nav>
    }
}
