//! Top bar: brand, the "New" shortcut, theme switcher and who you are signed
//! in as (§8).
//!
//! The section links live in [`crate::components::Sidebar`], as does logging
//! out; "New" stays up here because it is an action on the current page, not a
//! place to navigate to. On narrow screens the bar also carries the toggle that
//! opens the sidebar, since the rail itself is off-screen until then.

use leptos::prelude::*;
use leptos_router::hooks::use_location;

use crate::app::{use_sidebar, use_user};
use crate::components::ThemeSwitcher;
use crate::models::Permission;

/// A top-bar link that knows whether it points at the current page.
fn nav_link(href: &'static str, label: &'static str) -> impl IntoView {
    let path = use_location().pathname;
    view! {
        <a
            class="nav-link"
            href=href
            aria-current=move || if path.get() == href { Some("page") } else { None }
        >
            {label}
        </a>
    }
}

#[component]
pub fn Navbar() -> impl IntoView {
    let user = use_user();
    let open = use_sidebar();

    view! {
        <nav class="navbar">
            <button
                type="button"
                class="nav-toggle"
                aria-label="Toggle sections"
                aria-expanded=move || if open.get() { "true" } else { "false" }
                on:click=move |_| open.update(|o| *o = !*o)
            >
                "☰"
            </button>
            <a class="brand" href="/" on:click=move |_| open.set(false)>
                "📚 Knowledge Base"
            </a>
            <div class="spacer"></div>
            <div class="nav-tools">
                <Suspense fallback=|| ()>
                    {move || {
                        user.get()
                            .map(|maybe| match maybe {
                                None => nav_link("/login", "Log in").into_any(),
                                Some(u) => {
                                    let can_write = u.has_anywhere(Permission::Write);
                                    can_write.then(|| nav_link("/docs/new", "New")).into_any()
                                }
                            })
                    }}
                </Suspense>
                <ThemeSwitcher/>
                <Suspense fallback=|| ()>
                    {move || {
                        user.get()
                            .flatten()
                            .map(|u| {
                                view! {
                                    <span class="who" title="Signed in as">
                                        {u.username}
                                    </span>
                                }
                            })
                    }}
                </Suspense>
            </div>
        </nav>
    }
}
