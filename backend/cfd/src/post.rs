//! Post-processing of a solved case into what the UI shows: a port of
//! `post.py` from `reference/airflow-cfd/`.
//!
//! - a regular grid of temperature and velocity (2.5 cm, as the reference,
//!   for the numbers below; 5 cm for the browser, [`crate::grid`]);
//! - per rack: intake temperature at three heights, exhaust temperature;
//! - room indices: RCI-HI, RTI, the return temperature;
//! - streamline sets seeded on purpose: from every supply grille, backwards
//!   from every rack intake, forwards from every rack exhaust.
//!
//! Everything is deterministic. Positions inside are metres, as in the
//! solver; what leaves this module is millimetres.

use serde::{Deserialize, Serialize};

use crate::input::{Box3, CaseInput, Face, Grille, Rack};

/// Intake and exhaust sampling heights above the floor, mm (SPEC §17.1b).
pub const HEIGHTS: [(&str, i32); 3] = [("top", 1750), ("mid", 1050), ("bottom", 350)];
/// ASHRAE recommended and allowable maximum intake temperatures, °C.
pub const RECOMMENDED_MAX_C: f64 = 27.0;
pub const ALLOWABLE_MAX_C: f64 = 32.0;
/// The grid the numbers are taken from, m.
pub const H: f64 = 0.025;

fn mm(v: i32) -> f64 {
    v as f64 / 1000.0
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![a];
    }
    (0..n)
        .map(|i| a + (b - a) * i as f64 / (n - 1) as f64)
        .collect()
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The horizontal axis along a rack's front.
fn lateral(r: &Rack) -> usize {
    if r.front.axis() == 0 { 2 } else { 0 }
}

/// Points on planes parallel to a rack face, `offset_mm` outside it: `n`
/// across the rack (inset `inset_mm` from its sides) times `heights`, m.
fn face_points(
    r: &Rack,
    face: Face,
    offset_mm: i32,
    inset_mm: i32,
    n: usize,
    heights: &[f64],
) -> Vec<[f64; 3]> {
    let lat = lateral(r);
    let axis = face.axis();
    let plane = mm(face.plane_of(&r.body)) + face.sign() * mm(offset_mm);
    let across = linspace(
        mm(r.body[2 * lat] + inset_mm),
        mm(r.body[2 * lat + 1] - inset_mm),
        n,
    );
    let mut out = vec![];
    for &a in &across {
        for &y in heights {
            let mut p = [0.0; 3];
            p[axis] = plane;
            p[lat] = a;
            p[1] = y;
            out.push(p);
        }
    }
    out
}

/// Where a rack's intake is sampled: per height, five points across the
/// front 4 cm in front of it (the reference's band).
pub fn intake_points(r: &Rack) -> Vec<(&'static str, Vec<[f64; 3]>)> {
    HEIGHTS
        .iter()
        .map(|&(name, y)| (name, face_points(r, r.front, 40, 100, 5, &[mm(y)])))
        .collect()
}

fn exhaust_points(r: &Rack) -> Vec<Vec<[f64; 3]>> {
    HEIGHTS
        .iter()
        .map(|&(_, y)| face_points(r, r.front.opposite(), 40, 100, 5, &[mm(y)]))
        .collect()
}

/// Points over a grille, `offset_mm` outside its face: `n_long` along its
/// longer side (inset `inset_long`), `n_short` along the shorter one.
fn grille_points(
    g: &Grille,
    body: &Box3,
    offset_mm: i32,
    (n_long, inset_long): (usize, i32),
    (n_short, inset_short): (usize, i32),
) -> Vec<[f64; 3]> {
    let [a, b] = g.face.plane_axes();
    let r = g.rect;
    let a_long = r[1] - r[0] >= r[3] - r[2];
    let (na, ia, nb, ib) = if a_long {
        (n_long, inset_long, n_short, inset_short)
    } else {
        (n_short, inset_short, n_long, inset_long)
    };
    let plane = mm(g.face.plane_of(body)) + g.face.sign() * mm(offset_mm);
    let mut out = vec![];
    for va in linspace(mm(r[0] + ia), mm(r[1] - ia), na) {
        for vb in linspace(mm(r[2] + ib), mm(r[3] - ib), nb) {
            let mut p = [0.0; 3];
            p[g.face.axis()] = plane;
            p[a] = va;
            p[b] = vb;
            out.push(p);
        }
    }
    out
}

