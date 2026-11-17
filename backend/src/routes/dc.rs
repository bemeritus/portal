//! `/api/dc` — the server room module (SPEC §7).
//!
//! Every handler takes `RequireTool<DcRoom, Use>` or `RequireTool<DcRoom, Edit>`:
//! without `dc_room:use` nothing here answers anything but 401/403 — no room,
//! no catalog, no export (device owners may be client names). State-changing
//! requests also need the session's CSRF token in `X-CSRF-Token` (see
//! [`csrf_guard`]), which closes the README's "no CSRF token" gap for this
//! module.

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_sessions::Session;

use crate::audit::{Audit, audit_tx};
use crate::db::AppState;
use crate::dc::capacity::{self, Mounted, RackState, Request as CapacityRequest};
use crate::dc::csv::{self as dccsv, Change, ExportRow, RackRef};
use crate::dc::diff::{SnapshotDiff, diff};
use crate::dc::dxf::{self, Placed};
use crate::dc::model::{
    CatalogItem, CatalogProps, Face, Kind, RoomSummary, RoomView, Snapshot, parse_enum,
};
use crate::dc::ops::{self, Analysis, Applied, ChangeSet, Failure, ObjectFields, Op};
use crate::dc::store;
use crate::error::{ApiError, ApiResult, internal};
use crate::models::Language;
use crate::tool_access::{DcRoom, Edit, RequireTool, Use};

type Viewer = RequireTool<DcRoom, Use>;
type Editor = RequireTool<DcRoom, Edit>;

/// Session key of the CSRF token.
const CSRF_KEY: &str = "dc_csrf";
const CSRF_HEADER: &str = "x-csrf-token";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/csrf", get(csrf_token))
        .route("/catalog", get(catalog))
        .route("/rooms", get(rooms))
        .route("/rooms/{id}", get(room))
        .route("/rooms/{id}/revision", get(head))
        .route("/rooms/{id}/changes", post(changes))
        .route("/rooms/{id}/revisions", get(revisions))
        .route("/rooms/{id}/revisions/{n}", get(revision))
        .route("/rooms/{id}/revisions/{n}/restore", post(restore))
        .route("/rooms/{id}/capacity", get(capacity_finder))
        .route("/rooms/{id}/search", get(search))
        .route("/rooms/{id}/import/devices", post(import_devices))
        .route("/rooms/{id}/export/plan.dxf", get(export_dxf))
        .route("/rooms/{id}/export/inventory.csv", get(export_csv))
        .route_layer(middleware::from_fn(csrf_guard))
}

// --- CSRF ------------------------------------------------------------------------

#[derive(Serialize)]
struct CsrfToken {
    token: String,
}

/// The session's token, created on first ask. The SPA sends it back on every
/// state-changing request; a page on another site cannot read it.
async fn csrf_token(_: Viewer, session: Session) -> ApiResult<Json<CsrfToken>> {
    let existing: Option<String> = session
        .get(CSRF_KEY)
        .await
        .map_err(|e| internal("reading the CSRF token", e))?;
    let token = match existing {
        Some(t) => t,
        None => {
            let t = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            session
                .insert(CSRF_KEY, &t)
                .await
                .map_err(|e| internal("storing the CSRF token", e))?;
            t
        }
    };
    Ok(Json(CsrfToken { token }))
}

/// Constant-time comparison, so the check leaks nothing about the token.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn csrf_guard(session: Session, request: Request, next: Next) -> Response {
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let sent = request
        .headers()
        .get(CSRF_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let stored: Option<String> = match session.get(CSRF_KEY).await {
        Ok(t) => t,
        Err(e) => return internal("reading the CSRF token", e).into_response(),
    };
    match (sent, stored) {
        (Some(s), Some(t)) if same(s.as_bytes(), t.as_bytes()) => next.run(request).await,
        _ => ApiError::Forbidden("The page is out of date. Reload it and try again.".into())
            .into_response(),
    }
}

// --- Reading -----------------------------------------------------------------------

#[derive(Deserialize)]
struct CatalogQuery {
    kind: Option<String>,
}

