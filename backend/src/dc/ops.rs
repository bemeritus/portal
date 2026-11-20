//! Change sets: an ordered list of operations on one room, applied atomically
//! as one revision with one audit entry per operation (§7, §8).
//!
//! The flow, all in one transaction:
//! 1. lock the room; if its revision is not the one the client saw, stop with
//!    a conflict (no silent last-writer-wins);
//! 2. apply each operation, checking what can be checked alone (ids belong to
//!    this room, values are in range, kinds are typed);
//! 3. check the room as it now stands — placement, door swings, shelf cells
//!    under cooling units, racks with devices marked "not recorded" — since a
//!    move is only invalid or valid in the light of the other moves;
//! 4. bump the revision, store the snapshot, write the audit entries.
//!
//! The database's own constraints (no two devices in one unit, a device fits
//! its rack) are the last line; their violations come back as 409s here.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use sqlx::types::Json;

use super::geometry::{self, Clearance, Problem, Solid};
use super::model::{
    AnnotationPayload, CatalogItem, CatalogProps, DcObject, DeviceFields, Instance, Kind, Room,
    RoomSettings, ShelfCell, ShelfProps, Snapshot, Text, enum_str,
};
use super::store;
use crate::audit::{Audit, audit_tx};
use crate::error::{ApiError, ApiResult, internal};
use crate::models::User;

/// The most operations one change set may carry.
pub const MAX_OPS: usize = 500;

/// An object's editable fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectFields {
    pub catalog_id: i64,
    pub name: String,
    pub x0_mm: i32,
    pub z0_mm: i32,
    #[serde(default)]
    pub y0_mm: i32,
    #[serde(default)]
    pub rotation_deg: i32,
    #[serde(default = "empty_object")]
    pub instance: Value,
    #[serde(default)]
    pub contents_known: bool,
    #[serde(default)]
    pub note: Text,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    ObjectCreate {
        object: ObjectFields,
    },
    ObjectUpdate {
        id: i64,
        object: ObjectFields,
    },
    ObjectDelete {
        id: i64,
    },
    DeviceCreate {
        device: DeviceFields,
    },
    DeviceUpdate {
        id: i64,
        device: DeviceFields,
    },
    DeviceDelete {
        id: i64,
    },
    CellSet {
        cell: ShelfCell,
    },
    CellDelete {
        shelf_id: i64,
        cell_no: i32,
    },
    AnnotationCreate {
        annotation: AnnotationPayload,
    },
    /// A note's text or a saved view's state (FEEDBACK-7 §1.5, §4.8: update
    /// a view from the current one, the tour's order). Same kind only.
    AnnotationUpdate {
        id: i64,
        annotation: AnnotationPayload,
    },
    AnnotationDelete {
        id: i64,
    },
    /// The room's settings: clearances, the per-rack power budget
    /// (FEEDBACK-7 §1.7).
    RoomSettings {
        settings: RoomSettings,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeSet {
    /// The revision the client last saw.
    pub base_revision: i32,
    #[serde(default)]
    pub summary: Option<String>,
    pub ops: Vec<Op>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Applied {
    pub revision: i32,
    /// Per operation: the id a create made, `None` for the others.
    pub created: Vec<Option<i64>>,
    /// Clearance shortfalls in the room as it now stands.
    pub warnings: Vec<Clearance>,
}

/// The room moved on since the client loaded it.
#[derive(Debug)]
pub struct Stale {
    pub revision: i32,
}

pub enum Failure {
    Stale(Stale),
    Api(ApiError),
}

impl From<ApiError> for Failure {
    fn from(e: ApiError) -> Self {
        Failure::Api(e)
    }
}

// --- What a room's state implies ------------------------------------------------

/// Derived facts about a room's state: what breaks the rules (should be empty
/// for anything stored), rack clearances, shelf cells blocked by cooling, and
/// cooling units that hang over occupied cells.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Analysis {
    pub problems: Vec<ObjectProblem>,
    pub clearances: Vec<Clearance>,
    /// Shelf object id → blocked cell numbers.
    pub blocked_cells: BTreeMap<i64, Vec<i32>>,
    /// A cooling unit moved over occupied cells: a warning, not a refusal
    /// (FEEDBACK-7 §1.1) — condensate may drip onto the equipment.
    pub cooling_over_cells: Vec<CoolingOverCells>,
}

/// Occupied cells under one cooling unit, on one shelf.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CoolingOverCells {
    /// The cooling unit.
    pub object_id: i64,
    pub object: String,
    pub shelf_id: i64,
    pub cells: Vec<i32>,
}

