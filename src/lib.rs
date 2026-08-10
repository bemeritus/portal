//! Q&A Knowledge Base platform — Leptos full-stack crate root.
//!
//! The same crate compiles two ways:
//!   * `--features ssr`     → the Axum server binary (see `src/main.rs`)
//!   * `--features hydrate` → the wasm bundle that hydrates the SSR'd HTML
//!
//! Server-only code (database, auth guards, upload handling) lives in
//! [`backend`] and is gated behind `ssr`. Server *functions* in [`server`] are
//! compiled in both modes: on the client they become typed RPC stubs.

pub mod app;
pub mod components;
pub mod models;
pub mod pages;
pub mod server;

#[cfg(feature = "ssr")]
pub mod backend;

/// wasm entrypoint — mounts hydration onto the server-rendered `<body>`.
#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    use crate::app::App;
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(App);
}
