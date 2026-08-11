//! `/login` — the only public page (§8, FR-1..FR-3).

use leptos::prelude::*;
use leptos_meta::Title;
use leptos_router::hooks::use_navigate;

use crate::app::use_user;
use crate::server::auth::login;

#[component]
pub fn LoginPage() -> impl IntoView {
    let (username, set_username) = signal(String::new());
    let (password, set_password) = signal(String::new());
    let user = use_user();
    let navigate = use_navigate();

    let login_action = Action::new(move |(u, p): &(String, String)| {
        let (u, p) = (u.clone(), p.clone());
        async move { login(u, p).await }
    });

    // On success, refresh the shared user and go home.
    Effect::new(move |_| {
        if matches!(login_action.value().get(), Some(Ok(()))) {
            user.refetch();
            navigate("/", Default::default());
        }
    });

    let error = move || match login_action.value().get() {
        Some(Err(e)) => Some(e.to_string()),
        _ => None,
    };

    // Nothing to submit until both fields have something in them — a disabled
    // button is clearer than a round-trip that comes back "invalid credentials".
    let incomplete =
        move || username.get().trim().is_empty() || password.get().trim().is_empty();
    let busy = move || login_action.pending().get();

    view! {
        <Title text="Sign in · Knowledge Base"/>
        <div class="center-narrow panel">
            <h2 style="margin-top:0">"Sign in"</h2>
            <p class="muted">"Accounts are created by an administrator."</p>
            <form on:submit=move |ev| {
                ev.prevent_default();
                if !incomplete() && !busy() {
                    login_action.dispatch((username.get_untracked(), password.get_untracked()));
                }
            }>
                <label for="u">"Username"</label>
                <input
                    id="u"
                    type="text"
                    autocomplete="username"
                    autofocus="true"
                    prop:value=username
                    on:input=move |ev| set_username.set(event_target_value(&ev))
                />
                <label for="p">"Password"</label>
                <input
                    id="p"
                    type="password"
                    autocomplete="current-password"
                    prop:value=password
                    on:input=move |ev| set_password.set(event_target_value(&ev))
                />
                {move || error().map(|e| view! { <p class="flash error">{e}</p> })}
                <div style="margin-top:16px">
                    <button
                        class="btn"
                        type="submit"
                        prop:disabled=move || busy() || incomplete()
                    >
                        <Show when=busy fallback=|| ()>
                            <span class="spinner"></span>
                        </Show>
                        {move || if busy() { "Signing in…" } else { "Log in" }}
                    </button>
                </div>
            </form>
        </div>
    }
}