/// Per cooling unit and shelf, the occupied cells the unit blocks.
pub fn cooling_over_cells(
    shelves: &[(&Solid, &ShelfProps)],
    units: &[&Solid],
    cells: &[ShelfCell],
) -> Vec<CoolingOverCells> {
    let mut out = Vec::new();
    for u in units {
        for (shelf, p) in shelves {
            let under: Vec<i32> = geometry::blocked_cells(shelf, p, &[u])
                .into_iter()
                .filter(|n| {
                    cells
                        .iter()
                        .any(|c| c.shelf_id == shelf.id && c.cell_no == *n)
                })
                .collect();
            if !under.is_empty() {
                out.push(CoolingOverCells {
                    object_id: u.id,
                    object: u.name.clone(),
                    shelf_id: shelf.id,
                    cells: under,
                });
            }
        }
    }
    out
}

/// The cell a change set put or moved into a place under a cooling unit, if
/// any (FEEDBACK-7 §1.1). Only what the change set itself places is refused:
/// a cell it set, or an occupied cell of a shelf it moved that was not
/// blocked before. A cooling unit moved over occupied cells is allowed; that
/// is a warning (`cooling_over_cells`).
pub fn refused_cell(
    before: &BTreeMap<i64, Vec<i32>>,
    after: &BTreeMap<i64, Vec<i32>>,
    cells: &[ShelfCell],
    set_cells: &HashSet<(i64, i32)>,
    moved_shelves: &HashSet<i64>,
) -> Option<i32> {
    let blocked = |m: &BTreeMap<i64, Vec<i32>>, c: &ShelfCell| {
        m.get(&c.shelf_id).is_some_and(|b| b.contains(&c.cell_no))
    };
    cells
        .iter()
        .find(|c| {
            blocked(after, c)
                && (set_cells.contains(&(c.shelf_id, c.cell_no))
                    || (moved_shelves.contains(&c.shelf_id) && !blocked(before, c)))
        })
        .map(|c| c.cell_no)
}

#[derive(Clone, Debug, Serialize)]
pub struct ObjectProblem {
    pub object_id: i64,
    #[serde(flatten)]
    pub problem: Problem,
}

/// Place every object of a snapshot. An object whose catalog item is missing
/// or whose instance does not parse is a fault in stored data.
pub fn solids(
    room: &Room,
    items: &HashMap<i64, CatalogItem>,
    s: &Snapshot,
) -> ApiResult<Vec<Solid>> {
    s.objects
        .iter()
        .map(|o| {
            let item = items.get(&o.catalog_id).ok_or_else(|| {
                internal(
                    "placing an object",
                    format!("catalog item {} missing", o.catalog_id),
                )
            })?;
            geometry::solid(o, item, &room.floor_plan).map_err(|e| internal("placing an object", e))
        })
        .collect()
}

pub fn analyse(
    room: &Room,
    items: &HashMap<i64, CatalogItem>,
    s: &Snapshot,
) -> ApiResult<Analysis> {
    let solids = solids(room, items, s)?;
    let mut a = Analysis::default();
    for (i, solid) in solids.iter().enumerate() {
        for p in geometry::problems(i, &solids, &room.floor_plan, room.height_mm) {
            a.problems.push(ObjectProblem {
                object_id: solid.id,
                problem: p,
            });
        }
    }
    a.clearances = geometry::clearances(
        &solids,
        &room.floor_plan,
        &room.settings,
        &room.measurements.entries,
    );
    let cooling: Vec<&Solid> = solids.iter().filter(|s| s.kind == Kind::Cooling).collect();
    let mut shelves = Vec::new();
    for (o, solid) in s.objects.iter().zip(&solids) {
        if let Some(CatalogProps::Shelf(p)) = items.get(&o.catalog_id).map(|i| &i.props) {
            a.blocked_cells
                .insert(o.id, geometry::blocked_cells(solid, p, &cooling));
            shelves.push((solid, p));
        }
    }
    a.cooling_over_cells = cooling_over_cells(&shelves, &cooling, &s.cells);
    Ok(a)
}

// --- Applying a change set ----------------------------------------------------------

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::BadRequest(msg.into())
}

fn object_not_found() -> ApiError {
    bad("No such object in this room")
}

fn device_not_found() -> ApiError {
    bad("No such device in this room")
}

/// Map a database refusal to a sentence the user can act on.
fn db_refusal(context: &str, e: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &e {
        match db.constraint() {
            Some("dc_devices_front_no_overlap" | "dc_devices_rear_no_overlap") => {
                return ApiError::Conflict("Those units are already taken on that face".into());
            }
            Some("dc_devices_fit_rack") => {
                return ApiError::Conflict("The device does not fit in the rack's units".into());
            }
            Some("dc_devices_rack_kind") => return bad("Devices go in racks"),
            Some("dc_shelf_cells_shelf_kind") => return bad("Shelf cells go on shelves"),
            Some("dc_shelf_cells_fit_shelf") => return bad("No such cell on this shelf"),
            Some("dc_objects_room_id_name_key") => {
                return ApiError::Conflict(
                    "Another object in this room already has that name".into(),
                );
            }
            _ => {}
        }
        if db.is_foreign_key_violation() {
            return ApiError::Conflict(
                "Remove the devices and cells from that object first".into(),
            );
        }
    }
    internal(context, e)
}

