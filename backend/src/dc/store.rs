//! Reading and writing DC rows. Everything here takes a connection, so the
//! same functions run on the pool or inside a change set's transaction.
//!
//! JSONB columns are decoded into the typed structs of [`super::model`]; a row
//! that does not decode is a fault (the write paths only store what they
//! validated), logged and reported as a 500.

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use super::model::{
    Annotation, AnnotationPayload, CatalogItem, CatalogProps, CatalogUse, DcObject, Device,
    DeviceFields, PropSource, Room, RoomMeasurements, RoomSettings, RoomSummary, RoomView,
    ShelfCell, Snapshot, enum_str, parse_enum,
};
use crate::error::{ApiError, ApiResult, internal};

fn decode<T: serde::de::DeserializeOwned>(what: &str, v: Value) -> ApiResult<T> {
    serde_json::from_value(v).map_err(|e| internal(&format!("decoding {what}"), e))
}

// --- Rooms ---------------------------------------------------------------------

type RoomRow = (
    i64,
    String,
    Value,
    i32,
    Value,
    Value,
    i32,
    chrono::DateTime<chrono::Utc>,
);

fn room_from_row(r: RoomRow) -> ApiResult<Room> {
    Ok(Room {
        id: r.0,
        name: r.1,
        floor_plan: decode("a room's floor plan", r.2)?,
        height_mm: r.3,
        measurements: decode::<RoomMeasurements>("a room's measurements", r.4)?,
        settings: decode::<RoomSettings>("a room's settings", r.5)?,
        revision: r.6,
        updated_at: r.7,
    })
}

const ROOM_COLUMNS: &str =
    "id, name, floor_plan, height_mm, measurements, settings, revision, updated_at";

pub async fn room(conn: &mut PgConnection, id: i64) -> ApiResult<Room> {
    let row: Option<RoomRow> = sqlx::query_as(&format!(
        "SELECT {ROOM_COLUMNS} FROM dc_rooms WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading a room", e))?;
    room_from_row(row.ok_or_else(room_not_found)?)
}

/// The room, locked for the rest of the transaction: change sets on one room
/// are applied one at a time.
pub async fn room_for_update(conn: &mut PgConnection, id: i64) -> ApiResult<Room> {
    let row: Option<RoomRow> = sqlx::query_as(&format!(
        "SELECT {ROOM_COLUMNS} FROM dc_rooms WHERE id = $1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("locking a room", e))?;
    room_from_row(row.ok_or_else(room_not_found)?)
}

pub fn room_not_found() -> ApiError {
    ApiError::NotFound("Room not found".into())
}

pub async fn rooms(conn: &mut PgConnection) -> ApiResult<Vec<RoomSummary>> {
    let rows: Vec<(i64, String, i32, chrono::DateTime<chrono::Utc>, i64, i64)> = sqlx::query_as(
        "SELECT r.id, r.name, r.revision, r.updated_at,
                (SELECT count(*) FROM dc_objects o JOIN dc_catalog_items c ON c.id = o.catalog_id
                  WHERE o.room_id = r.id AND c.kind = 'rack'),
                (SELECT count(*) FROM dc_devices d JOIN dc_objects o ON o.id = d.rack_id
                  WHERE o.room_id = r.id)
           FROM dc_rooms r ORDER BY r.name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("listing rooms", e))?;
    Ok(rows
        .into_iter()
        .map(|r| RoomSummary {
            id: r.0,
            name: r.1,
            revision: r.2,
            updated_at: r.3,
            rack_count: r.4,
            device_count: r.5,
        })
        .collect())
}

// --- Catalog ---------------------------------------------------------------------

type ItemRow = (
    i64,
    String,
    String,
    String,
    i32,
    i32,
    i32,
    Value,
    Value,
    bool,
);

const ITEM_COLUMNS: &str =
    "id, kind, manufacturer, model, width_mm, depth_mm, height_mm, props, props_src, archived";

fn item_from_row(r: ItemRow) -> ApiResult<CatalogItem> {
    let props = CatalogProps::from_parts(&r.1, r.7)
        .map_err(|e| internal(&format!("decoding catalog item {}", r.0), e))?;
    Ok(CatalogItem {
        id: r.0,
        manufacturer: r.2,
        model: r.3,
        width_mm: r.4,
        depth_mm: r.5,
        height_mm: r.6,
        props,
        props_src: decode::<BTreeMap<String, PropSource>>("catalog sources", r.8)?,
        archived: r.9,
    })
}

/// The catalog, optionally one kind only. Phase 1 kinds only: rows of a kind
/// this build does not type (none can be written yet) are skipped.
pub async fn catalog(conn: &mut PgConnection, kind: Option<&str>) -> ApiResult<Vec<CatalogItem>> {
    let rows: Vec<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM dc_catalog_items
          WHERE ($1::text IS NULL OR kind = $1)
            AND kind IN ('rack', 'shelf', 'cooling', 'cable_tray', 'structure')
          ORDER BY kind, manufacturer, model"
    ))
    .bind(kind)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("listing the catalog", e))?;
    rows.into_iter().map(item_from_row).collect()
}

