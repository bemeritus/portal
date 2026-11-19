//! Placement geometry, pure: footprints, room containment, collisions, door
//! swing, gaps and service clearance (§4.4), shelf cells, rack units.
//!
//! No database and no I/O, so every rule is unit-tested here. The frontend has
//! a mirror (`frontend/src/dc/model/geometry.ts`) for instant feedback while
//! dragging; this one is what the write transaction trusts.
//!
//! Coordinates as in `room.json`: x along the room's length, z across it, y up,
//! all in millimetres. A rotation of 0 has a rack's front facing −z; 90 turns
//! it to face +x, 180 to +z, 270 to −x (viewed from above, clockwise).

use serde::Serialize;

use super::model::{
    CatalogItem, CatalogProps, DcObject, Hinge, Instance, Kind, Measurement, RoomSettings,
    ShelfProps, StructureSubtype,
};

/// Rack unit height, 1.75 in.
pub const U_MM: f64 = 44.45;

/// Axis-aligned rectangle on the floor plan, `x0 < x1`, `z0 < z1` (mm).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x0: i32,
    pub z0: i32,
    pub x1: i32,
    pub z1: i32,
}

impl Rect {
    pub fn new(x0: i32, z0: i32, x1: i32, z1: i32) -> Rect {
        Rect {
            x0: x0.min(x1),
            z0: z0.min(z1),
            x1: x0.max(x1),
            z1: z0.max(z1),
        }
    }

    /// Open intersection: rectangles that only touch do not overlap.
    pub fn overlaps(&self, o: &Rect) -> bool {
        self.x0 < o.x1 && o.x0 < self.x1 && self.z0 < o.z1 && o.z0 < self.z1
    }

    pub fn intersection(&self, o: &Rect) -> Option<Rect> {
        let r = Rect {
            x0: self.x0.max(o.x0),
            z0: self.z0.max(o.z0),
            x1: self.x1.min(o.x1),
            z1: self.z1.min(o.z1),
        };
        (r.x0 < r.x1 && r.z0 < r.z1).then_some(r)
    }
}

/// Which way something faces, in plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Dir {
    /// −x
    Left,
    /// +x
    Right,
    /// −z
    Up,
    /// +z
    Down,
}

impl Dir {
    pub fn opposite(self) -> Dir {
        match self {
            Dir::Left => Dir::Right,
            Dir::Right => Dir::Left,
            Dir::Up => Dir::Down,
            Dir::Down => Dir::Up,
        }
    }

    /// The direction a rack's front faces at a rotation.
    pub fn front(rotation_deg: i32) -> Dir {
        match rotation_deg.rem_euclid(360) {
            90 => Dir::Right,
            180 => Dir::Down,
            270 => Dir::Left,
            _ => Dir::Up,
        }
    }
}

/// An object's local size (before rotation): width along local x, depth along
/// local z, height. Catalog dimensions with the overrides the kind allows.
pub fn object_dims(item: &CatalogItem, instance: &Instance) -> (i32, i32, i32) {
    let (w, d, h) = (item.width_mm, item.depth_mm, item.height_mm);
    match instance {
        Instance::Cooling(i) => (i.width_mm.unwrap_or(w), d, h),
        Instance::CableTray(i) => (i.length_mm.unwrap_or(w), d, h),
        Instance::Structure(i) => (
            i.width_mm.unwrap_or(w),
            i.depth_mm.unwrap_or(d),
            i.height_mm.unwrap_or(h),
        ),
        Instance::Rack(_) | Instance::Shelf(_) => (w, d, h),
    }
}

/// The footprint of something `w × d` whose min corner is at `(x0, z0)` after
/// turning by `rotation_deg`.
pub fn footprint(x0: i32, z0: i32, w: i32, d: i32, rotation_deg: i32) -> Rect {
    let (fw, fd) = if rotation_deg.rem_euclid(180) == 0 {
        (w, d)
    } else {
        (d, w)
    };
    Rect::new(x0, z0, x0 + fw, z0 + fd)
}

/// One object as the geometry sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Solid {
    pub id: i64,
    pub name: String,
    pub kind: Kind,
    pub rect: Rect,
    pub y0: i32,
    pub y1: i32,
    pub rotation_deg: i32,
    /// For doors: the swing, a quarter disc.
    pub swing: Option<Swing>,
}

impl Solid {
    /// Stands on the floor and takes floor space (doors do not: they are an
    /// opening in a wall, and their swing is checked separately).
    pub fn on_floor(&self) -> bool {
        self.y0 == 0 && self.swing.is_none()
    }

    pub fn is_rack(&self) -> bool {
        self.kind == Kind::Rack
    }
}

