//! Convergence checks (SPEC §14.2): residuals below thresholds, the energy
//! and mass balances, intake temperatures stable over the averaging window.
//! A run that fails any of them is not shown as a result.
//!
//! The flow in a room is pseudo-steady: it keeps moving around a mean. So
//! every number is a mean over the last window of iterations, and stability
//! is judged on means (the window's two halves), never on single iterations.
//! The inputs: the solver's log (residuals), the averaged fields at the
//! middle and the end of the window, and the intake probes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::case::RHO_CP;
use crate::input::CaseInput;

/// Mean initial residual over the averaging window, per equation. The
/// buoyant room flow is pseudo-steady, so the residuals level off instead
/// of dropping to the solver's tolerance; these limits accept the plateau
/// of the reference run and reject a solution that is still moving.
pub const RESIDUAL_LIMITS: [(&str, f64); 5] = [
    ("p_rgh", 2e-2),
    ("U", 5e-3),
    ("T", 5e-3),
    ("k", 5e-3),
    ("epsilon", 5e-3),
];
/// Heat in vs heat carried out by the units, % of the heat in.
pub const ENERGY_LIMIT_PCT: f64 = 3.0;
/// Net flow through all openings, % of the supply flow.
pub const MASS_LIMIT_PCT: f64 = 1.0;
/// The largest change of an intake band's mean temperature between the
/// two halves of the averaging window, K. A run whose bands move more is
/// extended by another window, up to the worker's cap.
pub const DRIFT_LIMIT_K: f64 = 0.5;

/// Reads the solver's log as it arrives: the iteration, and each
/// equation's first initial residual of that iteration (`U` is the largest
/// of its components).
#[derive(Default)]
pub struct Residuals {
    pub iteration: i32,
    /// Per iteration, per equation.
    pub history: Vec<(i32, BTreeMap<String, f64>)>,
}

impl Residuals {
    pub fn line(&mut self, line: &str) {
        if let Some(t) = line.strip_prefix("Time = ") {
            if let Ok(i) = t.trim().parse::<f64>() {
                self.iteration = i as i32;
                self.history.push((self.iteration, BTreeMap::new()));
            }
            return;
        }
        let Some(rest) = line.split("Solving for ").nth(1) else {
            return;
        };
        let Some((field, tail)) = rest.split_once(',') else {
            return;
        };
        let Some(value) = tail
            .split("Initial residual = ")
            .nth(1)
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<f64>().ok())
        else {
            return;
        };
        let field = match field.trim() {
            "Ux" | "Uy" | "Uz" => "U",
            f => f,
        };
        if let Some((_, m)) = self.history.last_mut() {
            let e = m.entry(field.to_string());
            match e {
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert(value);
                }
                std::collections::btree_map::Entry::Occupied(mut o) if field == "U" => {
                    let v = o.get_mut();
                    *v = v.max(value);
                }
                _ => {}
            }
        }
    }

    /// Each equation's residual in the last complete iteration (the one
    /// being printed is not complete yet).
    pub fn latest(&self) -> BTreeMap<String, f64> {
        let done = self.history.len().saturating_sub(2);
        self.history
            .get(done)
            .map(|(_, m)| m.clone())
            .unwrap_or_default()
    }

    /// The mean of each equation's residual over iterations `> from`.
    pub fn mean_after(&self, from: i32) -> BTreeMap<String, f64> {
        let mut sum: BTreeMap<String, (f64, u32)> = BTreeMap::new();
        for (_, m) in self.history.iter().filter(|(i, _)| *i > from) {
            for (k, v) in m {
                let e = sum.entry(k.clone()).or_default();
                e.0 += v;
                e.1 += 1;
            }
        }
        sum.into_iter()
            .map(|(k, (s, n))| (k, s / n as f64))
            .collect()
    }
}

/// A function object's `.dat` file: rows of numbers after `#` comments.
/// Returns (time, values) per row.
pub fn dat_rows(text: &str) -> Vec<(f64, Vec<f64>)> {
    text.lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(|t| t.parse::<f64>());
            let time = it.next()?.ok()?;
            let vals: Option<Vec<f64>> = it.map(|v| v.ok()).collect();
            Some((time, vals?))
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub value: f64,
    pub limit: f64,
    pub ok: bool,
}

