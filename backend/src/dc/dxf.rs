//! The room as a DXF drawing (§16), ported from the prototype's `dxf.js`.
//!
//! DXF R12 in millimetres, Windows-1251 text (`$DWGCODEPAGE ANSI_1251`), so
//! AutoCAD, nanoCAD, BricsCAD and LibreCAD read Cyrillic. Geometry and
//! dimensions only — the plan seen from above with the back wall at the
//! bottom, as in the prototype, plus every object as a 3D box so the drawing
//! can be orbited in CAD. No notes, ruler marks or title block (team decision).
//!
//! Layer names and the few words on the drawing are in the exporting user's
//! language; Uzbek Latin and English are ASCII apart from `ʻ`/`ʼ`, which
//! become `'`.
//!
//! Unlike the prototype, nothing about this particular room is hard-coded:
//! what is drawn, and on which layer, follows each object's catalog kind.

use std::fmt::Write as _;

use super::geometry::{Dir, Rect, Solid, gap};
use super::model::{CatalogItem, CatalogProps, DcObject, Room, StructureSubtype};
use crate::models::Language;

// --- Windows-1251 ------------------------------------------------------------

/// Encode text as Windows-1251; what has no code there is substituted or `?`.
pub fn cp1251(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for ch in s.chars() {
        let c = ch as u32;
        match c {
            0..=0x7f => out.push(c as u8),
            0x410..=0x44f => out.push((c - 0x410 + 0xc0) as u8),
            0x401 => out.push(0xa8),  // Ё
            0x451 => out.push(0xb8),  // ё
            0x2116 => out.push(0xb9), // №
            0x2013 => out.push(0x96), // –
            0x2014 => out.push(0x97), // —
            0xb0 => out.push(0xb0),   // °
            0xab => out.push(0xab),   // «
            0xbb => out.push(0xbb),   // »
            0x2026 => out.push(0x85), // …
            0x406 => out.push(0xb2),  // І
            0x456 => out.push(0xb3),  // і
            // Uzbek Latin's okina and apostrophe, and their look-alikes.
            0x2bb | 0x2bc | 0x2018 | 0x2019 => out.push(b'\''),
            0xd7 | 0x2715 => out.push(b'x'),
            0x2248 => out.push(b'~'),
            0x203a => out.push(b'>'),
            0x2192 => out.extend_from_slice(b"->"),
            _ => out.push(b'?'),
        }
    }
    out
}

// --- Words on the drawing ------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Layer {
    Walls,
    Door,
    Racks,
    Objects,
    Shelf,
    Cooling,
    Tray,
    Safe,
    Dims,
    Labels,
    Solids,
}

const LAYERS: [Layer; 11] = [
    Layer::Walls,
    Layer::Door,
    Layer::Racks,
    Layer::Objects,
    Layer::Shelf,
    Layer::Cooling,
    Layer::Tray,
    Layer::Safe,
    Layer::Dims,
    Layer::Labels,
    Layer::Solids,
];

impl Layer {
    fn name(self, lang: Language) -> &'static str {
        use Language::*;
        use Layer::*;
        match (self, lang) {
            (Walls, Ru) => "СТЕНЫ",
            (Walls, Uz) => "DEVORLAR",
            (Walls, En) => "WALLS",
            (Door, Ru) => "ДВЕРЬ",
            (Door, Uz) => "ESHIK",
            (Door, En) => "DOOR",
            (Racks, Ru) => "СТОЙКИ",
            (Racks, Uz) => "STOYKALAR",
            (Racks, En) => "RACKS",
            (Objects, Ru) => "ОБЪЕКТЫ",
            (Objects, Uz) => "OBYEKTLAR",
            (Objects, En) => "OBJECTS",
            (Shelf, Ru) => "СТЕЛАЖ",
            (Shelf, Uz) => "STELLAJ",
            (Shelf, En) => "SHELF",
            (Cooling, Ru) => "КОНДИЦИОНЕРЫ",
            (Cooling, Uz) => "KONDITSIONERLAR",
            (Cooling, En) => "COOLING",
            (Tray, Ru) => "ЛОТОК",
            (Tray, Uz) => "LOTOK",
            (Tray, En) => "CABLE_TRAY",
            (Safe, Ru) => "СЕЙФ",
            (Safe, Uz) => "SEYF",
            (Safe, En) => "SAFE",
            (Dims, Ru) => "РАЗМЕРЫ",
            (Dims, Uz) => "OLCHAMLAR",
            (Dims, En) => "DIMENSIONS",
            (Labels, Ru) => "ПОДПИСИ",
            (Labels, Uz) => "YOZUVLAR",
            (Labels, En) => "LABELS",
            (Solids, _) => "3D",
        }
    }

    /// AutoCAD colour index and line type, as in the prototype.
    fn style(self) -> (i32, &'static str) {
        match self {
            Layer::Walls => (7, "CONTINUOUS"),
            Layer::Door => (30, "CONTINUOUS"),
            Layer::Racks => (4, "CONTINUOUS"),
            Layer::Objects => (8, "CONTINUOUS"),
            Layer::Shelf => (3, "CONTINUOUS"),
            Layer::Cooling => (6, "DASHED"),
            Layer::Tray => (140, "DASHED"),
            Layer::Safe => (9, "CONTINUOUS"),
            Layer::Dims => (2, "CONTINUOUS"),
            Layer::Labels => (7, "CONTINUOUS"),
            Layer::Solids => (252, "CONTINUOUS"),
        }
    }
}