pub async fn catalog_item(conn: &mut PgConnection, id: i64) -> ApiResult<Option<CatalogItem>> {
    let row: Option<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM dc_catalog_items WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| internal("loading a catalog item", e))?;
    row.map(item_from_row).transpose()
}

/// The items a room's objects use.
pub async fn catalog_of_room(conn: &mut PgConnection, room_id: i64) -> ApiResult<Vec<CatalogItem>> {
    let rows: Vec<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM dc_catalog_items
          WHERE id IN (SELECT catalog_id FROM dc_objects WHERE room_id = $1)
          ORDER BY id"
    ))
    .bind(room_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("loading a room's catalog items", e))?;
    rows.into_iter().map(item_from_row).collect()
}

/// Where catalog items stand: one row per object, by item, room and name.
pub async fn catalog_usage(conn: &mut PgConnection) -> ApiResult<Vec<CatalogUse>> {
    sqlx::query_as::<_, (i64, i64, String, i64, String)>(
        "SELECT o.catalog_id, r.id, r.name, o.id, o.name
           FROM dc_objects o JOIN dc_rooms r ON r.id = o.room_id
          ORDER BY o.catalog_id, r.name, o.name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("listing where catalog items are used", e))
    .map(|rows| {
        rows.into_iter()
            .map(
                |(catalog_id, room_id, room_name, object_id, object_name)| CatalogUse {
                    catalog_id,
                    room_id,
                    room_name,
                    object_id,
                    object_name,
                },
            )
            .collect()
    })
}

// --- Contents --------------------------------------------------------------------

type AnnotationRow = (
    i64,
    String,
    Value,
    Option<Uuid>,
    Option<String>,
    chrono::DateTime<chrono::Utc>,
);
type ObjectRow = (i64, i64, String, i32, i32, i32, i16, Value, bool, String);
type DeviceRow = (
    i64,
    i64,
    i16,
    i16,
    String,
    Option<i32>,
    String,
    String,
    String,
    String,
    Option<i32>,
    Option<String>,
    String,
    String,
);

fn corrupt(what: &str) -> ApiError {
    internal("decoding a DC row", what)
}

fn device_from_row(r: DeviceRow) -> ApiResult<Device> {
    Ok(Device {
        id: r.0,
        fields: DeviceFields {
            rack_id: r.1,
            u_bottom: r.2 as i32,
            u_height: r.3 as i32,
            face: parse_enum(&r.4).ok_or_else(|| corrupt("device face"))?,
            depth_mm: r.5,
            kind: parse_enum(&r.6).ok_or_else(|| corrupt("device kind"))?,
            name: r.7,
            owner: r.8,
            serial: r.9,
            power_w: r.10,
            power_src: match r.11 {
                Some(s) => Some(parse_enum(&s).ok_or_else(|| corrupt("power source"))?),
                None => None,
            },
            status: parse_enum(&r.12).ok_or_else(|| corrupt("device status"))?,
            note: r.13,
        },
    })
}

pub const DEVICE_COLUMNS: &str = "d.id, d.rack_id, d.u_bottom, d.u_height, d.face, d.depth_mm, \
     d.kind::text, d.name, d.owner, d.serial, d.power_w, d.power_src, d.status, d.note";

