//! What one airflow run needs, derived from a room revision: boxes, cooling
//! units with their grilles, racks with their heat, other heat sources, and
//! the settings. The backend builds it (`dc::airflow`); the worker turns it
//! into an OpenFOAM case ([`crate::case`]) and reads the result back
//! ([`crate::post`]).
//!
//! Lengths are integer millimetres in room coordinates: x along the first
//! wall, y up from the floor, z across. Powers are watts, airflows m³/h.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An axis-aligned box `[x0, x1, y0, y1, z0, z1]`, mm.
pub type Box3 = [i32; 6];

/// One face of a box, by its outward normal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Face {
    XMin,
    XMax,
    YMin,
    YMax,
    ZMin,
    ZMax,
}

impl Face {
    /// The axis the face is normal to (0 = x, 1 = y, 2 = z).
    pub fn axis(self) -> usize {
        match self {
            Face::XMin | Face::XMax => 0,
            Face::YMin | Face::YMax => 1,
            Face::ZMin | Face::ZMax => 2,
        }
    }

    /// +1 for an outward normal along the axis, −1 against it.
    pub fn sign(self) -> f64 {
        match self {
            Face::XMax | Face::YMax | Face::ZMax => 1.0,
            _ => -1.0,
        }
    }

    pub fn opposite(self) -> Face {
        match self {
            Face::XMin => Face::XMax,
            Face::XMax => Face::XMin,
            Face::YMin => Face::YMax,
            Face::YMax => Face::YMin,
            Face::ZMin => Face::ZMax,
            Face::ZMax => Face::ZMin,
        }
    }

    /// The two in-plane axes, in x, y, z order.
    pub fn plane_axes(self) -> [usize; 2] {
        match self.axis() {
            0 => [1, 2],
            1 => [0, 2],
            _ => [0, 1],
        }
    }

    /// The outward unit normal.
    pub fn normal(self) -> [f64; 3] {
        let mut n = [0.0; 3];
        n[self.axis()] = self.sign();
        n
    }

    /// The coordinate of this face of `b` along its axis.
    pub fn plane_of(self, b: &Box3) -> i32 {
        let a = self.axis();
        if self.sign() > 0.0 {
            b[2 * a + 1]
        } else {
            b[2 * a]
        }
    }
}

/// An opening on one face of a unit's body: `rect` spans the face's two
/// in-plane axes ([`Face::plane_axes`]) as `[a0, a1, b0, b1]`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grille {
    pub face: Face,
    pub rect: [i32; 4],
}

impl Grille {
    pub fn area_mm2(&self) -> f64 {
        let r = self.rect;
        (r[1] - r[0]) as f64 * (r[3] - r[2]) as f64
    }
}

/// A supply grille and where the air leaves it (SPEC §14.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Supply {
    pub grille: Grille,
    /// Degrees below horizontal (vertical faces only).
    pub pitch_deg: f64,
    /// Degrees to the right of the face normal, seen from behind the unit.
    pub yaw_deg: f64,
}

/// A cooling unit: a solid body with supply and return grilles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unit {
    /// The patch prefix in the case (`u1`): OpenFOAM names, not shown.
    pub key: String,
    pub object_id: i64,
    pub name: String,
    pub body: Box3,
    pub supplies: Vec<Supply>,
    pub returns: Vec<Grille>,
    pub airflow_m3h: i32,
}

/// A rack: its outer body (for sampling) and its interior, a fan-driven fluid
/// zone that carries the rack's heat from the front face to the opposite one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rack {
    pub key: String,
    pub object_id: i64,
    pub name: String,
    pub body: Box3,
    pub zone: Box3,
    /// The face the air enters; it leaves through the opposite one.
    pub front: Face,
    pub heat_w: i32,
}

/// Heat released into the air of some boxes (the exhaust volumes behind
/// tower cases on a shelf).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeatZone {
    pub key: String,
    pub name: String,
    pub boxes: Vec<Box3>,
    pub heat_w: i32,
}

/// A solid obstacle: walls of the case, nothing flows through it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Solid {
    pub name: String,
    pub b: Box3,
}

/// The numerical settings. Pinned per result, so a result is reproducible
/// from its input (PROMPT-AIRFLOW, rules).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// Background hex cell; the mesh refines it once at obstacles and twice
    /// at the grilles.
    pub cell_mm: i32,
    pub iterations: i32,
    /// The result is the mean over this many final iterations.
    pub average_last: i32,
    /// Air temperature rise through a rack: sets each rack's fan flow.
    pub rack_delta_t_k: f64,
    /// MPI processes, split geometrically: fixed, so the same input gives
    /// the same result.
    #[serde(default = "default_processes")]
    pub processes: usize,
}

