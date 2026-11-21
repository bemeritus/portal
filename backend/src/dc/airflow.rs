//! The airflow model's input from a room revision (SPEC §14.2): the room
//! model's half of the port of `reference/airflow-cfd/make_case.py`. Boxes
//! from the objects, grilles from the cooling units, heat from the devices,
//! and every number that is not measured listed as an assumption. Pure: the
//! case files are written by `portal_cfd::case` in the worker.
//!
//! Phase 1 kinds are boxes. A rack is a solid shell (plinth, top cap, side
//! panels) around a fan-driven interior; a shelf is posts and boards with a
//! tower case on every recorded cell; a cooling unit is a solid body with
//! supply and return grilles.

use std::collections::HashMap;

use portal_cfd::input::{
    Assumption, Box3, CaseInput, Face, Grille, HeatZone, Rack, Settings, Solid, Src, Supply, Unit,
};
use serde_json::{Value, json};

use super::geometry::{Dir, cell_info, footprint, object_dims};
use super::model::{
    CableTrayProps, CatalogItem, CatalogProps, CoolingProps, CoolingSubtype, DcObject,
    DeviceStatus, Discharge, Instance, OpeningRole, OutletSource, RoomView, ShelfProps,
    StructureSubtype, TrayType, UnitFace, enum_str,
};

/// SPEC §14.1: the supply temperature when the room does not set one.
pub const DEFAULT_SUPPLY_TEMP_C: f64 = 18.0;
/// A rack's heat when neither its devices nor a setting give one (the
/// reference's 3 kW).
pub const DEFAULT_RACK_HEAT_W: i32 = 3000;
/// What a tower case on a shelf cell gives off when the cell records no
/// power (the reference's 120 W).
pub const DEFAULT_CELL_HEAT_W: i32 = 120;
/// A gap of air thinner than this between an object and a wall breaks the
/// mesh (reference README, lessons): the object is modelled against the
/// wall, reaching this far into it.
pub const WALL_GAP_MM: i32 = 50;
const INTO_WALL_MM: i32 = 20;
/// Rack shell, as in the reference: top cap, side panels, and the space
/// behind each door left out of the fan zone.
const RACK_CAP_MM: i32 = 60;
const RACK_SIDE_MM: i32 = 50;
const RACK_DOOR_GAP_MM: i32 = 100;
/// Shelf posts and boards (the boards as thick as the reference's).
const SHELF_POST_MM: i32 = 40;
const SHELF_BOARD_MM: i32 = 35;
/// A tower case in a cell, as the 3D view draws it: width, height, depth,
/// and its distance from the shelf's front edge. Its heat leaves into the
/// air behind it.
const CELL_ITEM: [i32; 3] = [200, 440, 460];
const CELL_ITEM_FRONT_GAP_MM: i32 = 40;
const CELL_EXHAUST_MM: i32 = 100;

/// An object's own frame: local x along its width, y up from its base, z
/// along its depth with the front at −z; the origin at its footprint's
/// centre. The same transform as the 3D view's (`rotation.y = −θ`).
struct Frame {
    cx: f64,
    cz: f64,
    y0: i32,
    cos: f64,
    sin: f64,
    w: i32,
    d: i32,
    h: i32,
}

impl Frame {
    fn new(obj: &DcObject, (w, d, h): (i32, i32, i32)) -> Frame {
        let r = footprint(obj.x0_mm, obj.z0_mm, w, d, obj.rotation_deg);
        let t = (obj.rotation_deg as f64).to_radians();
        Frame {
            cx: (r.x0 + r.x1) as f64 / 2.0,
            cz: (r.z0 + r.z1) as f64 / 2.0,
            y0: obj.y0_mm,
            cos: t.cos().round(),
            sin: t.sin().round(),
            w,
            d,
            h,
        }
    }

    fn point(&self, [x, y, z]: [f64; 3]) -> [f64; 3] {
        [
            self.cx + x * self.cos - z * self.sin,
            self.y0 as f64 + y,
            self.cz + x * self.sin + z * self.cos,
        ]
    }

    /// A local box `[x0, x1, y0, y1, z0, z1]` in room coordinates.
    fn boxed(&self, l: [f64; 6]) -> Box3 {
        let a = self.point([l[0], l[2], l[4]]);
        let b = self.point([l[1], l[3], l[5]]);
        let mut out = [0; 6];
        for k in 0..3 {
            out[2 * k] = a[k].min(b[k]).round() as i32;
            out[2 * k + 1] = a[k].max(b[k]).round() as i32;
        }
        out
    }