/// A door leaf's sweep: a quarter disc of `radius` centred on the hinge,
/// spanning `quadrant` (the part of the plane the leaf passes through).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Swing {
    pub hinge: (i32, i32),
    pub radius: i32,
    pub quadrant: Rect,
    pub height: i32,
}

impl Swing {
    /// Does the sweep reach into `r`?
    pub fn hits(&self, r: &Rect) -> bool {
        let Some(part) = r.intersection(&self.quadrant) else {
            return false;
        };
        // Closest point of that part to the hinge, then compare with the radius.
        let (hx, hz) = (self.hinge.0 as i64, self.hinge.1 as i64);
        let cx = hx.clamp(part.x0 as i64, part.x1 as i64);
        let cz = hz.clamp(part.z0 as i64, part.z1 as i64);
        let (dx, dz) = (cx - hx, cz - hz);
        let rad = self.radius as i64;
        dx * dx + dz * dz < rad * rad
    }
}

/// Place an object: its footprint, vertical extent and, for a door, its swing.
/// `polygon` is needed to tell which side of a door is inside the room.
pub fn solid(obj: &DcObject, item: &CatalogItem, polygon: &[[i32; 2]]) -> Result<Solid, String> {
    let instance = Instance::parse(&item.props, &obj.instance)?;
    let (w, d, h) = object_dims(item, &instance);
    let rect = footprint(obj.x0_mm, obj.z0_mm, w, d, obj.rotation_deg);
    let mut swing = None;
    if let (CatalogProps::Structure(s), Instance::Structure(i)) = (&item.props, &instance)
        && s.subtype == StructureSubtype::Door
    {
        swing = Some(door_swing(
            rect,
            w,
            h,
            i.hinge.unwrap_or(Hinge::Low),
            polygon,
        ));
    }
    Ok(Solid {
        id: obj.id,
        name: obj.name.clone(),
        kind: item.kind(),
        rect,
        y0: obj.y0_mm,
        y1: obj.y0_mm + h,
        rotation_deg: obj.rotation_deg,
        swing,
    })
}

/// A door opening is the footprint's long side; the leaf swings into the room.
fn door_swing(rect: Rect, width: i32, height: i32, hinge: Hinge, polygon: &[[i32; 2]]) -> Swing {
    let along_x = (rect.x1 - rect.x0) >= (rect.z1 - rect.z0);
    let (cx, cz) = centroid(polygon);
    if along_x {
        let z = rect.z0;
        let into = if cz >= z as f64 { 1 } else { -1 };
        let (hx, toward) = match hinge {
            Hinge::Low => (rect.x0, 1),
            Hinge::High => (rect.x1, -1),
        };
        Swing {
            hinge: (hx, z),
            radius: width,
            quadrant: Rect::new(hx, z, hx + toward * width, z + into * width),
            height,
        }
    } else {
        let x = rect.x0;
        let into = if cx >= x as f64 { 1 } else { -1 };
        let (hz, toward) = match hinge {
            Hinge::Low => (rect.z0, 1),
            Hinge::High => (rect.z1, -1),
        };
        Swing {
            hinge: (x, hz),
            radius: width,
            quadrant: Rect::new(x, hz, x + into * width, hz + toward * width),
            height,
        }
    }
}

fn centroid(polygon: &[[i32; 2]]) -> (f64, f64) {
    let n = polygon.len().max(1) as f64;
    let (sx, sz) = polygon
        .iter()
        .fold((0.0, 0.0), |(a, b), p| (a + p[0] as f64, b + p[1] as f64));
    (sx / n, sz / n)
}

// --- Room polygon ------------------------------------------------------------

/// Point in polygon, boundary included.
pub fn point_in_polygon(x: i32, z: i32, polygon: &[[i32; 2]]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let (px, pz) = (x as i64, z as i64);
    let mut inside = false;
    for i in 0..n {
        let [ax, az] = polygon[i].map(i64::from);
        let [bx, bz] = polygon[(i + 1) % n].map(i64::from);
        // On the edge?
        let cross = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
        if cross == 0
            && px >= ax.min(bx)
            && px <= ax.max(bx)
            && pz >= az.min(bz)
            && pz <= az.max(bz)
        {
            return true;
        }
        if (az > pz) != (bz > pz) {
            // x of the edge at height pz, compared without division
            let lhs = (px - ax) * (bz - az);
            let rhs = (bx - ax) * (pz - az);
            if (bz > az && lhs < rhs) || (bz < az && lhs > rhs) {
                inside = !inside;
            }
        }
    }
    inside
}

