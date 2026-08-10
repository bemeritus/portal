//! `#[server]` functions — the typed RPC boundary (§7).
//!
//! These are compiled for both targets: on the server the body runs; on the
//! client the macro generates a stub that performs the network call. Every
//! function that touches data first passes through a guard in
//! [`crate::backend`] (SR-3).

pub mod auth;
pub mod categories;
pub mod documents;
pub mod users;
