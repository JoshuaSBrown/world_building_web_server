//! The HTTP surface. Implements `openapi.yaml`, which is the contract.
//!
//! This layer knows about requests and responses. It does not read HDF5 (that is
//! `workers`), does not walk run directories (that is `store`), and does not know
//! how a simulation is started (that is `runner`). Nothing here computes a
//! physical quantity.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_core::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::runner::{Event, Runner};
use crate::schema::{
    ApiError, CloudFrame, ExportRequest, Health, JobStatus, PlanetParams, PlanetSummary,
    SCHEMA_MAJOR,
};
use crate::store::Catalogue;
use crate::workers::Pool;

#[derive(Clone)]
pub struct AppState {
    pub runner: Arc<Runner>,
    pub pool: Arc<Pool>,
    pub catalogue: Catalogue,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/planets", get(list_planets).post(create_planet))
        .route("/planets/{planetId}", get(get_planet))
        .route("/jobs/{jobId}", get(job_status).delete(stop_job))
        .route("/jobs/{jobId}/events", get(job_events))
        .route("/jobs/{jobId}/steps", get(job_steps))
        .route("/jobs/{jobId}/steps/{step}/cloud", get(step_cloud))
        .route("/exports", post(start_export))
        .route("/exports/{exportId}", get(export_status))
        .route("/exports/{exportId}/archive", get(export_archive))
        .with_state(state)
}

fn err(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    (status, Json(ApiError::new(code, message))).into_response()
}

fn not_found(what: &str) -> Response {
    err(StatusCode::NOT_FOUND, "not_found", format!("no such {what}"))
}

// ---- meta ----------------------------------------------------------------

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        schema_major: SCHEMA_MAJOR,
        // No exporter is wired up. Reported, so the UI can hide the control
        // instead of offering a button that produces invented terrain.
        exporter: false,
    })
}

// ---- planets -------------------------------------------------------------

async fn list_planets(State(s): State<AppState>) -> Json<Vec<PlanetSummary>> {
    Json(s.catalogue.list().await)
}

async fn get_planet(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.catalogue.get(&id).await {
        Some(p) => Json(p).into_response(),
        None => not_found("planet"),
    }
}

async fn create_planet(State(s): State<AppState>, Json(params): Json<PlanetParams>) -> Response {
    if let Err(why) = params.validate() {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "invalid_params", why);
    }

    // Derived quantities come from PlanetBuilder. If it cannot be reached we fail
    // the request rather than return a planet with invented properties -- this
    // repo derives nothing, and a plausible number is the worst kind of wrong.
    let derived = match s.pool.derive(&params).await {
        Ok(v) => match serde_json::from_value(v.get("derived").cloned().unwrap_or(v)) {
            Ok(d) => d,
            Err(e) => {
                return err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "simulation_unavailable",
                    format!("the simulation returned properties this server could not read: {e}"),
                )
            }
        },
        Err(e) => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "simulation_unavailable",
                format!("could not derive this planet's properties: {e}"),
            )
        }
    };

    let job_id = match s.runner.start(&params).await {
        Ok(id) => id,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, "simulation_unavailable", e),
    };

    let planet = PlanetSummary {
        id: crate::store::new_id("pl"),
        unapplied_params: Runner::unapplied_params(&params),
        params,
        derived,
        created_at: crate::store::now_iso8601(),
        job_id: Some(job_id.clone()),
    };
    if let Err(e) = s.catalogue.put(&planet).await {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "catalogue_write_failed",
            format!("the run started but the planet could not be saved: {e}"),
        );
    }
    (StatusCode::CREATED, Json(serde_json::json!({ "planet": planet, "jobId": job_id })))
        .into_response()
}

// ---- jobs ----------------------------------------------------------------

async fn job_status(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.runner.get(&id).await {
        Some(job) => Json(job.status().await).into_response(),
        None => not_found("job"),
    }
}