    fn body(&self) -> Box3 {
        let (w, d, h) = (self.w as f64 / 2.0, self.d as f64 / 2.0, self.h as f64);
        self.boxed([-w, w, 0.0, h, -d, d])
    }

    /// The room face a local face turns into.
    fn face(&self, f: UnitFace) -> Face {
        let n = match f {
            UnitFace::Front => [0.0, 0.0, -1.0],
            UnitFace::Rear => [0.0, 0.0, 1.0],
            UnitFace::Left => [-1.0, 0.0, 0.0],
            UnitFace::Right => [1.0, 0.0, 0.0],
            UnitFace::Top => return Face::YMax,
            UnitFace::Bottom => return Face::YMin,
        };
        let x = n[0] * self.cos - n[2] * self.sin;
        let z = n[0] * self.sin + n[2] * self.cos;
        match (x.round() as i32, z.round() as i32) {
            (1, _) => Face::XMax,
            (-1, _) => Face::XMin,
            (_, 1) => Face::ZMax,
            _ => Face::ZMin,
        }
    }

    /// A rectangle on a local face, as fractions of the face: `u` across
    /// (local x on front, rear, top and bottom; local z on the sides, from
    /// the front), `v` up (local z from the front, on top and bottom).
    fn grille(&self, f: UnitFace, u: [f64; 2], v: [f64; 2]) -> Grille {
        let (w, d, h) = (self.w as f64, self.d as f64, self.h as f64);
        let across = |s: f64, len: f64| -len / 2.0 + s * len;
        let l = match f {
            UnitFace::Front | UnitFace::Rear => {
                let z = if f == UnitFace::Front {
                    -d / 2.0
                } else {
                    d / 2.0
                };
                [across(u[0], w), across(u[1], w), v[0] * h, v[1] * h, z, z]
            }
            UnitFace::Left | UnitFace::Right => {
                let x = if f == UnitFace::Left {
                    -w / 2.0
                } else {
                    w / 2.0
                };
                [x, x, v[0] * h, v[1] * h, across(u[0], d), across(u[1], d)]
            }
            UnitFace::Top | UnitFace::Bottom => {
                let y = if f == UnitFace::Top { h } else { 0.0 };
                [
                    across(u[0], w),
                    across(u[1], w),
                    y,
                    y,
                    across(v[0], d),
                    across(v[1], d),
                ]
            }
        };
        let b = self.boxed(l);
        let face = self.face(f);
        let [a, c] = face.plane_axes();
        Grille {
            face,
            rect: [b[2 * a], b[2 * a + 1], b[2 * c], b[2 * c + 1]],
        }
    }
}

fn assumption(key: &str, obj: Option<&DcObject>, value: Value, src: Src) -> Assumption {
    Assumption {
        key: key.into(),
        object_id: obj.map(|o| o.id),
        subject: obj.map(|o| o.name.clone()),
        value,
        src,
    }
}

/// The subtype's openings when neither the catalog nor the object gives
/// them (SPEC §14.1): (face, u, v) per supply, then per return, and the
/// supply pitch.
type Opening = (UnitFace, [f64; 2], [f64; 2]);