/// Everything a change set can touch, in a stable order (by id), so two
/// snapshots of the same state are equal and diffs are meaningful.
pub async fn snapshot(conn: &mut PgConnection, room_id: i64) -> ApiResult<Snapshot> {
    let objects: Vec<ObjectRow> = sqlx::query_as(
        "SELECT id, catalog_id, name, x0_mm, z0_mm, y0_mm, rotation_deg, instance, contents_known, note
           FROM dc_objects WHERE room_id = $1 ORDER BY id",
    )
    .bind(room_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("loading a room's objects", e))?;

    let devices: Vec<DeviceRow> = sqlx::query_as(&format!(
        "SELECT {DEVICE_COLUMNS} FROM dc_devices d JOIN dc_objects o ON o.id = d.rack_id
          WHERE o.room_id = $1 ORDER BY d.id"
    ))
    .bind(room_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("loading a room's devices", e))?;

    let cells: Vec<(i64, i16, String, String, Option<i32>, String)> = sqlx::query_as(
        "SELECT c.shelf_id, c.cell_no, c.name, c.owner, c.power_w, c.note
           FROM dc_shelf_cells c JOIN dc_objects o ON o.id = c.shelf_id
          WHERE o.room_id = $1 ORDER BY c.shelf_id, c.cell_no",
    )
    .bind(room_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("loading a room's shelf cells", e))?;

    let annotations: Vec<AnnotationRow> = sqlx::query_as(
        "SELECT a.id, a.kind, a.payload, a.author_id, u.username, a.created_at
               FROM dc_annotations a LEFT JOIN users u ON u.id = a.author_id
              WHERE a.room_id = $1 ORDER BY a.id",
    )
    .bind(room_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("loading a room's annotations", e))?;

    Ok(Snapshot {
        objects: objects
            .into_iter()
            .map(|r| DcObject {
                id: r.0,
                catalog_id: r.1,
                name: r.2,
                x0_mm: r.3,
                z0_mm: r.4,
                y0_mm: r.5,
                rotation_deg: r.6 as i32,
                instance: r.7,
                contents_known: r.8,
                note: r.9,
            })
            .collect(),
        devices: devices
            .into_iter()
            .map(device_from_row)
            .collect::<ApiResult<_>>()?,
        cells: cells
            .into_iter()
            .map(|r| ShelfCell {
                shelf_id: r.0,
                cell_no: r.1 as i32,
                name: r.2,
                owner: r.3,
                power_w: r.4,
                note: r.5,
            })
            .collect(),
        annotations: annotations
            .into_iter()
            .map(|r| {
                let payload: AnnotationPayload = decode(
                    "an annotation",
                    serde_json::json!({ "kind": r.1, "payload": r.2 }),
                )?;
                Ok(Annotation {
                    id: r.0,
                    payload,
                    author_id: r.3,
                    author_name: r.4,
                    created_at: r.5,
                })
            })
            .collect::<ApiResult<_>>()?,
    })
}

pub async fn view(conn: &mut PgConnection, room_id: i64) -> ApiResult<RoomView> {
    let room = room(conn, room_id).await?;
    let catalog = catalog_of_room(conn, room_id).await?;
    let contents = snapshot(conn, room_id).await?;
    Ok(RoomView {
        room,
        catalog,
        contents,
    })
}

// --- Writing rows ------------------------------------------------------------------

pub async fn insert_object(
    conn: &mut PgConnection,
    room_id: i64,
    id: Option<i64>,
    o: &DcObject,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO dc_objects
            (id, room_id, catalog_id, name, x0_mm, z0_mm, y0_mm, rotation_deg, instance, contents_known, note)
         VALUES (COALESCE($1, nextval('dc_objects_id_seq')), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id",
    )
    .bind(id)
    .bind(room_id)
    .bind(o.catalog_id)
    .bind(&o.name)
    .bind(o.x0_mm)
    .bind(o.z0_mm)
    .bind(o.y0_mm)
    .bind(o.rotation_deg as i16)
    .bind(&o.instance)
    .bind(o.contents_known)
    .bind(&o.note)
    .fetch_one(&mut *conn)
    .await
}