/// "bottom at 1960" under a wall-mounted unit.
fn bottom_at(lang: Language, y: i32) -> String {
    match lang {
        Language::Ru => format!("низ на {y}"),
        Language::Uz => format!("pastki {y}"),
        Language::En => format!("bottom at {y}"),
    }
}

// --- Group-code writer -----------------------------------------------------------

struct Writer {
    parts: Vec<String>,
    style: &'static str,
}

/// A number as DXF writes it: at most three decimals, always with a point.
fn fnum(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    let r = if r == 0.0 { 0.0 } else { r };
    let s = format!("{r}");
    if s.contains('.') || s.contains('e') {
        s
    } else {
        format!("{s}.0")
    }
}

/// `^` and `%%` are AutoCAD text control sequences; newlines end a value.
fn clean(t: &str) -> String {
    let t = t
        .replace(['\r', '\n'], " ")
        .replace('^', "^ ")
        .replace("%%", "%%%%%%");
    let t = t.trim();
    if t.is_empty() { " ".into() } else { t.into() }
}

impl Writer {
    fn new() -> Writer {
        Writer {
            parts: Vec::new(),
            style: "PLAN",
        }
    }

    fn g(&mut self, code: i32, val: &str) {
        self.parts.push(format!("{code:>3}"));
        self.parts.push(val.to_string());
    }

    fn n(&mut self, code: i32, v: f64) {
        self.g(code, &fnum(v));
    }

    fn int(&mut self, code: i32, v: i32) {
        self.parts.push(format!("{code:>3}"));
        self.parts.push(format!("{v:>6}"));
    }

    fn entity(&mut self, kind: &str, layer: &str) {
        self.g(0, kind);
        self.g(8, layer);
    }

    #[allow(clippy::too_many_arguments)]
    fn line3(&mut self, layer: &str, x1: f64, y1: f64, z1: f64, x2: f64, y2: f64, z2: f64) {
        self.entity("LINE", layer);
        self.n(10, x1);
        self.n(20, y1);
        self.n(30, z1);
        self.n(11, x2);
        self.n(21, y2);
        self.n(31, z2);
    }

    fn line(&mut self, layer: &str, x1: f64, y1: f64, x2: f64, y2: f64) {
        self.line3(layer, x1, y1, 0.0, x2, y2, 0.0);
    }

    fn rect(&mut self, layer: &str, x0: f64, y0: f64, x1: f64, y1: f64) {
        self.line(layer, x0, y0, x1, y0);
        self.line(layer, x1, y0, x1, y1);
        self.line(layer, x1, y1, x0, y1);
        self.line(layer, x0, y1, x0, y0);
    }

    fn arc(&mut self, layer: &str, x: f64, y: f64, r: f64, a0: f64, a1: f64) {
        self.entity("ARC", layer);
        self.n(10, x);
        self.n(20, y);
        self.n(30, 0.0);
        self.n(40, r);
        self.n(50, a0);
        self.n(51, a1);
    }

