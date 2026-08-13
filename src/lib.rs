//! Q&A Knowledge Base platform — Leptos full-stack crate root.
//!
//! The same crate compiles two ways:
//!   * `--features ssr`     → the Axum server binary (see `src/main.rs`)
//!   * `--features hydrate` → the wasm bundle that hydrates the SSR'd HTML
//!
//! Server-only code (database, auth guards, upload handling) lives in
//! [`backend`] and is gated behind `ssr`. Server *functions* in [`server`] are
//! compiled in both modes: on the client they become typed RPC stubs.

// Leptos view! trees monomorphise into deeply nested generic types. The release
// profile inlines far more aggressively than dev, which pushes rustc's layout
// computation past the default depth of 128 — so `cargo leptos build --release`
// fails with "queries overflow the depth limit" while `watch` builds fine.
#![recursion_limit = "256"]

pub mod app;
pub mod components;
pub mod error;
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