async fn catalog(
    State(state): State<AppState>,
    _: Viewer,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Vec<CatalogItem>>> {
    let kind = q.kind.filter(|k| !k.is_empty());
    if let Some(k) = &kind
        && parse_enum::<Kind>(k).is_none()
    {
        return Err(ApiError::BadRequest("Unknown catalog section".into()));
    }
    let mut conn = acquire(&state).await?;
    Ok(Json(store::catalog(&mut conn, kind.as_deref()).await?))
}

async fn acquire(state: &AppState) -> ApiResult<sqlx::pool::PoolConnection<sqlx::Postgres>> {
    state
        .pool
        .acquire()
        .await
        .map_err(|e| internal("getting a database connection", e))
}

async fn rooms(State(state): State<AppState>, _: Viewer) -> ApiResult<Json<Vec<RoomSummary>>> {
    let mut conn = acquire(&state).await?;
    Ok(Json(store::rooms(&mut conn).await?))
}

#[derive(Serialize)]
struct RoomResponse {
    #[serde(flatten)]
    view: RoomView,
    analysis: Analysis,
}

fn items_of(view: &RoomView) -> HashMap<i64, CatalogItem> {
    view.catalog.iter().map(|i| (i.id, i.clone())).collect()
}

async fn room(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Json<RoomResponse>> {
    let mut conn = acquire(&state).await?;
    let view = store::view(&mut conn, id).await?;
    let analysis = ops::analyse(&view.room, &items_of(&view), &view.contents)?;
    Ok(Json(RoomResponse { view, analysis }))
}

#[derive(Serialize)]
struct Head {
    revision: i32,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/// What the client polls every 15 s: cheap, one row.
async fn head(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Json<Head>> {
    let row: Option<(i32, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT revision, updated_at FROM dc_rooms WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| internal("reading a room's revision", e))?;
    let (revision, updated_at) = row.ok_or_else(store::room_not_found)?;
    Ok(Json(Head {
        revision,
        updated_at,
    }))
}

// --- Writing -------------------------------------------------------------------------

/// A 409 that says which revision the room is at, so the client can refetch
/// and decide what to do with its pending edit.
fn stale(revision: i32) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": "The room was changed by someone else. Reload to see their changes.",
            "revision": revision,
        })),
    )
        .into_response()
}

fn failure(f: Failure) -> Response {
    match f {
        Failure::Stale(s) => stale(s.revision),
        Failure::Api(e) => e.into_response(),
    }
}

async fn changes(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path(id): Path<i64>,
    Json(set): Json<ChangeSet>,
) -> Response {
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return internal("starting a change set", e).into_response(),
    };
    match ops::apply(&mut tx, id, set, &user).await {
        Ok(applied) => match tx.commit().await {
            Ok(()) => Json(applied).into_response(),
            Err(e) => internal("committing a change set", e).into_response(),
        },
        Err(f) => failure(f),
    }
}

// --- History -----------------------------------------------------------------------