    /// Centred text; `v` = vertical alignment (1 bottom, 2 middle).
    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, layer: &str, x: f64, y: f64, height: f64, s: &str, rot: f64, v: i32) {
        self.entity("TEXT", layer);
        self.n(10, x);
        self.n(20, y);
        self.n(30, 0.0);
        self.n(40, height);
        self.g(1, &clean(s));
        if rot != 0.0 {
            self.n(50, rot);
        }
        self.g(7, self.style);
        self.int(72, 1);
        self.n(11, x);
        self.n(21, y);
        self.n(31, 0.0);
        self.int(73, v);
    }

    fn face(&mut self, layer: &str, p: [[f64; 3]; 4]) {
        self.entity("3DFACE", layer);
        for (i, q) in p.iter().enumerate() {
            let i = i as i32;
            self.n(10 + i, q[0]);
            self.n(20 + i, q[1]);
            self.n(30 + i, q[2]);
        }
    }

    /// Six faces of a box between drawing corners and heights.
    #[allow(clippy::too_many_arguments)]
    fn boxed(&mut self, layer: &str, x0: f64, y0: f64, x1: f64, y1: f64, z0: f64, z1: f64) {
        let c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        self.face(layer, c.map(|q| [q[0], q[1], z0]));
        self.face(layer, c.map(|q| [q[0], q[1], z1]));
        for i in 0..4 {
            let (a, b) = (c[i], c[(i + 1) % 4]);
            self.face(
                layer,
                [
                    [a[0], a[1], z0],
                    [b[0], b[1], z0],
                    [b[0], b[1], z1],
                    [a[0], a[1], z1],
                ],
            );
        }
    }

    /// A dimension: the line, architectural ticks, the text above it.
    fn dim(&mut self, layer: &str, a: (f64, f64), b: (f64, f64), text: &str) {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = dx.hypot(dy);
        if len < 1.0 {
            return;
        }
        let (ux, uy) = (dx / len, dy / len);
        let (nx, ny) = (-uy, ux);
        let t = 35.0 * 0.7;
        self.line(layer, a.0, a.1, b.0, b.1);
        for p in [a, b] {
            self.line(
                layer,
                p.0 - (ux + nx) * t,
                p.1 - (uy + ny) * t,
                p.0 + (ux + nx) * t,
                p.1 + (uy + ny) * t,
            );
        }
        // Text reads left to right or bottom to top, above the line.
        let mut rot = dy.atan2(dx).to_degrees();
        if rot > 90.01 {
            rot -= 180.0;
        } else if rot <= -89.99 {
            rot += 180.0;
        }
        let rr = rot.to_radians();
        let off = 45.0;
        let rot = if rot.abs() < 0.01 { 0.0 } else { rot };
        self.text(
            layer,
            (a.0 + b.0) / 2.0 - rr.sin() * off,
            (a.1 + b.1) / 2.0 + rr.cos() * off,
            55.0,
            text,
            rot,
            1,
        );
    }
}

// --- The drawing -------------------------------------------------------------------

/// One object to draw, already placed.
pub struct Placed<'a> {
    pub solid: &'a Solid,
    pub object: &'a DcObject,
    pub item: &'a CatalogItem,
}

/// A dimension's text: the measured range where the room record has one for
/// `key`, the model's own value otherwise.
fn dim_text(room: &Room, key: &str, computed: i32) -> String {
    match room.measurements.entries.iter().find(|m| m.key == key) {
        Some(m) => match (m.min, m.max) {
            (Some(lo), Some(hi)) if lo != hi => format!("{lo}–{hi}"),
            _ => computed.to_string(),
        },
        None => computed.to_string(),
    }
}

fn layer_of(p: &Placed) -> Layer {
    match &p.item.props {
        CatalogProps::Rack(_) => Layer::Racks,
        CatalogProps::Shelf(_) => Layer::Shelf,
        CatalogProps::Cooling(_) => Layer::Cooling,
        CatalogProps::CableTray(_) => Layer::Tray,
        CatalogProps::Structure(s) => match s.subtype {
            StructureSubtype::Door => Layer::Door,
            StructureSubtype::Safe => Layer::Safe,
            _ => Layer::Objects,
        },
    }
}

