//! `/api/dc/rooms/{id}/airflow` — the airflow model (SPEC §14.2).
//!
//! The API only reads and enqueues: runs are executed by
//! `portal-cfd-worker`, which shares nothing with this process but the
//! database. Merged into [`super::dc::routes`], so the CSRF guard applies.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use portal_cfd::input::Assumption;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::AppState;
use crate::dc::airflow_store::{self as runs, Blob, RunInfo};
use crate::dc::model::{CatalogProps, Instance, RoomView};
use crate::dc::ops::{self, ChangeSet, Failure, ObjectFields, Op};
use crate::dc::store;
use crate::error::{ApiError, ApiResult, internal};
use crate::models::User;
use crate::tool_access::{DcRoom, Edit, RequireTool, Use};

type Viewer = RequireTool<DcRoom, Use>;
type Editor = RequireTool<DcRoom, Edit>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/rooms/{id}/airflow", get(status))
        .route("/rooms/{id}/airflow/assumptions", put(set_assumptions))
        .route("/rooms/{id}/airflow/runs", post(start))
        .route("/rooms/{id}/airflow/runs/{run}/cancel", post(cancel))
        .route("/rooms/{id}/airflow/runs/{run}/summary", get(summary))
        .route("/rooms/{id}/airflow/runs/{run}/grid", get(grid))
        .route(
            "/rooms/{id}/airflow/runs/{run}/streamlines",
            get(streamlines),
        )
}

/// The input of the room as it stands, as stored JSON (null when the room
/// cannot be modelled).
fn current(view: &RoomView) -> (Value, Result<portal_cfd::input::CaseInput, String>) {
    let input = runs::input_of(view);
    let value = input
        .as_ref()
        .ok()
        .and_then(|i| serde_json::to_value(i).ok())
        .unwrap_or(Value::Null);
    (value, input)
}

#[derive(Serialize)]
struct Status {
    /// A worker is running: a run can be computed.
    available: bool,
    revision: i32,
    /// What a run of the room as it stands assumes, input by input.
    assumptions: Vec<Assumption>,
    /// Why the room cannot be modelled, if it cannot.
    unsupported: Option<String>,
    /// The room's latest run, whatever became of it.
    latest: Option<RunInfo>,
    /// The latest run that converged: the result to show, marked outdated
    /// when the room has changed since.
    result: Option<RunInfo>,
}

async fn status(
    State(state): State<AppState>,
    _: Viewer,
    Path(id): Path<i64>,
) -> ApiResult<Json<Status>> {
    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|e| internal("connecting", e))?;
    let view = store::view(&mut conn, id).await?;
    let (value, input) = current(&view);
    let (latest, result) = runs::latest(&mut conn, id, &value).await?;
    Ok(Json(Status {
        available: runs::worker_available(&mut conn).await?,
        revision: view.room.revision,
        assumptions: input
            .as_ref()
            .map(|i| i.assumptions.clone())
            .unwrap_or_default(),
        unsupported: input.err(),
        latest,
        result,
    }))
}

#[derive(Serialize)]
struct Started {
    revision: i32,
    run: RunInfo,
    /// False when a run of the same input was already queued, running or
    /// finished: that run is returned instead.
    created: bool,
}

/// Queue a run of the room as it stands, in `tx`.
async fn enqueue_current(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: i64,
    user: &User,
) -> ApiResult<Started> {
    let view = store::view(tx, id).await?;
    let input = runs::input_of(&view).map_err(ApiError::BadRequest)?;
    let (run, created) =
        runs::enqueue(tx, id, &view.room.name, view.room.revision, &input, user).await?;
    Ok(Started {
        revision: view.room.revision,
        run,
        created,
    })
}

async fn start(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("starting an airflow run", e))?;
    let started = enqueue_current(&mut tx, id, &user).await?;
    tx.commit()
        .await
        .map_err(|e| internal("committing an airflow run", e))?;
    let code = if started.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((code, Json(started)).into_response())
}