/// A rectangle lies inside the polygon: its corners are inside (or on the
/// boundary) and no polygon vertex pokes strictly into it.
pub fn rect_in_polygon(r: &Rect, polygon: &[[i32; 2]]) -> bool {
    let corners = [(r.x0, r.z0), (r.x1, r.z0), (r.x1, r.z1), (r.x0, r.z1)];
    corners
        .iter()
        .all(|&(x, z)| point_in_polygon(x, z, polygon))
        && !polygon
            .iter()
            .any(|p| p[0] > r.x0 && p[0] < r.x1 && p[1] > r.z0 && p[1] < r.z1)
}

/// The polygon's bounding box.
pub fn bounds(polygon: &[[i32; 2]]) -> Rect {
    let xs = polygon.iter().map(|p| p[0]);
    let zs = polygon.iter().map(|p| p[1]);
    Rect {
        x0: xs.clone().min().unwrap_or(0),
        x1: xs.max().unwrap_or(0),
        z0: zs.clone().min().unwrap_or(0),
        z1: zs.max().unwrap_or(0),
    }
}

// --- Validity ------------------------------------------------------------------

/// Why a placement is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Problem {
    OutsideRoom,
    AboveCeiling,
    Overlaps { other: String },
    BlocksDoor { door: String },
}

/// Hard placement rules for `solids[idx]` against the room and the others.
pub fn problems(idx: usize, solids: &[Solid], polygon: &[[i32; 2]], room_h: i32) -> Vec<Problem> {
    let s = &solids[idx];
    let mut out = Vec::new();
    // A door sits in the wall line, so only its position along it is checked.
    if s.swing.is_none() && !rect_in_polygon(&s.rect, polygon) {
        out.push(Problem::OutsideRoom);
    }
    if s.y1 > room_h {
        out.push(Problem::AboveCeiling);
    }
    for (j, o) in solids.iter().enumerate() {
        if j == idx {
            continue;
        }
        let y_overlap = s.y0 < o.y1 && o.y0 < s.y1;
        match (&s.swing, &o.swing) {
            (None, None) => {
                if y_overlap && s.rect.overlaps(&o.rect) {
                    out.push(Problem::Overlaps {
                        other: o.name.clone(),
                    });
                }
            }
            (None, Some(sw)) => {
                if s.y0 < sw.height && sw.hits(&s.rect) {
                    out.push(Problem::BlocksDoor {
                        door: o.name.clone(),
                    });
                }
            }
            (Some(sw), None) => {
                if o.y0 < sw.height && sw.hits(&o.rect) {
                    out.push(Problem::BlocksDoor {
                        door: s.name.clone(),
                    });
                }
            }
            (Some(_), Some(_)) => {}
        }
    }
    out
}

/// Free distance from a face of `rect` to the nearest wall or obstacle,
/// looking in `dir` across the face's full span. Obstacles are given as
/// rectangles; walls come from the polygon's axis-aligned edges (phase 1 rooms
/// are rectangles; any other edge falls back to the bounding box).
pub fn gap(rect: &Rect, dir: Dir, obstacles: &[Rect], polygon: &[[i32; 2]]) -> Gap {
    let b = bounds(polygon);
    let mut best = match dir {
        Dir::Left => b.x0,
        Dir::Right => b.x1,
        Dir::Up => b.z0,
        Dir::Down => b.z1,
    };
    let mut hit: Option<usize> = None;
    let n = polygon.len();
    for i in 0..n {
        let [ax, az] = polygon[i];
        let [bx, bz] = polygon[(i + 1) % n];
        match dir {
            Dir::Left | Dir::Right if ax == bx => {
                let (lo, hi) = (az.min(bz), az.max(bz));
                if lo < rect.z1 && rect.z0 < hi {
                    if dir == Dir::Left && ax <= rect.x0 && ax > best {
                        best = ax;
                    }
                    if dir == Dir::Right && ax >= rect.x1 && ax < best {
                        best = ax;
                    }
                }
            }
            Dir::Up | Dir::Down if az == bz => {
                let (lo, hi) = (ax.min(bx), ax.max(bx));
                if lo < rect.x1 && rect.x0 < hi {
                    if dir == Dir::Up && az <= rect.z0 && az > best {
                        best = az;
                    }
                    if dir == Dir::Down && az >= rect.z1 && az < best {
                        best = az;
                    }
                }
            }
            _ => {}
        }
    }
    for (k, o) in obstacles.iter().enumerate() {
        let better = match dir {
            Dir::Left => o.z0 < rect.z1 && rect.z0 < o.z1 && o.x1 <= rect.x0 && o.x1 > best,
            Dir::Right => o.z0 < rect.z1 && rect.z0 < o.z1 && o.x0 >= rect.x1 && o.x0 < best,
            Dir::Up => o.x0 < rect.x1 && rect.x0 < o.x1 && o.z1 <= rect.z0 && o.z1 > best,
            Dir::Down => o.x0 < rect.x1 && rect.x0 < o.x1 && o.z0 >= rect.z1 && o.z0 < best,
        };
        if better {
            best = match dir {
                Dir::Left => o.x1,
                Dir::Right => o.x0,
                Dir::Up => o.z1,
                Dir::Down => o.z0,
            };
            hit = Some(k);
        }
    }
    let mm = match dir {
        Dir::Left => rect.x0 - best,
        Dir::Right => best - rect.x1,
        Dir::Up => rect.z0 - best,
        Dir::Down => best - rect.z1,
    };
    Gap { mm, obstacle: hit }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gap {
    pub mm: i32,
    /// Index into the obstacles, or `None` for a wall.
    pub obstacle: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Front,
    Rear,
}

/// What a clearance check was decided on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// A tape reading of this very gap.
    Measured,
    /// The model's distance; nobody measured this gap directly.
    Model,
}

