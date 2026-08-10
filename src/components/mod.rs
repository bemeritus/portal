//! Reusable UI components (§10).

mod navbar;
mod theme;
pub use navbar::Navbar;
pub use theme::{provide_theme, Theme, ThemeSignal, ThemeSwitcher, THEME_STORAGE_KEY};
