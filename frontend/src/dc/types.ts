/**
 * The DC module's wire types — a hand mirror of `backend/src/dc/model.rs`
 * (and of the response shapes in `routes/dc.rs`). Lengths are integer
 * millimetres, powers integer watts.
 */

export type Kind = "rack" | "shelf" | "cooling" | "cable_tray" | "structure";
export type DoorType = "glass" | "perforated" | "solid" | "none";
export type CableEntry = "top" | "bottom" | "both";
export type CoolingSubtype =
  | "split_wall"
  | "split_cassette"
  | "split_floor_ceiling"
  | "ducted"
  | "in_row"
  | "precision_perimeter";
export type Discharge = "upflow" | "downflow";
export type StructureSubtype = "wall" | "column" | "door" | "window" | "safe" | "locker" | "furniture" | "other";
export type TrayType = "tray" | "ladder" | "basket";

export interface RackProps {
  units: number;
  u1_height_mm: number;
  door_front: DoorType | null;
  door_rear: DoorType | null;
  max_static_load_kg: number | null;
  cable_entry: CableEntry | null;
}

export interface ShelfProps {
  /** Board heights above the floor, bottom board first. */
  boards_mm: number[];
  cells_per_board: number;
  sections: number[];
  /** Boards with number plates, counted from the top. */
  plated_boards: number;
}

export interface CoolingProps {
  subtype: CoolingSubtype;
  model_known: boolean;
  inverter: boolean | null;
  designed_24_7: boolean | null;
  cooling_total_w: number | null;
  cooling_sensible_w: number | null;
  rating_conditions: string | null;
  cooling_range_w: [number, number] | null;
  airflow_m3h: number[];
  power_input_w: number | null;
  eer: number | null;
  esp_pa: { rated: number; min: number | null; max: number | null } | null;
  weight_kg: number | null;
  refrigerant: string | null;
  power_supply: string | null;
  capacity_modulation: string | null;
  discharge_options: Discharge[];
  airflow_pattern: string | null;
  openings: { role: "supply" | "return"; face: string }[];
  derating: { outdoor_c: number; capacity_w: number }[];
  source_url: string | null;
}

export interface CableTrayProps {
  tray_type: TrayType;
  max_fill_pct: number | null;
  purpose: "power" | "data" | null;
}

export interface StructureProps {
  subtype: StructureSubtype;
}

export type PropSrc = "datasheet" | "measured" | "derived" | "assumed" | "photo";
export interface PropSource {
  src: PropSrc;
  url?: string;
  note?: string;
}

interface ItemBase {
  id: number;
  manufacturer: string;
  model: string;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  /** Keyed by property name, or `dims`. */
  props_src: Record<string, PropSource>;
  archived: boolean;
}

export type CatalogItem =
  | (ItemBase & { kind: "rack"; props: RackProps })
  | (ItemBase & { kind: "shelf"; props: ShelfProps })
  | (ItemBase & { kind: "cooling"; props: CoolingProps })
  | (ItemBase & { kind: "cable_tray"; props: CableTrayProps })
  | (ItemBase & { kind: "structure"; props: StructureProps });

/** Per-object overrides, by kind (all optional). */
export interface Instance {
  door_front?: DoorType;
  door_rear?: DoorType;
  width_mm?: number;
  depth_mm?: number;
  height_mm?: number;
  length_mm?: number;
  discharge?: Discharge;
  hinge?: "low" | "high";
  /** Racks: an open frame, no side panels. */
  open_frame?: boolean;
  /** Cooling: supply outlets aimed by hand (§14.1); empty = subtype default. */
  supply_outlets?: SupplyOutlet[];
}

export interface SupplyOutlet {
  id: string;
  label: string;
  pos_mm: { x: number; y: number; z: number };
  size_mm: { w: number; h: number };
  /** 0…90 degrees below horizontal. */
  pitch_deg: number;
  /** −60…+60, negative = left as seen from behind the unit. */
  yaw_deg: number;
  source: "manual" | "catalog_default";
}

export interface DcObject {
  id: number;
  catalog_id: number;
  name: string;
  x0_mm: number;
  z0_mm: number;
  y0_mm: number;
  rotation_deg: 0 | 90 | 180 | 270;
  instance: Instance;
  contents_known: boolean;
  note: string;
}

export type DeviceKind =
  | "server"
  | "storage"
  | "switch"
  | "router"
  | "patch"
  | "ups"
  | "pdu"
  | "kvm"
  | "blank"
  | "other";
export const DEVICE_KINDS: DeviceKind[] = [
  "server",
  "storage",
  "switch",
  "router",
  "patch",
  "ups",
  "pdu",
  "kvm",
  "blank",
  "other",
];
export type Face = "front" | "rear" | "both";
export type PowerSrc = "nameplate" | "measured" | "estimated";
export type DeviceStatus = "active" | "reserved" | "planned" | "decommissioning";
export const DEVICE_STATUSES: DeviceStatus[] = ["active", "reserved", "planned", "decommissioning"];

export interface DeviceFields {
  rack_id: number;
  u_bottom: number;
  u_height: number;
  face: Face;
  depth_mm: number | null;
  kind: DeviceKind;
  name: string;
  owner: string;
  serial: string;
  /** `null` = unknown, never 0. */
  power_w: number | null;
  power_src: PowerSrc | null;
  status: DeviceStatus;
  note: string;
}

