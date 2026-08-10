//! Top navigation bar. Reads the shared current-user resource and shows links
//! gated by role/permission (§8).

use leptos::prelude::*;
use leptos_router::hooks::use_navigate;

use crate::app::use_user;
use crate::components::ThemeSwitcher;
use crate::server::auth::logout;

#[component]
pub fn Navbar() -> impl IntoView {
    let user = use_user();
    let logout_action = Action::new(|_: &()| async move { logout().await });
    let navigate = use_navigate();

    // After a successful logout, refresh the user resource and go to /login.
    Effect::new(move |_| {
        if matches!(logout_action.value().get(), Some(Ok(()))) {
            user.refetch();
            navigate("/login", Default::default());
        }
    });

    view! {
        <nav class="navbar">
            <a class="brand" href="/">"📚 Knowledge Base"</a>
            <div class="spacer"></div>
            <ThemeSwitcher/>
            <Suspense fallback=|| ()>
                {move || {
                    user.get().map(|maybe| match maybe {
                        None => view! { <a href="/login">"Log in"</a> }.into_any(),
                        Some(u) => {
                            let can_write = u.is_admin || u.can_write;
                            let is_admin = u.is_admin;
                            let username = u.username.clone();
                            view! {
                                <a href="/">"Documents"</a>
                                {can_write.then(|| view! { <a href="/docs/new">"New"</a> })}
                                {is_admin.then(|| view! { <a href="/categories">"Categories"</a> })}
                                {is_admin.then(|| view! { <a href="/admin/users">"Users"</a> })}
                                <span class="who">{username}</span>
                                <button
                                    class="btn small secondary"
                                    on:click=move |_| { logout_action.dispatch(()); }
                                >
                                    "Log out"
                                </button>
                            }
                            .into_any()
                        }
                    })
                }}
            </Suspense>
        </nav>
    }
}