/// After a change set: a room that has had runs gets a new one when its
/// input changed (SPEC §17.1b: a changed assumption or deflector angle
/// starts a new run; the old result stays, marked outdated). Best effort:
/// the change itself has already committed.
pub async fn follow(state: &AppState, id: i64, user: &User) {
    let result: ApiResult<()> = async {
        let mut tx = state
            .pool
            .begin()
            .await
            .map_err(|e| internal("following up an edit", e))?;
        if !runs::has_runs(&mut tx, id).await? {
            return Ok(());
        }
        let view = store::view(&mut tx, id).await?;
        if let Ok(input) = runs::input_of(&view) {
            runs::enqueue(
                &mut tx,
                id,
                &view.room.name,
                view.room.revision,
                &input,
                user,
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|e| internal("following up an edit", e))
    }
    .await;
    if let Err(e) = result {
        tracing::warn!("room {id}: no airflow run after the edit: {e:?}");
    }
}

async fn cancel(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path((id, run)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|e| internal("cancelling an airflow run", e))?;
    let room = store::room(&mut tx, id).await?;
    runs::cancel(&mut tx, id, &room.name, run, &user).await?;
    tx.commit()
        .await
        .map_err(|e| internal("cancelling an airflow run", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The editable assumptions (PROMPT-AIRFLOW item 5). The room-level values
/// are sent as they should be (null = the default); the units and racks
/// listed get their value (null = the default), the others stay.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssumptionsEdit {
    base_revision: i32,
    supply_temp_c: Option<f64>,
    assumed_rack_heat_w: Option<i32>,
    #[serde(default)]
    units: Vec<UnitAirflow>,
    #[serde(default)]
    racks: Vec<RackHeat>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitAirflow {
    object_id: i64,
    airflow_m3h: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RackHeat {
    object_id: i64,
    heat_w: Option<i32>,
}

/// An object's update with one instance field set (or removed).
fn with_field(
    view: &RoomView,
    object_id: i64,
    field: &str,
    value: Option<i32>,
    want: fn(&CatalogProps) -> bool,
) -> ApiResult<Option<Op>> {
    let obj = view
        .contents
        .objects
        .iter()
        .find(|o| o.id == object_id)
        .ok_or_else(|| ApiError::BadRequest(format!("Object {object_id} is not in this room.")))?;
    let item = view
        .catalog
        .iter()
        .find(|i| i.id == obj.catalog_id)
        .ok_or_else(|| internal("an object without its catalog item", object_id))?;
    if !want(&item.props) {
        return Err(ApiError::BadRequest(format!(
            "{} does not take this assumption.",
            obj.name
        )));
    }
    let mut instance = obj.instance.clone();
    let old = instance.get(field).cloned();
    let new = value.map(|v| json!(v));
    if old == new {
        return Ok(None);
    }
    match (&mut instance, new) {
        (Value::Object(m), Some(v)) => {
            m.insert(field.into(), v);
        }
        (Value::Object(m), None) => {
            m.remove(field);
        }
        _ => {
            return Err(internal(
                "an object instance that is not an object",
                object_id,
            ));
        }
    }
    // Checked here for a clear message; the change set checks it again.
    Instance::parse(&item.props, &instance).map_err(ApiError::BadRequest)?;
    Ok(Some(Op::ObjectUpdate {
        id: obj.id,
        object: ObjectFields {
            catalog_id: obj.catalog_id,
            name: obj.name.clone(),
            x0_mm: obj.x0_mm,
            z0_mm: obj.z0_mm,
            y0_mm: obj.y0_mm,
            rotation_deg: obj.rotation_deg,
            instance,
            contents_known: obj.contents_known,
            note: obj.note.clone(),
        },
    }))
}

async fn set_assumptions(
    State(state): State<AppState>,
    RequireTool(user, _): Editor,
    Path(id): Path<i64>,
    Json(edit): Json<AssumptionsEdit>,
) -> Response {
    let result: Result<Started, Failure> = async {
        let mut tx = state
            .pool
            .begin()
            .await
            .map_err(|e| Failure::Api(internal("editing airflow assumptions", e)))?;
        let view = store::view(&mut tx, id).await.map_err(Failure::Api)?;
        let mut ops = vec![];
        let mut settings = view.room.settings.clone();
        settings.supply_temp_c = edit.supply_temp_c;
        settings.assumed_rack_heat_w = edit.assumed_rack_heat_w;
        if settings != view.room.settings {
            ops.push(Op::RoomSettings { settings });
        }
        for u in &edit.units {
            let op = with_field(&view, u.object_id, "airflow_m3h", u.airflow_m3h, |p| {
                matches!(p, CatalogProps::Cooling(_))
            })
            .map_err(Failure::Api)?;
            ops.extend(op);
        }
        for r in &edit.racks {
            let op = with_field(&view, r.object_id, "heat_w", r.heat_w, |p| {
                matches!(p, CatalogProps::Rack(_))
            })
            .map_err(Failure::Api)?;
            ops.extend(op);
        }
        if !ops.is_empty() {
            let set = ChangeSet {
                base_revision: edit.base_revision,
                summary: Some("airflow assumptions".into()),
                ops,
            };
            ops::apply(&mut tx, id, set, &user).await?;
        }
        let started = enqueue_current(&mut tx, id, &user)
            .await
            .map_err(Failure::Api)?;
        tx.commit()
            .await
            .map_err(|e| Failure::Api(internal("committing airflow assumptions", e)))?;
        Ok(started)
    }
    .await;
    match result {
        Ok(s) => Json(s).into_response(),
        Err(f) => super::dc::failure(f),
    }
}

async fn summary(
    State(state): State<AppState>,
    _: Viewer,
    Path((id, run)): Path<(i64, i64)>,
) -> ApiResult<Json<Value>> {
    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|e| internal("connecting", e))?;
    let (status, reason, summary) = runs::summary(&mut conn, id, run).await?;
    // A run that did not converge is not a result: only its checks, to say
    // why.
    Ok(Json(match (status.as_str(), summary) {
        ("done", Some(s)) => json!({"status": status, "summary": s}),
        ("not_converged", Some(s)) => {
            json!({"status": status, "reason": reason, "checks": s.get("checks")})
        }
        _ => json!({"status": status, "reason": reason}),
    }))
}

/// A stored gzip body: sent as is to a client that accepts gzip, inflated
/// otherwise. A run's result never changes, so it may be cached.
fn gzipped(headers: &HeaderMap, body: Vec<u8>, content_type: &'static str) -> ApiResult<Response> {
    let accepts = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().starts_with("gzip")));
    let mut resp = if accepts {
        let mut r = Response::new(Body::from(body));
        r.headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        r
    } else {
        let raw = portal_cfd::grid::gunzip(&body).map_err(|e| internal("inflating a result", e))?;
        Response::new(Body::from(raw))
    };
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(resp)
}

async fn grid(
    State(state): State<AppState>,
    _: Viewer,
    Path((id, run)): Path<(i64, i64)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|e| internal("connecting", e))?;
    let body = runs::blob(&mut conn, id, run, Blob::Grid).await?;
    gzipped(&headers, body, "application/octet-stream")
}

async fn streamlines(
    State(state): State<AppState>,
    _: Viewer,
    Path((id, run)): Path<(i64, i64)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|e| internal("connecting", e))?;
    let body = runs::blob(&mut conn, id, run, Blob::Streamlines).await?;
    gzipped(&headers, body, "application/json")
}
