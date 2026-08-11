//! Reusable UI components (§10).

mod confirm;
mod navbar;
mod theme;
pub use confirm::ConfirmButton;
pub use navbar::Navbar;
pub use theme::{provide_theme, Theme, ThemeSignal, ThemeSwitcher, THEME_STORAGE_KEY};
