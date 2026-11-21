//! Convergence checks and the uncertainty of the result (SPEC §14.2).
//!
//! The flow in a room is pseudo-steady: it keeps moving around a mean, some
//! intake bands by more than a degree. So every number is a mean over a
//! window of iterations, and how far that mean can be trusted is an
//! uncertainty, not a failure: per intake band, the 95 % interval of the
//! window mean by batch means. A run is extended while a band's interval is
//! wider than ±[`HALF_WIDTH_LIMIT_K`]; at the cap it is still a result,
//! with those bands flagged unstable.
//!
//! A run is not a result ("not converged") only for real failures:
//! residuals above their limits or growing, the energy balance off by more
//! than 3 %, a diverged solution (NaN, a solver crash), a timeout.
//!
//! The inputs: the solver's log (residuals), the averaged fields at the end
//! of the window (the energy balance through the grilles), and the intake
//! probes (every iteration).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::case::RHO_CP;
use crate::input::CaseInput;
use crate::post::Fluctuation;

/// Mean initial residual over the averaging window, per equation. The
/// buoyant room flow is pseudo-steady, so the residuals level off instead
/// of dropping to the solver's tolerance; these limits accept the plateau
/// of the reference run (8·10⁻³, 1.6·10⁻³, 1.1·10⁻³, 1.7·10⁻³, 6·10⁻⁴).
pub const RESIDUAL_LIMITS: [(&str, f64); 5] = [
    ("p_rgh", 2e-2),
    ("U", 5e-3),
    ("T", 5e-3),
    ("k", 5e-3),
    ("epsilon", 5e-3),
];
/// Residuals growing: the window's second half over its first.
pub const GROWTH_FACTOR: f64 = 2.0;
/// Heat in vs heat carried out by the units, % of the heat in.
pub const ENERGY_LIMIT_PCT: f64 = 3.0;
/// The widest 95 % half-width of a band mean the run is not extended for, K.
pub const HALF_WIDTH_LIMIT_K: f64 = 1.0;
/// Batch means: between 5 and 10 batches, the most whose means have a lag-1
/// autocorrelation of at most this.
pub const BATCHES_MIN: usize = 5;
pub const BATCHES_MAX: usize = 10;
pub const BATCH_AUTOCORR_LIMIT: f64 = 0.2;

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

    /// The mean of each equation's residual over iterations `(from, to]`.
    pub fn between(&self, from: i32, to: i32) -> BTreeMap<String, f64> {
        let mut sum: BTreeMap<String, (f64, u32)> = BTreeMap::new();
        for (_, m) in self.history.iter().filter(|(i, _)| *i > from && *i <= to) {
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

/// A band whose mean is still uncertain at the cap.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Unstable {
    pub object_id: i64,
    pub name: String,
    pub height: String,
    pub half_width: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Checks {
    /// The iterations averaged, `(from, to]`.
    pub window: [i32; 2],
    /// Mean initial residual per equation over the window.
    pub residuals: BTreeMap<String, Check>,
    /// Equations whose residual over the window's second half is more than
    /// [`GROWTH_FACTOR`] times that over its first half.
    pub residuals_growing: Vec<String>,
    pub heat_in_w: f64,
    /// Carried out through the grilles, from the averaged fields.
    pub heat_removed_w: f64,
    /// |in − removed| / in, %.
    pub energy_balance_pct: Check,
    /// |Σ flux| / supply flow, %. Reported; the pressure-outlet returns
    /// close it by construction.
    pub mass_balance_pct: f64,
    /// A field or a balance is not a number.
    pub diverged: bool,
    /// The widest 95 % half-width of a band mean, K, against the limit the
    /// run is extended for.
    pub half_width_k: Check,
    /// Bands wider than the limit (flagged unstable in the result when the
    /// run ends at the cap).
    pub wide: Vec<Unstable>,
}

/// Why a run is not a result; the UI translates the code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Diverged,
    EnergyBalance,
    Residuals,
    ResidualsGrowing,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::Diverged => "diverged",
            Failure::EnergyBalance => "energy_balance",
            Failure::Residuals => "residuals",
            Failure::ResidualsGrowing => "residuals_growing",
        }
    }
}

