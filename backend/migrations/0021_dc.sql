-- Server room module (DC), phase 1 — see dc-handoff/SPEC.md §4.
--
-- Everything placed in a room is an object that instantiates a catalog item.
-- Kind-specific properties are JSONB here but typed in Rust (`src/dc/model.rs`,
-- one serde struct per kind, validated on every write); no free-form JSON is
-- written by the API.
--
-- Units: every length is integer millimetres, every power integer watts.
-- Nothing in this migration touches a non-DC table.

-- The device no-overlap rule is an exclusion constraint over integer ranges
-- keyed by rack, which needs `=` on bigint inside a GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Rooms ----------------------------------------------------------------------

CREATE TABLE dc_rooms (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    -- polygon [[x, z], …] in mm, counter-clockwise; phase 1 rooms are rectangles
    floor_plan   JSONB NOT NULL,
    height_mm    INTEGER NOT NULL CHECK (height_mm > 0),
    -- provenance of each measured dimension (room.json shape), typed in Rust
    measurements JSONB NOT NULL,
    -- clearances, budgets, rule set; typed in Rust
    settings     JSONB NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 1,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catalog --------------------------------------------------------------------

CREATE TABLE dc_catalog_items (
    id           BIGSERIAL PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN (
                     'rack', 'shelf', 'cooling', 'ups', 'pdu', 'panel',
                     'raised_floor', 'cable_tray', 'structure', 'sensor')),
    manufacturer TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL,
    width_mm     INTEGER NOT NULL CHECK (width_mm >= 0),
    depth_mm     INTEGER NOT NULL CHECK (depth_mm >= 0),
    height_mm    INTEGER NOT NULL CHECK (height_mm >= 0),
    props        JSONB NOT NULL,
    -- per property: datasheet | measured | assumed, with a URL or a note
    props_src    JSONB NOT NULL DEFAULT '{}',
    archived     BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (kind, manufacturer, model)
);

-- Objects placed in a room ---------------------------------------------------

CREATE TABLE dc_objects (
    id             BIGSERIAL PRIMARY KEY,
    room_id        BIGINT NOT NULL REFERENCES dc_rooms(id) ON DELETE RESTRICT,
    catalog_id     BIGINT NOT NULL REFERENCES dc_catalog_items(id) ON DELETE RESTRICT,
    name           TEXT NOT NULL CHECK (btrim(name) <> ''),
    -- footprint min corner, after rotation
    x0_mm          INTEGER NOT NULL,
    z0_mm          INTEGER NOT NULL,
    -- mounting height: wall and ceiling units, trays
    y0_mm          INTEGER NOT NULL DEFAULT 0 CHECK (y0_mm >= 0),
    rotation_deg   SMALLINT NOT NULL DEFAULT 0 CHECK (rotation_deg IN (0, 90, 180, 270)),
    -- per-object overrides the kind allows (a rack's door, a tray's length)
    instance       JSONB NOT NULL DEFAULT '{}',
    -- racks: false = "contents not recorded", which is not the same as empty
    contents_known BOOLEAN NOT NULL DEFAULT false,
    note           TEXT NOT NULL DEFAULT '',
    UNIQUE (room_id, name)
);
CREATE INDEX dc_objects_room_idx ON dc_objects (room_id);

-- Devices mounted in a rack by U ---------------------------------------------

CREATE TYPE dc_device_kind AS ENUM (
    'server', 'storage', 'switch', 'router', 'patch', 'ups', 'pdu', 'kvm', 'blank', 'other');

CREATE TABLE dc_devices (
    id        BIGSERIAL PRIMARY KEY,
    rack_id   BIGINT NOT NULL REFERENCES dc_objects(id) ON DELETE RESTRICT,
    u_bottom  SMALLINT NOT NULL CHECK (u_bottom >= 1),
    u_height  SMALLINT NOT NULL CHECK (u_height >= 1),
    face      TEXT NOT NULL DEFAULT 'front' CHECK (face IN ('front', 'rear', 'both')),
    -- NULL = typical for the kind
    depth_mm  INTEGER CHECK (depth_mm > 0),
    kind      dc_device_kind NOT NULL,
    name      TEXT NOT NULL CHECK (btrim(name) <> ''),
    -- whose equipment: a client or an internal service, free text
    owner     TEXT NOT NULL DEFAULT '',
    serial    TEXT NOT NULL DEFAULT '',
    -- NULL = unknown; never 0 for unknown
    power_w   INTEGER CHECK (power_w >= 0),
    power_src TEXT CHECK (power_src IN ('nameplate', 'measured', 'estimated')),
    status    TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'reserved', 'planned', 'decommissioning')),
    note      TEXT NOT NULL DEFAULT '',
    -- a source without a value says nothing
    CHECK (power_src IS NULL OR power_w IS NOT NULL),

    -- Devices on the same face never share a unit, enforced here so that no
    -- code path — the API, an import, a hand-written UPDATE — can get round it.
    -- A 'both' device (full depth) takes the unit on the front and the rear,
    -- so it is in both groups and conflicts with either.
    CONSTRAINT dc_devices_front_no_overlap EXCLUDE USING gist (
        rack_id WITH =,
        int4range(u_bottom, u_bottom + u_height) WITH &&
    ) WHERE (face IN ('front', 'both')),
    CONSTRAINT dc_devices_rear_no_overlap EXCLUDE USING gist (
        rack_id WITH =,
        int4range(u_bottom, u_bottom + u_height) WITH &&
    ) WHERE (face IN ('rear', 'both'))
);

