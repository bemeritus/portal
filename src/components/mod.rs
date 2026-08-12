//! Reusable UI components (§10).

mod confirm;
mod navbar;
mod sidebar;
mod theme;
pub use confirm::ConfirmButton;
pub use navbar::Navbar;
pub use sidebar::Sidebar;
pub use theme::{provide_theme, Theme, ThemeSignal, ThemeSwitcher, THEME_STORAGE_KEY};
