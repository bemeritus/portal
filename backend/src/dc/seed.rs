//! The existing server room and the cooling catalog, as seed data (§4.2).
//!
//! Like the platform's other seed (`just seed`), this is data, not schema: it
//! runs when asked (`portal seed-dc`, `just seed-dc`), never on startup, and
//! running it twice is safe — catalog items are matched by
//! (kind, manufacturer, model) and the room by name, and what exists is left
//! alone, so edits made since are not overwritten.
//!
//! Sources, copied verbatim from `dc-handoff/data/`:
//! - `seeds/dc/room.json` — the room in millimetres with the provenance of
//!   every number;
//! - `seeds/dc/cooling.json` — 20 cooling units from public datasheets.
//!
//! [`plan`] turns them into rows and is pure, so the positions are tested
//! against `room.json` here; [`run`] writes the plan.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use sqlx::PgPool;

use super::geometry::units_for_height;
use super::model::{
    CableTrayProps, CatalogProps, CoolingProps, CoolingSubtype, DcObject, Discharge, EspPa,
    MeasSrc, Measurement, PropSource, PropSrc, RackProps, RoomMeasurements, RoomSettings,
    ShelfProps, Snapshot, StructureProps, StructureSubtype, TrayType, parse_enum,
};

const ROOM_JSON: &str = include_str!("../../seeds/dc/room.json");
const COOLING_JSON: &str = include_str!("../../seeds/dc/cooling.json");

/// The room's name; also what the device import template's `room` column says.
pub const ROOM_NAME: &str = "Серверная";

pub struct NewItem {
    pub manufacturer: String,
    pub model: String,
    pub dims: [i32; 3],
    pub props: CatalogProps,
    pub props_src: BTreeMap<String, PropSource>,
}

pub struct NewObject {
    /// Index into [`Plan::catalog`].
    pub item: usize,
    pub name: String,
    pub x0: i32,
    pub z0: i32,
    pub y0: i32,
    pub rotation_deg: i32,
    pub instance: Value,
    pub note: String,
}

pub struct Plan {
    pub catalog: Vec<NewItem>,
    pub room_name: String,
    pub floor_plan: Vec<[i32; 2]>,
    pub height_mm: i32,
    pub measurements: RoomMeasurements,
    pub settings: RoomSettings,
    pub objects: Vec<NewObject>,
}

/// Round half away from zero: 2487.5 → 2488. Ranges are kept in the
/// measurements; the geometry needs whole millimetres (within 1 mm of
/// `room.json`, as the acceptance asks).
fn mm(v: &Value) -> i32 {
    v.as_f64().map(|f| f.round() as i32).unwrap_or(0)
}

fn val(v: &Value) -> i32 {
    mm(if v.is_object() { &v["value"] } else { v })
}

fn src(v: &Value) -> MeasSrc {
    v["src"]
        .as_str()
        .and_then(parse_enum)
        .unwrap_or(MeasSrc::Assumed)
}

fn note(v: &Value) -> Option<String> {
    v["note"].as_str().map(str::to_string)
}

fn opt(v: &Value) -> Option<i32> {
    v.as_f64().map(|f| f.round() as i32)
}

type Line = [[i32; 3]; 2];

/// A measurement from a `{value, min?, max?, src, note?}` object.
fn measure(key: &str, v: &Value, objects: &[&str]) -> Measurement {
    Measurement {
        key: key.into(),
        value: val(v),
        min: opt(&v["min"]),
        max: opt(&v["max"]),
        src: src(v),
        model: None,
        line: None,
        note: note(v),
        objects: objects.iter().map(|s| s.to_string()).collect(),
    }
}

/// … drawn as a dimension along `line`, whose length in the model is `model`.
fn drawn(mut m: Measurement, model: i32, line: Line) -> Measurement {
    m.model = Some(model);
    m.line = Some(line);
    m
}

/// A plain tape reading.
fn tape(key: &str, value: i32, objects: &[&str]) -> Measurement {
    measure(key, &json!({"value": value, "src": "measured"}), objects)
}

/// Two tape readings that disagreed: both kept, the midpoint as the value.
fn readings(key: &str, a: i32, b: i32, objects: &[&str]) -> Measurement {
    let (lo, hi) = (a.min(b), a.max(b));
    if lo == hi {
        return tape(key, lo, objects);
    }
    measure(
        key,
        &json!({"value": (lo + hi + 1) / 2, "min": lo, "max": hi, "src": "range"}),
        objects,
    )
}

fn source(src: PropSrc, url: Option<&str>, note: Option<&str>) -> PropSource {
    PropSource {
        src,
        url: url.map(str::to_string),
        note: note.map(str::to_string),
    }
}