fn check_device(d: &DeviceFields) -> ApiResult<()> {
    if d.name.trim().is_empty() {
        return Err(bad("A device needs a name"));
    }
    if d.u_bottom < 1 || d.u_height < 1 || d.u_bottom + d.u_height > 100 {
        return Err(bad("Units out of range"));
    }
    if d.power_w.is_some_and(|p| p < 0) {
        return Err(bad("Power must not be negative"));
    }
    if d.power_src.is_some() && d.power_w.is_none() {
        return Err(bad("A power source needs a power value"));
    }
    if d.depth_mm.is_some_and(|v| v <= 0) {
        return Err(bad("Depth must be positive"));
    }
    Ok(())
}

fn check_cell(c: &ShelfCell) -> ApiResult<()> {
    if c.name.trim().is_empty() {
        return Err(bad("A cell needs a name"));
    }
    if c.power_w.is_some_and(|p| p < 0) {
        return Err(bad("Power must not be negative"));
    }
    Ok(())
}

fn check_settings(s: &RoomSettings) -> ApiResult<()> {
    if !(0..=5000).contains(&s.clearance_front_mm) || !(0..=5000).contains(&s.clearance_rear_mm) {
        return Err(bad("Clearance out of range"));
    }
    if s.rack_power_budget_w
        .is_some_and(|w| !(100..=100_000).contains(&w))
    {
        return Err(bad("Power budget out of range"));
    }
    Ok(())
}

/// "budget 6000 W, front 1000 mm, rear 600 mm" for the audit.
fn settings_line(s: &RoomSettings) -> String {
    let budget = s
        .rack_power_budget_w
        .map(|w| format!("{w} W"))
        .unwrap_or_else(|| "not set".into());
    format!(
        "budget {budget}, front {} mm, rear {} mm",
        s.clearance_front_mm, s.clearance_rear_mm
    )
}

fn check_annotation(a: &AnnotationPayload) -> ApiResult<()> {
    match a {
        AnnotationPayload::Note(n) if n.text.trim().is_empty() => Err(bad("A note needs text")),
        AnnotationPayload::View(v) if v.name.trim().is_empty() => Err(bad("A view needs a name")),
        AnnotationPayload::View(v) if !(10..=120).contains(&v.fov) => {
            Err(bad("Field of view out of range"))
        }
        AnnotationPayload::View(v)
            if v.state
                .as_ref()
                .is_some_and(|s| s.to_string().len() > 32_768) =>
        {
            Err(bad("A view's state is too large"))
        }
        AnnotationPayload::View(v) if v.hold_s.is_some_and(|s| !(1..=600).contains(&s)) => {
            Err(bad("Hold time out of range"))
        }
        _ => Ok(()),
    }
}

/// The catalog item an object may use: existing, not archived for new
/// placements, of a kind phase 1 types; and its instance typed by it.
async fn check_object(
    conn: &mut PgConnection,
    items: &mut HashMap<i64, CatalogItem>,
    o: &ObjectFields,
    creating: bool,
) -> ApiResult<Value> {
    if o.name.trim().is_empty() {
        return Err(bad("An object needs a name"));
    }
    if !matches!(o.rotation_deg, 0 | 90 | 180 | 270) {
        return Err(bad("Rotation must be 0, 90, 180 or 270"));
    }
    if o.y0_mm < 0 {
        return Err(bad("Mounting height must not be negative"));
    }
    if !items.contains_key(&o.catalog_id) {
        match store::catalog_item(conn, o.catalog_id).await? {
            Some(item) => {
                items.insert(item.id, item);
            }
            None => return Err(bad("That catalog item does not exist")),
        }
    }
    let item = &items[&o.catalog_id];
    if creating && item.archived {
        return Err(bad("Archived catalog items cannot be placed"));
    }
    let instance = Instance::parse(&item.props, &o.instance).map_err(|e| {
        tracing::info!("rejected instance for catalog item {}: {e}", item.id);
        bad("These settings are not valid for this kind of equipment")
    })?;
    Ok(instance.to_value())
}

fn object_kind(items: &HashMap<i64, CatalogItem>, s: &Snapshot, id: i64) -> Option<Kind> {
    let o = s.objects.iter().find(|o| o.id == id)?;
    items.get(&o.catalog_id).map(|i| i.kind())
}