/// The process count when nothing sets it: a small host. Set the app's
/// `AIRFLOW_PROCESSES` and the worker's CPUs to the host's core count.
pub fn default_processes() -> usize {
    4
}

impl Default for Settings {
    /// The settings that converge in `reference/airflow-cfd/`.
    fn default() -> Self {
        Settings {
            cell_mm: 70,
            iterations: 2000,
            average_last: 500,
            rack_delta_t_k: 10.0,
            processes: default_processes(),
        }
    }
}

/// Where an input number came from. Everything but `measured` and
/// `datasheet` is a guess and is shown as one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Src {
    Measured,
    Datasheet,
    /// Summed from device powers.
    Devices,
    /// Set by hand for this room or object.
    Manual,
    /// A default of the model or the room; not measured.
    Assumed,
}

/// One input the result depends on, listed with the result (SPEC §14.2:
/// every assumed input appears in the result's header).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assumption {
    /// Stable id; the UI translates it.
    pub key: String,
    /// The object it is about, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub value: Value,
    pub src: Src,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseInput {
    /// The room's box: length along x, height, width along z.
    pub room: [i32; 3],
    pub solids: Vec<Solid>,
    pub units: Vec<Unit>,
    pub racks: Vec<Rack>,
    pub heat: Vec<HeatZone>,
    pub supply_temp_c: f64,
    pub settings: Settings,
    pub assumptions: Vec<Assumption>,
}

impl CaseInput {
    /// Heat released into the room, W.
    pub fn heat_in_w(&self) -> f64 {
        let racks: i64 = self.racks.iter().map(|r| r.heat_w as i64).sum();
        let zones: i64 = self.heat.iter().map(|h| h.heat_w as i64).sum();
        (racks + zones) as f64
    }

    /// Checks the case writer relies on: boxes are not empty, grilles lie on
    /// their unit's face, keys are unique OpenFOAM words.
    pub fn validate(&self) -> Result<(), String> {
        let ok_box = |b: &Box3| b[0] < b[1] && b[2] < b[3] && b[4] < b[5];
        if self.room.iter().any(|&v| v <= 0) {
            return Err("the room has no volume".into());
        }
        for s in &self.solids {
            if !ok_box(&s.b) {
                return Err(format!("{}: empty box", s.name));
            }
        }
        if self.units.is_empty() {
            return Err("the room has no cooling unit".into());
        }
        let mut keys = Vec::new();
        for u in &self.units {
            if !ok_box(&u.body) {
                return Err(format!("{}: empty box", u.name));
            }
            if u.supplies.is_empty() || u.returns.is_empty() {
                return Err(format!("{}: needs a supply and a return", u.name));
            }
            if u.airflow_m3h <= 0 {
                return Err(format!("{}: airflow must be positive", u.name));
            }
            let grilles = u.supplies.iter().map(|s| &s.grille).chain(&u.returns);
            for g in grilles {
                let [a, b] = g.face.plane_axes();
                let r = g.rect;
                let inside = r[0] < r[1]
                    && r[2] < r[3]
                    && r[0] >= u.body[2 * a]
                    && r[1] <= u.body[2 * a + 1]
                    && r[2] >= u.body[2 * b]
                    && r[3] <= u.body[2 * b + 1];
                if !inside {
                    return Err(format!("{}: a grille lies outside its face", u.name));
                }
            }
            keys.push(u.key.as_str());
        }
        for r in &self.racks {
            if !ok_box(&r.body) || !ok_box(&r.zone) {
                return Err(format!("{}: empty box", r.name));
            }
            if r.heat_w < 0 {
                return Err(format!("{}: heat must not be negative", r.name));
            }
            if r.front.axis() == 1 {
                return Err(format!("{}: a rack breathes through a side", r.name));
            }
            keys.push(r.key.as_str());
        }
        for h in &self.heat {
            if h.boxes.is_empty() || !h.boxes.iter().all(ok_box) || h.heat_w < 0 {
                return Err(format!("{}: bad heat zone", h.name));
            }
            keys.push(h.key.as_str());
        }
        let word = |k: &str| {
            k.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && k.chars().all(|c| c.is_ascii_alphanumeric())
        };
        if let Some(k) = keys.iter().find(|k| !word(k)) {
            return Err(format!("'{k}' is not a valid case key"));
        }
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        if sorted.windows(2).any(|w| w[0] == w[1]) {
            return Err("case keys must be unique".into());
        }
        let s = &self.settings;
        if s.cell_mm < 20
            || s.iterations < 1
            || s.average_last < 1
            || s.average_last > s.iterations
            || s.processes < 1
        {
            return Err("bad numerical settings".into());
        }
        Ok(())
    }
}
