//! A destructive-action button that asks before it fires.
//!
//! Deleting a document, dropping a category or blocking a user used to happen
//! on a single click with no way back. This wraps those actions in a two-step
//! flow — the button turns into "Confirm" + "Cancel" — which needs no browser
//! dialog and therefore behaves the same under SSR and hydration.

use leptos::prelude::*;

#[component]
pub fn ConfirmButton<F>(
    /// Label in the resting state, e.g. "Delete".
    #[prop(into)]
    label: String,
    /// Label of the armed button. Defaults to "Confirm".
    #[prop(into, optional)]
    confirm_label: Option<String>,
    /// Extra classes for the resting button (the armed one is always danger).
    #[prop(into, optional)]
    class: Option<String>,
    /// Disables both buttons while the underlying action is in flight.
    #[prop(into, optional)]
    pending: Option<Signal<bool>>,
    /// Runs once the user confirms.
    on_confirm: F,
) -> impl IntoView
where
    F: Fn() + Send + Sync + 'static,
{
    let armed = RwSignal::new(false);
    let confirm_label = confirm_label.unwrap_or_else(|| "Confirm".to_string());
    let class = class.unwrap_or_else(|| "btn small danger".to_string());
    // `Show` re-runs both arms, so the callback has to live somewhere `Copy`.
    let on_confirm = StoredValue::new(on_confirm);
    let is_pending = move || pending.map(|p| p.get()).unwrap_or(false);

    view! {
        <Show
            when=move || armed.get()
            fallback={
                let class = class.clone();
                let label = label.clone();
                move || {
                    view! {
                        <button
                            type="button"
                            class=class.clone()
                            prop:disabled=is_pending
                            on:click=move |_| armed.set(true)
                        >
                            {label.clone()}
                        </button>
                    }
                }
            }
        >
            <span class="actions" style="gap:6px">
                <button
                    type="button"
                    class="btn small danger"
                    prop:disabled=is_pending
                    on:click=move |_| {
                        armed.set(false);
                        on_confirm.with_value(|f| f());
                    }
                >
                    {confirm_label.clone()}
                </button>
                <button
                    type="button"
                    class="btn small secondary"
                    on:click=move |_| armed.set(false)
                >
                    "Cancel"
                </button>
            </span>
        </Show>
    }
}