fn default_openings(
    c: &CoolingProps,
    discharge: Option<Discharge>,
) -> (Vec<Opening>, Vec<Opening>, f64) {
    use UnitFace::*;
    match c.subtype {
        // The reference's ducted unit: supply on the front, return under the
        // rear half.
        CoolingSubtype::Ducted | CoolingSubtype::SplitFloorCeiling => (
            vec![(Front, [0.13, 0.87], [0.23, 0.77])],
            vec![(Bottom, [0.12, 0.88], [0.55, 0.92])],
            0.0,
        ),
        // Return over the top, supply from the lower front louvre angled down.
        CoolingSubtype::SplitWall => (
            vec![(Front, [0.1, 0.9], [0.05, 0.3])],
            vec![(Top, [0.1, 0.9], [0.2, 0.8])],
            30.0,
        ),
        // Supply along two edges of the underside, return in its centre.
        CoolingSubtype::SplitCassette => (
            vec![
                (Bottom, [0.15, 0.85], [0.05, 0.15]),
                (Bottom, [0.15, 0.85], [0.85, 0.95]),
            ],
            vec![(Bottom, [0.3, 0.7], [0.25, 0.75])],
            0.0,
        ),
        CoolingSubtype::InRow => (
            vec![(Front, [0.1, 0.9], [0.1, 0.9])],
            vec![(Rear, [0.1, 0.9], [0.1, 0.9])],
            0.0,
        ),
        // No raised floor is modelled: a downflow unit supplies low on its
        // front instead.
        CoolingSubtype::PrecisionPerimeter => match discharge {
            Some(Discharge::Downflow) => (
                vec![(Front, [0.1, 0.9], [0.05, 0.4])],
                vec![(Top, [0.1, 0.9], [0.1, 0.9])],
                0.0,
            ),
            _ => (
                vec![(Top, [0.1, 0.9], [0.1, 0.9])],
                vec![(Front, [0.1, 0.9], [0.2, 0.8])],
                0.0,
            ),
        },
    }
}

/// Airflow when neither the object nor the catalog gives one, m³/h.
fn default_airflow(s: CoolingSubtype) -> i32 {
    match s {
        CoolingSubtype::SplitWall => 700,
        CoolingSubtype::SplitCassette => 1000,
        CoolingSubtype::SplitFloorCeiling | CoolingSubtype::Ducted => 1100,
        CoolingSubtype::InRow => 3000,
        CoolingSubtype::PrecisionPerimeter => 8000,
    }
}

/// Which local face a point on (or in) the unit's body is nearest.
fn nearest_face(f: &Frame, p: [f64; 3]) -> UnitFace {
    let (w, d, h) = (f.w as f64 / 2.0, f.d as f64 / 2.0, f.h as f64);
    let cands = [
        (UnitFace::Front, (p[2] + d).abs()),
        (UnitFace::Rear, (p[2] - d).abs()),
        (UnitFace::Left, (p[0] + w).abs()),
        (UnitFace::Right, (p[0] - w).abs()),
        (UnitFace::Bottom, p[1].abs()),
        (UnitFace::Top, (p[1] - h).abs()),
    ];
    cands
        .into_iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|c| c.0)
        .unwrap_or(UnitFace::Front)
}

/// Is the box within [`WALL_GAP_MM`] of a wall, floor or ceiling on any side
/// not in `keep`? Then it reaches into it.
fn against_walls(b: &mut Box3, room: [i32; 3], keep: &[Face]) -> bool {
    let mut moved = false;
    for a in 0..3 {
        let lo = [Face::XMin, Face::YMin, Face::ZMin][a];
        let hi = lo.opposite();
        if !keep.contains(&lo) && (0..WALL_GAP_MM).contains(&b[2 * a]) {
            moved |= b[2 * a] != 0;
            b[2 * a] = -INTO_WALL_MM;
        }
        if !keep.contains(&hi) && (0..WALL_GAP_MM).contains(&(room[a] - b[2 * a + 1])) {
            moved |= b[2 * a + 1] != room[a];
            b[2 * a + 1] = room[a] + INTO_WALL_MM;
        }
    }
    moved
}