#[derive(Serialize)]
struct RevisionSummary {
    revision: i32,
    author_name: String,
    summary: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn revisions(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Json<Vec<RevisionSummary>>> {
    let rows: Vec<(i32, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT revision, author_name, summary, created_at FROM dc_room_revisions
          WHERE room_id = $1 ORDER BY revision DESC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("listing a room's revisions", e))?;
    if rows.is_empty() {
        // Every room has at least the revision that created it.
        let mut conn = acquire(&state).await?;
        store::room(&mut conn, id).await?;
    }
    Ok(Json(
        rows.into_iter()
            .map(|r| RevisionSummary {
                revision: r.0,
                author_name: r.1,
                summary: r.2,
                created_at: r.3,
            })
            .collect(),
    ))
}

#[derive(Serialize)]
struct RevisionDetail {
    #[serde(flatten)]
    summary: RevisionSummary,
    snapshot: Snapshot,
    /// Against the revision before it (against an empty room for the first).
    diff: SnapshotDiff,
}

async fn load_revision(
    pool: &sqlx::PgPool,
    room_id: i64,
    n: i32,
) -> ApiResult<Option<(RevisionSummary, Snapshot)>> {
    let row: Option<(
        i32,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
        serde_json::Value,
    )> = sqlx::query_as(
        "SELECT revision, author_name, summary, created_at, snapshot FROM dc_room_revisions
              WHERE room_id = $1 AND revision = $2",
    )
    .bind(room_id)
    .bind(n)
    .fetch_optional(pool)
    .await
    .map_err(|e| internal("loading a room revision", e))?;
    row.map(|r| {
        let snapshot: Snapshot =
            serde_json::from_value(r.4).map_err(|e| internal("decoding a room revision", e))?;
        Ok((
            RevisionSummary {
                revision: r.0,
                author_name: r.1,
                summary: r.2,
                created_at: r.3,
            },
            snapshot,
        ))
    })
    .transpose()
}

fn revision_not_found() -> ApiError {
    ApiError::NotFound("Revision not found".into())
}

async fn revision(
    State(state): State<AppState>,
    _: Viewer,
    Path((id, n)): Path<(i64, i32)>,
) -> ApiResult<Json<RevisionDetail>> {
    let (summary, snapshot) = load_revision(&state.pool, id, n)
        .await?
        .ok_or_else(revision_not_found)?;
    let before = match load_revision(&state.pool, id, n - 1).await? {
        Some((_, s)) => s,
        None => Snapshot::default(),
    };
    let diff = diff(&before, &snapshot);
    Ok(Json(RevisionDetail {
        summary,
        snapshot,
        diff,
    }))
}

#[derive(Deserialize)]
struct RestoreBody {
    base_revision: i32,
}

/// Put an old revision back — as a new revision, so nothing is rewound and a
/// mistaken restore is itself undone by restoring again.
async fn restore(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path((id, n)): Path<(i64, i32)>,
    Json(body): Json<RestoreBody>,
) -> Response {
    let result: Result<Applied, Failure> = async {
        let (_, snapshot) = load_revision(&state.pool, id, n)
            .await?
            .ok_or_else(revision_not_found)?;
        let mut tx = state
            .pool
            .begin()
            .await
            .map_err(|e| internal("starting a restore", e))?;
        let room = store::room_for_update(&mut tx, id).await?;
        if room.revision != body.base_revision {
            return Err(Failure::Stale(ops::Stale {
                revision: room.revision,
            }));
        }
        store::replace_contents(&mut tx, id, &snapshot)
            .await
            .map_err(|e| internal("restoring a room revision", e))?;
        let revision = room.revision + 1;
        sqlx::query("UPDATE dc_rooms SET revision = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(revision)
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("advancing a room's revision", e))?;
        let now = store::snapshot(&mut tx, id).await?;
        let summary = format!("restored revision {n}");
        store::write_revision(
            &mut tx,
            id,
            revision,
            &now,
            Some((user.id, &user.username)),
            &summary,
        )
        .await?;
        audit_tx(
            &mut tx,
            &user,
            Audit {
                action: "dc.room.restore",
                target_type: "dc",
                target_id: None,
                target_name: &room.name,
                details: Some(format!("revision {revision}: {summary}")),
            },
        )
        .await?;
        let items: HashMap<i64, CatalogItem> = store::catalog_of_room(&mut tx, id)
            .await?
            .into_iter()
            .map(|i| (i.id, i))
            .collect();
        let analysis = ops::analyse(&room, &items, &now)?;
        tx.commit()
            .await
            .map_err(|e| internal("committing a restore", e))?;
        Ok(Applied {
            revision,
            created: vec![],
            warnings: analysis
                .clearances
                .into_iter()
                .filter(|c| !c.ok())
                .collect(),
        })
    }
    .await;
    match result {
        Ok(a) => Json(a).into_response(),
        Err(f) => failure(f),
    }
}

// --- Capacity and search ---------------------------------------------------------

#[derive(Deserialize)]
struct CapacityQuery {
    u: i32,
    power_w: Option<i32>,
    face: Option<String>,
}

async fn capacity_finder(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
    Query(q): Query<CapacityQuery>,
) -> ApiResult<Json<capacity::Answer>> {
    if !(1..=60).contains(&q.u) {
        return Err(ApiError::BadRequest(
            "Height must be between 1 and 60 units".into(),
        ));
    }
    if q.power_w.is_some_and(|p| p < 0) {
        return Err(ApiError::BadRequest("Power must not be negative".into()));
    }
    let face = match q.face.as_deref() {
        None | Some("") => Face::Front,
        Some(f) => parse_enum(f).ok_or_else(|| ApiError::BadRequest("Unknown face".into()))?,
    };
    let mut conn = acquire(&state).await?;
    let view = store::view(&mut conn, id).await?;
    let items = items_of(&view);
    let racks: Vec<RackState> = view
        .contents
        .objects
        .iter()
        .filter_map(|o| match items.get(&o.catalog_id).map(|i| &i.props) {
            Some(CatalogProps::Rack(r)) => Some(RackState {
                id: o.id,
                name: o.name.clone(),
                units: r.units,
                contents_known: o.contents_known,
                devices: view
                    .contents
                    .devices
                    .iter()
                    .filter(|d| d.fields.rack_id == o.id)
                    .map(|d| Mounted {
                        u_bottom: d.fields.u_bottom,
                        u_height: d.fields.u_height,
                        face: d.fields.face,
                        power_w: d.fields.power_w,
                    })
                    .collect(),
            }),
            _ => None,
        })
        .collect();
    Ok(Json(capacity::find(
        &racks,
        CapacityRequest {
            u: q.u,
            face,
            power_w: q.power_w,
        },
        view.room.settings.rack_power_budget_w,
    )))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct SearchHit {
    /// `object` | `device` | `cell`
    kind: String,
    /// The device's id, or the object's for objects and cells.
    id: i64,
    object_id: i64,
    object_name: String,
    name: String,
    owner: String,
    serial: String,
    u_bottom: Option<i16>,
    u_height: Option<i16>,
    face: Option<String>,
    cell_no: Option<i16>,
}

/// Names, owners, serials and notes of everything in the room.
async fn search(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<SearchHit>>> {
    let term = q.q.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    let pattern = format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let hits = sqlx::query_as::<_, SearchHit>(
        "SELECT * FROM (
            SELECT 'device' AS kind, d.id, o.id AS object_id, o.name AS object_name, d.name,
                   d.owner, d.serial, d.u_bottom, d.u_height, d.face, NULL::smallint AS cell_no
              FROM dc_devices d JOIN dc_objects o ON o.id = d.rack_id
             WHERE o.room_id = $1
               AND (d.name ILIKE $2 OR d.owner ILIKE $2 OR d.serial ILIKE $2 OR d.note ILIKE $2)
            UNION ALL
            SELECT 'cell', c.shelf_id, c.shelf_id, o.name, c.name, c.owner, '', NULL, NULL, NULL,
                   c.cell_no
              FROM dc_shelf_cells c JOIN dc_objects o ON o.id = c.shelf_id
             WHERE o.room_id = $1 AND (c.name ILIKE $2 OR c.owner ILIKE $2 OR c.note ILIKE $2)
            UNION ALL
            SELECT 'object', o.id, o.id, o.name, o.name, '', '', NULL, NULL, NULL, NULL
              FROM dc_objects o
             WHERE o.room_id = $1 AND (o.name ILIKE $2 OR o.note ILIKE $2)
         ) hits
         ORDER BY kind DESC, object_name, name
         LIMIT 50",
    )
    .bind(id)
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| internal("searching a room", e))?;
    Ok(Json(hits))
}

// --- Import ------------------------------------------------------------------------

#[derive(Deserialize)]
struct ImportQuery {
    #[serde(default)]
    dry_run: bool,
    /// Required to apply: the revision the dry run was made against.
    base_revision: Option<i32>,
}

#[derive(Serialize)]
struct ImportResult {
    dry_run: bool,
    created: usize,
    updated: usize,
    unchanged: usize,
    plan: dccsv::Plan,
    /// The room's revision the plan was made against, or the new one.
    revision: i32,
}

/// The racks of a room, for matching rows by name.
fn rack_refs(view: &RoomView) -> Vec<RackRef> {
    let items = items_of(view);
    view.contents
        .objects
        .iter()
        .filter_map(|o| match items.get(&o.catalog_id).map(|i| &i.props) {
            Some(CatalogProps::Rack(r)) => Some(RackRef {
                id: o.id,
                name: o.name.clone(),
                units: r.units,
            }),
            _ => None,
        })
        .collect()
}

/// `POST …/import/devices?dry_run=true` with the CSV as the body shows what
/// would change; the same request without `dry_run` (and with the dry run's
/// `base_revision`) applies it, all or nothing, as one revision.
async fn import_devices(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path(id): Path<i64>,
    Query(q): Query<ImportQuery>,
    body: axum::body::Bytes,
) -> Response {
    let text = match std::str::from_utf8(&body) {
        Ok(t) => t,
        Err(_) => {
            return ApiError::BadRequest(
                "The file is not UTF-8 text. Save it as CSV UTF-8.".into(),
            )
            .into_response();
        }
    };
    let mut conn = match acquire(&state).await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let view = match store::view(&mut conn, id).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    drop(conn);
    let (rows, mut parse_errors) = dccsv::parse(text);
    let mut plan = dccsv::plan(
        &view.room.name,
        rows,
        &rack_refs(&view),
        &view.contents.devices,
    );
    parse_errors.append(&mut plan.errors);
    parse_errors.sort_by_key(|e| e.line);
    plan.errors = parse_errors;
    let (created, updated, unchanged) = plan.counts();

    if q.dry_run || !plan.errors.is_empty() {
        let result = ImportResult {
            dry_run: true,
            created,
            updated,
            unchanged,
            plan,
            revision: view.room.revision,
        };
        if q.dry_run {
            return Json(result).into_response();
        }
        let mut body = serde_json::to_value(&result).unwrap_or_default();
        body["error"] = json!("The file has errors; nothing was imported.");
        return (StatusCode::BAD_REQUEST, Json(body)).into_response();
    }
    let Some(base_revision) = q.base_revision else {
        return ApiError::BadRequest("Check the file first, then import it".into()).into_response();
    };
    if created + updated == 0 {
        return ApiError::BadRequest("The file changes nothing".into()).into_response();
    }

    // Racks that get devices now have recorded contents.
    let mut ops: Vec<Op> = Vec::new();
    let racks_touched: std::collections::BTreeSet<i64> = plan
        .changes
        .iter()
        .filter_map(|c| match c {
            Change::Create { after, .. } | Change::Update { after, .. } => Some(after.rack_id),
            Change::Unchanged { .. } => None,
        })
        .collect();
    for o in &view.contents.objects {
        if racks_touched.contains(&o.id) && !o.contents_known {
            ops.push(Op::ObjectUpdate {
                id: o.id,
                object: ObjectFields {
                    catalog_id: o.catalog_id,
                    name: o.name.clone(),
                    x0_mm: o.x0_mm,
                    z0_mm: o.z0_mm,
                    y0_mm: o.y0_mm,
                    rotation_deg: o.rotation_deg,
                    instance: o.instance.clone(),
                    contents_known: true,
                    note: o.note.clone(),
                },
            });
        }
    }
    for c in &plan.changes {
        match c {
            Change::Create { after, .. } => ops.push(Op::DeviceCreate {
                device: after.clone(),
            }),
            Change::Update { id, after, .. } => ops.push(Op::DeviceUpdate {
                id: *id,
                device: after.clone(),
            }),
            Change::Unchanged { .. } => {}
        }
    }
    let set = ChangeSet {
        base_revision,
        summary: Some(format!("CSV import: {created} new, {updated} updated")),
        ops,
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return internal("starting an import", e).into_response(),
    };
    match ops::apply(&mut tx, id, set, &user).await {
        Ok(applied) => {
            if let Err(e) = tx.commit().await {
                return internal("committing an import", e).into_response();
            }
            Json(ImportResult {
                dry_run: false,
                created,
                updated,
                unchanged,
                plan,
                revision: applied.revision,
            })
            .into_response()
        }
        Err(f) => failure(f),
    }
}

// --- Export --------------------------------------------------------------------------

/// `attachment` with an ASCII fallback name and the real one per RFC 5987.
fn attachment(ascii: &str, utf8: &str) -> HeaderValue {
    let encoded: String = utf8
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

fn file(body: Vec<u8>, content_type: &'static str, ascii: &str, utf8: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CONTENT_DISPOSITION, attachment(ascii, utf8));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, Body::from(body)).into_response()
}

async fn export_dxf(
    State(state): State<AppState>,
    RequireTool(user, _): Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut conn = acquire(&state).await?;
    let view = store::view(&mut conn, id).await?;
    let items = items_of(&view);
    let solids = ops::solids(&view.room, &items, &view.contents)?;
    let placed: Vec<Placed> = view
        .contents
        .objects
        .iter()
        .zip(&solids)
        .map(|(o, s)| Placed {
            solid: s,
            object: o,
            item: &items[&o.catalog_id],
        })
        .collect();
    let bytes = dxf::build(&view.room, &placed, Language::from_db(&user.language));
    Ok(file(
        bytes,
        "application/dxf",
        &format!("room-{id}-plan.dxf"),
        &format!("{}-plan.dxf", view.room.name),
    ))
}

async fn export_csv(
    State(state): State<AppState>,
    RequireTool(user, _): Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut conn = acquire(&state).await?;
    let view = store::view(&mut conn, id).await?;
    let names: HashMap<i64, &str> = view
        .contents
        .objects
        .iter()
        .map(|o| (o.id, o.name.as_str()))
        .collect();
    let mut devices: Vec<_> = view.contents.devices.iter().collect();
    devices.sort_by(|a, b| {
        let key = |d: &crate::dc::model::Device| {
            (
                names.get(&d.fields.rack_id).copied().unwrap_or(""),
                std::cmp::Reverse(d.fields.u_bottom),
            )
        };
        key(a).cmp(&key(b))
    });
    let rows: Vec<ExportRow> = devices
        .iter()
        .map(|d| ExportRow {
            rack: names.get(&d.fields.rack_id).copied().unwrap_or(""),
            device: &d.fields,
        })
        .collect();
    let text = dccsv::write(&view.room.name, &rows, Language::from_db(&user.language));
    Ok(file(
        text.into_bytes(),
        "text/csv; charset=utf-8",
        &format!("room-{id}-inventory.csv"),
        &format!("{}-inventory.csv", view.room.name),
    ))
}