// --- Nearest cells -------------------------------------------------------------

/// The k nearest cell centres of a point, by bucketing the centres on a
/// regular lattice and searching outward until no closer centre can exist.
pub struct Nearest<'a> {
    pts: &'a [[f64; 3]],
    size: f64,
    n: [i64; 3],
    start: Vec<u32>,
    items: Vec<u32>,
}

impl<'a> Nearest<'a> {
    /// Bucketed on the case's background cell.
    pub fn for_case(input: &CaseInput, pts: &'a [[f64; 3]]) -> Nearest<'a> {
        Nearest::new(
            pts,
            input.room.map(mm),
            input.settings.cell_mm as f64 / 1000.0,
        )
    }

    pub fn new(pts: &'a [[f64; 3]], room: [f64; 3], size: f64) -> Nearest<'a> {
        let n = room.map(|v| ((v / size).ceil() as i64).max(1));
        let bucket = |p: &[f64; 3]| -> usize {
            let i = |a: usize| ((p[a] / size).floor() as i64).clamp(0, n[a] - 1);
            ((i(2) * n[1] + i(1)) * n[0] + i(0)) as usize
        };
        let total = (n[0] * n[1] * n[2]) as usize;
        let mut count = vec![0u32; total + 1];
        for p in pts {
            count[bucket(p) + 1] += 1;
        }
        for i in 0..total {
            count[i + 1] += count[i];
        }
        let mut fill = count.clone();
        let mut items = vec![0u32; pts.len()];
        for (k, p) in pts.iter().enumerate() {
            let b = bucket(p);
            items[fill[b] as usize] = k as u32;
            fill[b] += 1;
        }
        Nearest {
            pts,
            size,
            n,
            start: count,
            items,
        }
    }

    /// The `K` nearest centres as (squared distance, index), nearest first;
    /// ties by index.
    pub fn query<const K: usize>(&self, p: [f64; 3]) -> [(f64, u32); K] {
        let mut best = [(f64::INFINITY, u32::MAX); K];
        let c = [0, 1, 2].map(|a| ((p[a] / self.size).floor() as i64).clamp(0, self.n[a] - 1));
        let mut r = 0i64;
        loop {
            for i in (c[0] - r)..=(c[0] + r) {
                for j in (c[1] - r)..=(c[1] + r) {
                    for k in (c[2] - r)..=(c[2] + r) {
                        let on_shell =
                            (i - c[0]).abs() == r || (j - c[1]).abs() == r || (k - c[2]).abs() == r;
                        if !on_shell
                            || i < 0
                            || j < 0
                            || k < 0
                            || i >= self.n[0]
                            || j >= self.n[1]
                            || k >= self.n[2]
                        {
                            continue;
                        }
                        let b = ((k * self.n[1] + j) * self.n[0] + i) as usize;
                        for &idx in &self.items[self.start[b] as usize..self.start[b + 1] as usize]
                        {
                            let q = self.pts[idx as usize];
                            let d = (0..3).map(|a| (q[a] - p[a]).powi(2)).sum::<f64>();
                            let worst = best[K - 1];
                            if d < worst.0 || (d == worst.0 && idx < worst.1) {
                                let mut s = K - 1;
                                best[s] = (d, idx);
                                while s > 0
                                    && (best[s].0 < best[s - 1].0
                                        || (best[s].0 == best[s - 1].0
                                            && best[s].1 < best[s - 1].1))
                                {
                                    best.swap(s, s - 1);
                                    s -= 1;
                                }
                            }
                        }
                    }
                }
            }
            // Anything not yet seen is at least r buckets away.
            let reach = r as f64 * self.size;
            let covered = (0..3).all(|a| c[a] - r <= 0 && c[a] + r >= self.n[a] - 1);
            if (best[K - 1].0.is_finite() && best[K - 1].0 <= reach * reach) || covered {
                return best;
            }
            r += 1;
        }
    }
}

/// Inverse-distance weights of the 4 nearest centres (`post.py`).
fn idw(near: &Nearest, p: [f64; 3]) -> [(f64, u32); 4] {
    let q = near.query::<4>(p);
    let mut w = q.map(|(d, i)| (1.0 / d.sqrt().max(1e-4), i));
    let s: f64 = w.iter().map(|x| x.0).sum();
    for x in &mut w {
        x.0 /= s;
    }
    w
}

// --- The regular grid ------------------------------------------------------------

/// Temperature (°C) and velocity on a regular grid of cell-centred points,
/// x fastest; `solid` marks points inside an obstacle or a unit.
pub struct Grid {
    pub h: f64,
    pub n: [usize; 3],
    pub t: Vec<f32>,
    pub u: Vec<[f32; 3]>,
    pub solid: Vec<bool>,
}

impl Grid {
    fn idx(&self, i: usize, j: usize, k: usize) -> usize {
        (k * self.n[1] + j) * self.n[0] + i
    }

    fn sample<const N: usize>(&self, p: [f64; 3], get: impl Fn(usize) -> [f64; N]) -> [f64; N] {
        trilinear(self.h, self.n, p, |[i, j, k]| get(self.idx(i, j, k)))
    }

    pub fn temperature(&self, p: [f64; 3]) -> f64 {
        self.sample(p, |i| [self.t[i] as f64])[0]
    }

    pub fn velocity(&self, p: [f64; 3]) -> [f64; 3] {
        self.sample(p, |i| self.u[i].map(|v| v as f64))
    }

    fn solid_at(&self, p: [f64; 3]) -> bool {
        let i = [0, 1, 2].map(|a| ((p[a] / self.h) as usize).min(self.n[a] - 1));
        self.solid[self.idx(i[0], i[1], i[2])]
    }
}

/// Trilinear interpolation between the nodes of a cell-centred grid, with
/// the edge value outside (`map_coordinates(order=1, mode='nearest')`).
fn trilinear<const N: usize>(
    h: f64,
    n: [usize; 3],
    p: [f64; 3],
    get: impl Fn([usize; 3]) -> [f64; N],
) -> [f64; N] {
    let mut lo = [0usize; 3];
    let mut hi = [0usize; 3];
    let mut f = [0.0; 3];
    for a in 0..3 {
        let x = (p[a] / h - 0.5).max(0.0);
        let last = n[a] - 1;
        let i = (x.floor() as usize).min(last);
        lo[a] = i;
        hi[a] = (i + 1).min(last);
        f[a] = if i >= last { 0.0 } else { x - i as f64 };
    }
    let mut out = [0.0; N];
    for corner in 0..8 {
        let pick = |a: usize| corner >> a & 1 == 1;
        let w: f64 = (0..3)
            .map(|a| if pick(a) { f[a] } else { 1.0 - f[a] })
            .product();
        if w == 0.0 {
            continue;
        }
        let v = get([0, 1, 2].map(|a| if pick(a) { hi[a] } else { lo[a] }));
        for c in 0..N {
            out[c] += w * v[c];
        }
    }
    out
}

/// The temperature of the 2.5 cm grid at single points, computed only
/// where needed: the same numbers as [`Grid::temperature`] of a full
/// [`resample`], for fields that need no full grid (the half-window means).
pub struct PointSampler<'a> {
    near: &'a Nearest<'a>,
    t_c: &'a [f64],
    n: [usize; 3],
}

impl<'a> PointSampler<'a> {
    pub fn new(input: &CaseInput, near: &'a Nearest<'a>, t_c: &'a [f64]) -> PointSampler<'a> {
        let n = input.room.map(|v| axis_count(mm(v), H));
        PointSampler { near, t_c, n }
    }

    pub fn temperature(&self, p: [f64; 3]) -> f64 {
        trilinear(H, self.n, p, |ijk| {
            let q = ijk.map(|v| H / 2.0 + v as f64 * H);
            [idw(self.near, q)
                .iter()
                .map(|&(w, c)| w * self.t_c[c as usize])
                .sum()]
        })[0]
    }
}

/// Points `h/2, 3h/2, …` below `len` (`np.arange(h/2, len, h)`).
fn axis_count(len: f64, h: f64) -> usize {
    ((len - h / 2.0) / h).ceil().max(1.0) as usize
}

/// Every box the air cannot enter: obstacles and unit bodies.
pub fn obstacle_boxes(input: &CaseInput) -> Vec<[f64; 6]> {
    input
        .solids
        .iter()
        .map(|s| s.b)
        .chain(input.units.iter().map(|u| u.body))
        .map(|b| b.map(mm))
        .collect()
}

/// Resample cell values onto a grid of spacing `h` (m), inverse-distance
/// weighted over the 4 nearest cells, as the reference does.
pub fn resample(input: &CaseInput, near: &Nearest, t_c: &[f64], u: &[[f64; 3]], h: f64) -> Grid {
    let room = input.room.map(mm);
    let n = room.map(|v| axis_count(v, h));
    let boxes = obstacle_boxes(input);
    let total = n[0] * n[1] * n[2];
    let threads = std::thread::available_parallelism()
        .map(|v| v.get())
        .unwrap_or(1)
        .min(16);
    let chunk = total.div_ceil(threads);
    let mut t = vec![0f32; total];
    let mut uu = vec![[0f32; 3]; total];
    let mut solid = vec![false; total];
    std::thread::scope(|s| {
        for ((tc, uc), (sc, base)) in t
            .chunks_mut(chunk)
            .zip(uu.chunks_mut(chunk))
            .zip(solid.chunks_mut(chunk).zip((0..).step_by(chunk)))
        {
            let boxes = &boxes;
            s.spawn(move || {
                for off in 0..tc.len() {
                    let idx = base + off;
                    let (i, j, k) = (idx % n[0], idx / n[0] % n[1], idx / (n[0] * n[1]));
                    let p = [i, j, k].map(|v| h / 2.0 + v as f64 * h);
                    let w = idw(near, p);
                    let mut tv = 0.0;
                    let mut uv = [0.0; 3];
                    for (wt, ci) in w {
                        let ci = ci as usize;
                        tv += wt * t_c[ci];
                        for a in 0..3 {
                            uv[a] += wt * u[ci][a];
                        }
                    }
                    tc[off] = tv as f32;
                    uc[off] = uv.map(|v| v as f32);
                    sc[off] = boxes
                        .iter()
                        .any(|b| (0..3).all(|a| p[a] >= b[2 * a] && p[a] <= b[2 * a + 1]));
                }
            });
        }
    });
    Grid {
        h,
        n,
        t,
        u: uu,
        solid,
    }
}

// --- The summary -------------------------------------------------------------------

/// Each rack's intake band means (top, mid, bottom), unrounded, from any
/// sampler of the 2.5 cm grid's temperature.
pub fn intake_means(input: &CaseInput, temperature: impl Fn([f64; 3]) -> f64) -> Vec<[f64; 3]> {
    input
        .racks
        .iter()
        .map(|r| {
            let v: Vec<f64> = intake_points(r)
                .iter()
                .map(|(_, pts)| pts.iter().map(|&p| temperature(p)).sum::<f64>() / pts.len() as f64)
                .collect();
            [v[0], v[1], v[2]]
        })
        .collect()
}

/// How an intake band moves around its mean over the averaging window:
/// from the per-iteration temperatures at the band's points (cell values).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Fluctuation {
    pub std: f64,
    /// Mean − minimum, and maximum − mean, of the band over the window.
    pub below: f64,
    pub above: f64,
}

/// One intake band over the averaging window, °C, model. `min` and `max`
/// are the band's range over the window placed around its mean.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Band {
    pub mean: f64,
    pub std: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Intake {
    pub top: Band,
    pub mid: Band,
    pub bottom: Band,
}

impl Intake {
    pub fn means(&self) -> [f64; 3] {
        [self.top.mean, self.mid.mean, self.bottom.mean]
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RackResult {
    pub object_id: i64,
    pub name: String,
    pub heat_w: i32,
    pub intake: Intake,
    /// °C, model.
    pub exhaust: f64,
    /// The highest band mean.
    pub max_intake: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Numbers {
    pub racks: Vec<RackResult>,
    /// Rack Cooling Index, high side, %: 100 = no intake above 27 °C.
    pub rci_hi: f64,
    /// Return Temperature Index, %: below 100 cold air bypasses the racks,
    /// above 100 hot air recirculates.
    pub rti: f64,
    pub return_temp: f64,
    pub supply_temp: f64,
    pub t_min: f64,
    pub t_max: f64,
    pub u_max: f64,
    pub cells: usize,
}

/// The rack, room and index numbers of `post.py`, from the 2.5 cm grid of
/// the averaged fields; `fluct` is per rack, per band (top, mid, bottom).
pub fn numbers(
    input: &CaseInput,
    grid: &Grid,
    t_cells: &[f64],
    u_cells: &[[f64; 3]],
    fluct: &[[Fluctuation; 3]],
) -> Numbers {
    let band = |pts: &[[f64; 3]]| -> f64 {
        pts.iter().map(|&p| grid.temperature(p)).sum::<f64>() / pts.len() as f64
    };
    let means = intake_means(input, |p| grid.temperature(p));
    let racks: Vec<RackResult> = input
        .racks
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let b = |k: usize| {
                let f = fluct.get(i).map(|f| f[k]).unwrap_or_default();
                let mean = means[i][k];
                Band {
                    mean: round1(mean),
                    std: (f.std * 100.0).round() / 100.0,
                    min: round1(mean - f.below),
                    max: round1(mean + f.above),
                }
            };
            let intake = Intake {
                top: b(0),
                mid: b(1),
                bottom: b(2),
            };
            let ex = exhaust_points(r);
            let exhaust = round1(ex.iter().map(|p| band(p)).sum::<f64>() / ex.len() as f64);
            RackResult {
                object_id: r.object_id,
                name: r.name.clone(),
                heat_w: r.heat_w,
                max_intake: intake.means().into_iter().fold(f64::MIN, f64::max),
                intake,
                exhaust,
            }
        })
        .collect();
    let intakes: Vec<f64> = racks.iter().flat_map(|r| r.intake.means()).collect();
    let over: f64 = intakes
        .iter()
        .map(|t| (t - RECOMMENDED_MAX_C).max(0.0))
        .sum();
    let rci_hi = if intakes.is_empty() {
        100.0
    } else {
        100.0 * (1.0 - over / (intakes.len() as f64 * (ALLOWABLE_MAX_C - RECOMMENDED_MAX_C)))
    };
    // The return temperature: over each return grille, 5 cm outside it.
    let per_unit: Vec<f64> = input
        .units
        .iter()
        .map(|u| {
            let pts: Vec<[f64; 3]> = u
                .returns
                .iter()
                .flat_map(|g| grille_points(g, &u.body, 50, (6, 50), (3, 40)))
                .collect();
            band(&pts)
        })
        .collect();
    let t_ret = per_unit.iter().sum::<f64>() / per_unit.len().max(1) as f64;
    let ts = input.supply_temp_c;
    let rti = 100.0 * (t_ret - ts) / input.settings.rack_delta_t_k;
    let fold = |f: fn(f64, f64) -> f64, init: f64| t_cells.iter().copied().fold(init, f);
    Numbers {
        racks,
        rci_hi: round1(rci_hi),
        rti: rti.round(),
        return_temp: round1(t_ret),
        supply_temp: ts,
        t_min: round1(fold(f64::min, f64::INFINITY)),
        t_max: round1(fold(f64::max, f64::NEG_INFINITY)),
        u_max: (u_cells
            .iter()
            .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
            .fold(0.0, f64::max)
            * 100.0)
            .round()
            / 100.0,
        cells: t_cells.len(),
    }
}

// --- Streamlines -------------------------------------------------------------------

/// One streamline: points `[x_mm, y_mm, z_mm, t_c]`, upstream first.
pub type Line = Vec<[f64; 4]>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetKind {
    /// From a unit's supply grilles, downstream.
    Unit,
    /// Into a rack's intake, traced upstream.
    RackIntake,
    /// From a rack's exhaust, downstream.
    RackExhaust,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StreamSet {
    pub kind: SetKind,
    pub object_id: i64,
    pub name: String,
    pub lines: Vec<Line>,
}

/// RK2 through the grid in 1.2 cm steps, stopping in still air, at a wall
/// or in a solid; every second point is kept, with its temperature.
fn trace(grid: &Grid, room: [f64; 3], start: [f64; 3], sign: f64) -> Line {
    const STEPS: usize = 900;
    const DS: f64 = 0.012;
    let norm = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let inside = |p: [f64; 3]| (0..3).all(|a| p[a] > 0.0 && p[a] < room[a]);
    let mut p = start;
    let mut pts = vec![p];
    for _ in 0..STEPS {
        let k1 = grid.velocity(p);
        let s = norm(k1);
        if s < 0.02 {
            break;
        }
        let mid = [0, 1, 2].map(|a| p[a] + sign * k1[a] / s * DS / 2.0);
        let k2 = grid.velocity(mid);
        let s2 = norm(k2);
        if s2 < 1e-6 {
            break;
        }
        p = [0, 1, 2].map(|a| p[a] + sign * k2[a] / s2 * DS);
        if !inside(p) || grid.solid_at(p) {
            break;
        }
        pts.push(p);
    }
    if sign < 0.0 {
        pts.reverse();
    }
    pts.iter()
        .step_by(2)
        .map(|q| {
            [
                (q[0] * 1000.0).round(),
                (q[1] * 1000.0).round(),
                (q[2] * 1000.0).round(),
                (grid.temperature(*q) * 100.0).round() / 100.0,
            ]
        })
        .collect()
}

pub fn streamlines(input: &CaseInput, grid: &Grid) -> Vec<StreamSet> {
    let room = input.room.map(mm);
    let mut sets = vec![];
    for u in &input.units {
        let lines = u
            .supplies
            .iter()
            .flat_map(|s| grille_points(&s.grille, &u.body, 20, (6, 50), (3, 20)))
            .map(|p| trace(grid, room, p, 1.0))
            .collect();
        sets.push(StreamSet {
            kind: SetKind::Unit,
            object_id: u.object_id,
            name: u.name.clone(),
            lines,
        });
    }
    let heights = |n| linspace(0.3, 1.8, n);
    for r in &input.racks {
        let seeds = face_points(r, r.front, 30, 120, 4, &heights(5));
        sets.push(StreamSet {
            kind: SetKind::RackIntake,
            object_id: r.object_id,
            name: r.name.clone(),
            lines: seeds.iter().map(|&p| trace(grid, room, p, -1.0)).collect(),
        });
        let seeds = face_points(r, r.front.opposite(), 30, 120, 3, &heights(4));
        sets.push(StreamSet {
            kind: SetKind::RackExhaust,
            object_id: r.object_id,
            name: r.name.clone(),
            lines: seeds.iter().map(|&p| trace(grid, room, p, 1.0)).collect(),
        });
    }
    sets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_matches_brute_force() {
        // A lattice with refined patches, like a castellated mesh.
        let mut pts = vec![];
        for i in 0..20 {
            for j in 0..10 {
                for k in 0..12 {
                    pts.push([
                        0.035 + 0.07 * i as f64,
                        0.035 + 0.07 * j as f64,
                        0.035 + 0.07 * k as f64,
                    ]);
                }
            }
        }
        for i in 0..8 {
            pts.push([0.3 + 0.0175 * i as f64, 0.21, 0.4]);
        }
        let room = [1.4, 0.7, 0.84];
        let near = Nearest::new(&pts, room, 0.07);
        for p in [
            [0.0, 0.0, 0.0],
            [0.31, 0.2, 0.41],
            [1.39, 0.69, 0.83],
            [0.7, 0.35, 0.42],
        ] {
            let got = near.query::<4>(p);
            let mut all: Vec<(f64, u32)> = pts
                .iter()
                .enumerate()
                .map(|(i, q)| ((0..3).map(|a| (q[a] - p[a]).powi(2)).sum(), i as u32))
                .collect();
            all.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            assert_eq!(got.to_vec(), all[..4].to_vec(), "{p:?}");
        }
    }

    #[test]
    fn grid_counts_match_numpy_arange() {
        // np.arange(0.0125, 5.545, 0.025).size == 222
        assert_eq!(axis_count(5.545, 0.025), 222);
        assert_eq!(axis_count(2.41, 0.025), 96);
        assert_eq!(axis_count(3.845, 0.025), 154);
    }

    #[test]
    fn intake_band_is_the_reference_band() {
        let r = Rack {
            key: "r1".into(),
            object_id: 1,
            name: "R".into(),
            body: [530, 1130, 0, 2040, 2250, 3250],
            zone: [580, 1080, 100, 1980, 2350, 3150],
            front: Face::ZMin,
            heat_w: 3000,
        };
        let pts = intake_points(&r);
        assert_eq!(pts[0].0, "top");
        let xs: Vec<f64> = pts[0].1.iter().map(|p| (p[0] * 1000.0).round()).collect();
        assert_eq!(xs, vec![630.0, 730.0, 830.0, 930.0, 1030.0]);
        assert!(
            pts[0]
                .1
                .iter()
                .all(|p| (p[2] - 2.21).abs() < 1e-9 && (p[1] - 1.75).abs() < 1e-9)
        );
    }
}