/// One service-clearance check for a rack (§4.4). A shortfall is a warning,
/// never a refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Clearance {
    pub object_id: i64,
    pub object: String,
    pub side: Side,
    pub basis: Basis,
    /// The tape reading of the same gap; for two readings, the lower one.
    pub measured_mm: Option<i32>,
    /// The gap in the model.
    pub model_mm: i32,
    pub required_mm: i32,
    /// What the gap ends at; `None` = a wall.
    pub obstacle: Option<String>,
}

impl Clearance {
    /// The gap the check is decided on: the tape when there is one.
    pub fn gap_mm(&self) -> i32 {
        self.measured_mm.unwrap_or(self.model_mm)
    }

    pub fn ok(&self) -> bool {
        self.gap_mm() >= self.required_mm
    }
}

/// How far a measurement's ends may sit from the gap's ends and still be
/// read as the same gap (the model is placed in whole millimetres).
const SAME_GAP_MM: i32 = 2;

/// The tape reading of a rack's gap: a measurement drawn along the same line —
/// from the rack's face, in the gap's direction, within the rack's width, to
/// where the gap ends. For two readings, the lower one.
fn measured_gap(rect: &Rect, dir: Dir, g: Gap, measurements: &[Measurement]) -> Option<i32> {
    let (face, end, across) = match dir {
        Dir::Left => (rect.x0, rect.x0 - g.mm, (rect.z0, rect.z1)),
        Dir::Right => (rect.x1, rect.x1 + g.mm, (rect.z0, rect.z1)),
        Dir::Up => (rect.z0, rect.z0 - g.mm, (rect.x0, rect.x1)),
        Dir::Down => (rect.z1, rect.z1 + g.mm, (rect.x0, rect.x1)),
    };
    let along_x = matches!(dir, Dir::Left | Dir::Right);
    measurements.iter().find_map(|m| {
        let [p, q] = m.line?;
        let (pa, qa, pc, qc) = if along_x {
            (p[0], q[0], p[2], q[2])
        } else {
            (p[2], q[2], p[0], q[0])
        };
        let near = |a: i32, b: i32| (a - b).abs() <= SAME_GAP_MM;
        let ends = (near(pa, face) && near(qa, end)) || (near(qa, face) && near(pa, end));
        let inside = pc == qc && across.0 < pc && pc < across.1;
        (ends && inside).then(|| m.min.unwrap_or(m.value))
    })
}

/// Front and rear clearance of every rack. Obstacles are the other things that
/// stand on the floor; wall- and ceiling-mounted ones leave the floor free.
/// A tape reading of the same gap decides over the model (FEEDBACK-5 §1): the
/// model is assembled from other readings, the tape read this one.
pub fn clearances(
    solids: &[Solid],
    polygon: &[[i32; 2]],
    settings: &RoomSettings,
    measurements: &[Measurement],
) -> Vec<Clearance> {
    let mut out = Vec::new();
    for (i, s) in solids.iter().enumerate() {
        if !s.is_rack() {
            continue;
        }
        let others: Vec<(usize, Rect)> = solids
            .iter()
            .enumerate()
            .filter(|(j, o)| *j != i && o.on_floor())
            .map(|(j, o)| (j, o.rect))
            .collect();
        let rects: Vec<Rect> = others.iter().map(|(_, r)| *r).collect();
        let front = Dir::front(s.rotation_deg);
        for (side, dir, required) in [
            (Side::Front, front, settings.clearance_front_mm),
            (Side::Rear, front.opposite(), settings.clearance_rear_mm),
        ] {
            let g = gap(&s.rect, dir, &rects, polygon);
            let measured = measured_gap(&s.rect, dir, g, measurements);
            out.push(Clearance {
                object_id: s.id,
                object: s.name.clone(),
                side,
                basis: if measured.is_some() {
                    Basis::Measured
                } else {
                    Basis::Model
                },
                measured_mm: measured,
                model_mm: g.mm,
                required_mm: required,
                obstacle: g.obstacle.map(|k| solids[others[k].0].name.clone()),
            });
        }
    }
    out
}