impl Checks {
    /// A real failure: the run is not a result. An uncertain mean is not
    /// one (see [`Checks::uncertain`]).
    pub fn failure(&self) -> Option<Failure> {
        if self.diverged {
            Some(Failure::Diverged)
        } else if !self.energy_balance_pct.ok {
            Some(Failure::EnergyBalance)
        } else if self.residuals.values().any(|c| !c.ok) {
            Some(Failure::Residuals)
        } else if !self.residuals_growing.is_empty() {
            Some(Failure::ResidualsGrowing)
        } else {
            None
        }
    }

    /// Some band's mean is still wider than the limit: worth more iterations.
    pub fn uncertain(&self) -> bool {
        !self.half_width_k.ok
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

/// The checks of the window `(from, to]`; `fluct` per rack and band.
pub fn evaluate(
    input: &CaseInput,
    window: [i32; 2],
    residuals: &Residuals,
    (removed, net): (f64, f64),
    fluct: &[[Fluctuation; 3]],
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
    let mean = residuals.between(window[0], window[1]);
    let mid = (window[0] + window[1]) / 2;
    let (first, second) = (
        residuals.between(window[0], mid),
        residuals.between(mid, window[1]),
    );
    let residual_checks: BTreeMap<String, Check> = RESIDUAL_LIMITS
        .iter()
        .map(|&(k, limit)| {
            let v = mean.get(k).copied().unwrap_or(f64::NAN);
            (k.to_string(), Check::at_most(v, limit))
        })
        .collect();
    let growing = RESIDUAL_LIMITS
        .iter()
        .filter(|(k, _)| match (first.get(*k), second.get(*k)) {
            (Some(a), Some(b)) => *b > GROWTH_FACTOR * a,
            _ => false,
        })
        .map(|(k, _)| k.to_string())
        .collect();
    let mut wide = vec![];
    let mut widest: f64 = 0.0;
    for (i, r) in input.racks.iter().enumerate() {
        for (k, (height, _)) in crate::post::HEIGHTS.iter().enumerate() {
            let hw = fluct.get(i).map_or(f64::NAN, |f| f[k].half_width);
            widest = widest.max(hw);
            if hw.is_nan() || hw > HALF_WIDTH_LIMIT_K {
                wide.push(Unstable {
                    object_id: r.object_id,
                    name: r.name.clone(),
                    height: height.to_string(),
                    half_width: round2(hw),
                });
            }
        }
    }
    let diverged =
        !removed.is_finite() || !net.is_finite() || mean.values().any(|v| !v.is_finite());
    Checks {
        window,
        residuals: residual_checks,
        residuals_growing: growing,
        heat_in_w: heat_in.round(),
        heat_removed_w: if removed.is_finite() {
            removed.round()
        } else {
            removed
        },
        energy_balance_pct: Check::at_most(round2(energy), ENERGY_LIMIT_PCT),
        mass_balance_pct: (100.0 * net.abs() / supply * 1000.0).round() / 1000.0,
        diverged,
        half_width_k: Check::at_most(
            if wide.iter().any(|w| w.half_width.is_nan()) {
                f64::NAN
            } else {
                round2(widest)
            },
            HALF_WIDTH_LIMIT_K,
        ),
        wide,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Student's t, two-sided 95 %, for 4…9 degrees of freedom.
fn t95(df: usize) -> f64 {
    [2.776, 2.571, 2.447, 2.365, 2.306, 2.262][df.clamp(4, 9) - 4]
}

/// The uncertainty of a series' mean by batch means: the most batches
/// (10 down to 5) whose means have a lag-1 autocorrelation of at most
/// [`BATCH_AUTOCORR_LIMIT`]; the 95 % half-width is t·s/√b over the batch
/// means. The oldest samples that do not fill a batch are left out.
pub struct BatchMeans {
    pub half_width: f64,
    pub batches: usize,
    pub lag1: f64,
    pub correlated: bool,
}

pub fn batch_means(series: &[f64]) -> BatchMeans {
    let estimate = |b: usize| -> Option<(f64, f64)> {
        let size = series.len() / b;
        if size < 2 {
            return None;
        }
        let tail = &series[series.len() - size * b..];
        let means: Vec<f64> = tail
            .chunks(size)
            .map(|c| c.iter().sum::<f64>() / size as f64)
            .collect();
        let m = means.iter().sum::<f64>() / b as f64;
        let ss: f64 = means.iter().map(|x| (x - m).powi(2)).sum();
        let lag1 = if ss > 0.0 {
            means
                .windows(2)
                .map(|w| (w[0] - m) * (w[1] - m))
                .sum::<f64>()
                / ss
        } else {
            0.0
        };
        let sd = (ss / (b - 1) as f64).sqrt();
        Some((t95(b - 1) * sd / (b as f64).sqrt(), lag1))
    };
    for b in (BATCHES_MIN..=BATCHES_MAX).rev() {
        if let Some((hw, lag1)) = estimate(b)
            && lag1 <= BATCH_AUTOCORR_LIMIT
        {
            return BatchMeans {
                half_width: hw,
                batches: b,
                lag1,
                correlated: false,
            };
        }
    }
    match estimate(BATCHES_MIN) {
        Some((hw, lag1)) => BatchMeans {
            half_width: hw,
            batches: BATCHES_MIN,
            lag1,
            correlated: true,
        },
        None => BatchMeans {
            half_width: f64::NAN,
            batches: 0,
            lag1: f64::NAN,
            correlated: true,
        },
    }
}

/// Each intake band over the window `(from, to]`, from the intake probes
/// (five per band, in [`crate::case::probe_points`] order): how much it
/// moved, and the uncertainty of its mean.
pub fn fluctuations(
    input: &CaseInput,
    probes: &[(f64, Vec<f64>)],
    window: [i32; 2],
) -> Vec<[Fluctuation; 3]> {
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
                    return Fluctuation {
                        half_width: f64::NAN,
                        correlated: true,
                        ..Fluctuation::default()
                    };
                }
                let n = series.len() as f64;
                let mean = series.iter().sum::<f64>() / n;
                let var = series.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
                let (lo, hi) = series
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| {
                        (a.min(v), b.max(v))
                    });
                let bm = batch_means(&series);
                Fluctuation {
                    std: var.sqrt(),
                    below: mean - lo,
                    above: hi - mean,
                    half_width: bm.half_width,
                    batches: bm.batches,
                    correlated: bm.correlated,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(r.between(1499, 1501)["p_rgh"], 0.006);
        assert_eq!(r.between(1500, 1501)["p_rgh"], 0.004);
        // 1501 is still being printed: the last complete one is 1500.
        assert_eq!(r.latest()["p_rgh"], 0.008);
    }

    #[test]
    fn dat_files_skip_their_comments() {
        let rows = dat_rows("# Probe 0 (1 2 3)\n# Time 0\n1 0.25\n2\t-0.5\n");
        assert_eq!(rows, vec![(1.0, vec![0.25]), (2.0, vec![-0.5])]);
    }

    /// Residuals at `level` (p_rgh five times higher) from 1490 to 2000,
    /// multiplied by `late` after 1750.
    fn residuals(level: f64, late: f64) -> Residuals {
        let mut r = Residuals::default();
        for i in 1490..=2000 {
            r.line(&format!("Time = {i}"));
            let l = if i > 1750 { level * late } else { level };
            for f in ["Ux", "T", "p_rgh", "k", "epsilon"] {
                let v = if f == "p_rgh" { 5.0 * l } else { l };
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

    fn bands(half_width: f64) -> Vec<[Fluctuation; 3]> {
        let f = Fluctuation {
            std: 0.5,
            below: 1.0,
            above: 1.0,
            half_width,
            batches: 10,
            correlated: false,
        };
        vec![[f; 3]; 4]
    }

    #[test]
    fn a_settled_run_passes() {
        let c = input();
        let ch = evaluate(
            &c,
            [1500, 2000],
            &residuals(1e-3, 1.0),
            (13_000.0, 1e-6),
            &bands(0.4),
        );
        assert_eq!(ch.failure(), None, "{ch:?}");
        assert!(!ch.uncertain());
        assert_eq!(ch.energy_balance_pct.value, 1.07);
        assert!(ch.wide.is_empty());
    }

    #[test]
    fn an_uncertain_band_extends_the_run_but_is_no_failure() {
        let c = input();
        let mut f = bands(0.4);
        f[1][0].half_width = 1.7; // rack 2 top
        let ch = evaluate(&c, [1500, 2000], &residuals(1e-3, 1.0), (13_000.0, 0.0), &f);
        assert_eq!(ch.failure(), None);
        assert!(ch.uncertain());
        assert_eq!(ch.half_width_k.value, 1.7);
        assert_eq!(ch.wide.len(), 1);
        assert_eq!(
            (ch.wide[0].height.as_str(), ch.wide[0].half_width),
            ("top", 1.7)
        );
    }

    #[test]
    fn real_failures_are_failures() {
        let c = input();
        let ok = bands(0.4);
        let r = residuals(1e-3, 1.0);
        // 4.9 % of the heat unaccounted for.
        let ch = evaluate(&c, [1500, 2000], &r, (12_492.0, 0.0), &ok);
        assert_eq!(ch.failure(), Some(Failure::EnergyBalance));
        // Residuals above their limits.
        let ch = evaluate(
            &c,
            [1500, 2000],
            &residuals(1e-2, 1.0),
            (13_000.0, 0.0),
            &ok,
        );
        assert_eq!(ch.failure(), Some(Failure::Residuals));
        // Below the limits but growing: three times higher in the second half.
        let ch = evaluate(
            &c,
            [1500, 2000],
            &residuals(5e-4, 3.0),
            (13_000.0, 0.0),
            &ok,
        );
        assert_eq!(ch.failure(), Some(Failure::ResidualsGrowing));
        assert_eq!(ch.residuals_growing.len(), 5);
        // NaN.
        let ch = evaluate(&c, [1500, 2000], &r, (f64::NAN, 0.0), &ok);
        assert_eq!(ch.failure(), Some(Failure::Diverged));
        // No residuals at all is not a pass.
        let ch = evaluate(
            &c,
            [1500, 2000],
            &Residuals::default(),
            (13_000.0, 0.0),
            &ok,
        );
        assert_eq!(ch.failure(), Some(Failure::Residuals));
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

    /// A deterministic pseudo-random sequence (an LCG), uniform in [-1, 1).
    fn noise(n: usize, mut s: u64) -> Vec<f64> {
        (0..n)
            .map(|_| {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (s >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn independent_noise_uses_ten_batches_and_a_small_interval() {
        // ±1 K white noise over 500 iterations: the mean is known to about
        // t·(0.577/√500) ≈ 0.05 K.
        let s: Vec<f64> = noise(500, 7).iter().map(|v| 30.0 + v).collect();
        let b = batch_means(&s);
        assert_eq!(b.batches, 10);
        assert!(!b.correlated);
        assert!(b.half_width < 0.15, "{}", b.half_width);
    }

    #[test]
    fn a_slow_swing_gives_a_wide_interval() {
        // A ±2 K swing with a 600-iteration period, as rack 2 top's: the
        // window does not average it out.
        let s: Vec<f64> = (0..500)
            .map(|i| 38.0 + 2.0 * (i as f64 * std::f64::consts::TAU / 600.0).sin())
            .collect();
        let b = batch_means(&s);
        assert!(b.half_width > 1.0, "{}", b.half_width);
        // Batch means of a slow swing stay correlated.
        assert!(b.correlated || b.batches < 10);
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
        // Every batch has the same mean: no uncertainty, ten batches.
        assert!(f[0][0].half_width < 1e-9);
        assert_eq!(f[0][0].batches, 10);
    }
}