/// Build the file's bytes.
pub fn build(room: &Room, placed: &[Placed<'_>], lang: Language) -> Vec<u8> {
    let b = super::geometry::bounds(&room.floor_plan);
    let depth = b.z1 as f64;
    // Plan coordinates: x as is, z flipped so the z = 0 wall is at the top.
    let px = |x: i32| x as f64;
    let py = |z: i32| depth - z as f64;
    let l = |layer: Layer| layer.name(lang);
    let mut w = Writer::new();

    // Walls.
    let n = room.floor_plan.len();
    for i in 0..n {
        let [ax, az] = room.floor_plan[i];
        let [bx, bz] = room.floor_plan[(i + 1) % n];
        w.line(l(Layer::Walls), px(ax), py(az), px(bx), py(bz));
    }

    let floor: Vec<Rect> = placed
        .iter()
        .filter(|p| p.solid.on_floor())
        .map(|p| p.solid.rect)
        .collect();

    for p in placed {
        let layer = layer_of(p);
        let r = p.solid.rect;
        let (x0, x1, y0, y1) = (px(r.x0), px(r.x1), py(r.z1), py(r.z0));
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        match (&p.item.props, &p.solid.swing) {
            (_, Some(sw)) => {
                // Door: the open leaf, its sweep, the opening.
                let (hx, hy) = (px(sw.hinge.0), py(sw.hinge.1));
                let q = sw.quadrant;
                // The quadrant's corner opposite the hinge, in drawing space.
                let far_x = if q.x0 == sw.hinge.0 { q.x1 } else { q.x0 };
                let far_z = if q.z0 == sw.hinge.1 { q.z1 } else { q.z0 };
                let along_x = r.x1 - r.x0 >= r.z1 - r.z0;
                let (closed, open) = if along_x {
                    ((px(far_x), hy), (hx, py(far_z)))
                } else {
                    ((hx, py(far_z)), (px(far_x), hy))
                };
                w.line(l(Layer::Door), hx, hy, open.0, open.1);
                let ang = |p: (f64, f64)| (p.1 - hy).atan2(p.0 - hx).to_degrees().rem_euclid(360.0);
                let (a, c) = (ang(closed), ang(open));
                let (a0, a1) = if (c - a).rem_euclid(360.0) <= 180.0 {
                    (a, c)
                } else {
                    (c, a)
                };
                w.arc(l(Layer::Door), hx, hy, sw.radius as f64, a0, a1);
                w.line(l(Layer::Door), px(r.x0), py(r.z0), px(r.x1), py(r.z1));
                let (ox, oy) = (
                    hx + (closed.0 - hx + open.0 - hx) * 0.5,
                    hy + (closed.1 - hy + open.1 - hy) * 0.35,
                );
                let size = format!(
                    "{} {}×{}",
                    p.object.name,
                    sw.radius,
                    p.solid.y1 - p.solid.y0
                );
                w.text(l(Layer::Labels), ox, oy, 60.0, &size, 0.0, 2);
            }
            (CatalogProps::CableTray(_), _) => {
                // A tray is its centre line along the run.
                if x1 - x0 >= y1 - y0 {
                    w.line(l(layer), x0, cy, x1, cy);
                } else {
                    w.line(l(layer), cx, y0, cx, y1);
                }
                w.text(l(layer), cx, cy + 60.0, 50.0, &p.object.name, 0.0, 2);
            }
            (CatalogProps::Shelf(s), _) => {
                w.rect(l(layer), x0, y0, x1, y1);
                // Section dividers along the shelf's length.
                let along_x = p.solid.rotation_deg.rem_euclid(180) == 0;
                let len = if along_x { r.x1 - r.x0 } else { r.z1 - r.z0 } as f64;
                let cell = len / s.cells_per_board as f64;
                let mut at = 0;
                for sec in s.sections.iter().take(s.sections.len().saturating_sub(1)) {
                    at += sec;
                    let d = cell * at as f64;
                    if along_x {
                        w.line(l(layer), x0 + d, y0, x0 + d, y1);
                    } else {
                        w.line(l(layer), x0, y1 - d, x1, y1 - d);
                    }
                }
                let label = format!("{}, h {}", p.object.name, p.solid.y1 - p.solid.y0);
                w.text(l(Layer::Labels), cx, y0 - 110.0, 70.0, &label, 0.0, 2);
            }
            (CatalogProps::Cooling(_), _) if p.solid.y0 > 0 => {
                w.rect(l(layer), x0, y0, x1, y1);
                w.text(l(layer), cx, cy + 50.0, 55.0, &p.object.name, 0.0, 2);
                w.text(
                    l(layer),
                    cx,
                    cy - 50.0,
                    45.0,
                    &bottom_at(lang, p.solid.y0),
                    0.0,
                    2,
                );
            }
            _ => {
                w.rect(l(layer), x0, y0, x1, y1);
                if layer == Layer::Racks {
                    // A line just inside the front face.
                    let k = 25.0;
                    let (a, b2) = match Dir::front(p.solid.rotation_deg) {
                        Dir::Up => ((x0, y1 - k), (x1, y1 - k)),
                        Dir::Down => ((x0, y0 + k), (x1, y0 + k)),
                        Dir::Right => ((x1 - k, y0), (x1 - k, y1)),
                        Dir::Left => ((x0 + k, y0), (x0 + k, y1)),
                    };
                    w.line(l(layer), a.0, a.1, b2.0, b2.1);
                }
                let vert = x1 - x0 < 450.0;
                let rot = if vert { 90.0 } else { 0.0 };
                let size = format!(
                    "{}×{}, h {}",
                    r.x1 - r.x0,
                    r.z1 - r.z0,
                    p.solid.y1 - p.solid.y0
                );
                if layer == Layer::Safe {
                    w.text(l(Layer::Labels), cx, cy, 50.0, &p.object.name, 0.0, 2);
                } else {
                    let (nx, ny) = if vert { (cx, cy) } else { (cx, cy + 50.0) };
                    w.text(l(Layer::Labels), nx, ny, 60.0, &p.object.name, rot, 2);
                    let (sx, sy) = if vert {
                        (cx + 80.0, cy)
                    } else {
                        (cx, cy - 60.0)
                    };
                    w.text(l(Layer::Labels), sx, sy, 40.0, &size, rot, 2);
                }
            }
        }
    }

    // --- Dimensions ---
    let d = l(Layer::Dims);
    // Room length below the back wall, width left of the left wall.
    w.dim(
        d,
        (px(b.x0), py(b.z1) - 280.0),
        (px(b.x1), py(b.z1) - 280.0),
        &dim_text(room, "room.length_x", b.x1 - b.x0),
    );
    w.dim(
        d,
        (px(b.x0) - 280.0, py(b.z1)),
        (px(b.x0) - 280.0, py(b.z0)),
        &dim_text(room, "room.width_z", b.z1 - b.z0),
    );

    // Racks facing −z, as a row: gaps along x, and to the obstacles in front
    // and the wall behind.
    let mut row: Vec<&Placed> = placed
        .iter()
        .filter(|p| p.solid.is_rack() && p.solid.rotation_deg == 0)
        .collect();
    row.sort_by_key(|p| p.solid.rect.x0);
    if let Some(first) = row.first() {
        let zl = py(row.iter().map(|p| p.solid.rect.z0).min().unwrap_or(0)) + 160.0;
        let mut prev = b.x0;
        for p in &row {
            let r = p.solid.rect;
            w.dim(
                d,
                (px(prev), zl),
                (px(r.x0), zl),
                &(r.x0 - prev).to_string(),
            );
            prev = r.x1;
        }
        w.dim(
            d,
            (px(prev), zl),
            (px(b.x1), zl),
            &(b.x1 - prev).to_string(),
        );
        let _ = first;
        for p in &row {
            let r = p.solid.rect;
            let others: Vec<Rect> = floor.iter().copied().filter(|o| *o != r).collect();
            let cx = px((r.x0 + r.x1) / 2);
            let front = gap(&r, Dir::Up, &others, &room.floor_plan);
            if front.mm > 0 {
                w.dim(
                    d,
                    (cx, py(r.z0 - front.mm)),
                    (cx, py(r.z0)),
                    &front.mm.to_string(),
                );
            }
            let rear = gap(&r, Dir::Down, &others, &room.floor_plan);
            if rear.mm > 0 {
                w.dim(
                    d,
                    (cx, py(r.z1)),
                    (cx, py(r.z1 + rear.mm)),
                    &rear.mm.to_string(),
                );
            }
        }
    }

    for p in placed {
        let r = p.solid.rect;
        match &p.item.props {
            CatalogProps::Shelf(_) => {
                // Length, the gaps to both side walls, the depth.
                let y = py(r.z1) - 120.0;
                w.dim(d, (px(r.x0), y), (px(r.x1), y), &(r.x1 - r.x0).to_string());
                w.dim(
                    d,
                    (px(b.x0), y),
                    (px(r.x0), y),
                    &dim_text(room, "shelf.x0", r.x0 - b.x0),
                );
                w.dim(
                    d,
                    (px(r.x1), y),
                    (px(b.x1), y),
                    &dim_text(room, "shelf.right_gap", b.x1 - r.x1),
                );
                w.dim(
                    d,
                    (px(r.x0) - 80.0, py(r.z1)),
                    (px(r.x0) - 80.0, py(r.z0)),
                    &(r.z1 - r.z0).to_string(),
                );
            }
            CatalogProps::Structure(s) if s.subtype == StructureSubtype::Door => {
                // Position and width along its wall, outside the room.
                if r.x1 - r.x0 < r.z1 - r.z0 {
                    let out = if r.x0 >= b.x1 { 280.0 } else { -280.0 };
                    let x = px(r.x0) + out;
                    w.dim(d, (x, py(b.z0)), (x, py(r.z0)), &(r.z0 - b.z0).to_string());
                    w.dim(d, (x, py(r.z0)), (x, py(r.z1)), &(r.z1 - r.z0).to_string());
                } else {
                    let out = if r.z0 >= b.z1 { -280.0 } else { 280.0 };
                    let y = py(r.z0) + out;
                    w.dim(d, (px(b.x0), y), (px(r.x0), y), &(r.x0 - b.x0).to_string());
                    w.dim(d, (px(r.x0), y), (px(r.x1), y), &(r.x1 - r.x0).to_string());
                }
            }
            CatalogProps::Structure(s) if s.subtype == StructureSubtype::Safe => {
                let y = py(r.z1) - 80.0;
                w.dim(d, (px(r.x0), y), (px(r.x1), y), &(r.x1 - r.x0).to_string());
                let x = px(r.x0) - 40.0;
                w.dim(d, (x, py(r.z1)), (x, py(r.z0)), &(r.z1 - r.z0).to_string());
            }
            _ => {}
        }
    }

    // --- 3D: every object as a box, the walls as faces ---
    for p in placed {
        if p.solid.swing.is_some() {
            continue;
        }
        let r = p.solid.rect;
        w.boxed(
            l(Layer::Solids),
            px(r.x0),
            py(r.z1),
            px(r.x1),
            py(r.z0),
            p.solid.y0 as f64,
            p.solid.y1 as f64,
        );
    }
    let h = room.height_mm as f64;
    for i in 0..n {
        let [ax, az] = room.floor_plan[i];
        let [bx, bz] = room.floor_plan[(i + 1) % n];
        w.face(
            l(Layer::Solids),
            [
                [px(ax), py(az), 0.0],
                [px(bx), py(bz), 0.0],
                [px(bx), py(bz), h],
                [px(ax), py(az), h],
            ],
        );
    }

    assemble(w, lang, h)
}

/// Header, tables and the entities, as bytes.
fn assemble(w: Writer, lang: Language, height: f64) -> Vec<u8> {
    let entities = w.parts;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for pair in entities.chunks(2) {
        let code: i32 = pair[0].trim().parse().unwrap_or(-1);
        let v: f64 = match pair[1].trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if (10..=13).contains(&code) {
            x0 = x0.min(v);
            x1 = x1.max(v);
        } else if (20..=23).contains(&code) {
            y0 = y0.min(v);
            y1 = y1.max(v);
        }
    }
    if x0 > x1 {
        (x0, y0, x1, y1) = (0.0, 0.0, 0.0, 0.0);
    }

    let mut h = Writer::new();
    h.g(0, "SECTION");
    h.g(2, "HEADER");
    h.g(9, "$ACADVER");
    h.g(1, "AC1009");
    h.g(9, "$DWGCODEPAGE");
    h.g(3, "ANSI_1251");
    h.g(9, "$INSBASE");
    h.n(10, 0.0);
    h.n(20, 0.0);
    h.n(30, 0.0);
    h.g(9, "$EXTMIN");
    h.n(10, x0);
    h.n(20, y0);
    h.n(30, 0.0);
    h.g(9, "$EXTMAX");
    h.n(10, x1);
    h.n(20, y1);
    h.n(30, height);
    h.g(9, "$LIMMIN");
    h.n(10, x0);
    h.n(20, y0);
    h.g(9, "$LIMMAX");
    h.n(10, x1);
    h.n(20, y1);
    h.g(9, "$LTSCALE");
    h.n(40, 20.0);
    h.g(9, "$TEXTSTYLE");
    h.g(7, "PLAN");
    h.g(9, "$CLAYER");
    h.g(8, "0");
    h.g(0, "ENDSEC");

    h.g(0, "SECTION");
    h.g(2, "TABLES");
    h.g(0, "TABLE");
    h.g(2, "LTYPE");
    h.int(70, 2);
    h.g(0, "LTYPE");
    h.g(2, "CONTINUOUS");
    h.int(70, 0);
    h.g(3, "Solid line");
    h.int(72, 65);
    h.int(73, 0);
    h.n(40, 0.0);
    h.g(0, "LTYPE");
    h.g(2, "DASHED");
    h.int(70, 0);
    h.g(3, "__ __ __ __");
    h.int(72, 65);
    h.int(73, 2);
    h.n(40, 9.525);
    h.n(49, 6.35);
    h.n(49, -3.175);
    h.g(0, "ENDTAB");
    h.g(0, "TABLE");
    h.g(2, "LAYER");
    h.int(70, LAYERS.len() as i32 + 1);
    h.g(0, "LAYER");
    h.g(2, "0");
    h.int(70, 0);
    h.int(62, 7);
    h.g(6, "CONTINUOUS");
    for layer in LAYERS {
        let (colour, ltype) = layer.style();
        h.g(0, "LAYER");
        h.g(2, layer.name(lang));
        h.int(70, 0);
        h.int(62, colour);
        h.g(6, ltype);
    }
    h.g(0, "ENDTAB");
    h.g(0, "TABLE");
    h.g(2, "STYLE");
    h.int(70, 1);
    h.g(0, "STYLE");
    h.g(2, "PLAN");
    h.int(70, 0);
    h.n(40, 0.0);
    h.n(41, 1.0);
    h.n(50, 0.0);
    h.int(71, 0);
    h.n(42, 60.0);
    h.g(3, "arial.ttf");
    h.g(4, "");
    h.g(0, "ENDTAB");
    h.g(0, "ENDSEC");
    h.g(0, "SECTION");
    h.g(2, "BLOCKS");
    h.g(0, "ENDSEC");
    h.g(0, "SECTION");
    h.g(2, "ENTITIES");

    let mut text = String::new();
    for s in h.parts.iter().chain(entities.iter()) {
        let _ = write!(text, "{s}\r\n");
    }
    text.push_str("  0\r\nENDSEC\r\n  0\r\nEOF\r\n");
    cp1251(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cyrillic_and_uzbek_marks_encode() {
        assert_eq!(cp1251("АЯая"), vec![0xc0, 0xdf, 0xe0, 0xff]);
        assert_eq!(cp1251("Ёё№–"), vec![0xa8, 0xb8, 0xb9, 0x96]);
        assert_eq!(cp1251("oʻzbekʼ"), b"o'zbek'".to_vec());
        assert_eq!(cp1251("600×1000"), b"600x1000".to_vec());
        assert_eq!(cp1251("日"), b"?".to_vec());
    }

    #[test]
    fn numbers_always_carry_a_point() {
        assert_eq!(fnum(5545.0), "5545.0");
        assert_eq!(fnum(9.525), "9.525");
        assert_eq!(fnum(-0.0001), "0.0");
        assert_eq!(fnum(1.23456), "1.235");
    }

    #[test]
    fn text_control_sequences_are_escaped() {
        assert_eq!(clean("a^b"), "a^ b");
        assert_eq!(clean("50%%"), "50%%%%%%");
        assert_eq!(clean("two\nlines"), "two lines");
        assert_eq!(clean("  "), " ");
    }

    #[test]
    fn layers_are_named_per_language() {
        assert_eq!(Layer::Walls.name(Language::Ru), "СТЕНЫ");
        assert_eq!(Layer::Walls.name(Language::En), "WALLS");
        for layer in LAYERS {
            for lang in [Language::Uz, Language::En] {
                assert!(layer.name(lang).is_ascii());
            }
        }
    }
}
