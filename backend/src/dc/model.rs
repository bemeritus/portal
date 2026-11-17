//! The DC module's types: catalog kinds with their typed properties, objects,
//! devices, shelf cells, annotations, room settings and measurements.
//!
//! These are the API's contract; `frontend/src/dc/types.ts` mirrors them.
//! Kind-specific properties live in JSONB columns but never as free-form
//! JSON: every write goes through [`CatalogProps::from_parts`] or
//! [`Instance::parse`], which deserialize into one struct per kind with
//! `deny_unknown_fields`, and [`validate`](CatalogProps::validate) the values.
//!
//! Lengths are `i32` millimetres, powers `i32` watts, airflows `i32` m³/h.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// --- Small helpers -----------------------------------------------------------

/// Parse a snake_case enum from the text a column stores.
pub fn parse_enum<T: DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(Value::String(s.to_string())).ok()
}

/// The text a snake_case enum is stored as.
pub fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        _ => String::new(),
    }
}

// --- Catalog kinds -----------------------------------------------------------

/// Every kind the schema knows (§4.2). Phase 1 types the first five; the rest
/// exist so the column's CHECK and this enum agree, and are refused on write
/// until their phase defines their properties.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Rack,
    Shelf,
    Cooling,
    CableTray,
    Structure,
    Ups,
    Pdu,
    Panel,
    RaisedFloor,
    Sensor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoorType {
    Glass,
    Perforated,
    Solid,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CableEntry {
    Top,
    Bottom,
    Both,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RackProps {
    /// Usable units, U1 at the bottom.
    pub units: i32,
    /// Height of the bottom edge of U1 above the floor.
    pub u1_height_mm: i32,
    /// `None` = not recorded for this rack type (objects may say).
    pub door_front: Option<DoorType>,
    pub door_rear: Option<DoorType>,
    pub max_static_load_kg: Option<i32>,
    pub cable_entry: Option<CableEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelfProps {
    /// Height of each board's top surface above the floor, bottom board first.
    pub boards_mm: Vec<i32>,
    pub cells_per_board: i32,
    /// Cells per section, left to right; dividers stand between sections.
    pub sections: Vec<i32>,
    /// Boards with number plates, counted from the top. Cells are numbered
    /// from the top board down; cells on unplated boards have no plate.
    pub plated_boards: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoolingSubtype {
    SplitWall,
    SplitCassette,
    SplitFloorCeiling,
    Ducted,
    InRow,
    PrecisionPerimeter,
}

impl CoolingSubtype {
    /// Precision units are built for IT load; comfort units are not (§12.3).
    #[cfg(test)]
    pub fn is_precision(self) -> bool {
        matches!(
            self,
            CoolingSubtype::InRow | CoolingSubtype::PrecisionPerimeter
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Discharge {
    Upflow,
    Downflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningRole {
    Supply,
    Return,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitFace {
    Front,
    Rear,
    Top,
    Bottom,
    Left,
    Right,
}

/// A supply or return opening on the unit, relative to the unit. Empty in the
/// catalog means "the subtype's default" (renderers and, later, the airflow
/// model share those defaults).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub role: OpeningRole,
    pub face: UnitFace,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EspPa {
    pub rated: i32,
    pub min: Option<i32>,
    pub max: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeratingPoint {
    pub outdoor_c: i32,
    pub capacity_w: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoolingProps {
    pub subtype: CoolingSubtype,
    /// False for a placeholder such as «Сплит, модель не указана»: the body
    /// was measured but nobody knows the model, so capacities are `None`.
    pub model_known: bool,
    pub inverter: Option<bool>,
    pub designed_24_7: Option<bool>,
    /// Rated total cooling at `rating_conditions`.
    pub cooling_total_w: Option<i32>,
    /// The part that lowers air temperature; `None` when the datasheet does
    /// not publish it (§12.2).
    pub cooling_sensible_w: Option<i32>,
    pub rating_conditions: Option<String>,
    pub cooling_range_w: Option<[i32; 2]>,
    /// Fan steps, highest first.
    pub airflow_m3h: Vec<i32>,
    pub power_input_w: Option<i32>,
    pub eer: Option<f64>,
    pub esp_pa: Option<EspPa>,
    pub weight_kg: Option<f64>,
    pub refrigerant: Option<String>,
    pub power_supply: Option<String>,
    pub capacity_modulation: Option<String>,
    #[serde(default)]
    pub discharge_options: Vec<Discharge>,
    pub airflow_pattern: Option<String>,
    #[serde(default)]
    pub openings: Vec<Opening>,
    #[serde(default)]
    pub derating: Vec<DeratingPoint>,
    pub source_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructureSubtype {
    Wall,
    Column,
    Door,
    Window,
    Safe,
    /// A metal locker / cabinet standing on the floor.
    Locker,
    Furniture,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructureProps {
    pub subtype: StructureSubtype,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayType {
    Tray,
    Ladder,
    Basket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayPurpose {
    Power,
    Data,
}

/// A cable tray type. Its width is the item's `depth_mm` (across the run) and
/// its side height the item's `height_mm`; the run length is per object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CableTrayProps {
    pub tray_type: TrayType,
    pub max_fill_pct: Option<i32>,
    pub purpose: Option<TrayPurpose>,
}

/// The typed properties of a catalog item, tagged by kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "props", rename_all = "snake_case")]
pub enum CatalogProps {
    Rack(RackProps),
    Shelf(ShelfProps),
    Cooling(Box<CoolingProps>),
    CableTray(CableTrayProps),
    Structure(StructureProps),
}

impl CatalogProps {
    pub fn kind(&self) -> Kind {
        match self {
            CatalogProps::Rack(_) => Kind::Rack,
            CatalogProps::Shelf(_) => Kind::Shelf,
            CatalogProps::Cooling(_) => Kind::Cooling,
            CatalogProps::CableTray(_) => Kind::CableTray,
            CatalogProps::Structure(_) => Kind::Structure,
        }
    }

    /// Rebuild from the `kind` and `props` columns, rejecting anything that is
    /// not exactly the kind's struct.
    pub fn from_parts(kind: &str, props: Value) -> Result<CatalogProps, String> {
        let tagged = serde_json::json!({ "kind": kind, "props": props });
        serde_json::from_value(tagged).map_err(|e| e.to_string())
    }

    /// The `props` column's value.
    pub fn props_value(&self) -> Value {
        match serde_json::to_value(self) {
            Ok(Value::Object(mut m)) => m.remove("props").unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }

    /// Value checks serde cannot express.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            CatalogProps::Rack(r) => {
                if !(1..=60).contains(&r.units) {
                    return Err("rack units must be between 1 and 60".into());
                }
                if r.u1_height_mm < 0 {
                    return Err("U1 height must not be negative".into());
                }
            }
            CatalogProps::Shelf(s) => {
                if s.boards_mm.is_empty() || s.cells_per_board < 1 {
                    return Err("a shelf needs boards and cells".into());
                }
                if s.sections.iter().sum::<i32>() != s.cells_per_board {
                    return Err("shelf sections must add up to the cells per board".into());
                }
                if s.boards_mm.windows(2).any(|w| w[0] >= w[1]) {
                    return Err("shelf boards must be listed bottom to top".into());
                }
                if !(0..=s.boards_mm.len() as i32).contains(&s.plated_boards) {
                    return Err("plated boards out of range".into());
                }
            }
            CatalogProps::Cooling(c) => {
                let non_negative = [c.cooling_total_w, c.cooling_sensible_w, c.power_input_w];
                if non_negative.iter().flatten().any(|&v| v < 0)
                    || c.airflow_m3h.iter().any(|&v| v <= 0)
                {
                    return Err("cooling capacities and airflows must be positive".into());
                }
                if !c.model_known && (c.cooling_total_w.is_some() || c.cooling_sensible_w.is_some())
                {
                    return Err("a unit of unknown model has no capacity".into());
                }
            }
            CatalogProps::CableTray(_) | CatalogProps::Structure(_) => {}
        }
        Ok(())
    }
}

/// Where a catalog property's value came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropSrc {
    Datasheet,
    Measured,
    Derived,
    Assumed,
    /// Seen on the site photos.
    Photo,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PropSource {
    pub src: PropSrc,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A catalog item as the API sends it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CatalogItem {
    pub id: i64,
    pub manufacturer: String,
    pub model: String,
    pub width_mm: i32,
    pub depth_mm: i32,
    pub height_mm: i32,
    #[serde(flatten)]
    pub props: CatalogProps,
    /// Keyed by property name, or `"dims"` for the three dimensions.
    pub props_src: BTreeMap<String, PropSource>,
    pub archived: bool,
}

impl CatalogItem {
    pub fn kind(&self) -> Kind {
        self.props.kind()
    }
}

// --- Per-object overrides ----------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hinge {
    /// At the end of the opening with the smaller coordinate along the wall.
    Low,
    High,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RackInstance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub door_front: Option<DoorType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub door_rear: Option<DoorType>,
    /// An open frame: no side panels (rack 1 on the photos).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_frame: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct CoolingInstance {
    /// Only for a unit of unknown model, whose bodies were measured one by one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_mm: Option<i32>,
    /// Perimeter units: upflow or downflow, chosen per object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discharge: Option<Discharge>,
    /// Supply outlets with their direction (§14.1). Empty = the subtype's
    /// default openings apply. Edited by hand from phase 2.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub supply_outlets: Vec<SupplyOutlet>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutletSource {
    /// Set by hand (deflectors).
    Manual,
    /// From the catalog or the subtype's default; not measured.
    CatalogDefault,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Xyz {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wh {
    pub w: i32,
    pub h: i32,
}

/// One supply outlet of a cooling unit, aimed by hand (§14.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplyOutlet {
    pub id: String,
    pub label: String,
    /// Centre of the outlet relative to the unit (local frame, mm).
    pub pos_mm: Xyz,
    pub size_mm: Wh,
    /// 0…90: degrees below horizontal.
    pub pitch_deg: i32,
    /// −60…+60: left/right of the supply normal, negative = left as seen
    /// from behind the unit.
    pub yaw_deg: i32,
    pub source: OutletSource,
}

impl SupplyOutlet {
    pub fn validate(&self) -> Result<(), String> {
        if !(0..=90).contains(&self.pitch_deg) {
            return Err("outlet pitch must be 0…90°".into());
        }
        if !(-60..=60).contains(&self.yaw_deg) {
            return Err("outlet yaw must be −60…+60°".into());
        }
        if self.size_mm.w <= 0 || self.size_mm.h <= 0 {
            return Err("outlet size must be positive".into());
        }
        if self.id.trim().is_empty() {
            return Err("an outlet needs an id".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct StructureInstance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_mm: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_mm: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height_mm: Option<i32>,
    /// Doors: which end of the opening the hinge is at. Doors swing inward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hinge: Option<Hinge>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct CableTrayInstance {
    /// Run length along the object's local x.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_mm: Option<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelfInstance {}

/// An object's `instance` column, typed by the kind of its catalog item.
#[derive(Clone, Debug, PartialEq)]
pub enum Instance {
    Rack(RackInstance),
    Shelf(ShelfInstance),
    Cooling(CoolingInstance),
    CableTray(CableTrayInstance),
    Structure(StructureInstance),
}

impl Instance {
    pub fn parse(item: &CatalogProps, value: &Value) -> Result<Instance, String> {
        fn de<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
            serde_json::from_value(v.clone()).map_err(|e| e.to_string())
        }
        let inst = match item {
            CatalogProps::Rack(_) => Instance::Rack(de(value)?),
            CatalogProps::Shelf(_) => Instance::Shelf(de(value)?),
            CatalogProps::Cooling(c) => {
                let i: CoolingInstance = de(value)?;
                if i.width_mm.is_some() && c.model_known {
                    return Err("only a unit of unknown model can override its width".into());
                }
                if let Some(d) = i.discharge
                    && !c.discharge_options.contains(&d)
                {
                    return Err("that discharge is not offered by this unit".into());
                }
                for o in &i.supply_outlets {
                    o.validate()?;
                }
                let mut ids: Vec<&str> = i.supply_outlets.iter().map(|o| o.id.as_str()).collect();
                ids.sort_unstable();
                if ids.windows(2).any(|w| w[0] == w[1]) {
                    return Err("outlet ids must be unique".into());
                }
                Instance::Cooling(i)
            }
            CatalogProps::CableTray(_) => Instance::CableTray(de(value)?),
            CatalogProps::Structure(_) => Instance::Structure(de(value)?),
        };
        for v in inst.lengths().into_iter().flatten() {
            if v <= 0 {
                return Err("overridden sizes must be positive".into());
            }
        }
        Ok(inst)
    }

    fn lengths(&self) -> Vec<Option<i32>> {
        match self {
            Instance::Cooling(c) => vec![c.width_mm],
            Instance::CableTray(t) => vec![t.length_mm],
            Instance::Structure(s) => vec![s.width_mm, s.depth_mm, s.height_mm],
            _ => vec![],
        }
    }

    pub fn to_value(&self) -> Value {
        let v = match self {
            Instance::Rack(i) => serde_json::to_value(i),
            Instance::Shelf(i) => serde_json::to_value(i),
            Instance::Cooling(i) => serde_json::to_value(i),
            Instance::CableTray(i) => serde_json::to_value(i),
            Instance::Structure(i) => serde_json::to_value(i),
        };
        v.unwrap_or(Value::Object(Default::default()))
    }
}

// --- Rooms ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSet {
    /// Правила устройства электроустановок.
    Pue,
    Iec60364,
}

/// Per-room settings (§4.4, §12). Phase 1 reads them; editing is phase 2.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RoomSettings {
    /// Free space that must stay in front of a rack's front face.
    pub clearance_front_mm: i32,
    /// … and behind its rear face.
    pub clearance_rear_mm: i32,
    /// Per-rack power budget. `None` = not set: power views then compare racks
    /// with each other and say that no budget is set.
    pub rack_power_budget_w: Option<i32>,
    pub electrical_rule_set: RuleSet,
}

impl Default for RoomSettings {
    fn default() -> Self {
        RoomSettings {
            clearance_front_mm: 1000,
            clearance_rear_mm: 600,
            rack_power_budget_w: None,
            electrical_rule_set: RuleSet::Pue,
        }
    }
}

/// How a measured number was obtained (§3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasSrc {
    Measured,
    Range,
    Derived,
    Assumed,
    /// Seen on the site photos: presence certain, size and position estimates.
    Photo,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Measurement {
    /// Stable id; the UI translates it (`dc.measureKey.<key>`), falling back
    /// to the key itself.
    pub key: String,
    /// The value as obtained (`src`): the tape reading, the midpoint of two
    /// readings, a derived or an assumed value. Never replaced by the model.
    pub value: i32,
    /// Two readings that disagreed: both are kept and both are shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i32>,
    pub src: MeasSrc,
    /// The same distance in the model, where it is a distance in the model.
    /// A difference above [`TAPE_TOLERANCE_MM`] is shown, never hidden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<i32>,
    /// Where the dimension is drawn: two points in room coordinates (mm).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<[[i32; 3]; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Names of the objects this number positions or sizes — what the 3D
    /// view marks when the number is assumed.
    #[serde(default)]
    pub objects: Vec<String>,
}

/// Model and tape may differ by this much before the dimension is marked.
pub const TAPE_TOLERANCE_MM: i32 = 5;

impl Measurement {
    /// Does the model disagree with what was read by more than the tolerance?
    /// For two readings, the model must be within the tolerance of their span.
    pub fn disagrees(&self) -> bool {
        let Some(model) = self.model else {
            return false;
        };
        let (lo, hi) = (
            self.min.unwrap_or(self.value),
            self.max.unwrap_or(self.value),
        );
        model < lo - TAPE_TOLERANCE_MM || model > hi + TAPE_TOLERANCE_MM
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RoomMeasurements {
    pub entries: Vec<Measurement>,
    /// What to re-measure, as written by whoever measured.
    pub remeasure: Vec<String>,
    /// What the model does not contain or only guesses.
    pub not_modelled: Vec<String>,
    /// Conflicts between readings, as written.
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Room {
    pub id: i64,
    pub name: String,
    /// `[x, z]` vertices in mm, counter-clockwise.
    pub floor_plan: Vec<[i32; 2]>,
    pub height_mm: i32,
    pub measurements: RoomMeasurements,
    pub settings: RoomSettings,
    pub revision: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomSummary {
    pub id: i64,
    pub name: String,
    pub revision: i32,
    pub updated_at: DateTime<Utc>,
    pub rack_count: i64,
    pub device_count: i64,
}

// --- Things in a room ----------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DcObject {
    pub id: i64,
    pub catalog_id: i64,
    pub name: String,
    pub x0_mm: i32,
    pub z0_mm: i32,
    pub y0_mm: i32,
    pub rotation_deg: i32,
    /// Typed by the catalog item's kind ([`Instance`]); sent as stored.
    pub instance: Value,
    pub contents_known: bool,
    pub note: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Server,
    Storage,
    Switch,
    Router,
    Patch,
    Ups,
    Pdu,
    Kvm,
    Blank,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Face {
    Front,
    Rear,
    Both,
}

impl Face {
    /// Would two devices on these faces compete for the same unit?
    pub fn conflicts(self, other: Face) -> bool {
        self == Face::Both || other == Face::Both || self == other
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerSrc {
    Nameplate,
    Measured,
    Estimated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Active,
    Reserved,
    Planned,
    Decommissioning,
}

/// The editable fields of a device; [`Device`] adds the id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceFields {
    pub rack_id: i64,
    pub u_bottom: i32,
    pub u_height: i32,
    pub face: Face,
    #[serde(default)]
    pub depth_mm: Option<i32>,
    pub kind: DeviceKind,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub serial: String,
    /// `None` = unknown. Never 0 for unknown.
    #[serde(default)]
    pub power_w: Option<i32>,
    #[serde(default)]
    pub power_src: Option<PowerSrc>,
    #[serde(default = "active")]
    pub status: DeviceStatus,
    #[serde(default)]
    pub note: String,
}

fn active() -> DeviceStatus {
    DeviceStatus::Active
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub id: i64,
    #[serde(flatten)]
    pub fields: DeviceFields,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelfCell {
    pub shelf_id: i64,
    pub cell_no: i32,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub power_w: Option<i32>,
    #[serde(default)]
    pub note: String,
}

/// A note pinned at a point, or a saved camera view. Positions in mm.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum AnnotationPayload {
    Note(NotePayload),
    View(ViewPayload),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotePayload {
    pub position: [i32; 3],
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewPayload {
    pub name: String,
    pub position: [i32; 3],
    pub target: [i32; 3],
    /// Vertical field of view in degrees (perspective).
    pub fov: i32,
    pub ortho: bool,
    /// The display mode the view was saved in (§11.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ViewMode>,
    /// The owner highlighted when it was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// The selection, as its deep link (`obj-12`, `device-7`, `cell-5-16`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Shared with everyone who can see the room, or personal.
    #[serde(default = "yes")]
    pub shared: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewMode {
    Schema,
    Realistic,
    Fill,
    Power,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: i64,
    #[serde(flatten)]
    pub payload: AnnotationPayload,
    #[serde(default)]
    pub author_id: Option<uuid::Uuid>,
    pub author_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl Annotation {
    /// Can `user` see it? Personal views are their author's only.
    pub fn visible_to(&self, user: uuid::Uuid) -> bool {
        match &self.payload {
            AnnotationPayload::View(v) if !v.shared => self.author_id == Some(user),
            _ => true,
        }
    }
}

impl Snapshot {
    /// The snapshot as `user` may see it.
    pub fn for_user(mut self, user: uuid::Uuid) -> Snapshot {
        self.annotations.retain(|a| a.visible_to(user));
        self
    }
}

/// Everything in a room that a change set can touch, frozen into a revision.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub objects: Vec<DcObject>,
    pub devices: Vec<Device>,
    pub cells: Vec<ShelfCell>,
    pub annotations: Vec<Annotation>,
}

/// `GET /api/dc/rooms/{id}`: the room and everything needed to draw it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomView {
    pub room: Room,
    /// The catalog items the room's objects use.
    pub catalog: Vec<CatalogItem>,
    #[serde(flatten)]
    pub contents: Snapshot,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rack_props() -> Value {
        json!({"units": 42, "u1_height_mm": 100, "door_front": null, "door_rear": null,
               "max_static_load_kg": null, "cable_entry": null})
    }

    #[test]
    fn props_round_trip_through_the_columns() {
        let p = CatalogProps::from_parts("rack", rack_props()).unwrap();
        assert_eq!(p.kind(), Kind::Rack);
        assert_eq!(p.props_value(), rack_props());
    }

    #[test]
    fn unknown_fields_and_kinds_are_refused() {
        let mut extra = rack_props();
        extra["colour"] = json!("red");
        assert!(CatalogProps::from_parts("rack", extra).is_err());
        assert!(CatalogProps::from_parts("ups", json!({})).is_err());
        assert!(CatalogProps::from_parts("rack", json!({"units": "42"})).is_err());
    }

    #[test]
    fn catalog_item_serializes_kind_and_props_side_by_side() {
        let item = CatalogItem {
            id: 1,
            manufacturer: String::new(),
            model: "R".into(),
            width_mm: 600,
            depth_mm: 1000,
            height_mm: 2040,
            props: CatalogProps::from_parts("rack", rack_props()).unwrap(),
            props_src: BTreeMap::new(),
            archived: false,
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["kind"], "rack");
        assert_eq!(v["props"]["units"], 42);
        let back: CatalogItem = serde_json::from_value(v).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn instance_is_typed_by_kind() {
        let rack = CatalogProps::from_parts("rack", rack_props()).unwrap();
        assert!(Instance::parse(&rack, &json!({"door_front": "glass"})).is_ok());
        assert!(Instance::parse(&rack, &json!({"length_mm": 5})).is_err());
        assert!(Instance::parse(&rack, &json!({"door_front": "wood"})).is_err());
    }

    #[test]
    fn only_unknown_models_override_width() {
        let base = json!({"subtype": "split_wall", "model_known": true, "inverter": null,
            "designed_24_7": null, "cooling_total_w": null, "cooling_sensible_w": null,
            "rating_conditions": null, "cooling_range_w": null, "airflow_m3h": [],
            "power_input_w": null, "eer": null, "esp_pa": null, "weight_kg": null,
            "refrigerant": null, "power_supply": null, "capacity_modulation": null,
            "airflow_pattern": null, "source_url": null});
        let known = CatalogProps::from_parts("cooling", base.clone()).unwrap();
        assert!(Instance::parse(&known, &json!({"width_mm": 1250})).is_err());
        let mut unknown = base;
        unknown["model_known"] = json!(false);
        let unknown = CatalogProps::from_parts("cooling", unknown).unwrap();
        assert!(Instance::parse(&unknown, &json!({"width_mm": 1250})).is_ok());
        assert!(Instance::parse(&unknown, &json!({"width_mm": 0})).is_err());
    }

    #[test]
    fn supply_outlets_are_typed_and_checked() {
        let base = json!({"subtype": "ducted", "model_known": false, "inverter": null,
            "designed_24_7": null, "cooling_total_w": null, "cooling_sensible_w": null,
            "rating_conditions": null, "cooling_range_w": null, "airflow_m3h": [],
            "power_input_w": null, "eer": null, "esp_pa": null, "weight_kg": null,
            "refrigerant": null, "power_supply": null, "capacity_modulation": null,
            "airflow_pattern": null, "source_url": null});
        let item = CatalogProps::from_parts("cooling", base).unwrap();
        let outlet = |pitch: i32, yaw: i32| {
            json!({"supply_outlets": [{"id": "s1", "label": "1",
            "pos_mm": {"x": 0, "y": 190, "z": -325}, "size_mm": {"w": 800, "h": 200},
            "pitch_deg": pitch, "yaw_deg": yaw, "source": "manual"}]})
        };
        assert!(Instance::parse(&item, &outlet(30, -20)).is_ok());
        assert!(Instance::parse(&item, &outlet(95, 0)).is_err());
        assert!(Instance::parse(&item, &outlet(10, 61)).is_err());
        let mut extra = outlet(0, 0);
        extra["supply_outlets"][0]["speed"] = json!(3);
        assert!(Instance::parse(&item, &extra).is_err());
    }

    #[test]
    fn a_tape_reading_outside_the_tolerance_is_flagged() {
        let m = |value, min, max, model| Measurement {
            key: "k".into(),
            value,
            min,
            max,
            src: MeasSrc::Measured,
            model,
            line: None,
            note: None,
            objects: vec![],
        };
        assert!(m(610, None, None, Some(595)).disagrees());
        assert!(!m(635, None, None, Some(630)).disagrees());
        assert!(m(1498, Some(1495), Some(1500), Some(1510)).disagrees());
        assert!(!m(600, Some(600), Some(605), Some(600)).disagrees());
        assert!(!m(600, None, None, None).disagrees());
    }

    #[test]
    fn personal_views_are_their_authors_only() {
        let (me, other) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let view = |shared: bool| Annotation {
            id: 1,
            payload: serde_json::from_value(json!({"kind": "view", "payload": {
                "name": "v", "position": [0, 0, 0], "target": [1, 1, 1], "fov": 45,
                "ortho": false, "mode": "fill", "owner": "Клиент X", "shared": shared}}))
            .unwrap(),
            author_id: Some(me),
            author_name: None,
            created_at: chrono::Utc::now(),
        };
        assert!(view(false).visible_to(me));
        assert!(!view(false).visible_to(other));
        assert!(view(true).visible_to(other));
        // Older views without the field are shared.
        let old: AnnotationPayload = serde_json::from_value(json!({"kind": "view", "payload": {
            "name": "v", "position": [0, 0, 0], "target": [1, 1, 1], "fov": 45, "ortho": false}}))
        .unwrap();
        assert!(matches!(old, AnnotationPayload::View(v) if v.shared && v.mode.is_none()));
    }

    #[test]
    fn shelf_sections_must_cover_the_board() {
        let s = |sections: Vec<i32>| {
            CatalogProps::Shelf(ShelfProps {
                boards_mm: vec![100, 948, 1795],
                cells_per_board: 14,
                sections,
                plated_boards: 2,
            })
            .validate()
        };
        assert!(s(vec![5, 9]).is_ok());
        assert!(s(vec![5, 8]).is_err());
    }

    #[test]
    fn faces_conflict_as_the_database_says() {
        assert!(Face::Front.conflicts(Face::Front));
        assert!(!Face::Front.conflicts(Face::Rear));
        assert!(Face::Both.conflicts(Face::Rear));
        assert!(Face::Front.conflicts(Face::Both));
    }

    #[test]
    fn enums_round_trip_as_column_text() {
        assert_eq!(enum_str(&DeviceKind::Kvm), "kvm");
        assert_eq!(parse_enum::<DeviceKind>("kvm"), Some(DeviceKind::Kvm));
        assert_eq!(parse_enum::<DeviceKind>("toaster"), None);
        assert_eq!(enum_str(&CoolingSubtype::InRow), "in_row");
    }
}