/// The run's input for a room as it stands in `view`, solved on `processes`
/// MPI processes.
pub fn case_input(view: &RoomView, processes: usize) -> Result<CaseInput, String> {
    let room = &view.room;
    let xs: Vec<i32> = room.floor_plan.iter().map(|p| p[0]).collect();
    let zs: Vec<i32> = room.floor_plan.iter().map(|p| p[1]).collect();
    let (x0, x1) = (
        *xs.iter().min().unwrap_or(&0),
        *xs.iter().max().unwrap_or(&0),
    );
    let (z0, z1) = (
        *zs.iter().min().unwrap_or(&0),
        *zs.iter().max().unwrap_or(&0),
    );
    let rectangle = room.floor_plan.len() == 4
        && room
            .floor_plan
            .iter()
            .all(|p| (p[0] == x0 || p[0] == x1) && (p[1] == z0 || p[1] == z1));
    if !rectangle || x0 != 0 || z0 != 0 {
        return Err("the airflow model needs a rectangular room with a corner at 0, 0".into());
    }
    let dims = [x1, room.height_mm, z1];
    let items: HashMap<i64, &CatalogItem> = view.catalog.iter().map(|i| (i.id, i)).collect();
    let settings = &room.settings;
    let mut solids = vec![];
    let mut units = vec![];
    let mut racks = vec![];
    let mut heat = vec![];
    let mut assumptions = vec![];
    let mut moved: Vec<String> = vec![];
    let mut skipped: Vec<String> = vec![];
    let mut doors = false;

    let (ts, ts_src) = match settings.supply_temp_c {
        Some(t) => (t, Src::Manual),
        None => (DEFAULT_SUPPLY_TEMP_C, Src::Assumed),
    };
    assumptions.push(assumption("supply_temp_c", None, json!(ts), ts_src));

    let mut push_solid = |name: &str, mut b: Box3, moved: &mut Vec<String>| {
        if against_walls(&mut b, dims, &[]) && !moved.iter().any(|m| m == name) {
            moved.push(name.to_string());
        }
        solids.push(Solid {
            name: name.to_string(),
            b,
        });
    };

    for obj in &view.contents.objects {
        let item = items
            .get(&obj.catalog_id)
            .ok_or_else(|| format!("{}: catalog item missing", obj.name))?;
        let inst = Instance::parse(&item.props, &obj.instance)?;
        let size = object_dims(item, &inst);
        let f = Frame::new(obj, size);
        let (w, d, h) = (size.0 as f64 / 2.0, size.1 as f64 / 2.0, size.2 as f64);
        match (&item.props, &inst) {
            (CatalogProps::Rack(p), Instance::Rack(i)) => {
                let base = p.u1_height_mm as f64;
                let cap = h - RACK_CAP_MM as f64;
                push_solid(&obj.name, f.boxed([-w, w, 0.0, base, -d, d]), &mut moved);
                push_solid(&obj.name, f.boxed([-w, w, cap, h, -d, d]), &mut moved);
                if i.open_frame != Some(true) {
                    let s = RACK_SIDE_MM as f64;
                    push_solid(
                        &obj.name,
                        f.boxed([-w, -w + s, base, cap, -d, d]),
                        &mut moved,
                    );
                    push_solid(&obj.name, f.boxed([w - s, w, base, cap, -d, d]), &mut moved);
                }
                let (s, g) = (RACK_SIDE_MM as f64, RACK_DOOR_GAP_MM as f64);
                let zone = f.boxed([-w + s, w - s, base, cap, -d + g, d - g]);
                let front = match Dir::front(obj.rotation_deg) {
                    Dir::Up => Face::ZMin,
                    Dir::Down => Face::ZMax,
                    Dir::Left => Face::XMin,
                    Dir::Right => Face::XMax,
                };
                let (heat_w, src) = rack_heat(view, obj, i.heat_w, settings.assumed_rack_heat_w);
                assumptions.push(assumption("rack_heat_w", Some(obj), json!(heat_w), src));
                racks.push(Rack {
                    key: format!("r{}", racks.len() + 1),
                    object_id: obj.id,
                    name: obj.name.clone(),
                    body: f.body(),
                    zone,
                    front,
                    heat_w,
                });
            }
            (CatalogProps::Cooling(c), Instance::Cooling(i)) => {
                let (sup_default, ret_default, pitch_default) = default_openings(c, i.discharge);
                let mut supplies = vec![];
                if i.supply_outlets.is_empty() {
                    for (face, u, v) in &sup_default {
                        supplies.push(Supply {
                            grille: f.grille(*face, *u, *v),
                            pitch_deg: pitch_default,
                            yaw_deg: 0.0,
                        });
                    }
                    assumptions.push(assumption(
                        "unit_supply",
                        Some(obj),
                        json!({"pitch_deg": pitch_default, "yaw_deg": 0, "default": "subtype"}),
                        Src::Assumed,
                    ));
                }
                for o in &i.supply_outlets {
                    let c3 = [o.pos_mm.x as f64, o.pos_mm.y as f64, o.pos_mm.z as f64];
                    let face = nearest_face(&f, c3);
                    let (hw, hh) = (o.size_mm.w as f64 / 2.0, o.size_mm.h as f64 / 2.0);
                    let frac = |c: f64, half: f64, len: f64| {
                        [
                            ((c - half) / len + 0.5).clamp(0.0, 1.0),
                            ((c + half) / len + 0.5).clamp(0.0, 1.0),
                        ]
                    };
                    let (fw, fd, fh) = (f.w as f64, f.d as f64, f.h as f64);
                    let (u, v) = match face {
                        UnitFace::Front | UnitFace::Rear => {
                            (frac(c3[0], hw, fw), frac(c3[1] - fh / 2.0, hh, fh))
                        }
                        UnitFace::Left | UnitFace::Right => {
                            (frac(c3[2], hw, fd), frac(c3[1] - fh / 2.0, hh, fh))
                        }
                        UnitFace::Top | UnitFace::Bottom => {
                            (frac(c3[0], hw, fw), frac(c3[2], hh, fd))
                        }
                    };
                    supplies.push(Supply {
                        grille: f.grille(face, u, v),
                        pitch_deg: o.pitch_deg as f64,
                        yaw_deg: o.yaw_deg as f64,
                    });
                    let src = match o.source {
                        OutletSource::Manual => Src::Manual,
                        OutletSource::CatalogDefault => Src::Assumed,
                    };
                    assumptions.push(assumption(
                        "unit_supply",
                        Some(obj),
                        json!({"outlet": o.id, "pitch_deg": o.pitch_deg, "yaw_deg": o.yaw_deg}),
                        src,
                    ));
                }
                let listed: Vec<UnitFace> = c
                    .openings
                    .iter()
                    .filter(|o| o.role == OpeningRole::Return)
                    .map(|o| o.face)
                    .collect();
                let returns: Vec<Grille> = if listed.is_empty() {
                    assumptions.push(assumption(
                        "unit_return",
                        Some(obj),
                        json!({"face": enum_str(&ret_default[0].0), "default": "subtype"}),
                        Src::Assumed,
                    ));
                    ret_default
                        .iter()
                        .map(|(fc, u, v)| f.grille(*fc, *u, *v))
                        .collect()
                } else {
                    // The catalog names the face; where on it is the subtype's
                    // rectangle if it is the same face, else its middle.
                    assumptions.push(assumption(
                        "unit_return",
                        Some(obj),
                        json!({"face": enum_str(&listed[0]), "size": "assumed"}),
                        Src::Datasheet,
                    ));
                    listed
                        .iter()
                        .map(|fc| match ret_default.iter().find(|r| r.0 == *fc) {
                            Some((_, u, v)) => f.grille(*fc, *u, *v),
                            None => f.grille(*fc, [0.1, 0.9], [0.25, 0.75]),
                        })
                        .collect()
                };
                let (airflow, src) = match (i.airflow_m3h, c.airflow_m3h.first()) {
                    (Some(q), _) => (q, Src::Manual),
                    (None, Some(&q)) => (q, Src::Datasheet),
                    (None, None) => (default_airflow(c.subtype), Src::Assumed),
                };
                assumptions.push(assumption(
                    "unit_airflow_m3h",
                    Some(obj),
                    json!(airflow),
                    src,
                ));
                let mut body = f.body();
                let keep: Vec<Face> = supplies
                    .iter()
                    .map(|s| s.grille.face)
                    .chain(returns.iter().map(|g| g.face))
                    .collect();
                if against_walls(&mut body, dims, &keep) {
                    moved.push(obj.name.clone());
                }
                units.push(Unit {
                    key: format!("u{}", units.len() + 1),
                    object_id: obj.id,
                    name: obj.name.clone(),
                    body,
                    supplies,
                    returns,
                    airflow_m3h: airflow,
                });
            }
            (CatalogProps::Shelf(p), _) => shelf(
                &f,
                obj,
                p,
                view,
                &mut push_solid,
                &mut moved,
                &mut heat,
                &mut assumptions,
            ),
            (CatalogProps::Structure(s), _) => match s.subtype {
                StructureSubtype::Door => doors = true,
                StructureSubtype::Window | StructureSubtype::Wall => {}
                _ => push_solid(&obj.name, f.body(), &mut moved),
            },
            (CatalogProps::CableTray(CableTrayProps { tray_type, .. }), _) => match tray_type {
                TrayType::Tray => push_solid(&obj.name, f.body(), &mut moved),
                TrayType::Ladder | TrayType::Basket => skipped.push(obj.name.clone()),
            },
            _ => return Err(format!("{}: kind and properties disagree", obj.name)),
        }
    }

    let s = Settings {
        processes,
        ..Settings::default()
    };
    assumptions.push(assumption(
        "rack_delta_t_k",
        None,
        json!(s.rack_delta_t_k),
        Src::Assumed,
    ));
    assumptions.push(assumption("rack_doors", None, json!("open"), Src::Assumed));
    assumptions.push(assumption("walls", None, json!("adiabatic"), Src::Assumed));
    if doors {
        assumptions.push(assumption("doors", None, json!("closed"), Src::Assumed));
    }
    if !skipped.is_empty() {
        assumptions.push(assumption(
            "not_modelled",
            None,
            json!(skipped),
            Src::Assumed,
        ));
    }
    if !moved.is_empty() {
        assumptions.push(assumption("against_wall", None, json!(moved), Src::Assumed));
    }
    let input = CaseInput {
        room: dims,
        solids,
        units,
        racks,
        heat,
        supply_temp_c: ts,
        settings: s,
        assumptions,
    };
    input.validate()?;
    Ok(input)
}