impl Check {
    fn at_most(value: f64, limit: f64) -> Check {
        Check {
            value,
            limit,
            ok: value.is_finite() && value <= limit,
        }
    }
}

/// One intake band's mean over each half of the averaging window, °C.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Halves {
    pub object_id: i64,
    pub name: String,
    pub height: String,
    pub first: f64,
    pub second: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Checks {
    /// The iterations averaged, `(from, to]`.
    pub window: [i32; 2],
    /// Mean initial residual per equation over the window.
    pub residuals: BTreeMap<String, Check>,
    pub heat_in_w: f64,
    /// Carried out through the grilles, from the averaged fields.
    pub heat_removed_w: f64,
    /// |in − removed| / in, %.
    pub energy_balance_pct: Check,
    /// |Σ flux| / supply flow, %.
    pub mass_balance_pct: Check,
    /// The largest difference between a band's means over the two halves
    /// of the window, K.
    pub intake_drift_k: Check,
    pub halves: Vec<Halves>,
}

/// Why a run is not shown as a result; the UI translates the code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Residuals,
    EnergyBalance,
    MassBalance,
    IntakeDrift,
}

impl Checks {
    pub fn failure(&self) -> Option<Failure> {
        if !self.energy_balance_pct.ok {
            Some(Failure::EnergyBalance)
        } else if !self.mass_balance_pct.ok {
            Some(Failure::MassBalance)
        } else if self.residuals.values().any(|c| !c.ok) {
            Some(Failure::Residuals)
        } else if !self.intake_drift_k.ok {
            Some(Failure::IntakeDrift)
        } else {
            None
        }
    }
}

/// The averaged fields on one opening patch: φ (m³/s per face, out of the
/// room positive) and T (K) per face.
pub struct Opening {
    pub phi: Vec<f64>,
    pub t: Vec<f64>,
}

/// Heat carried out through the openings, W, and the net flow out, m³/s:
/// Σ φ·(T − T_supply) over every face, so a small net flux does not count
/// as heat.
pub fn heat_removed(input: &CaseInput, openings: &[Opening]) -> (f64, f64) {
    let ts = 273.15 + input.supply_temp_c;
    let mut heat = 0.0;
    let mut net = 0.0;
    for o in openings {
        for (phi, t) in o.phi.iter().zip(&o.t) {
            heat += RHO_CP * phi * (t - ts);
            net += phi;
        }
    }
    (heat, net)
}