// --- Racks -------------------------------------------------------------------

/// Usable units of a rack of `height_mm` with `plinth_and_cap_mm` taken by the
/// plinth and top cap: `floor((h − p) / 44.45)`. The four existing racks:
/// `floor((2040 − 160) / 44.45) = 42`.
pub fn units_for_height(height_mm: i32, plinth_and_cap_mm: i32) -> i32 {
    (((height_mm - plinth_and_cap_mm) as f64) / U_MM).floor() as i32
}

// --- Shelf cells ---------------------------------------------------------------

/// Clear height above a top-board cell below which a unit overhead blocks it:
/// the prototype's top cell height.
pub const TOP_CELL_CLEAR_MM: i32 = 580;
/// Half the width of what stands in a cell (a tower case, about 220 mm).
pub const CELL_ITEM_HALF_MM: i32 = 110;
/// Extra distance kept from an overhead unit's body.
pub const OVERHEAD_MARGIN_MM: i32 = 30;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CellInfo {
    pub cell_no: i32,
    /// 0 = top board.
    pub board_from_top: i32,
    /// 0 = first cell of the board along the shelf's width.
    pub column: i32,
    /// Whether the board carries number plates.
    pub plated: bool,
}

pub fn cell_count(p: &ShelfProps) -> i32 {
    p.boards_mm.len() as i32 * p.cells_per_board
}

/// Cells are numbered from the top board down, left to right along the shelf.
pub fn cell_info(p: &ShelfProps, cell_no: i32) -> Option<CellInfo> {
    if cell_no < 1 || cell_no > cell_count(p) {
        return None;
    }
    let board_from_top = (cell_no - 1) / p.cells_per_board;
    Some(CellInfo {
        cell_no,
        board_from_top,
        column: (cell_no - 1) % p.cells_per_board,
        plated: board_from_top < p.plated_boards,
    })
}

/// Does column 0 sit at the high end of the shelf's long axis?
pub fn cells_reversed(rotation_deg: i32) -> bool {
    matches!(rotation_deg.rem_euclid(360), 0 | 90)
}

/// The plan rectangle of what would stand in a cell, given the shelf's solid.
fn cell_item_rect(shelf: &Solid, p: &ShelfProps, column: i32) -> Rect {
    let r = shelf.rect;
    let along_x = shelf.rotation_deg.rem_euclid(180) == 0;
    let len = if along_x { r.x1 - r.x0 } else { r.z1 - r.z0 } as f64;
    // Cells run left to right as seen from the shelf's front. Facing a front
    // that faces −z (rotation 0) your left is +x, so column 0 is at the far end;
    // at 180 (front +z) it is at x0. Likewise 90 → z1, 270 → z0.
    let reversed = cells_reversed(shelf.rotation_deg);
    let col = if reversed {
        p.cells_per_board - 1 - column
    } else {
        column
    };
    let centre = len / p.cells_per_board as f64 * (col as f64 + 0.5);
    if along_x {
        let c = r.x0 as f64 + centre;
        Rect::new(
            (c - CELL_ITEM_HALF_MM as f64).round() as i32,
            r.z0,
            (c + CELL_ITEM_HALF_MM as f64).round() as i32,
            r.z1,
        )
    } else {
        let c = r.z0 as f64 + centre;
        Rect::new(
            r.x0,
            (c - CELL_ITEM_HALF_MM as f64).round() as i32,
            r.x1,
            (c + CELL_ITEM_HALF_MM as f64).round() as i32,
        )
    }
}