fn device_line(d: &DeviceFields) -> String {
    let units = if d.u_height > 1 {
        format!("U{}–{}", d.u_bottom, d.u_bottom + d.u_height - 1)
    } else {
        format!("U{}", d.u_bottom)
    };
    let power = d.power_w.map(|p| format!(", {p} W")).unwrap_or_default();
    format!("{} ({units}, {}{power})", d.name, enum_str(&d.face))
}

/// Apply a change set. The caller commits `conn`'s transaction on `Ok`.
pub async fn apply(
    conn: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room_id: i64,
    set: ChangeSet,
    actor: &User,
) -> Result<Applied, Failure> {
    if set.ops.is_empty() {
        return Err(bad("A change set needs at least one operation").into());
    }
    if set.ops.len() > MAX_OPS {
        return Err(bad("Too many operations in one change set").into());
    }
    let mut room = store::room_for_update(conn, room_id).await?;
    if room.revision != set.base_revision {
        return Err(Failure::Stale(Stale {
            revision: room.revision,
        }));
    }
    let mut items: HashMap<i64, CatalogItem> = store::catalog_of_room(conn, room_id)
        .await?
        .into_iter()
        .map(|i| (i.id, i))
        .collect();
    let mut state = store::snapshot(conn, room_id).await?;
    let blocked_before = analyse(&room, &items, &state)?.blocked_cells;
    let mut set_cells: HashSet<(i64, i32)> = HashSet::new();
    let mut new_settings: Option<RoomSettings> = None;
    let mut created = Vec::with_capacity(set.ops.len());
    let mut audits: Vec<(String, String, String)> = Vec::new();
    let mut touched: HashSet<i64> = HashSet::new();
    let label = |name: &str| format!("{} / {name}", room.name);

    for op in &set.ops {
        let mut new_id = None;
        match op {
            Op::ObjectCreate { object } => {
                let instance = check_object(conn, &mut items, object, true).await?;
                let o = DcObject {
                    id: 0,
                    catalog_id: object.catalog_id,
                    name: object.name.trim().to_string(),
                    x0_mm: object.x0_mm,
                    z0_mm: object.z0_mm,
                    y0_mm: object.y0_mm,
                    rotation_deg: object.rotation_deg,
                    instance,
                    contents_known: object.contents_known,
                    note: object.note.clone(),
                };
                let id = store::insert_object(conn, room_id, None, &o)
                    .await
                    .map_err(|e| db_refusal("creating an object", e))?;
                new_id = Some(id);
                touched.insert(id);
                audits.push((
                    "dc.object.create".into(),
                    label(&o.name),
                    format!("at x {} z {}", o.x0_mm, o.z0_mm),
                ));
                state.objects.push(DcObject { id, ..o });
            }
            Op::ObjectUpdate { id, object } => {
                let idx = state
                    .objects
                    .iter()
                    .position(|o| o.id == *id)
                    .ok_or_else(object_not_found)?;
                if state.objects[idx].catalog_id != object.catalog_id {
                    return Err(bad("An object's catalog item cannot be changed").into());
                }
                let instance = check_object(conn, &mut items, object, false).await?;
                sqlx::query(
                    "UPDATE dc_objects SET name = $2, x0_mm = $3, z0_mm = $4, y0_mm = $5,
                            rotation_deg = $6, instance = $7, contents_known = $8, note = $9
                      WHERE id = $1",
                )
                .bind(id)
                .bind(object.name.trim())
                .bind(object.x0_mm)
                .bind(object.z0_mm)
                .bind(object.y0_mm)
                .bind(object.rotation_deg as i16)
                .bind(&instance)
                .bind(object.contents_known)
                .bind(Json(&object.note))
                .execute(&mut **conn)
                .await
                .map_err(|e| db_refusal("updating an object", e))?;
                let before = state.objects[idx].clone();
                let after = DcObject {
                    id: *id,
                    catalog_id: object.catalog_id,
                    name: object.name.trim().to_string(),
                    x0_mm: object.x0_mm,
                    z0_mm: object.z0_mm,
                    y0_mm: object.y0_mm,
                    rotation_deg: object.rotation_deg,
                    instance,
                    contents_known: object.contents_known,
                    note: object.note.clone(),
                };
                let mut what = Vec::new();
                if (before.x0_mm, before.z0_mm, before.y0_mm)
                    != (after.x0_mm, after.z0_mm, after.y0_mm)
                {
                    what.push(format!(
                        "moved from x {} z {} to x {} z {}",
                        before.x0_mm, before.z0_mm, after.x0_mm, after.z0_mm
                    ));
                }
                if before.rotation_deg != after.rotation_deg {
                    what.push(format!(
                        "rotated {}° → {}°",
                        before.rotation_deg, after.rotation_deg
                    ));
                }
                if before.name != after.name {
                    what.push(format!("renamed from '{}'", before.name));
                }
                if before.contents_known != after.contents_known {
                    what.push(
                        if after.contents_known {
                            "contents recorded"
                        } else {
                            "contents not recorded"
                        }
                        .into(),
                    );
                }
                if before.instance != after.instance || before.note != after.note {
                    what.push("details edited".into());
                }
                touched.insert(*id);
                audits.push((
                    "dc.object.update".into(),
                    label(&after.name),
                    what.join("; "),
                ));
                state.objects[idx] = after;
            }
            Op::ObjectDelete { id } => {
                let idx = state
                    .objects
                    .iter()
                    .position(|o| o.id == *id)
                    .ok_or_else(object_not_found)?;
                if state.devices.iter().any(|d| d.fields.rack_id == *id)
                    || state.cells.iter().any(|c| c.shelf_id == *id)
                {
                    return Err(ApiError::Conflict(
                        "Remove the devices and cells from that object first".into(),
                    )
                    .into());
                }
                sqlx::query("DELETE FROM dc_objects WHERE id = $1")
                    .bind(id)
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| db_refusal("deleting an object", e))?;
                let gone = state.objects.remove(idx);
                audits.push(("dc.object.delete".into(), label(&gone.name), String::new()));
            }
            Op::DeviceCreate { device } | Op::DeviceUpdate { device, .. } => {
                check_device(device)?;
                let rack = state
                    .objects
                    .iter()
                    .find(|o| o.id == device.rack_id)
                    .ok_or_else(object_not_found)?;
                if object_kind(&items, &state, rack.id) != Some(Kind::Rack) {
                    return Err(bad("Devices go in racks").into());
                }
                let rack_name = rack.name.clone();
                let mut fields = device.clone();
                fields.name = fields.name.trim().to_string();
                if let Op::DeviceUpdate { id, .. } = op {
                    let idx = state
                        .devices
                        .iter()
                        .position(|d| d.id == *id)
                        .ok_or_else(device_not_found)?;
                    let before = state.devices[idx].fields.clone();
                    sqlx::query(
                        "UPDATE dc_devices SET rack_id = $2, u_bottom = $3, u_height = $4, face = $5,
                                depth_mm = $6, kind = $7::dc_device_kind, name = $8, owner = $9,
                                serial = $10, power_w = $11, power_src = $12, status = $13, note = $14
                          WHERE id = $1",
                    )
                    .bind(id)
                    .bind(fields.rack_id)
                    .bind(fields.u_bottom as i16)
                    .bind(fields.u_height as i16)
                    .bind(enum_str(&fields.face))
                    .bind(fields.depth_mm)
                    .bind(enum_str(&fields.kind))
                    .bind(&fields.name)
                    .bind(&fields.owner)
                    .bind(&fields.serial)
                    .bind(fields.power_w)
                    .bind(fields.power_src.map(|p| enum_str(&p)))
                    .bind(enum_str(&fields.status))
                    .bind(&fields.note)
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| db_refusal("updating a device", e))?;
                    audits.push((
                        "dc.device.update".into(),
                        label(&rack_name),
                        format!("{} → {}", device_line(&before), device_line(&fields)),
                    ));
                    state.devices[idx].fields = fields;
                } else {
                    let id = store::insert_device(conn, None, &fields)
                        .await
                        .map_err(|e| db_refusal("adding a device", e))?;
                    new_id = Some(id);
                    audits.push((
                        "dc.device.create".into(),
                        label(&rack_name),
                        device_line(&fields),
                    ));
                    state.devices.push(super::model::Device { id, fields });
                }
            }
            Op::DeviceDelete { id } => {
                let idx = state
                    .devices
                    .iter()
                    .position(|d| d.id == *id)
                    .ok_or_else(device_not_found)?;
                sqlx::query("DELETE FROM dc_devices WHERE id = $1")
                    .bind(id)
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| db_refusal("removing a device", e))?;
                let gone = state.devices.remove(idx);
                let rack = state
                    .objects
                    .iter()
                    .find(|o| o.id == gone.fields.rack_id)
                    .map(|o| o.name.clone())
                    .unwrap_or_default();
                audits.push((
                    "dc.device.delete".into(),
                    label(&rack),
                    device_line(&gone.fields),
                ));
            }
            Op::CellSet { cell } => {
                check_cell(cell)?;
                let shelf = state
                    .objects
                    .iter()
                    .find(|o| o.id == cell.shelf_id)
                    .ok_or_else(object_not_found)?;
                let Some(CatalogProps::Shelf(p)) = items.get(&shelf.catalog_id).map(|i| &i.props)
                else {
                    return Err(bad("Shelf cells go on shelves").into());
                };
                if geometry::cell_info(p, cell.cell_no).is_none() {
                    return Err(bad("No such cell on this shelf").into());
                }
                let shelf_name = shelf.name.clone();
                set_cells.insert((cell.shelf_id, cell.cell_no));
                let mut c = cell.clone();
                c.name = c.name.trim().to_string();
                store::upsert_cell(conn, &c)
                    .await
                    .map_err(|e| db_refusal("saving a shelf cell", e))?;
                audits.push((
                    "dc.cell.set".into(),
                    label(&shelf_name),
                    format!("cell {}: {}", c.cell_no, c.name),
                ));
                state
                    .cells
                    .retain(|x| !(x.shelf_id == c.shelf_id && x.cell_no == c.cell_no));
                state.cells.push(c);
            }
            Op::CellDelete { shelf_id, cell_no } => {
                let shelf = state
                    .objects
                    .iter()
                    .find(|o| o.id == *shelf_id)
                    .ok_or_else(object_not_found)?;
                let shelf_name = shelf.name.clone();
                let n =
                    sqlx::query("DELETE FROM dc_shelf_cells WHERE shelf_id = $1 AND cell_no = $2")
                        .bind(shelf_id)
                        .bind(*cell_no as i16)
                        .execute(&mut **conn)
                        .await
                        .map_err(|e| db_refusal("clearing a shelf cell", e))?
                        .rows_affected();
                if n == 0 {
                    return Err(bad("That cell is already empty").into());
                }
                state
                    .cells
                    .retain(|x| !(x.shelf_id == *shelf_id && x.cell_no == *cell_no));
                audits.push((
                    "dc.cell.delete".into(),
                    label(&shelf_name),
                    format!("cell {cell_no}"),
                ));
            }
            Op::AnnotationCreate { annotation } => {
                check_annotation(annotation)?;
                let id =
                    store::insert_annotation(conn, room_id, None, annotation, Some(actor.id), None)
                        .await
                        .map_err(|e| db_refusal("adding an annotation", e))?;
                new_id = Some(id);
                let what = match annotation {
                    AnnotationPayload::Note(n) => n.text.clone(),
                    AnnotationPayload::View(v) => v.name.clone(),
                };
                audits.push(("dc.annotation.create".into(), label(&what), String::new()));
                state.annotations.push(super::model::Annotation {
                    id,
                    payload: annotation.clone(),
                    author_id: Some(actor.id),
                    author_name: Some(actor.username.clone()),
                    created_at: chrono::Utc::now(),
                });
            }
            Op::AnnotationDelete { id } => {
                // Someone else's personal view does not exist for this user.
                let idx = state
                    .annotations
                    .iter()
                    .position(|a| a.id == *id && a.visible_to(actor.id))
                    .ok_or_else(|| bad("No such annotation in this room"))?;
                sqlx::query("DELETE FROM dc_annotations WHERE id = $1")
                    .bind(id)
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| db_refusal("removing an annotation", e))?;
                let gone = state.annotations.remove(idx);
                let what = match gone.payload {
                    AnnotationPayload::Note(n) => n.text,
                    AnnotationPayload::View(v) => v.name,
                };
                audits.push(("dc.annotation.delete".into(), label(&what), String::new()));
            }
            Op::AnnotationUpdate { id, annotation } => {
                check_annotation(annotation)?;
                let idx = state
                    .annotations
                    .iter()
                    .position(|a| a.id == *id && a.visible_to(actor.id))
                    .ok_or_else(|| bad("No such annotation in this room"))?;
                let same_kind = matches!(
                    (&state.annotations[idx].payload, annotation),
                    (AnnotationPayload::Note(_), AnnotationPayload::Note(_))
                        | (AnnotationPayload::View(_), AnnotationPayload::View(_))
                );
                if !same_kind {
                    return Err(bad("An annotation's kind cannot be changed").into());
                }
                let v = serde_json::to_value(annotation).unwrap_or(Value::Null);
                sqlx::query("UPDATE dc_annotations SET payload = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&v["payload"])
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| db_refusal("updating an annotation", e))?;
                let what = match annotation {
                    AnnotationPayload::Note(n) => n.text.clone(),
                    AnnotationPayload::View(v) => v.name.clone(),
                };
                audits.push(("dc.annotation.update".into(), label(&what), String::new()));
                state.annotations[idx].payload = annotation.clone();
            }
            Op::RoomSettings { settings } => {
                check_settings(settings)?;
                sqlx::query("UPDATE dc_rooms SET settings = $2 WHERE id = $1")
                    .bind(room_id)
                    .bind(Json(settings))
                    .execute(&mut **conn)
                    .await
                    .map_err(|e| internal("saving a room's settings", e))?;
                audits.push((
                    "dc.room.settings".into(),
                    room.name.clone(),
                    settings_line(settings),
                ));
                new_settings = Some(settings.clone());
            }
        }
        created.push(new_id);
    }
    if let Some(s) = new_settings {
        room.settings = s;
    }

    // The room as it now stands.
    let analysis = analyse(&room, &items, &state)?;
    if let Some(p) = analysis
        .problems
        .iter()
        .find(|p| touched.contains(&p.object_id))
    {
        let name = state
            .objects
            .iter()
            .find(|o| o.id == p.object_id)
            .map(|o| o.name.as_str())
            .unwrap_or("");
        return Err(placement_error(name, &p.problem).into());
    }
    let moved_shelves: HashSet<i64> = touched
        .iter()
        .copied()
        .filter(|id| object_kind(&items, &state, *id) == Some(Kind::Shelf))
        .collect();
    if let Some(n) = refused_cell(
        &blocked_before,
        &analysis.blocked_cells,
        &state.cells,
        &set_cells,
        &moved_shelves,
    ) {
        return Err(bad(format!(
            "Cell {n} is under a cooling unit and cannot be used"
        ))
        .into());
    }
    for rack in &state.objects {
        if !rack.contents_known && state.devices.iter().any(|d| d.fields.rack_id == rack.id) {
            return Err(bad(format!(
                "'{}' has devices but its contents are marked as not recorded",
                rack.name
            ))
            .into());
        }
    }

    let revision = room.revision + 1;
    sqlx::query("UPDATE dc_rooms SET revision = $2, updated_at = now() WHERE id = $1")
        .bind(room_id)
        .bind(revision)
        .execute(&mut **conn)
        .await
        .map_err(|e| internal("advancing a room's revision", e))?;
    let state = store::snapshot(conn, room_id).await?;
    let summary = set
        .summary
        .map(|s| s.trim().chars().take(200).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| summarize(&audits));
    store::write_revision(
        conn,
        room_id,
        revision,
        &state,
        Some((actor.id, &actor.username)),
        &summary,
    )
    .await?;
    for (action, target, details) in &audits {
        audit_tx(
            conn,
            actor,
            Audit {
                action,
                target_type: "dc",
                target_id: None,
                target_name: target,
                details: Some(format!(
                    "revision {revision}{}{details}",
                    if details.is_empty() { "" } else { ": " }
                )),
            },
        )
        .await?;
    }
    Ok(Applied {
        revision,
        created,
        warnings: analysis
            .clearances
            .into_iter()
            .filter(|c| !c.ok())
            .collect(),
    })
}

