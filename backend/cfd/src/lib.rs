//! The airflow model's pure algorithms (SPEC §14.2), shared by the API and
//! the worker: the OpenFOAM case generated from a room ([`input`],
//! [`case`]), the solver's files read back ([`foam`]), the result
//! ([`post`], [`grid`]) and the convergence checks ([`checks`]).
//!
//! A port of `dc-handoff/reference/airflow-cfd/`. OpenFOAM is the solver;
//! nothing here solves the flow.

pub mod case;
pub mod checks;
pub mod foam;
pub mod grid;
pub mod input;
pub mod post;
pub mod reference;
pub mod summary;