/// Cells of the top board that a cooling unit hangs too low over to use.
pub fn blocked_cells(shelf: &Solid, p: &ShelfProps, overhead: &[&Solid]) -> Vec<i32> {
    let Some(&top) = p.boards_mm.last() else {
        return vec![];
    };
    (0..p.cells_per_board)
        .filter(|&col| {
            let cell = cell_item_rect(shelf, p, col);
            overhead.iter().any(|u| {
                let body = Rect::new(
                    u.rect.x0 - OVERHEAD_MARGIN_MM,
                    u.rect.z0 - OVERHEAD_MARGIN_MM,
                    u.rect.x1 + OVERHEAD_MARGIN_MM,
                    u.rect.z1 + OVERHEAD_MARGIN_MM,
                );
                u.y0 >= top && u.y0 - top < TOP_CELL_CLEAR_MM && cell.overlaps(&body)
            })
        })
        .map(|col| col + 1)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dc::model::MeasSrc;

    const ROOM: [[i32; 2]; 4] = [[0, 0], [5545, 0], [5545, 3845], [0, 3845]];

    fn s(name: &str, kind: Kind, rect: Rect, y0: i32, y1: i32) -> Solid {
        Solid {
            id: 0,
            name: name.into(),
            kind,
            rect,
            y0,
            y1,
            rotation_deg: 0,
            swing: None,
        }
    }

    fn rack(name: &str, x0: i32, front_z: i32) -> Solid {
        s(
            name,
            Kind::Rack,
            Rect::new(x0, front_z, x0 + 600, front_z + 1000),
            0,
            2040,
        )
    }

    fn shelf() -> Solid {
        // Against the z = 0 wall, its front facing into the room.
        Solid {
            rotation_deg: 180,
            ..s("shelf", Kind::Shelf, Rect::new(200, 0, 4730, 910), 0, 1795)
        }
    }

    #[test]
    fn rotation_swaps_the_footprint() {
        assert_eq!(
            footprint(10, 20, 600, 1000, 0),
            Rect::new(10, 20, 610, 1020)
        );
        assert_eq!(
            footprint(10, 20, 600, 1000, 90),
            Rect::new(10, 20, 1010, 620)
        );
        assert_eq!(Dir::front(0), Dir::Up);
        assert_eq!(Dir::front(90), Dir::Right);
        assert_eq!(Dir::front(180).opposite(), Dir::Up);
    }

    #[test]
    fn points_and_rects_in_the_room() {
        assert!(point_in_polygon(0, 0, &ROOM));
        assert!(point_in_polygon(5545, 1000, &ROOM));
        assert!(!point_in_polygon(5546, 1000, &ROOM));
        assert!(rect_in_polygon(&Rect::new(0, 0, 600, 1000), &ROOM));
        assert!(!rect_in_polygon(&Rect::new(5000, 0, 5600, 1000), &ROOM));
        // An L-shaped room: the notch is outside even though all corners of
        // the bounding box are not.
        let l = [
            [0, 0],
            [2000, 0],
            [2000, 1000],
            [1000, 1000],
            [1000, 2000],
            [0, 2000],
        ];
        assert!(rect_in_polygon(&Rect::new(0, 0, 1000, 2000), &l));
        assert!(!rect_in_polygon(&Rect::new(500, 500, 1500, 1500), &l));
    }

    #[test]
    fn touching_is_not_overlapping() {
        let a = rack("a", 0, 2000);
        let b = rack("b", 600, 2000);
        let solids = vec![a, b];
        assert!(problems(0, &solids, &ROOM, 2410).is_empty());
        let c = rack("c", 599, 2000);
        let solids = vec![solids[0].clone(), c];
        assert_eq!(
            problems(0, &solids, &ROOM, 2410),
            vec![Problem::Overlaps { other: "c".into() }]
        );
    }

    #[test]
    fn wall_units_pass_over_floor_objects() {
        // The air conditioners hang above the shelf: the plans overlap, the
        // heights do not.
        let ac = s(
            "ac",
            Kind::Cooling,
            Rect::new(297, 30, 1442, 680),
            1935,
            2315,
        );
        let solids = vec![shelf(), ac];
        assert!(problems(1, &solids, &ROOM, 2410).is_empty());
        let low = s(
            "low",
            Kind::Cooling,
            Rect::new(297, 30, 1442, 680),
            1700,
            2080,
        );
        let solids = vec![shelf(), low];
        assert_eq!(problems(1, &solids, &ROOM, 2410).len(), 1);
    }

    #[test]
    fn outside_and_above_are_refused() {
        let r = rack("r", 5000, 2000);
        assert_eq!(problems(0, &[r], &ROOM, 2410), vec![Problem::OutsideRoom]);
        let r = rack("r", 0, 2000);
        assert_eq!(problems(0, &[r], &ROOM, 2000), vec![Problem::AboveCeiling]);
    }

    fn door() -> Solid {
        // The room's door: right wall, opening z 860–1790, hinge at 1790,
        // swinging in toward the shelf wall.
        let rect = Rect::new(5545, 860, 5545, 1790);
        let sw = door_swing(rect, 930, 1970, Hinge::High, &ROOM);
        Solid {
            swing: Some(sw),
            ..s("door", Kind::Structure, rect, 0, 1970)
        }
    }

    #[test]
    fn door_swing_is_a_quarter_disc_into_the_room() {
        let d = door();
        let sw = d.swing.unwrap();
        assert_eq!(sw.hinge, (5545, 1790));
        assert_eq!(sw.quadrant, Rect::new(4615, 860, 5545, 1790));
        // Inside the disc near the wall.
        assert!(sw.hits(&Rect::new(5300, 1500, 5400, 1600)));
        // In the quadrant's corner but outside the disc.
        assert!(!sw.hits(&Rect::new(4620, 865, 4700, 900)));
        // The safe sits by the same wall, clear of the swing.
        assert!(!sw.hits(&Rect::new(5009, 5, 5515, 405)));
        let solids = vec![d, rack("r", 4900, 1200)];
        assert_eq!(
            problems(1, &solids, &ROOM, 2410),
            vec![Problem::BlocksDoor {
                door: "door".into()
            }]
        );
    }

    #[test]
    fn gaps_to_walls_and_neighbours() {
        let r = rack("r", 530, 2250).rect;
        assert_eq!(gap(&r, Dir::Left, &[], &ROOM).mm, 530);
        assert_eq!(
            gap(&r, Dir::Down, &[], &ROOM),
            Gap {
                mm: 595,
                obstacle: None
            }
        );
        let sh = shelf().rect;
        assert_eq!(
            gap(&r, Dir::Up, &[sh], &ROOM),
            Gap {
                mm: 1340,
                obstacle: Some(0)
            }
        );
    }

    fn seeded_racks() -> Vec<Solid> {
        let tray = s(
            "tray",
            Kind::CableTray,
            Rect::new(0, 3645, 5545, 3845),
            1990,
            2050,
        );
        vec![
            shelf(),
            tray,
            rack("r1", 530, 2250),
            rack("r2", 1595, 2260),
            rack("r3", 2635, 2220),
            rack("r4", 3435, 2215),
        ]
    }

    /// A tape reading drawn from a rack's back (rack at `x0`, front at
    /// `front_z`) to the rear wall, as the seed draws it.
    fn back_tape(x0: i32, front_z: i32, value: i32, range: Option<(i32, i32)>) -> Measurement {
        let back = front_z + 1000;
        Measurement {
            key: "racks.back".into(),
            value,
            min: range.map(|r| r.0),
            max: range.map(|r| r.1),
            src: MeasSrc::Measured,
            model: Some(3845 - back),
            line: Some([[x0 + 300, 0, back], [x0 + 300, 0, 3845]]),
            note: None,
            objects: vec![],
        }
    }

    #[test]
    fn without_a_tape_reading_the_model_decides() {
        // SPEC §4.4: with 1000/600 defaults, racks 1 and 2 are short at the
        // rear by the model of room.json v2 (595 and 585 mm).
        let c = clearances(&seeded_racks(), &ROOM, &RoomSettings::default(), &[]);
        let short: Vec<_> = c
            .iter()
            .filter(|c| !c.ok())
            .map(|c| (c.object.as_str(), c.side, c.basis, c.gap_mm()))
            .collect();
        assert_eq!(
            short,
            vec![
                ("r1", Side::Rear, Basis::Model, 595),
                ("r2", Side::Rear, Basis::Model, 585)
            ]
        );
        assert!(c.iter().all(|c| c.measured_mm.is_none()));
        let front: Vec<_> = c
            .iter()
            .filter(|c| c.side == Side::Front)
            .map(|c| c.model_mm)
            .collect();
        assert_eq!(front, vec![1340, 1350, 1310, 1305]);
        assert!(
            c.iter()
                .filter(|c| c.side == Side::Front)
                .all(|c| c.obstacle.as_deref() == Some("shelf"))
        );
    }

    #[test]
    fn a_tape_reading_of_the_same_gap_decides() {
        // FEEDBACK-5 §1: r1 is 595 by the model but 610 by the tape — it
        // passes; r2 is 585 by the model and 555 by the tape — it fails.
        let tapes = [
            back_tape(530, 2250, 610, None),
            back_tape(1595, 2260, 555, None),
        ];
        let c = clearances(&seeded_racks(), &ROOM, &RoomSettings::default(), &tapes);
        let rear = |name: &str| {
            c.iter()
                .find(|c| c.object == name && c.side == Side::Rear)
                .unwrap()
        };
        let r1 = rear("r1");
        assert_eq!(
            (r1.basis, r1.measured_mm, r1.model_mm, r1.ok()),
            (Basis::Measured, Some(610), 595, true)
        );
        let r2 = rear("r2");
        assert_eq!(
            (r2.basis, r2.measured_mm, r2.model_mm, r2.ok()),
            (Basis::Measured, Some(555), 585, false)
        );
        // Nobody measured r3's back: the model decides there.
        let r3 = rear("r3");
        assert_eq!((r3.basis, r3.measured_mm), (Basis::Model, None));
        // A reading of the rack's back does not stand for its front.
        assert!(
            c.iter()
                .filter(|c| c.side == Side::Front)
                .all(|c| c.basis == Basis::Model)
        );
        let short: Vec<_> = c
            .iter()
            .filter(|c| !c.ok())
            .map(|c| c.object.as_str())
            .collect();
        assert_eq!(short, vec!["r2"]);
    }

    #[test]
    fn a_tape_line_elsewhere_is_not_this_gap() {
        // Same length, but beside the rack: not a reading of its gap.
        let mut beside = back_tape(530, 2250, 610, None);
        beside.line = Some([[1200, 0, 3250], [1200, 0, 3845]]);
        // Along the rack, but to a different end (the rack has moved since).
        let mut moved = back_tape(530, 2250, 610, None);
        moved.line = Some([[830, 0, 3200], [830, 0, 3845]]);
        // No line at all.
        let mut undrawn = back_tape(530, 2250, 610, None);
        undrawn.line = None;
        for m in [beside, moved, undrawn] {
            let c = clearances(&seeded_racks(), &ROOM, &RoomSettings::default(), &[m]);
            let r1 = c
                .iter()
                .find(|c| c.object == "r1" && c.side == Side::Rear)
                .unwrap();
            assert_eq!((r1.basis, r1.gap_mm()), (Basis::Model, 595));
        }
    }

    #[test]
    fn a_range_that_straddles_the_requirement_uses_its_lower_end() {
        // Two readings, 590 and 615: the lower one decides, so it fails —
        // even though the midpoint (603) and the model would pass.
        // 600 mm behind, the default.
        let settings = RoomSettings::default();
        let solids = vec![rack("r", 530, 2240), shelf()];
        let tape = back_tape(530, 2240, 603, Some((590, 615)));
        let c = clearances(&solids, &ROOM, &settings, &[tape]);
        let rear = c.iter().find(|c| c.side == Side::Rear).unwrap();
        assert_eq!(rear.model_mm, 605);
        assert_eq!(
            (rear.basis, rear.measured_mm, rear.ok()),
            (Basis::Measured, Some(590), false)
        );
        // A range wholly above the requirement passes.
        let tape = back_tape(530, 2240, 610, Some((605, 615)));
        let c = clearances(&solids, &ROOM, &settings, &[tape]);
        let rear = c.iter().find(|c| c.side == Side::Rear).unwrap();
        assert_eq!((rear.measured_mm, rear.ok()), (Some(605), true));
    }

    #[test]
    fn units_of_the_rack_type() {
        assert_eq!(units_for_height(2040, 160), 42);
        assert_eq!(units_for_height(2000, 160), 41);
    }

    fn shelf_props() -> ShelfProps {
        ShelfProps {
            boards_mm: vec![100, 948, 1795],
            cells_per_board: 14,
            sections: vec![5, 9],
            plated_boards: 2,
            finish: None,
        }
    }

    #[test]
    fn cells_are_numbered_from_the_top_board() {
        let p = shelf_props();
        assert_eq!(cell_count(&p), 42);
        let c = cell_info(&p, 15).unwrap();
        assert_eq!((c.board_from_top, c.column, c.plated), (1, 0, true));
        let c = cell_info(&p, 42).unwrap();
        assert_eq!((c.board_from_top, c.column, c.plated), (2, 13, false));
        assert!(cell_info(&p, 43).is_none());
        assert!(cell_info(&p, 0).is_none());
    }

    #[test]
    fn air_conditioners_block_the_top_cells_under_them() {
        let acs = [
            s(
                "ac1",
                Kind::Cooling,
                Rect::new(4005, 30, 5255, 680),
                1960,
                2340,
            ),
            s(
                "ac2",
                Kind::Cooling,
                Rect::new(2488, 30, 3633, 680),
                1965,
                2345,
            ),
            s(
                "ac3",
                Kind::Cooling,
                Rect::new(298, 30, 1443, 680),
                1935,
                2315,
            ),
        ];
        let refs: Vec<&Solid> = acs.iter().collect();
        let blocked = blocked_cells(&shelf(), &shelf_props(), &refs);
        // Same set as the prototype's `slotInfo`: eleven of the fourteen top cells.
        assert_eq!(blocked, vec![1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14]);
        // Seen from the other side, the same cells carry the mirrored numbers.
        let back = Solid {
            rotation_deg: 0,
            ..shelf()
        };
        let mirrored = blocked_cells(&back, &shelf_props(), &refs);
        assert_eq!(mirrored, vec![1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14]);
        // A unit high enough above the board blocks nothing.
        let high = s(
            "hi",
            Kind::Cooling,
            Rect::new(298, 30, 1443, 680),
            2400,
            2780,
        );
        assert!(blocked_cells(&shelf(), &shelf_props(), &[&high]).is_empty());
    }
}
