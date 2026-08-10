//! Theme selection: Dark, White, and White-Blue.
//!
//! The chosen theme is reflected as a `data-theme` attribute on the `<html>`
//! element (CSS variables in `style/main.css` do the rest) and persisted to
//! `localStorage`. To avoid a flash of the wrong theme, an inline script in the
//! document shell (see [`crate::app::shell`]) applies the stored value before
//! hydration; this module keeps it in sync afterwards.

use leptos::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
    Blue,
}

impl Theme {
    pub const ALL: [Theme; 3] = [Theme::Dark, Theme::Light, Theme::Blue];

    /// The `data-theme` / storage value.
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
            Theme::Blue => "blue",
        }
    }

    pub fn from_str(s: &str) -> Theme {
        match s {
            "light" => Theme::Light,
            "blue" => Theme::Blue,
            _ => Theme::Dark,
        }
    }

    /// Human-readable label for the switcher.
    pub fn label(self) -> &'static str {
        match self {
            Theme::Dark => "Dark",
            Theme::Light => "White",
            Theme::Blue => "White-Blue",
        }
    }
}

/// Key used in `localStorage` and in the shell bootstrap script.
pub const THEME_STORAGE_KEY: &str = "theme";

pub type ThemeSignal = RwSignal<Theme>;

/// Create the theme signal, provide it via context, and (on the client) load
/// the stored preference and reflect any change back to the DOM + storage.
pub fn provide_theme() -> ThemeSignal {
    let theme: ThemeSignal = RwSignal::new(Theme::Dark);
    provide_context(theme);

    #[cfg(feature = "hydrate")]
    {
        if let Some(stored) = read_stored() {
            theme.set(Theme::from_str(&stored));
        }
        Effect::new(move |_| {
            apply(theme.get().as_str());
        });
    }

    theme
}

#[cfg(feature = "hydrate")]
fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

#[cfg(feature = "hydrate")]
fn read_stored() -> Option<String> {
    local_storage()?.get_item(THEME_STORAGE_KEY).ok().flatten()
}

#[cfg(feature = "hydrate")]
fn apply(theme: &str) {
    if let Some(el) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.document_element())
    {
        let _ = el.set_attribute("data-theme", theme);
    }
    if let Some(storage) = local_storage() {
        let _ = storage.set_item(THEME_STORAGE_KEY, theme);
    }
}

/// A compact dropdown that switches the active theme.
#[component]
pub fn ThemeSwitcher() -> impl IntoView {
    let theme = expect_context::<ThemeSignal>();
    view! {
        <select
            class="theme-select"
            title="Theme"
            prop:value=move || theme.get().as_str()
            on:change=move |ev| theme.set(Theme::from_str(&event_target_value(&ev)))
        >
            {Theme::ALL
                .iter()
                .map(|t| view! { <option value=t.as_str()>{t.label()}</option> })
                .collect_view()}
        </select>
    }
}