/// "3 changes: device.create ×2, object.update" when the client gave none.
fn summarize(audits: &[(String, String, String)]) -> String {
    if audits.len() == 1 {
        let (a, t, d) = &audits[0];
        let short = a.trim_start_matches("dc.");
        return if d.is_empty() {
            format!("{short}: {t}")
        } else {
            format!("{short}: {t} — {d}")
        }
        .chars()
        .take(200)
        .collect();
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (a, _, _) in audits {
        *counts.entry(a.trim_start_matches("dc.")).or_default() += 1;
    }
    let parts: Vec<String> = counts
        .iter()
        .map(|(a, n)| {
            if *n > 1 {
                format!("{a} ×{n}")
            } else {
                (*a).to_string()
            }
        })
        .collect();
    format!("{} changes: {}", audits.len(), parts.join(", "))
}

pub fn placement_error(name: &str, p: &Problem) -> ApiError {
    match p {
        Problem::OutsideRoom => bad(format!("'{name}' does not fit inside the room")),
        Problem::AboveCeiling => bad(format!("'{name}' is higher than the room")),
        Problem::Overlaps { other } => bad(format!("'{name}' overlaps '{other}'")),
        Problem::BlocksDoor { door } => bad(format!("'{name}' is in the way of '{door}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn operations_deserialize_from_the_wire() {
        let ops: Vec<Op> = serde_json::from_value(json!([
            {"op": "object_update", "id": 3, "object": {"catalog_id": 1, "name": "r", "x0_mm": 10, "z0_mm": 20}},
            {"op": "device_delete", "id": 9},
            {"op": "cell_set", "cell": {"shelf_id": 5, "cell_no": 15, "name": "tower"}},
            {"op": "annotation_create", "annotation": {"kind": "note", "payload": {"position": [1, 2, 3], "text": "hi"}}}
        ]))
        .unwrap();
        assert_eq!(ops.len(), 4);
        assert!(
            matches!(&ops[0], Op::ObjectUpdate { id: 3, object } if object.instance == json!({}))
        );
        assert!(serde_json::from_value::<Op>(json!({"op": "object_delete"})).is_err());
        assert!(serde_json::from_value::<Op>(json!({"op": "room_delete", "id": 1})).is_err());
    }

    #[test]
    fn summaries_name_what_happened() {
        let one = vec![(
            "dc.device.create".to_string(),
            "Серверная / Стойка 2".to_string(),
            "X (U10, front)".to_string(),
        )];
        assert_eq!(
            summarize(&one),
            "device.create: Серверная / Стойка 2 — X (U10, front)"
        );
        let many = vec![
            ("dc.device.create".to_string(), String::new(), String::new()),
            ("dc.device.create".to_string(), String::new(), String::new()),
            ("dc.object.update".to_string(), String::new(), String::new()),
        ];
        assert_eq!(
            summarize(&many),
            "3 changes: device.create ×2, object.update"
        );
    }

    fn solid(name: &str, kind: Kind, rect: geometry::Rect, y0: i32, y1: i32) -> Solid {
        Solid {
            id: if kind == Kind::Shelf { 1 } else { 2 },
            name: name.into(),
            kind,
            rect,
            y0,
            y1,
            rotation_deg: if kind == Kind::Shelf { 180 } else { 0 },
            swing: None,
        }
    }

    fn cell(n: i32) -> ShelfCell {
        ShelfCell {
            shelf_id: 1,
            cell_no: n,
            name: format!("tower {n}"),
            owner: String::new(),
            power_w: None,
            note: String::new(),
        }
    }

    /// The seed's shelf against the z = 0 wall and an air conditioner over
    /// its left end (the geometry tests' shelf).
    fn shelf_and_unit(unit_x0: i32) -> (Solid, ShelfProps, Solid) {
        let shelf = solid(
            "shelf",
            Kind::Shelf,
            geometry::Rect::new(200, 0, 4730, 910),
            0,
            1795,
        );
        let p = ShelfProps {
            boards_mm: vec![100, 948, 1795],
            cells_per_board: 14,
            sections: vec![5, 9],
            plated_boards: 2,
            finish: None,
        };
        let unit = solid(
            "Кондиционер 2",
            Kind::Cooling,
            geometry::Rect::new(unit_x0, 30, unit_x0 + 1145, 680),
            1935,
            2315,
        );
        (shelf, p, unit)
    }

    #[test]
    fn a_cooling_unit_moved_over_occupied_cells_is_a_warning() {
        // Cells 11 and 12 hold equipment; the unit starts clear of them and is
        // moved over them. Nothing in the change set placed a cell, so it is
        // accepted, and the unit carries the warning.
        let (shelf, p, away) = shelf_and_unit(300);
        let (_, _, over) = shelf_and_unit(3300);
        let cells = vec![cell(11), cell(12)];
        let blocked = |u: &Solid| BTreeMap::from([(1, geometry::blocked_cells(&shelf, &p, &[u]))]);
        let (before, after) = (blocked(&away), blocked(&over));
        assert!(after[&1].contains(&11) && after[&1].contains(&12));
        assert_eq!(
            refused_cell(&before, &after, &cells, &HashSet::new(), &HashSet::new()),
            None
        );
        let warn = cooling_over_cells(&[(&shelf, &p)], &[&over], &cells);
        assert_eq!(
            warn,
            vec![CoolingOverCells {
                object_id: 2,
                object: "Кондиционер 2".into(),
                shelf_id: 1,
                cells: vec![11, 12],
            }]
        );
        assert!(cooling_over_cells(&[(&shelf, &p)], &[&away], &cells).is_empty());
    }

    #[test]
    fn putting_or_moving_a_cell_under_a_unit_is_refused() {
        let (shelf, p, over) = shelf_and_unit(3300);
        let after = BTreeMap::from([(1, geometry::blocked_cells(&shelf, &p, &[&over]))]);
        let cells = vec![cell(11), cell(12)];
        // A cell set into a blocked place.
        let set = HashSet::from([(1, 12)]);
        assert_eq!(
            refused_cell(&after, &after, &cells, &set, &HashSet::new()),
            Some(12)
        );
        // The shelf moved so that occupied cells come under the unit.
        let moved = HashSet::from([1]);
        assert_eq!(
            refused_cell(&BTreeMap::new(), &after, &cells, &HashSet::new(), &moved),
            Some(11)
        );
        // The shelf moved, but those cells were under the unit already.
        assert_eq!(
            refused_cell(&after, &after, &cells, &HashSet::new(), &moved),
            None
        );
    }

    #[test]
    fn device_checks() {
        let mut d: DeviceFields = serde_json::from_value(json!({
            "rack_id": 1, "u_bottom": 10, "u_height": 2, "face": "front", "kind": "server", "name": "X"
        }))
        .unwrap();
        assert!(check_device(&d).is_ok());
        d.power_src = Some(super::super::model::PowerSrc::Measured);
        assert!(check_device(&d).is_err());
        d.power_w = Some(450);
        assert!(check_device(&d).is_ok());
        d.name = "  ".into();
        assert!(check_device(&d).is_err());
    }
}