/// The plan of `room.json` (schema `eskiz-dc-room/2`, which follows the hand
/// drawing `data/drawing-hand.png`). Every tape value of the drawing becomes a
/// measurement with the line it is drawn along and the model's own length of
/// that line, so the view can show the tape value and mark where the model
/// disagrees — never replacing one with the other.
pub fn plan() -> Result<Plan, String> {
    let r: Value = serde_json::from_str(ROOM_JSON).map_err(|e| format!("room.json: {e}"))?;
    let c: Value = serde_json::from_str(COOLING_JSON).map_err(|e| format!("cooling.json: {e}"))?;
    let mut catalog = Vec::new();
    let mut objects = Vec::new();
    let mut entries = Vec::new();

    // --- Room ---
    let length = val(&r["room"]["length_x"]);
    let width = val(&r["room"]["width_z"]);
    let height = val(&r["room"]["height_y"]);
    let out = 250; // dimensions of the room sit this far outside the walls
    entries.push(drawn(
        measure("room.length_x", &r["room"]["length_x"], &[]),
        length,
        [[0, 0, width + out], [length, 0, width + out]],
    ));
    entries.push(drawn(
        measure("room.width_z", &r["room"]["width_z"], &[]),
        width,
        [[-out, 0, 0], [-out, 0, width]],
    ));
    entries.push(drawn(
        measure("room.height_y", &r["room"]["height_y"], &[]),
        height,
        [[-out, 0, width + out], [-out, height, width + out]],
    ));

    // --- Racks: one type for all four (team decision) ---
    let rt = &r["rack_type"];
    let (rw, rd, rh) = (val(&rt["width"]), val(&rt["depth"]), val(&rt["height"]));
    let units = rt["units"].as_i64().unwrap_or(0) as i32;
    // U1 starts 100 mm up; plinth and top cap 160 mm in total (assumed).
    if units_for_height(rh, 160) != units {
        return Err(format!(
            "rack type: {units}U does not match its height {rh}"
        ));
    }
    let mut rack_src = BTreeMap::new();
    rack_src.insert(
        "dims".into(),
        source(
            PropSrc::Measured,
            None,
            Some("fixed by team decision: every rack is 600 × 1000 × 2040; measured widths are kept as tape values"),
        ),
    );
    rack_src.insert(
        "units".into(),
        source(PropSrc::Derived, None, rt["note"].as_str()),
    );
    rack_src.insert(
        "u1_height_mm".into(),
        source(
            PropSrc::Assumed,
            None,
            Some("plinth and top cap of 160 mm in total assumed"),
        ),
    );
    let rack_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: format!("Стойка {rw}×{rd}×{rh}, {units}U"),
        dims: [rw, rd, rh],
        props: CatalogProps::Rack(RackProps {
            units,
            u1_height_mm: 100,
            door_front: None,
            door_rear: None,
            max_static_load_kg: None,
            cable_entry: None,
        }),
        props_src: rack_src,
    });

    let s = &r["shelf"];
    let shelf_z0 = val(&s["z0"]);
    let shelf_depth = val(&s["depth_z"]);
    let shelf_front = shelf_z0 + shelf_depth;

    let rm = &r["rack_measurements"];
    let racks = r["racks"].as_array().cloned().unwrap_or_default();
    let names: BTreeMap<String, String> = racks
        .iter()
        .map(|k| {
            (
                k["id"].as_str().unwrap_or("").to_string(),
                k["name"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let name_of = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    // (id, x0, front_z)
    let placed: Vec<(String, i32, i32)> = racks
        .iter()
        .map(|k| {
            (
                k["id"].as_str().unwrap_or("").to_string(),
                mm(&k["x0"]),
                mm(&k["front_z"]),
            )
        })
        .collect();
    let row_z = placed.iter().map(|p| p.2).min().unwrap_or(0) - 150;
    for (k, (id, x0, fz)) in racks.iter().zip(&placed) {
        let name = name_of(id);
        // Rack 1 is an open frame with a glass door (photos 03, 08).
        let instance = if id == "r1" {
            json!({ "door_front": k["door"], "open_frame": true })
        } else {
            json!({ "door_front": k["door"] })
        };
        objects.push(NewObject {
            item: rack_item,
            name: name.clone(),
            x0: *x0,
            z0: *fz,
            y0: 0,
            rotation_deg: k["rotation_deg"].as_i64().unwrap_or(0) as i32,
            instance,
            note: if id == "r1" {
                "open frame (photos 03, 08)".into()
            } else {
                String::new()
            },
        });
        // Width as measured (one or two readings), depth and height.
        let widths: Vec<i32> = k["measured_width"]
            .as_array()
            .into_iter()
            .flatten()
            .map(mm)
            .collect();
        if let (Some(&a), Some(&b)) = (widths.first(), widths.last()) {
            entries.push(drawn(
                readings(&format!("racks.width.{id}"), a, b, &[&name]),
                rw,
                [[*x0, rh, fz + 120], [x0 + rw, rh, fz + 120]],
            ));
        }
        entries.push(drawn(
            measure(&format!("racks.depth.{id}"), &rm["depth"], &[&name]),
            rd,
            [[x0 + rw - 90, rh, *fz], [x0 + rw - 90, rh, fz + rd]],
        ));
        entries.push(drawn(
            measure(&format!("racks.height.{id}"), &rm["height"], &[&name]),
            rh,
            [[*x0, 0, *fz], [*x0, rh, *fz]],
        ));
    }
    // Gaps along x, left wall → r1 → … → right wall.
    let mut prev = 0;
    for (i, g) in rm["gaps_x_left_to_right"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let between: Vec<&str> = g["between"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        let key = format!(
            "racks.gap.{}",
            between
                .iter()
                .map(|b| b.replace(' ', "_"))
                .collect::<Vec<_>>()
                .join("-")
        );
        let objs: Vec<String> = between
            .iter()
            .filter(|b| names.contains_key(**b))
            .map(|b| name_of(b))
            .collect();
        let objs: Vec<&str> = objs.iter().map(String::as_str).collect();
        let next = placed.get(i).map(|p| p.1).unwrap_or(length);
        // A remainder derived from the others, with two tape readings: the
        // readings are what was measured, the remainder is the model's.
        let m = if g["src"].as_str() == Some("derived") && g["min"].is_number() {
            let mut m = readings(&key, mm(&g["min"]), mm(&g["max"]), &objs);
            m.note = note(g);
            m
        } else {
            measure(&key, g, &objs)
        };
        entries.push(drawn(m, next - prev, [[prev, 0, row_z], [next, 0, row_z]]));
        prev = next + rw;
    }
    for g in rm["aisle_shelf_front_to_rack_front"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let id = g["rack"].as_str().unwrap_or("");
        let Some((_, x0, fz)) = placed.iter().find(|p| p.0 == id) else {
            continue;
        };
        let cx = x0 + rw / 2 - 120;
        entries.push(drawn(
            measure(&format!("racks.aisle.{id}"), g, &[&name_of(id)]),
            fz - shelf_front,
            [[cx, 0, shelf_front], [cx, 0, *fz]],
        ));
    }
    for g in rm["rack_back_to_wall"].as_array().into_iter().flatten() {
        let id = g["rack"].as_str().unwrap_or("");
        let Some((_, x0, fz)) = placed.iter().find(|p| p.0 == id) else {
            continue;
        };
        let back = fz + rd;
        let cx = x0 + rw / 2;
        let mut m = tape(
            &format!("racks.back.{id}"),
            mm(&g["measured"]),
            &[&name_of(id)],
        );
        m.note = rm["conflict"]
            .as_str()
            .filter(|_| g["diff"].as_i64().unwrap_or(0).abs() > 5)
            .map(str::to_string);
        entries.push(drawn(m, width - back, [[cx, 0, back], [cx, 0, width]]));
    }

    // --- Shelf, against the shelf wall ---
    let boards: Vec<i32> = s["boards_y"]
        .as_array()
        .into_iter()
        .flatten()
        .map(val)
        .collect();
    let sections: Vec<i32> = s["sections"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v["cells"].as_i64().unwrap_or(0) as i32)
        .collect();
    let shelf_name = s["name"].as_str().unwrap_or("Стелаж").to_string();
    let (shelf_x0, shelf_len, shelf_h) = (val(&s["x0"]), val(&s["length_x"]), val(&s["height_y"]));
    let mut shelf_src = BTreeMap::new();
    shelf_src.insert(
        "dims".into(),
        source(PropSrc::Measured, None, Some("height read as 1795–1800")),
    );
    shelf_src.insert(
        "boards_mm".into(),
        source(
            PropSrc::Assumed,
            None,
            Some("bottom board and the middle board's height (equal spacing, 947.5 rounded) assumed; top board measured"),
        ),
    );
    shelf_src.insert(
        "sections".into(),
        source(PropSrc::Assumed, None, s["src_sections"].as_str()),
    );
    shelf_src.insert(
        "plated_boards".into(),
        source(PropSrc::Photo, None, s["cell_numbering"].as_str()),
    );
    let shelf_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: shelf_name.clone(),
        dims: [shelf_len, shelf_depth, shelf_h],
        props: CatalogProps::Shelf(ShelfProps {
            boards_mm: boards,
            cells_per_board: s["cells_per_board"].as_i64().unwrap_or(0) as i32,
            sections,
            // "top board 1-14, middle board 15-28 (plates on the boards),
            // bottom board has no plates"
            plated_boards: 2,
        }),
        props_src: shelf_src,
    });
    objects.push(NewObject {
        item: shelf_item,
        name: shelf_name.clone(),
        x0: shelf_x0,
        z0: shelf_z0,
        y0: 0,
        // Against the shelf wall, its front facing into the room (+z).
        rotation_deg: 180,
        instance: json!({}),
        note: String::new(),
    });
    let sn: &[&str] = &[&shelf_name];
    let shelf_x1 = shelf_x0 + shelf_len;
    let z_shelf_dims = shelf_front + 120;
    entries.push(drawn(
        measure("shelf.length_x", &s["length_x"], sn),
        shelf_len,
        [[shelf_x0, 0, z_shelf_dims], [shelf_x1, 0, z_shelf_dims]],
    ));
    entries.push(drawn(
        measure("shelf.x0", &s["x0"], sn),
        shelf_x0,
        [[0, 0, z_shelf_dims], [shelf_x0, 0, z_shelf_dims]],
    ));
    entries.push(drawn(
        measure("shelf.right_gap", &s["right_gap"], sn),
        length - shelf_x1,
        [[shelf_x1, 0, z_shelf_dims], [length, 0, z_shelf_dims]],
    ));
    entries.push(drawn(
        measure("shelf.depth_z", &s["depth_z"], sn),
        shelf_depth,
        [
            [shelf_x0 + 120, shelf_h, shelf_z0],
            [shelf_x0 + 120, shelf_h, shelf_front],
        ],
    ));
    entries.push(drawn(
        measure("shelf.height_y", &s["height_y"], sn),
        shelf_h,
        [[shelf_x1, 0, shelf_front], [shelf_x1, shelf_h, shelf_front]],
    ));
    entries.push(measure("shelf.z0", &s["z0"], sn));
    for (i, b) in s["boards_y"].as_array().into_iter().flatten().enumerate() {
        entries.push(measure(&format!("shelf.board_{}", i + 1), b, sn));
    }

    // --- Air conditioners: ducted units under the ceiling, model unknown ---
    let acc = &r["air_conditioner_common"];
    let acs = r["air_conditioners"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ac_width = acs.iter().map(|a| val(&a["length"])).min().unwrap_or(0);
    let ac_depth = val(&acc["depth_z"]);
    let ac_height = val(&acc["unit_height"]);
    let ac_z0 = val(&acc["z0"]);
    let mut ac_src = BTreeMap::new();
    ac_src.insert(
        "dims".into(),
        source(
            PropSrc::Measured,
            None,
            Some("body measured on site; length differs per unit (see the room's measurements)"),
        ),
    );
    ac_src.insert(
        "subtype".into(),
        source(PropSrc::Photo, None, acc["type"]["note"].as_str()),
    );
    let ac_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: "Канальный, модель не указана".into(),
        dims: [ac_width, ac_depth, ac_height],
        props: CatalogProps::Cooling(Box::new(CoolingProps {
            subtype: CoolingSubtype::Ducted,
            model_known: false,
            inverter: None,
            designed_24_7: None,
            cooling_total_w: None,
            cooling_sensible_w: None,
            rating_conditions: None,
            cooling_range_w: None,
            airflow_m3h: vec![],
            power_input_w: None,
            eer: None,
            esp_pa: None,
            weight_kg: None,
            refrigerant: None,
            power_supply: None,
            capacity_modulation: None,
            discharge_options: vec![],
            airflow_pattern: None,
            openings: vec![],
            derating: vec![],
            source_url: None,
        })),
        props_src: ac_src,
    });
    let ac_names: Vec<String> = (1..=acs.len())
        .map(|i| format!("Кондиционер {i}"))
        .collect();
    let all_acs: Vec<&str> = ac_names.iter().map(String::as_str).collect();
    let z_ac_dims = ac_z0 + ac_depth + 60;
    let mut ac_x: Vec<(i32, i32, i32, i32)> = Vec::new(); // x0, x1, y0, y1
    for (i, a) in acs.iter().enumerate() {
        let len = val(&a["length"]);
        let x0 = mm(&a["x0"]);
        let (y0, y1) = (mm(&a["y0"]), mm(&a["y0"]) + ac_height);
        ac_x.push((x0, x0 + len, y0, y1));
        // Supply at the front flange, straight out: the subtype's default,
        // not measured (§14.1 — set by hand from phase 2).
        let mut instance = json!({ "supply_outlets": [{
            "id": "s1", "label": "1",
            "pos_mm": { "x": 0, "y": ac_height / 2, "z": -ac_depth / 2 },
            "size_mm": { "w": len * 3 / 4, "h": ac_height * 6 / 10 },
            "pitch_deg": 0, "yaw_deg": 0, "source": "catalog_default"
        }]});
        if len != ac_width {
            instance["width_mm"] = json!(len);
        }
        objects.push(NewObject {
            item: ac_item,
            name: ac_names[i].clone(),
            x0,
            z0: ac_z0,
            y0,
            // Hanging above the shelf, supply toward the room (+z).
            rotation_deg: 180,
            instance,
            note:
                "ducted unit on threaded rods under the ceiling (photos 02, 06); ducts not modelled"
                    .into(),
        });
        let id = a["id"].as_str().unwrap_or("");
        let cx = (x0 + x0 + len) / 2;
        entries.push(drawn(
            measure(&format!("ac.{id}.length"), &a["length"], &[&ac_names[i]]),
            len,
            [[x0, y0, z_ac_dims], [x0 + len, y0, z_ac_dims]],
        ));
        entries.push(drawn(
            measure(
                &format!("ac.{id}.gap_to_ceiling"),
                &a["gap_to_ceiling"],
                &[&ac_names[i]],
            ),
            height - y1,
            [
                [cx, y1, ac_z0 + ac_depth / 2],
                [cx, height, ac_z0 + ac_depth / 2],
            ],
        ));
    }
    if let Some(&(x0, x1, y0, y1)) = ac_x.first() {
        entries.push(drawn(
            measure("ac.unit_height", &acc["unit_height"], &all_acs),
            y1 - y0,
            [[x1, y0, z_ac_dims], [x1, y1, z_ac_dims]],
        ));
        entries.push(drawn(
            measure("ac.depth_z", &acc["depth_z"], &all_acs),
            ac_depth,
            [[x0 + 100, y0, ac_z0], [x0 + 100, y0, ac_z0 + ac_depth]],
        ));
        entries.push(drawn(
            measure(
                "ac.ac1_to_right_wall",
                &acc["ac1_to_right_wall"],
                &all_acs[..1],
            ),
            length - x1,
            [[x1, y0, z_ac_dims], [length, y0, z_ac_dims]],
        ));
    }
    entries.push(measure("ac.z0", &acc["z0"], &all_acs));
    for (key, field, (a, b)) in [
        ("ac.gap_ac1_ac2", "gap_ac1_ac2", (0, 1)),
        ("ac.gap_ac2_ac3", "gap_ac2_ac3", (1, 2)),
    ] {
        if let (Some(&(ax0, _, ay0, _)), Some(&(_, bx1, _, _))) = (ac_x.get(a), ac_x.get(b)) {
            entries.push(drawn(
                measure(key, &acc[field], &[&ac_names[a], &ac_names[b]]),
                ax0 - bx1,
                [[bx1, ay0, z_ac_dims], [ax0, ay0, z_ac_dims]],
            ));
        }
    }

    // --- Door ---
    let d = &r["door"];
    let (door_w, door_h) = (val(&d["width"]), val(&d["height"]));
    let door_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: format!("Дверь {door_w}×{door_h}"),
        dims: [door_w, 0, door_h],
        props: CatalogProps::Structure(StructureProps {
            subtype: StructureSubtype::Door,
        }),
        props_src: BTreeMap::from([("dims".into(), source(PropSrc::Measured, None, None))]),
    });
    let door_z0 = val(&d["z0"]);
    // Hinge at z = 1790, the high end of the opening; swings in toward the
    // shelf wall.
    let hinge = if mm(&d["hinge_z"]) >= door_z0 + door_w {
        "high"
    } else {
        "low"
    };
    objects.push(NewObject {
        item: door_item,
        name: "Дверь".into(),
        x0: length,
        z0: door_z0,
        y0: 0,
        rotation_deg: 90,
        instance: json!({ "hinge": hinge }),
        note: d["opens"].as_str().unwrap_or("").to_string(),
    });
    let dx = length + out;
    entries.push(drawn(
        measure("door.z0", &d["z0"], &["Дверь"]),
        door_z0,
        [[dx, 0, 0], [dx, 0, door_z0]],
    ));
    entries.push(drawn(
        measure("door.width", &d["width"], &["Дверь"]),
        door_w,
        [[dx, 0, door_z0], [dx, 0, door_z0 + door_w]],
    ));
    entries.push(drawn(
        measure("door.height", &d["height"], &["Дверь"]),
        door_h,
        [
            [length, 0, door_z0 + door_w + 60],
            [length, door_h, door_z0 + door_w + 60],
        ],
    ));

    // --- Locker (grey metal cabinet) ---
    let sf = &r["safe"];
    let (lw, ld, lh) = (
        val(&sf["width_x"]),
        val(&sf["depth_z"]),
        val(&sf["height_y"]),
    );
    let locker = sf["name"].as_str().unwrap_or("Шкаф").to_string();
    let locker_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: format!("Шкаф металлический {lw}×{ld}×{lh}"),
        dims: [lw, ld, lh],
        props: CatalogProps::Structure(StructureProps {
            subtype: StructureSubtype::Locker,
        }),
        props_src: BTreeMap::from([(
            "dims".into(),
            source(PropSrc::Measured, None, sf["note"].as_str()),
        )]),
    });
    let (lx0, lz0) = (val(&sf["x1"]) - lw, val(&sf["z0"]));
    objects.push(NewObject {
        item: locker_item,
        name: locker.clone(),
        x0: lx0,
        z0: lz0,
        y0: 0,
        rotation_deg: 180,
        instance: json!({}),
        note: String::new(),
    });
    let ln: &[&str] = &[&locker];
    entries.push(drawn(
        measure("safe.width_x", &sf["width_x"], ln),
        lw,
        [[lx0, lh, lz0 + ld + 60], [lx0 + lw, lh, lz0 + ld + 60]],
    ));
    entries.push(drawn(
        measure("safe.depth_z", &sf["depth_z"], ln),
        ld,
        [[lx0 - 60, lh, lz0], [lx0 - 60, lh, lz0 + ld]],
    ));
    entries.push(drawn(
        measure("safe.height_y", &sf["height_y"], ln),
        lh,
        [[lx0, 0, lz0 + ld], [lx0, lh, lz0 + ld]],
    ));
    entries.push(measure("safe.x1", &sf["x1"], ln));
    entries.push(measure("safe.z0", &sf["z0"], ln));

    // --- Cable tray: wire mesh basket along the wall behind the racks only ---
    let t = &r["cable_tray"];
    let (tw, th) = (val(&t["width"]), val(&t["side_height"]));
    let below = val(&t["top_below_ceiling"]);
    let tray_y0 = height - below - th;
    let extent: Vec<i32> = t["extent_x"]["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(mm)
        .collect();
    let (tx0, tx1) = (
        extent.first().copied().unwrap_or(0),
        extent.last().copied().unwrap_or(length),
    );
    let tray_item = catalog.len();
    catalog.push(NewItem {
        manufacturer: String::new(),
        model: format!("Лоток сетчатый {tw}×{th}"),
        // Width across the run is the depth; the run length is per object.
        dims: [1000, tw, th],
        props: CatalogProps::CableTray(CableTrayProps {
            tray_type: TrayType::Basket,
            max_fill_pct: None,
            purpose: None,
        }),
        props_src: BTreeMap::from([(
            "dims".into(),
            source(
                PropSrc::Assumed,
                None,
                Some("width and side height assumed from photos 04, 05"),
            ),
        )]),
    });
    let tray_name = "Лоток за стойками";
    objects.push(NewObject {
        item: tray_item,
        name: tray_name.into(),
        x0: tx0,
        z0: width - tw,
        y0: tray_y0,
        rotation_deg: 0,
        instance: json!({ "length_mm": tx1 - tx0 }),
        note: t["route"].as_str().unwrap_or("").to_string(),
    });
    let tx = length - 300;
    entries.push(drawn(
        measure(
            "tray.top_below_ceiling",
            &t["top_below_ceiling"],
            &[tray_name],
        ),
        below,
        [
            [tx, height - below, width - tw / 2],
            [tx, height, width - tw / 2],
        ],
    ));
    entries.push(measure("tray.width", &t["width"], &[tray_name]));
    entries.push(measure("tray.side_height", &t["side_height"], &[tray_name]));
    entries.push(measure(
        "tray.extent_x",
        &json!({"value": tx1 - tx0, "src": "assumed", "note": t["extent_x"]["note"]}),
        &[tray_name],
    ));

    // --- Cooling catalog ---
    for it in c["items"].as_array().into_iter().flatten() {
        catalog.push(cooling_item(it)?);
    }

    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str().map(str::to_string))
            .collect()
    };
    let mut not_modelled = strings(&r["not_modelled"]);
    not_modelled.extend(strings(&r["not_modelled_or_assumed_only"]));
    if let Some(n) = acc["airflow"]["note"].as_str() {
        not_modelled.push(format!("air conditioners: {n}"));
    }

    Ok(Plan {
        catalog,
        room_name: ROOM_NAME.into(),
        floor_plan: vec![[0, 0], [length, 0], [length, width], [0, width]],
        height_mm: height,
        measurements: RoomMeasurements {
            entries,
            remeasure: strings(&r["remeasure"]),
            not_modelled,
            conflicts: rm["conflict"]
                .as_str()
                .map(|s| vec![s.to_string()])
                .unwrap_or_default(),
        },
        settings: RoomSettings::default(),
        objects,
    })
}

