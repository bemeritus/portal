//! The server room module (DC): rooms built from a catalog of equipment.
//!
//! `model` holds the types; `geometry`, `capacity`, `csv` and `dxf` are pure
//! algorithms with their own tests; `store`, `ops` and `seed` are the database
//! side. The HTTP handlers are in `routes::dc`. Specification:
//! `dc-handoff/SPEC.md`.

pub mod airflow;
pub mod airflow_store;
pub mod capacity;
pub mod csv;
pub mod diff;
pub mod digest;
pub mod dxf;
pub mod geometry;
pub mod model;
pub mod ops;
pub mod seed;
pub mod store;
