//! The result of a run as stored and served (`summary` of a run): the
//! numbers, the checks, and everything needed to reproduce it.

use serde::{Deserialize, Serialize};

use crate::checks::{Checks, Unstable};
use crate::grid::Header;
use crate::input::{Assumption, Settings};
use crate::post::Numbers;

/// The format of [`Summary`]; bumped when it changes incompatibly.
pub const VERSION: u32 = 1;

/// What kind of flow the numbers describe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flow {
    /// The buoyant room flow keeps moving around a mean: every number is a
    /// mean over `checks.window`, and each intake band carries its
    /// fluctuation over that window.
    PseudoSteady,
}

/// Wall-clock seconds, to 0.1 s.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Timings {
    pub mesh: f64,
    pub solve: f64,
    pub post: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub version: u32,
    #[serde(flatten)]
    pub numbers: Numbers,
    pub flow: Flow,
    pub checks: Checks,
    /// Intake bands whose mean was still uncertain (95 % half-width over
    /// the limit) when the run reached its cap: shown with their interval,
    /// flagged unstable.
    pub unstable: Vec<Unstable>,
    pub settings: Settings,
    /// Iterations solved (more than `settings.iterations` when the window
    /// had to be extended).
    pub iterations: i32,
    /// MPI processes (from the settings).
    pub processes: usize,
    /// The solver image, by digest.
    pub image: String,
    pub solver: String,
    pub timings_s: Timings,
    pub grid: Header,
    pub assumptions: Vec<Assumption>,
}