export interface Device extends DeviceFields {
  id: number;
}

export interface ShelfCell {
  shelf_id: number;
  cell_no: number;
  name: string;
  owner: string;
  power_w: number | null;
  note: string;
}

export type Vec3mm = [number, number, number];
export type AnnotationPayload =
  | { kind: "note"; payload: { position: Vec3mm; text: string } }
  | {
      kind: "view";
      payload: { name: string; position: Vec3mm; target: Vec3mm; fov: number; ortho: boolean };
    };

export type Annotation = AnnotationPayload & {
  id: number;
  author_name: string | null;
  created_at: string;
};

export type MeasSrc = "measured" | "range" | "derived" | "assumed" | "photo";
export interface Measurement {
  key: string;
  /** As obtained (tape reading, midpoint of two readings, derived, assumed). */
  value: number;
  /** Two readings that disagreed. */
  min?: number;
  max?: number;
  src: MeasSrc;
  /** The same distance in the model. */
  model?: number;
  /** Where the dimension is drawn, room coordinates in mm. */
  line?: [[number, number, number], [number, number, number]];
  note?: string;
  objects: string[];
}

export interface RoomSettings {
  clearance_front_mm: number;
  clearance_rear_mm: number;
  rack_power_budget_w: number | null;
  electrical_rule_set: "pue" | "iec60364";
}

export interface Room {
  id: number;
  name: string;
  floor_plan: [number, number][];
  height_mm: number;
  measurements: {
    entries: Measurement[];
    remeasure: string[];
    not_modelled: string[];
    conflicts: string[];
  };
  settings: RoomSettings;
  revision: number;
  updated_at: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  revision: number;
  updated_at: string;
  rack_count: number;
  device_count: number;
}

export type Problem =
  | { type: "outside_room" }
  | { type: "above_ceiling" }
  | { type: "overlaps"; other: string }
  | { type: "blocks_door"; door: string };

export interface Clearance {
  object_id: number;
  object: string;
  side: "front" | "rear";
  gap_mm: number;
  required_mm: number;
  obstacle: string | null;
}

export interface Analysis {
  problems: ({ object_id: number } & Problem)[];
  clearances: Clearance[];
  /** Shelf object id → blocked cell numbers. */
  blocked_cells: Record<string, number[]>;
}

export interface RoomData {
  room: Room;
  catalog: CatalogItem[];
  objects: DcObject[];
  devices: Device[];
  cells: ShelfCell[];
  annotations: Annotation[];
  analysis: Analysis;
}

// --- Writes ------------------------------------------------------------------

export type ObjectFields = Omit<DcObject, "id">;

export type Op =
  | { op: "object_create"; object: ObjectFields }
  | { op: "object_update"; id: number; object: ObjectFields }
  | { op: "object_delete"; id: number }
  | { op: "device_create"; device: DeviceFields }
  | { op: "device_update"; id: number; device: DeviceFields }
  | { op: "device_delete"; id: number }
  | { op: "cell_set"; cell: ShelfCell }
  | { op: "cell_delete"; shelf_id: number; cell_no: number }
  | { op: "annotation_create"; annotation: AnnotationPayload }
  | { op: "annotation_delete"; id: number };

export interface Applied {
  revision: number;
  created: (number | null)[];
  warnings: Clearance[];
}

export interface RevisionSummary {
  revision: number;
  author_name: string;
  summary: string;
  created_at: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type EntityChange =
  | { change: "added"; key: string; after: Record<string, unknown> }
  | { change: "removed"; key: string; before: Record<string, unknown> }
  | { change: "changed"; key: string; name: string; fields: FieldChange[] };

export interface RevisionDetail extends RevisionSummary {
  snapshot: { objects: DcObject[]; devices: Device[]; cells: ShelfCell[]; annotations: Annotation[] };
  diff: {
    objects: EntityChange[];
    devices: EntityChange[];
    cells: EntityChange[];
    annotations: EntityChange[];
  };
}

export interface CapacityRange {
  from: number;
  to: number;
}

export interface CapacityCandidate {
  rack_id: number;
  rack_name: string;
  suggestion: CapacityRange;
  ranges: CapacityRange[];
  free_units: number;
  used_power_w: number;
  unknown_power: number;
  budget_w: number | null;
  headroom_w: number | null;
  fits_power: boolean | null;
}

export interface CapacityAnswer {
  candidates: CapacityCandidate[];
  not_recorded: string[];
  no_space: string[];
}

export interface SearchHit {
  kind: "object" | "device" | "cell";
  id: number;
  object_id: number;
  object_name: string;
  name: string;
  owner: string;
  serial: string;
  u_bottom: number | null;
  u_height: number | null;
  face: Face | null;
  cell_no: number | null;
}

export interface ImportRowError {
  line: number;
  code: string;
  column?: string;
  value?: string;
}

export type ImportChange =
  | { action: "create"; line: number; rack: string; after: DeviceFields }
  | { action: "update"; line: number; rack: string; id: number; before: DeviceFields; after: DeviceFields }
  | { action: "unchanged"; line: number; rack: string; id: number };

export interface ImportResult {
  dry_run: boolean;
  created: number;
  updated: number;
  unchanged: number;
  plan: { changes: ImportChange[]; errors: ImportRowError[] };
  revision: number;
}