-- A device sits in a rack, inside the rack's units.
CREATE FUNCTION dc_devices_check_rack() RETURNS trigger AS $$
DECLARE
    item_kind TEXT;
    units     INTEGER;
BEGIN
    SELECT c.kind, (c.props ->> 'units')::INTEGER
      INTO item_kind, units
      FROM dc_objects o JOIN dc_catalog_items c ON c.id = o.catalog_id
     WHERE o.id = NEW.rack_id;
    IF item_kind IS DISTINCT FROM 'rack' THEN
        RAISE EXCEPTION 'dc_devices.rack_id % is not a rack', NEW.rack_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'dc_devices_rack_kind';
    END IF;
    IF NEW.u_bottom + NEW.u_height - 1 > units THEN
        RAISE EXCEPTION 'units %-% do not fit a %U rack',
                NEW.u_bottom, NEW.u_bottom + NEW.u_height - 1, units
            USING ERRCODE = 'check_violation', CONSTRAINT = 'dc_devices_fit_rack';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dc_devices_check_rack
    BEFORE INSERT OR UPDATE OF rack_id, u_bottom, u_height ON dc_devices
    FOR EACH ROW EXECUTE FUNCTION dc_devices_check_rack();

-- Shelf cells ----------------------------------------------------------------

CREATE TABLE dc_shelf_cells (
    shelf_id BIGINT NOT NULL REFERENCES dc_objects(id) ON DELETE RESTRICT,
    cell_no  SMALLINT NOT NULL CHECK (cell_no >= 1),
    name     TEXT NOT NULL CHECK (btrim(name) <> ''),
    owner    TEXT NOT NULL DEFAULT '',
    power_w  INTEGER CHECK (power_w >= 0),
    note     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (shelf_id, cell_no)
);

-- A cell belongs to a shelf, and its number exists on that shelf.
CREATE FUNCTION dc_shelf_cells_check_shelf() RETURNS trigger AS $$
DECLARE
    item_kind TEXT;
    cells     INTEGER;
BEGIN
    SELECT c.kind,
           jsonb_array_length(c.props -> 'boards_mm') * (c.props ->> 'cells_per_board')::INTEGER
      INTO item_kind, cells
      FROM dc_objects o JOIN dc_catalog_items c ON c.id = o.catalog_id
     WHERE o.id = NEW.shelf_id;
    IF item_kind IS DISTINCT FROM 'shelf' THEN
        RAISE EXCEPTION 'dc_shelf_cells.shelf_id % is not a shelf', NEW.shelf_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'dc_shelf_cells_shelf_kind';
    END IF;
    IF NEW.cell_no > cells THEN
        RAISE EXCEPTION 'cell % does not exist on a shelf of % cells', NEW.cell_no, cells
            USING ERRCODE = 'check_violation', CONSTRAINT = 'dc_shelf_cells_fit_shelf';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dc_shelf_cells_check_shelf
    BEFORE INSERT OR UPDATE OF shelf_id, cell_no ON dc_shelf_cells
    FOR EACH ROW EXECUTE FUNCTION dc_shelf_cells_check_shelf();

-- Notes pinned in 3D and saved camera views ----------------------------------

CREATE TABLE dc_annotations (
    id         BIGSERIAL PRIMARY KEY,
    room_id    BIGINT NOT NULL REFERENCES dc_rooms(id) ON DELETE RESTRICT,
    kind       TEXT NOT NULL CHECK (kind IN ('note', 'view')),
    payload    JSONB NOT NULL,
    -- users.id is a UUID in this platform
    author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dc_annotations_room_idx ON dc_annotations (room_id);

-- History: one full snapshot per committed change set (§8) -------------------

CREATE TABLE dc_room_revisions (
    room_id     BIGINT NOT NULL REFERENCES dc_rooms(id) ON DELETE RESTRICT,
    revision    INTEGER NOT NULL,
    snapshot    JSONB NOT NULL,
    -- NULL with author_name 'seed' for the revision the seed writes; kept by
    -- name as well so the history outlives a deleted account, like audit_log
    author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    summary     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, revision)
);