/// The checks of one window. `first` and `second` are each rack's intake
/// band means (top, mid, bottom) over the window's halves.
pub fn evaluate(
    input: &CaseInput,
    window: [i32; 2],
    residuals: &Residuals,
    (removed, net): (f64, f64),
    first: &[[f64; 3]],
    second: &[[f64; 3]],
) -> Checks {
    let heat_in = input.heat_in_w();
    let supply: f64 = input
        .units
        .iter()
        .map(|u| u.airflow_m3h as f64 / 3600.0)
        .sum();
    let energy = if heat_in > 0.0 {
        100.0 * (heat_in - removed).abs() / heat_in
    } else {
        0.0
    };
    let mean = residuals.mean_after(window[0]);
    let residuals = RESIDUAL_LIMITS
        .iter()
        .map(|&(k, limit)| {
            let v = mean.get(k).copied().unwrap_or(f64::NAN);
            (k.to_string(), Check::at_most(v, limit))
        })
        .collect();
    let mut halves = vec![];
    for (i, r) in input.racks.iter().enumerate() {
        for (k, (height, _)) in crate::post::HEIGHTS.iter().enumerate() {
            halves.push(Halves {
                object_id: r.object_id,
                name: r.name.clone(),
                height: height.to_string(),
                first: round2(first[i][k]),
                second: round2(second[i][k]),
            });
        }
    }
    let drift = input
        .racks
        .iter()
        .enumerate()
        .flat_map(|(i, _)| (0..3).map(move |k| (first[i][k] - second[i][k]).abs()))
        .fold(0.0, f64::max);
    Checks {
        window,
        residuals,
        heat_in_w: heat_in.round(),
        heat_removed_w: removed.round(),
        energy_balance_pct: Check::at_most(round2(energy), ENERGY_LIMIT_PCT),
        mass_balance_pct: Check::at_most(
            (100.0 * net.abs() / supply * 1000.0).round() / 1000.0,
            MASS_LIMIT_PCT,
        ),
        intake_drift_k: Check::at_most(round2(drift), DRIFT_LIMIT_K),
        halves,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// The mean over the second half of a window from the mean over the first
/// half (`n1` iterations) and the mean over all of it (`n2`).
pub fn second_half(first: f64, all: f64, n1: i64, n2: i64) -> f64 {
    (n2 as f64 * all - n1 as f64 * first) / (n2 - n1) as f64
}

/// Each intake band's fluctuation over the window `(from, to]`, from the
/// intake probes (five per band, in [`crate::case::probe_points`] order).
pub fn fluctuations(
    input: &CaseInput,
    probes: &[(f64, Vec<f64>)],
    window: [i32; 2],
) -> Vec<[crate::post::Fluctuation; 3]> {
    const PER_BAND: usize = 5;
    let rows: Vec<&Vec<f64>> = probes
        .iter()
        .filter(|(t, v)| {
            *t > window[0] as f64
                && *t <= window[1] as f64
                && v.len() >= input.racks.len() * 3 * PER_BAND
        })
        .map(|(_, v)| v)
        .collect();
    (0..input.racks.len())
        .map(|i| {
            [0, 1, 2].map(|k| {
                let b = (i * 3 + k) * PER_BAND;
                let series: Vec<f64> = rows
                    .iter()
                    .map(|r| r[b..b + PER_BAND].iter().sum::<f64>() / PER_BAND as f64)
                    .collect();
                if series.is_empty() {
                    return crate::post::Fluctuation::default();
                }
                let n = series.len() as f64;
                let mean = series.iter().sum::<f64>() / n;
                let var = series.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
                let (lo, hi) = series
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| {
                        (a.min(v), b.max(v))
                    });
                crate::post::Fluctuation {
                    std: var.sqrt(),
                    below: mean - lo,
                    above: hi - mean,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::CaseInput;

    #[test]
    fn the_log_gives_one_residual_per_equation_and_iteration() {
        let mut r = Residuals::default();
        for l in [
            "Time = 1500",
            "",
            "smoothSolver:  Solving for Ux, Initial residual = 0.0015, Final residual = 5e-05, No Iterations 1",
            "smoothSolver:  Solving for Uy, Initial residual = 0.0021, Final residual = 3e-05, No Iterations 1",
            "smoothSolver:  Solving for Uz, Initial residual = 0.0009, Final residual = 3e-05, No Iterations 1",
            "GAMG:  Solving for p_rgh, Initial residual = 0.008, Final residual = 5e-05, No Iterations 3",
            "GAMG:  Solving for p_rgh, Initial residual = 0.0003, Final residual = 2e-06, No Iterations 4",
            "Time = 1501",
            "GAMG:  Solving for p_rgh, Initial residual = 0.004, Final residual = 5e-05, No Iterations 3",
        ] {
            r.line(l);
        }
        assert_eq!(r.iteration, 1501);
        assert_eq!(r.history[0].1["U"], 0.0021);
        assert_eq!(r.history[0].1["p_rgh"], 0.008);
        assert_eq!(r.mean_after(1499)["p_rgh"], 0.006);
        // 1501 is still being printed: the last complete one is 1500.
        assert_eq!(r.latest()["p_rgh"], 0.008);
    }

    fn residuals_at(level: f64) -> Residuals {
        let mut r = Residuals::default();
        for i in 1490..=2000 {
            r.line(&format!("Time = {i}"));
            for f in ["Ux", "T", "p_rgh", "k", "epsilon"] {
                let v = if f == "p_rgh" { 5.0 * level } else { level };
                r.line(&format!(
                    "s:  Solving for {f}, Initial residual = {v}, Final residual = 0, No Iterations 1"
                ));
            }
        }
        r
    }

    fn input() -> CaseInput {
        crate::reference::reference_input()
    }

    #[test]
    fn a_settled_window_passes() {
        let c = input();
        let first = vec![[30.0, 25.0, 22.0]; c.racks.len()];
        let second = vec![[30.4, 24.8, 22.0]; c.racks.len()];
        let r = residuals_at(1e-3);
        let ch = evaluate(&c, [1500, 2000], &r, (13_000.0, 1e-6), &first, &second);
        assert_eq!(ch.failure(), None, "{ch:?}");
        assert_eq!(ch.energy_balance_pct.value, 1.07);
        assert_eq!(ch.intake_drift_k.value, 0.4);
        assert_eq!(ch.halves.len(), 12);
    }

    #[test]
    fn each_check_can_fail_the_run() {
        let c = input();
        let ok = vec![[30.0, 25.0, 22.0]; c.racks.len()];
        let r = residuals_at(1e-3);
        // 4.9 % of the heat unaccounted for.
        let ch = evaluate(&c, [1500, 2000], &r, (12_492.0, 0.0), &ok, &ok);
        assert_eq!(ch.failure(), Some(Failure::EnergyBalance));
        // 2 % of the supply flow lost.
        let ch = evaluate(&c, [1500, 2000], &r, (13_000.0, 0.0183), &ok, &ok);
        assert_eq!(ch.failure(), Some(Failure::MassBalance));
        // Residuals still high.
        let high = residuals_at(1e-2);
        let ch = evaluate(&c, [1500, 2000], &high, (13_000.0, 0.0), &ok, &ok);
        assert_eq!(ch.failure(), Some(Failure::Residuals));
        // One band's halves 2.35 K apart (rack 2 top in the v2606 reference).
        let mut second = ok.clone();
        second[1][0] += 2.35;
        let ch = evaluate(&c, [1500, 2000], &r, (13_000.0, 0.0), &ok, &second);
        assert_eq!(ch.failure(), Some(Failure::IntakeDrift));
        assert_eq!(ch.intake_drift_k.value, 2.35);
        // No residuals at all is not a pass.
        let none = Residuals::default();
        let ch = evaluate(&c, [1500, 2000], &none, (13_000.0, 0.0), &ok, &ok);
        assert_eq!(ch.failure(), Some(Failure::Residuals));
    }

    #[test]
    fn the_second_half_comes_from_the_two_written_means() {
        // fieldAverage from 1500: 251 iterations at 1750, 501 at 2000.
        let (first, second) = (30.0, 32.0);
        let all = (251.0 * first + 250.0 * second) / 501.0;
        assert!((second_half(first, all, 251, 501) - second).abs() < 1e-9);
    }

    #[test]
    fn heat_out_counts_only_air_warmer_than_the_supply() {
        let c = input();
        // In through a supply at 17 °C, out through a return at 27 °C.
        let ts = 273.15 + 17.0;
        let o = [
            Opening {
                phi: vec![-0.3],
                t: vec![ts],
            },
            Opening {
                phi: vec![0.2, 0.1],
                t: vec![ts + 10.0, ts + 10.0],
            },
        ];
        let (heat, net) = heat_removed(&c, &o);
        assert!((heat - RHO_CP * 0.3 * 10.0).abs() < 1e-6);
        assert!(net.abs() < 1e-12);
    }

    #[test]
    fn fluctuation_is_taken_over_the_window_only() {
        let c = input();
        let n = c.racks.len() * 3 * 5;
        let probes: Vec<(f64, Vec<f64>)> = (1400..=2000)
            .map(|t| {
                // ±1 K inside the window, far off before it.
                let v = if t <= 1500 {
                    350.0
                } else if t % 2 == 0 {
                    301.0
                } else {
                    299.0
                };
                (t as f64, vec![v; n])
            })
            .collect();
        let f = fluctuations(&c, &probes, [1500, 2000]);
        assert!((f[0][0].std - 1.0).abs() < 1e-9);
        assert!((f[0][0].below - 1.0).abs() < 1e-9 && (f[0][0].above - 1.0).abs() < 1e-9);
    }

    #[test]
    fn dat_files_skip_their_comments() {
        let rows = dat_rows("# Surface field value\n# Time sum(phi)\n1 0.25\n2\t-0.5\n");
        assert_eq!(rows, vec![(1.0, vec![0.25]), (2.0, vec![-0.5])]);
    }
}