async fn stop_job(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    if s.runner.stop(&id).await {
        StatusCode::ACCEPTED.into_response()
    } else {
        not_found("job")
    }
}

/// Notifications only. The client pulls the data it still wants.
async fn job_events(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    let Some(job) = s.runner.get(&id).await else {
        return Err(not_found("job"));
    };

    // Subscribe BEFORE sending the current status, so a status change between the
    // two is queued rather than missed.
    let rx = job.subscribe();
    let current = job.status().await;

    let initial = tokio_stream::once(Ok(sse_status(&current)));
    let live = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(Event::Status(st)) => Some(Ok(sse_status(&st))),
        Ok(Event::Step(step)) => Some(Ok(SseEvent::default()
            .event("step")
            .data(serde_json::json!({ "step": step }).to_string()))),
        // Lagged: this client fell behind the broadcast buffer. Dropping the
        // announcement is correct -- a newer one supersedes it, and the client
        // only ever wants the newest step anyway.
        Err(_) => None,
    });

    Ok(Sse::new(initial.chain(live)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

fn sse_status(st: &JobStatus) -> SseEvent {
    SseEvent::default()
        .event("status")
        .data(serde_json::to_string(st).unwrap_or_else(|_| "{}".into()))
}

async fn job_steps(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(job) = s.runner.get(&id).await else {
        return not_found("job");
    };
    let steps = job.run_dir.manifest().await.readable_steps();
    Json(serde_json::json!({ "steps": steps })).into_response()
}

async fn step_cloud(
    State(s): State<AppState>,
    Path((id, step)): Path<(String, u64)>,
) -> Response {
    let Some(job) = s.runner.get(&id).await else {
        return not_found("job");
    };

    // Refuse a format we do not understand rather than half-read it.
    if let Some(run) = job.run_dir.run_json().await {
        match run.schema_major() {
            Some(major) if major == SCHEMA_MAJOR => {}
            Some(major) => {
                return err(
                    StatusCode::CONFLICT,
                    "schema_major_unsupported",
                    format!(
                        "this run is schema MAJOR {major}; this server reads {SCHEMA_MAJOR}"
                    ),
                )
            }
            None => {
                return err(
                    StatusCode::CONFLICT,
                    "schema_major_unsupported",
                    "this run declares no schema_version, so its format cannot be trusted",
                )
            }
        }
    }

    // Only a closed part may be opened; the in-progress file is not readable.
    let Some(part) = job.run_dir.part_file_for(step).await else {
        return err(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("step {step} is not readable yet"),
        );
    };

    let value = match s.pool.read_step(&part, step).await {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "read_failed",
                format!("could not read step {step}: {e}"),
            )
        }
    };

    let elevation: Vec<f64> = value
        .get("elevation")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if elevation.is_empty() {
        return err(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("step {step} recorded no elevation field"),
        );
    }

    let t = if job.steps_total > 0 {
        (step as f64 / job.steps_total as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };

    Json(CloudFrame {
        step,
        t,
        elevation,
        // The simulation carries no water inventory, so no run records a sea
        // level. Null, never zero: the client draws absent as absent.
        sea_level: value.get("seaLevel").and_then(serde_json::Value::as_f64),
        schema_major: SCHEMA_MAJOR,
    })
    .into_response()
}

// ---- exports -------------------------------------------------------------

async fn start_export(Json(_req): Json<ExportRequest>) -> Response {
    // 501, not a stub archive. An exporter that returns invented terrain is worse
    // than one that says it does not exist: the file would look like a result.
    err(
        StatusCode::NOT_IMPLEMENTED,
        "exporter_unavailable",
        "no exporter is wired up yet, so no heightmap can be baked",
    )
}

async fn export_status(Path(_id): Path<String>) -> Response {
    not_found("export")
}

async fn export_archive(Path(_id): Path<String>) -> Response {
    not_found("export")
}