/// A rack's heat: its devices' powers when all are known, else the rack's
/// own setting, else the room's.
fn rack_heat(view: &RoomView, obj: &DcObject, own: Option<i32>, room: Option<i32>) -> (i32, Src) {
    let running: Vec<Option<i32>> = view
        .contents
        .devices
        .iter()
        .filter(|d| d.fields.rack_id == obj.id)
        .filter(|d| {
            matches!(
                d.fields.status,
                DeviceStatus::Active | DeviceStatus::Decommissioning
            )
        })
        .map(|d| d.fields.power_w)
        .collect();
    if obj.contents_known && running.iter().all(Option::is_some) {
        return (running.iter().flatten().sum(), Src::Devices);
    }
    match (own, room) {
        (Some(w), _) => (w, Src::Manual),
        (None, Some(w)) => (w, Src::Manual),
        (None, None) => (DEFAULT_RACK_HEAT_W, Src::Assumed),
    }
}

/// Posts, boards, and a tower case on every recorded cell with its heat
/// released behind it.
#[allow(clippy::too_many_arguments)]
fn shelf(
    f: &Frame,
    obj: &DcObject,
    p: &ShelfProps,
    view: &RoomView,
    push_solid: &mut impl FnMut(&str, Box3, &mut Vec<String>),
    moved: &mut Vec<String>,
    heat: &mut Vec<HeatZone>,
    assumptions: &mut Vec<Assumption>,
) {
    let (w, d, h) = (f.w as f64 / 2.0, f.d as f64 / 2.0, f.h as f64);
    let post = SHELF_POST_MM as f64;
    let cell_w = f.w as f64 / p.cells_per_board as f64;
    let mut post_x = vec![-w, w - post];
    let mut at = 0;
    for sec in &p.sections[..p.sections.len().saturating_sub(1)] {
        at += sec;
        post_x.push(w - at as f64 * cell_w - post / 2.0);
    }
    for x in post_x {
        for z in [-d, d - post] {
            push_solid(
                &obj.name,
                f.boxed([x, x + post, 0.0, h, z, z + post]),
                moved,
            );
        }
    }
    let mut boards = p.boards_mm.clone();
    boards.sort_unstable();
    for &by in &boards {
        let by = by as f64;
        push_solid(
            &obj.name,
            f.boxed([-w, w, by - SHELF_BOARD_MM as f64, by, -d, d]),
            moved,
        );
    }
    for c in view.contents.cells.iter().filter(|c| c.shelf_id == obj.id) {
        let Some(info) = cell_info(p, c.cell_no) else {
            continue;
        };
        let board = boards[boards.len() - 1 - info.board_from_top as usize];
        let above = boards.iter().find(|&&b| b > board).copied();
        let item_h = match above {
            Some(a) => CELL_ITEM[1].min(a - SHELF_BOARD_MM - board - 10),
            None => CELL_ITEM[1],
        } as f64;
        let x = w - cell_w * (info.column as f64 + 0.5);
        let half = CELL_ITEM[0] as f64 / 2.0;
        let by = board as f64;
        let front = -d + CELL_ITEM_FRONT_GAP_MM as f64;
        let back = front + CELL_ITEM[2] as f64;
        let name = format!("{} {}", obj.name, c.cell_no);
        push_solid(
            &name,
            f.boxed([x - half, x + half, by, by + item_h, front, back]),
            moved,
        );
        let (watts, src) = match c.power_w {
            Some(p) => (p, Src::Manual),
            None => (DEFAULT_CELL_HEAT_W, Src::Assumed),
        };
        heat.push(HeatZone {
            key: format!("c{}", heat.len() + 1),
            name,
            boxes: vec![f.boxed([
                x - half,
                x + half,
                by + 50.0,
                by + item_h - 40.0,
                back,
                back + CELL_EXHAUST_MM as f64,
            ])],
            heat_w: watts,
        });
        assumptions.push(Assumption {
            key: "cell_heat_w".into(),
            object_id: Some(obj.id),
            subject: Some(format!("{} {}", obj.name, c.cell_no)),
            value: json!(watts),
            src,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dc::model::ShelfCell;
    use crate::dc::seed::plan_view;

    /// The seeded racks, in the order they are placed.
    fn rack(view: &mut RoomView, n: usize) -> &mut DcObject {
        let racks: Vec<i64> = view
            .contents
            .objects
            .iter()
            .filter(|o| {
                view.catalog
                    .iter()
                    .any(|i| i.id == o.catalog_id && matches!(i.props, CatalogProps::Rack(_)))
            })
            .map(|o| o.id)
            .collect();
        view.contents
            .objects
            .iter_mut()
            .find(|o| o.id == racks[n])
            .unwrap()
    }

    fn find<'a>(c: &'a CaseInput, key: &str) -> Vec<&'a Assumption> {
        c.assumptions.iter().filter(|a| a.key == key).collect()
    }

    #[test]
    fn the_seeded_room_gives_the_reference_geometry() {
        let view = plan_view();
        let c = case_input(&view, 12).unwrap();
        assert_eq!(c.room, [5545, 2410, 3845]);
        assert_eq!(c.units.len(), 3);
        assert_eq!(c.racks.len(), 4);
        // Rack 1 as in make_case.py: front at z 2250, facing the shelf, its
        // fan zone inset by the side panels and the door gaps.
        let r1 = &c.racks[0];
        assert_eq!(r1.body, [530, 1130, 0, 2040, 2250, 3250]);
        assert_eq!(r1.zone, [580, 1080, 100, 1980, 2350, 3150]);
        assert_eq!(r1.front, Face::ZMin);
        // Rack 1 is an open frame: plinth and cap only.
        assert_eq!(c.solids.iter().filter(|s| s.name == r1.name).count(), 2);
        assert_eq!(
            c.solids
                .iter()
                .filter(|s| s.name == c.racks[1].name)
                .count(),
            4
        );
        // The plinth reaches into the floor; the ducted units, 30 mm off the
        // wall, are modelled against it, their tops left below the ceiling.
        let plinth = c.solids.iter().find(|s| s.name == r1.name).unwrap();
        assert_eq!(plinth.b[2], -20);
        let u1 = &c.units[0];
        assert_eq!(u1.body[4], -20);
        assert!(u1.body[3] < 2410);
        // The seeded outlet: front face (+z), pitch 0 as recorded.
        assert_eq!(u1.supplies[0].grille.face, Face::ZMax);
        assert_eq!(u1.supplies[0].pitch_deg, 0.0);
        assert_eq!(u1.returns[0].face, Face::YMin);
        // No recorded cells, so no tower and no shelf heat.
        assert!(c.heat.is_empty());
        assert!(find(&c, "against_wall")[0].value.as_array().unwrap().len() >= 3);
    }

    #[test]
    fn every_guess_is_listed() {
        let c = case_input(&plan_view(), 12).unwrap();
        let airflow = find(&c, "unit_airflow_m3h");
        assert_eq!(airflow.len(), 3);
        assert!(
            airflow
                .iter()
                .all(|a| a.src == Src::Assumed && a.value == json!(1100))
        );
        let heat = find(&c, "rack_heat_w");
        assert!(
            heat.iter()
                .all(|a| a.src == Src::Assumed && a.value == json!(3000))
        );
        assert_eq!(find(&c, "supply_temp_c")[0].value, json!(18.0));
        assert_eq!(find(&c, "unit_return")[0].src, Src::Assumed);
        assert_eq!(
            find(&c, "not_modelled")[0].value.as_array().unwrap().len(),
            1
        );
        assert_eq!(find(&c, "doors")[0].value, json!("closed"));
    }

    #[test]
    fn settings_and_objects_override_the_defaults() {
        let mut view = plan_view();
        view.room.settings.supply_temp_c = Some(17.0);
        view.room.settings.assumed_rack_heat_w = Some(2500);
        let r4 = rack(&mut view, 3);
        r4.instance["heat_w"] = json!(1500);
        let r4 = r4.id;
        let ac = view
            .contents
            .objects
            .iter_mut()
            .find(|o| o.instance.get("supply_outlets").is_some())
            .unwrap();
        ac.instance["airflow_m3h"] = json!(900);
        ac.instance["supply_outlets"][0]["pitch_deg"] = json!(30);
        let c = case_input(&view, 12).unwrap();
        assert_eq!(c.supply_temp_c, 17.0);
        let heats: Vec<i32> = c.racks.iter().map(|r| r.heat_w).collect();
        assert_eq!(heats, vec![2500, 2500, 2500, 1500]);
        assert_eq!(
            c.racks.iter().find(|r| r.object_id == r4).unwrap().heat_w,
            1500
        );
        assert_eq!(c.units[0].airflow_m3h, 900);
        assert_eq!(c.units[0].supplies[0].pitch_deg, 30.0);
    }

    #[test]
    fn a_recorded_cell_is_a_tower_with_its_heat() {
        let mut view = plan_view();
        let shelf = view
            .contents
            .objects
            .iter()
            .find(|o| {
                view.catalog
                    .iter()
                    .any(|i| i.id == o.catalog_id && matches!(i.props, CatalogProps::Shelf(_)))
            })
            .unwrap()
            .id;
        // Cell 29 is the first cell of the bottom board.
        view.contents.cells.push(ShelfCell {
            shelf_id: shelf,
            cell_no: 29,
            name: "t".into(),
            owner: String::new(),
            power_w: Some(250),
            note: String::new(),
        });
        let c = case_input(&view, 12).unwrap();
        assert_eq!(c.heat.len(), 1);
        assert_eq!(c.heat[0].heat_w, 250);
        let b = c.heat[0].boxes[0];
        // Behind the tower, toward the wall the shelf stands against.
        let tower = c.solids.iter().find(|s| s.name == c.heat[0].name).unwrap();
        assert_eq!(b[5], tower.b[4]);
        assert_eq!(tower.b[2], 100);
        // Column 0 of a shelf turned 180° is at its low x end.
        assert!(tower.b[0] < 400);
    }

    #[test]
    fn devices_with_known_power_give_the_rack_heat() {
        use crate::dc::model::{Device, DeviceFields, DeviceKind, Face as DFace, PowerSrc};
        let mut view = plan_view();
        let rack = rack(&mut view, 1);
        rack.contents_known = true;
        let rack = rack.id;
        let dev = |id: i64, w: Option<i32>, status: DeviceStatus| Device {
            id,
            fields: DeviceFields {
                rack_id: rack,
                u_bottom: id as i32 * 2,
                u_height: 1,
                face: DFace::Front,
                depth_mm: None,
                kind: DeviceKind::Server,
                name: "s".into(),
                owner: String::new(),
                serial: String::new(),
                power_w: w,
                power_src: Some(PowerSrc::Measured),
                status,
                note: String::new(),
            },
        };
        view.contents.devices = vec![
            dev(1, Some(400), DeviceStatus::Active),
            dev(2, Some(350), DeviceStatus::Active),
            dev(3, None, DeviceStatus::Planned),
        ];
        let c = case_input(&view, 12).unwrap();
        let r = c.racks.iter().find(|r| r.object_id == rack).unwrap();
        assert_eq!(r.heat_w, 750);
        // One running device of unknown power: back to the assumption.
        view.contents.devices[1].fields.power_w = None;
        let c = case_input(&view, 12).unwrap();
        assert_eq!(
            c.racks.iter().find(|r| r.object_id == rack).unwrap().heat_w,
            3000
        );
    }

    #[test]
    fn a_room_that_is_not_a_box_is_refused() {
        let mut view = plan_view();
        view.room.floor_plan = vec![
            [0, 0],
            [5000, 0],
            [5000, 2000],
            [2000, 2000],
            [2000, 4000],
            [0, 4000],
        ];
        assert!(case_input(&view, 12).is_err());
    }
}