pub async fn insert_device(
    conn: &mut PgConnection,
    id: Option<i64>,
    d: &DeviceFields,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO dc_devices
            (id, rack_id, u_bottom, u_height, face, depth_mm, kind, name, owner, serial,
             power_w, power_src, status, note)
         VALUES (COALESCE($1, nextval('dc_devices_id_seq')), $2, $3, $4, $5, $6,
                 $7::dc_device_kind, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id",
    )
    .bind(id)
    .bind(d.rack_id)
    .bind(d.u_bottom as i16)
    .bind(d.u_height as i16)
    .bind(enum_str(&d.face))
    .bind(d.depth_mm)
    .bind(enum_str(&d.kind))
    .bind(&d.name)
    .bind(&d.owner)
    .bind(&d.serial)
    .bind(d.power_w)
    .bind(d.power_src.map(|p| enum_str(&p)))
    .bind(enum_str(&d.status))
    .bind(&d.note)
    .fetch_one(&mut *conn)
    .await
}

pub async fn upsert_cell(conn: &mut PgConnection, c: &ShelfCell) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO dc_shelf_cells (shelf_id, cell_no, name, owner, power_w, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (shelf_id, cell_no) DO UPDATE
            SET name = EXCLUDED.name, owner = EXCLUDED.owner,
                power_w = EXCLUDED.power_w, note = EXCLUDED.note",
    )
    .bind(c.shelf_id)
    .bind(c.cell_no as i16)
    .bind(&c.name)
    .bind(&c.owner)
    .bind(c.power_w)
    .bind(&c.note)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

pub async fn insert_annotation(
    conn: &mut PgConnection,
    room_id: i64,
    id: Option<i64>,
    payload: &AnnotationPayload,
    author: Option<Uuid>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<i64, sqlx::Error> {
    let v = serde_json::to_value(payload).unwrap_or(Value::Null);
    sqlx::query_scalar(
        "INSERT INTO dc_annotations (id, room_id, kind, payload, author_id, created_at)
         VALUES (COALESCE($1, nextval('dc_annotations_id_seq')), $2, $3, $4, $5, COALESCE($6, now()))
         RETURNING id",
    )
    .bind(id)
    .bind(room_id)
    .bind(v["kind"].as_str().unwrap_or(""))
    .bind(&v["payload"])
    .bind(author)
    .bind(created_at)
    .fetch_one(&mut *conn)
    .await
}

/// Replace everything in a room with a snapshot (a restore), keeping the ids
/// the snapshot recorded so deep links and later diffs still line up.
pub async fn replace_contents(
    conn: &mut PgConnection,
    room_id: i64,
    s: &Snapshot,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM dc_devices WHERE rack_id IN (SELECT id FROM dc_objects WHERE room_id = $1)",
    )
    .bind(room_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM dc_shelf_cells WHERE shelf_id IN (SELECT id FROM dc_objects WHERE room_id = $1)",
    )
    .bind(room_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM dc_annotations WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM dc_objects WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *conn)
        .await?;
    for o in &s.objects {
        insert_object(conn, room_id, Some(o.id), o).await?;
    }
    for d in &s.devices {
        insert_device(conn, Some(d.id), &d.fields).await?;
    }
    for c in &s.cells {
        upsert_cell(conn, c).await?;
    }
    for a in &s.annotations {
        // A restored note keeps its author and time.
        insert_annotation(
            conn,
            room_id,
            Some(a.id),
            &a.payload,
            a.author_id,
            Some(a.created_at),
        )
        .await?;
    }
    Ok(())
}

/// Record a committed change set as the room's next revision.
pub async fn write_revision(
    conn: &mut PgConnection,
    room_id: i64,
    revision: i32,
    snapshot: &Snapshot,
    author: Option<(Uuid, &str)>,
    summary: &str,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO dc_room_revisions (room_id, revision, snapshot, author_id, author_name, summary)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(room_id)
    .bind(revision)
    .bind(serde_json::to_value(snapshot).map_err(|e| internal("encoding a snapshot", e))?)
    .bind(author.map(|a| a.0))
    .bind(author.map(|a| a.1).unwrap_or("seed"))
    .bind(summary)
    .execute(&mut *conn)
    .await
    .map_err(|e| internal("recording a room revision", e))
    .map(|_| ())
}