/// One `cooling.json` item as a catalog item.
fn cooling_item(it: &Value) -> Result<NewItem, String> {
    let id = it["id"].as_str().unwrap_or("?");
    let subtype: CoolingSubtype = it["subtype"]
        .as_str()
        .and_then(parse_enum)
        .ok_or_else(|| format!("cooling.json {id}: unknown subtype"))?;
    let dims: Vec<i32> = it["dims"]
        .as_array()
        .into_iter()
        .flatten()
        .map(mm)
        .collect();
    let [w, d, h] = dims[..] else {
        return Err(format!("cooling.json {id}: dims"));
    };
    let url = it["source"].as_str();
    let mut src = BTreeMap::new();
    src.insert("dims".to_string(), source(PropSrc::Datasheet, url, None));
    let mut range = it["cooling_range_w"]
        .as_array()
        .map(|a| [mm(&a[0]), mm(&a[1])]);
    if range.is_none()
        && let Some(b) = it["cooling_range_btuh"].as_array()
    {
        // 1 BTU/h = 0.29307 W.
        let w = |v: &Value| (v.as_f64().unwrap_or(0.0) * 0.293_071).round() as i32;
        range = Some([w(&b[0]), w(&b[1])]);
        src.insert(
            "cooling_range_w".into(),
            source(PropSrc::Derived, url, Some("converted from BTU/h")),
        );
    }
    if let Some(n) = it["power_input_src"].as_str() {
        src.insert(
            "power_input_w".into(),
            source(PropSrc::Derived, url, Some(n)),
        );
    }
    if let Some(n) = it["airflow_src"].as_str() {
        src.insert("airflow_m3h".into(), source(PropSrc::Derived, url, Some(n)));
    }
    if let Some(n) = it["sensible_conditions"].as_str() {
        let uk = &it["cooling_at_uk_conditions"];
        let detail = if uk.is_object() {
            format!(
                "{n}: total {} W, sensible {} W",
                mm(&uk["total_w"]),
                mm(&uk["sensible_w"])
            )
        } else {
            n.to_string()
        };
        src.insert(
            "cooling_sensible_w".into(),
            source(PropSrc::Datasheet, url, Some(&detail)),
        );
    }
    let esp = &it["esp_pa"];
    let props = CoolingProps {
        subtype,
        model_known: true,
        inverter: it["inverter"].as_bool(),
        designed_24_7: it["designed_24_7"].as_bool(),
        cooling_total_w: opt(&it["cooling_total_w"]),
        cooling_sensible_w: opt(&it["cooling_sensible_w"]),
        rating_conditions: it["conditions"].as_str().map(str::to_string),
        cooling_range_w: range,
        airflow_m3h: it["airflow_m3h"]
            .as_array()
            .into_iter()
            .flatten()
            .map(mm)
            .collect(),
        power_input_w: opt(&it["power_input_w"]),
        eer: it["eer"].as_f64(),
        esp_pa: esp.is_object().then(|| EspPa {
            rated: mm(&esp["rated"]),
            min: opt(&esp["min"]),
            max: opt(&esp["max"]),
        }),
        weight_kg: it["weight_kg"].as_f64(),
        refrigerant: None,
        power_supply: it["power_supply"].as_str().map(str::to_string),
        capacity_modulation: it["capacity_modulation"].as_str().map(str::to_string),
        discharge_options: it["discharge_options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().and_then(parse_enum::<Discharge>))
            .collect(),
        airflow_pattern: it["airflow_pattern"].as_str().map(str::to_string),
        openings: vec![],
        derating: vec![],
        source_url: url.map(str::to_string),
    };
    let props = CatalogProps::Cooling(Box::new(props));
    props
        .validate()
        .map_err(|e| format!("cooling.json {id}: {e}"))?;
    Ok(NewItem {
        manufacturer: it["manufacturer"].as_str().unwrap_or("").to_string(),
        model: it["model"].as_str().unwrap_or(id).to_string(),
        dims: [w, d, h],
        props,
        props_src: src,
    })
}

/// What a seed run did.
#[derive(Debug, Default)]
pub struct Report {
    pub items_added: usize,
    pub items_kept: usize,
    pub room_added: bool,
}

/// Write the plan. Catalog items that exist are kept as they are; the room and
/// its objects are created only when no room of that name exists.
pub async fn run(pool: &PgPool) -> Result<Report, String> {
    let plan = plan()?;
    let mut report = Report::default();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let mut ids = Vec::with_capacity(plan.catalog.len());
    for item in &plan.catalog {
        item.props
            .validate()
            .map_err(|e| format!("{}: {e}", item.model))?;
        let kind = super::model::enum_str(&item.props.kind());
        let inserted: Option<i64> = sqlx::query_scalar(
            "INSERT INTO dc_catalog_items
                (kind, manufacturer, model, width_mm, depth_mm, height_mm, props, props_src)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (kind, manufacturer, model) DO NOTHING
             RETURNING id",
        )
        .bind(&kind)
        .bind(&item.manufacturer)
        .bind(&item.model)
        .bind(item.dims[0])
        .bind(item.dims[1])
        .bind(item.dims[2])
        .bind(item.props.props_value())
        .bind(serde_json::to_value(&item.props_src).map_err(|e| e.to_string())?)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("{}: {e}", item.model))?;
        let id = match inserted {
            Some(id) => {
                report.items_added += 1;
                id
            }
            None => {
                report.items_kept += 1;
                sqlx::query_scalar(
                    "SELECT id FROM dc_catalog_items WHERE kind = $1 AND manufacturer = $2 AND model = $3",
                )
                .bind(&kind)
                .bind(&item.manufacturer)
                .bind(&item.model)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
            }
        };
        ids.push(id);
    }

    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM dc_rooms WHERE name = $1)")
        .bind(&plan.room_name)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if !exists {
        let room_id: i64 = sqlx::query_scalar(
            "INSERT INTO dc_rooms (name, floor_plan, height_mm, measurements, settings)
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(&plan.room_name)
        .bind(json!(plan.floor_plan))
        .bind(plan.height_mm)
        .bind(serde_json::to_value(&plan.measurements).map_err(|e| e.to_string())?)
        .bind(serde_json::to_value(&plan.settings).map_err(|e| e.to_string())?)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        for o in &plan.objects {
            let obj = DcObject {
                id: 0,
                catalog_id: ids[o.item],
                name: o.name.clone(),
                x0_mm: o.x0,
                z0_mm: o.z0,
                y0_mm: o.y0,
                rotation_deg: o.rotation_deg,
                instance: o.instance.clone(),
                // Nobody has recorded what is in the racks yet.
                contents_known: false,
                note: o.note.clone(),
            };
            super::store::insert_object(&mut tx, room_id, None, &obj)
                .await
                .map_err(|e| format!("{}: {e}", o.name))?;
        }
        let snapshot: Snapshot = super::store::snapshot(&mut tx, room_id)
            .await
            .map_err(|_| "reading back the seeded room".to_string())?;
        super::store::write_revision(&mut tx, room_id, 1, &snapshot, None, "seed")
            .await
            .map_err(|_| "recording revision 1".to_string())?;
        report.room_added = true;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dc::geometry::{Rect, footprint};
    use crate::dc::model::Kind;

    fn rect_of(p: &Plan, name: &str) -> (Rect, i32, i32) {
        let o = p
            .objects
            .iter()
            .find(|o| o.name == name)
            .unwrap_or_else(|| panic!("{name}"));
        let it = &p.catalog[o.item];
        let w = o.instance["width_mm"]
            .as_i64()
            .or(o.instance["length_mm"].as_i64())
            .map(|v| v as i32)
            .unwrap_or(it.dims[0]);
        (
            footprint(o.x0, o.z0, w, it.dims[1], o.rotation_deg),
            o.y0,
            o.y0 + it.dims[2],
        )
    }

    #[test]
    fn the_plan_builds() {
        let p = plan().unwrap();
        assert_eq!(
            p.floor_plan,
            vec![[0, 0], [5545, 0], [5545, 3845], [0, 3845]]
        );
        assert_eq!(p.height_mm, 2410);
        // 6 items from the room (rack type, shelf, air conditioner, door,
        // locker, tray), 20 cooling units.
        assert_eq!(p.catalog.len(), 26);
        let cooling: Vec<_> = p
            .catalog
            .iter()
            .filter(|i| i.props.kind() == Kind::Cooling)
            .collect();
        assert_eq!(cooling.len(), 21);
        let precision = cooling
            .iter()
            .filter(|i| matches!(&i.props, CatalogProps::Cooling(c) if c.subtype.is_precision()))
            .count();
        assert_eq!(precision, 4);
    }

    fn entry<'a>(p: &'a Plan, key: &str) -> &'a Measurement {
        p.measurements
            .entries
            .iter()
            .find(|m| m.key == key)
            .unwrap_or_else(|| panic!("no measurement {key}"))
    }

    #[test]
    fn racks_are_where_room_json_puts_them() {
        let p = plan().unwrap();
        // (name, x0, front_z) from room.json v2; every rack 600 × 1000.
        for (name, x0, z0) in [
            ("Стойка 1", 530, 2250),
            ("Стойка 2", 1595, 2260),
            ("Стойка 3", 2635, 2220),
            ("Стойка 4", 3435, 2215),
        ] {
            let (r, y0, y1) = rect_of(&p, name);
            assert_eq!(r, Rect::new(x0, z0, x0 + 600, z0 + 1000), "{name}");
            assert_eq!((y0, y1), (0, 2040));
        }
        // The gaps the tape gave: 530, 465, 440, 200.
        let x: Vec<_> = ["Стойка 1", "Стойка 2", "Стойка 3", "Стойка 4"]
            .iter()
            .map(|n| rect_of(&p, n).0)
            .collect();
        assert_eq!(
            [
                x[0].x0,
                x[1].x0 - x[0].x1,
                x[2].x0 - x[1].x1,
                x[3].x0 - x[2].x1
            ],
            [530, 465, 440, 200]
        );
        // Rack 1 is an open frame.
        let r1 = p.objects.iter().find(|o| o.name == "Стойка 1").unwrap();
        assert_eq!(r1.instance["open_frame"], json!(true));
    }

    #[test]
    fn the_rest_is_within_a_millimetre() {
        let p = plan().unwrap();
        // The shelf stands against its wall.
        let (s, _, sh) = rect_of(&p, "Стелаж colocation (Tower)");
        assert_eq!((s, sh), (Rect::new(200, 0, 4730, 910), 1795));
        // Air conditioners: room.json's x0/x1/y0 to within 1 mm.
        for (name, x0, x1, y0) in [
            ("Кондиционер 1", 4005.0, 5255.0, 1960),
            ("Кондиционер 2", 2487.5, 3632.5, 1965),
            ("Кондиционер 3", 297.5, 1442.5, 1935),
        ] {
            let (r, ry0, ry1) = rect_of(&p, name);
            assert!(
                (r.x0 as f64 - x0).abs() <= 1.0 && (r.x1 as f64 - x1).abs() <= 1.0,
                "{name}: {r:?}"
            );
            assert_eq!((r.z0, r.z1), (30, 680));
            assert_eq!((ry0, ry1 - ry0), (y0, 380));
        }
        let (locker, _, h) = rect_of(&p, "Металлический шкаф (локер)");
        assert_eq!((locker, h), (Rect::new(5009, 5, 5515, 405), 1230));
        // One tray, behind the racks, 360 below the ceiling; none on the left wall.
        let trays: Vec<_> = p
            .objects
            .iter()
            .filter(|o| p.catalog[o.item].props.kind() == Kind::CableTray)
            .collect();
        assert_eq!(trays.len(), 1);
        let (back, ty0, ty1) = rect_of(&p, "Лоток за стойками");
        assert_eq!(
            (back, ty0, ty1),
            (Rect::new(0, 3645, 5545, 3845), 1990, 2050)
        );
        let door = p.objects.iter().find(|o| o.name == "Дверь").unwrap();
        assert_eq!(
            (door.x0, door.z0, door.instance["hinge"].as_str()),
            (5545, 860, Some("high"))
        );
        // Nothing seen on the photos beyond this is seeded.
        assert_eq!(p.objects.len(), 4 + 1 + 3 + 1 + 1 + 1);
    }

    #[test]
    fn air_conditioners_are_ducted_units_of_unknown_model() {
        let p = plan().unwrap();
        let ac = p
            .catalog
            .iter()
            .find(|i| i.model == "Канальный, модель не указана")
            .unwrap();
        let CatalogProps::Cooling(c) = &ac.props else {
            panic!()
        };
        assert_eq!(c.subtype, CoolingSubtype::Ducted);
        assert!(!c.model_known);
        assert_eq!((c.cooling_total_w, c.cooling_sensible_w), (None, None));
        assert_eq!(ac.dims, [1145, 650, 380]);
        assert_eq!(ac.props_src["subtype"].src, PropSrc::Photo);
        // Every unit has its supply outlet as a default, not as measured.
        for o in p
            .objects
            .iter()
            .filter(|o| o.item == p.catalog.iter().position(|i| std::ptr::eq(i, ac)).unwrap())
        {
            let outlets = o.instance["supply_outlets"].as_array().unwrap();
            assert_eq!(outlets.len(), 1);
            assert_eq!(outlets[0]["source"], "catalog_default");
        }
    }

    /// Every tape value of `data/drawing-hand.png`, in mm, is a measurement
    /// with a line to draw it along (FEEDBACK-1 §2).
    #[test]
    fn every_number_on_the_hand_drawing_is_a_dimension() {
        let p = plan().unwrap();
        let shown = |key: &str| -> (i32, Option<i32>, Option<i32>) {
            let m = entry(&p, key);
            assert!(m.line.is_some(), "{key} has no line");
            (m.value, m.min, m.max)
        };
        assert_eq!(shown("room.length_x"), (5545, Some(5540), Some(5550)));
        assert_eq!(shown("room.width_z"), (3845, Some(3840), Some(3850)));
        assert_eq!(shown("room.height_y"), (2410, Some(2400), Some(2420)));
        for (k, v) in [
            ("racks.gap.left_wall-r1", 530),
            ("racks.gap.r1-r2", 465),
            ("racks.gap.r2-r3", 440),
            ("racks.gap.r3-r4", 200),
        ] {
            assert_eq!(shown(k).0, v, "{k}");
        }
        assert_eq!(
            shown("racks.gap.r4-right_wall"),
            (1498, Some(1495), Some(1500))
        );
        assert_eq!(shown("racks.width.r1"), (603, Some(600), Some(605)));
        assert_eq!(shown("racks.width.r2"), (598, Some(595), Some(600)));
        assert_eq!(shown("racks.width.r3"), (600, None, None));
        assert_eq!(shown("racks.width.r4"), (598, Some(595), Some(600)));
        for r in ["r1", "r2", "r3", "r4"] {
            assert_eq!(shown(&format!("racks.depth.{r}")).0, 1000);
            assert_eq!(shown(&format!("racks.height.{r}")).0, 2040);
        }
        for (r, aisle, back) in [
            ("r1", 1340, 610),
            ("r2", 1350, 555),
            ("r3", 1310, 625),
            ("r4", 1305, 635),
        ] {
            assert_eq!(shown(&format!("racks.aisle.{r}")).0, aisle);
            assert_eq!(shown(&format!("racks.back.{r}")).0, back);
        }
        assert_eq!(shown("shelf.length_x").0, 4530);
        assert_eq!(shown("shelf.depth_z").0, 910);
        assert_eq!(shown("shelf.height_y"), (1795, Some(1795), Some(1800)));
        assert_eq!(shown("tray.top_below_ceiling").0, 360);
        for k in [
            "ac.ac1.length",
            "ac.ac2.length",
            "ac.ac3.length",
            "ac.ac1.gap_to_ceiling",
            "ac.ac2.gap_to_ceiling",
            "ac.ac3.gap_to_ceiling",
            "ac.unit_height",
            "ac.ac1_to_right_wall",
            "ac.gap_ac1_ac2",
            "ac.gap_ac2_ac3",
        ] {
            shown(k);
        }
    }

    /// Model vs tape: the drawing's back gaps disagree with the model by
    /// −15, +30, 0, −5 mm (room.json); only beyond 5 mm is it marked.
    #[test]
    fn model_and_tape_differences_are_kept_and_marked() {
        let p = plan().unwrap();
        let check = |key: &str| {
            let m = entry(&p, key);
            (m.model, m.disagrees())
        };
        assert_eq!(check("racks.back.r1"), (Some(595), true));
        assert_eq!(check("racks.back.r2"), (Some(585), true));
        assert_eq!(check("racks.back.r3"), (Some(625), false));
        assert_eq!(check("racks.back.r4"), (Some(630), false));
        assert_eq!(check("racks.gap.r4-right_wall"), (Some(1510), true));
        assert_eq!(check("racks.aisle.r1"), (Some(1340), false));
        assert_eq!(check("racks.width.r1"), (Some(600), false));
        assert_eq!(check("room.length_x"), (Some(5545), false));
        // Every measurement's line is exactly as long as its model value.
        for m in &p.measurements.entries {
            if let (Some([a, b]), Some(model)) = (m.line, m.model) {
                let len = (((b[0] - a[0]) as f64).powi(2)
                    + ((b[1] - a[1]) as f64).powi(2)
                    + ((b[2] - a[2]) as f64).powi(2))
                .sqrt();
                assert!(
                    (len - model as f64).abs() < 0.5,
                    "{}: line {len} vs model {model}",
                    m.key
                );
            }
        }
    }

    #[test]
    fn every_assumed_number_is_recorded_as_assumed() {
        let p = plan().unwrap();
        let assumed: Vec<&str> = p
            .measurements
            .entries
            .iter()
            .filter(|m| m.src == MeasSrc::Assumed)
            .map(|m| m.key.as_str())
            .collect();
        for k in [
            "shelf.board_1",
            "shelf.board_2",
            "ac.z0",
            "safe.x1",
            "safe.z0",
            "tray.width",
            "tray.side_height",
            "tray.extent_x",
        ] {
            assert!(assumed.contains(&k), "{k} should be assumed");
        }
        assert!(!assumed.contains(&"room.length_x"));
        assert!(!assumed.contains(&"shelf.z0"));
        assert_eq!(p.measurements.remeasure.len(), 4);
    }

    #[test]
    fn cooling_units_keep_their_datasheet_numbers() {
        let p = plan().unwrap();
        let find = |m: &str| p.catalog.iter().find(|i| i.model.starts_with(m)).unwrap();
        let crv = find("Liebert CRV CRD35");
        let CatalogProps::Cooling(c) = &crv.props else {
            panic!()
        };
        assert_eq!(
            (c.subtype, c.cooling_sensible_w, c.airflow_m3h.clone()),
            (CoolingSubtype::InRow, Some(36000), vec![8000])
        );
        assert_eq!(crv.dims, [600, 1132, 2000]);
        assert!(
            crv.props_src["dims"]
                .url
                .as_deref()
                .unwrap()
                .starts_with("https://www.vertiv.com")
        );
        let pdx = find("Liebert PDX");
        let CatalogProps::Cooling(c) = &pdx.props else {
            panic!()
        };
        assert_eq!(
            c.discharge_options,
            vec![Discharge::Upflow, Discharge::Downflow]
        );
        let midea = find("MSAFB-12HRDN1");
        let CatalogProps::Cooling(c) = &midea.props else {
            panic!()
        };
        assert_eq!(c.cooling_range_w, Some([791, 3634]));
        assert_eq!(midea.props_src["cooling_range_w"].src, PropSrc::Derived);
    }

    /// The plan placed and drawn: the DXF has the walls and the racks where
    /// `room.json` puts them, in millimetres, with the plan's z flipped.
    #[test]
    fn the_dxf_of_the_seeded_room_matches_room_json() {
        use crate::dc::dxf::{self, Placed};
        use crate::dc::geometry::solid;
        use crate::dc::model::{CatalogItem, DcObject, Room};
        use crate::models::Language;

        let p = plan().unwrap();
        let items: Vec<CatalogItem> = p
            .catalog
            .iter()
            .enumerate()
            .map(|(i, n)| CatalogItem {
                id: i as i64 + 1,
                manufacturer: n.manufacturer.clone(),
                model: n.model.clone(),
                width_mm: n.dims[0],
                depth_mm: n.dims[1],
                height_mm: n.dims[2],
                props: n.props.clone(),
                props_src: n.props_src.clone(),
                archived: false,
            })
            .collect();
        let objects: Vec<DcObject> = p
            .objects
            .iter()
            .enumerate()
            .map(|(i, o)| DcObject {
                id: i as i64 + 1,
                catalog_id: o.item as i64 + 1,
                name: o.name.clone(),
                x0_mm: o.x0,
                z0_mm: o.z0,
                y0_mm: o.y0,
                rotation_deg: o.rotation_deg,
                instance: o.instance.clone(),
                contents_known: false,
                note: o.note.clone(),
            })
            .collect();
        let room = Room {
            id: 1,
            name: p.room_name.clone(),
            floor_plan: p.floor_plan.clone(),
            height_mm: p.height_mm,
            measurements: p.measurements.clone(),
            settings: p.settings.clone(),
            revision: 1,
            updated_at: chrono::Utc::now(),
        };
        let solids: Vec<_> = objects
            .iter()
            .map(|o| solid(o, &items[o.catalog_id as usize - 1], &room.floor_plan).unwrap())
            .collect();
        let placed: Vec<Placed> = objects
            .iter()
            .zip(&solids)
            .map(|(o, s)| Placed {
                solid: s,
                object: o,
                item: &items[o.catalog_id as usize - 1],
            })
            .collect();
        let bytes = dxf::build(&room, &placed, Language::En);
        let text: String = bytes.iter().map(|&b| b as char).collect();
        let lines: Vec<&str> = text.split("\r\n").collect();
        assert_eq!(lines[..4], ["  0", "SECTION", "  2", "HEADER"]);
        assert_eq!(lines[lines.len() - 3..], ["  0", "EOF", ""]);
        assert!(text.contains("$DWGCODEPAGE\r\n  3\r\nANSI_1251"));

        // LINE entities on a layer, as (x1, y1, x2, y2).
        let segs = |layer: &str| -> Vec<[f64; 4]> {
            let mut out = Vec::new();
            for (i, w) in lines.windows(4).enumerate() {
                if w[0] == "  0" && w[1] == "LINE" && w[2] == "  8" && w[3] == layer {
                    let v = |k: usize| lines[i + 5 + 2 * k].trim().parse::<f64>().unwrap();
                    out.push([v(0), v(1), v(3), v(4)]);
                }
            }
            out
        };
        // The room outline, the z = 0 wall drawn at the top (y = 3845).
        let walls = segs("WALLS");
        assert_eq!(walls[0], [0.0, 3845.0, 5545.0, 3845.0]);
        assert_eq!(walls[2], [5545.0, 0.0, 0.0, 0.0]);
        // Rack 1: x 530–1130, z 2250–3250, i.e. y 595–1595 in the drawing.
        let racks = segs("RACKS");
        assert!(racks.contains(&[530.0, 595.0, 1130.0, 595.0]));
        assert!(racks.contains(&[1130.0, 1595.0, 530.0, 1595.0]));
        // Its front line, 25 mm inside the front face.
        assert!(racks.contains(&[530.0, 1570.0, 1130.0, 1570.0]));
        // Dimensions carry the tape value (r1's back gap: 610, model 595),
        // and a circle marks each one the model disagrees with.
        let texts: Vec<&str> = lines
            .windows(2)
            .filter(|w| w[0] == "  1")
            .map(|w| w[1])
            .collect();
        assert!(texts.contains(&"610"));
        assert!(!texts.contains(&"595"));
        let circles = lines.iter().filter(|l| **l == "CIRCLE").count();
        let marked = p
            .measurements
            .entries
            .iter()
            .filter(|m| m.disagrees() && m.line.is_some_and(|[a, b]| a[0] != b[0] || a[2] != b[2]))
            .count();
        assert_eq!(circles, marked);
        assert!(marked >= 3);
        // Room dimensions show the measured ranges.
        assert!(text.contains("5540\u{96}5550"));
        assert!(text.contains("3840\u{96}3850"));
    }
}
