//! The HTTP surface. Implements `openapi.yaml`, which is the contract.
//!
//! This layer knows about requests and responses. It does not read HDF5 (that is
//! `workers`), does not walk run directories (that is `store`), and does not know
//! how a simulation is started (that is `runner`). Nothing here computes a
//! physical quantity.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
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
    RunRef, RunRequest, RunSettings, RUNNABLE_KINDS, SCHEMA_MAJOR,
};

/// The simulation every planet starts with, and the only one that exists.
const CORE_SURFACE_FORMATION: &str = "core-surface-formation";

/// The point count quoted when no planet is in hand. A planet's own creation
/// value is what a run actually defaults to.
const DEFAULT_POINTS: u32 = 500;
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
        .route("/planets/{planetId}/runs", post(start_run))
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

async fn health(State(s): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        schema_major: SCHEMA_MAJOR,
        // The real defaults, read off the runner, so a form showing them cannot
        // drift from what a run actually starts with. `nPoints` is the planet's
        // own, so this one stands in for a body that has not been chosen yet.
        run_defaults: s.runner.defaults(DEFAULT_POINTS),
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

    // A planet's first run uses the point count it was created with.
    let settings = s.runner.defaults(params.max_points);
    if let Err(why) = settings.validate() {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "invalid_params", why);
    }
    let job_id = match s.runner.start(&params, settings).await {
        Ok(id) => id,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, "simulation_unavailable", e),
    };

    let now = crate::store::now_iso8601();
    let planet = PlanetSummary {
        id: crate::store::new_id("pl"),
        unapplied_params: Runner::unapplied_params(&params),
        params,
        derived,
        created_at: now.clone(),
        job_id: Some(job_id.clone()),
        runs: vec![RunRef {
            kind: CORE_SURFACE_FORMATION.into(),
            job_id: job_id.clone(),
            started_at: now,
            settings: Some(settings),
        }],
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

/// Start one simulation for a planet that already exists.
///
/// Creating a planet starts its first run; this is how a second one begins --
/// re-running a simulation, or running one that consumes what an earlier run
/// produced. A kind this server cannot run is REFUSED, with the reason, rather
/// than accepted and never started.
async fn start_run(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RunRequest>,
) -> Response {
    let Some(mut planet) = s.catalogue.get(&id).await else {
        return not_found("planet");
    };
    if !RUNNABLE_KINDS.contains(&req.kind.as_str()) {
        return err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "simulation_unavailable",
            format!(
                "this server cannot run {:?}. It runs: {}. A simulation that does not \
                 exist is refused rather than queued, so a planet is never reported as \
                 having been through something nothing ran.",
                req.kind,
                RUNNABLE_KINDS.join(", "),
            ),
        );
    }

    // What the caller asked for, falling back to the server's defaults for
    // anything it did not name. The planet's own point count is the default
    // point count -- it is where this body's runs start from.
    let d = s.runner.defaults(planet.params.max_points);
    let settings = RunSettings {
        n_points: req.n_points.unwrap_or(d.n_points),
        steps: req.steps.unwrap_or(d.steps),
        dt_myr: req.dt_myr.unwrap_or(d.dt_myr),
        checkpoint_every_steps: req.checkpoint_every_steps.unwrap_or(d.checkpoint_every_steps),
    };
    if let Err(why) = settings.validate() {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "invalid_params", why);
    }

    let job_id = match s.runner.start(&planet.params, settings).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, "simulation_unavailable", e),
    };
    planet.runs.push(RunRef {
        kind: req.kind,
        job_id: job_id.clone(),
        started_at: crate::store::now_iso8601(),
        settings: Some(settings),
    });
    planet.job_id = Some(job_id.clone());
    if let Err(e) = s.catalogue.put(&planet).await {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "catalogue_write_failed",
            format!("the run started but the planet could not be updated: {e}"),
        );
    }
    (StatusCode::ACCEPTED, Json(serde_json::json!({ "planet": planet, "jobId": job_id })))
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

/// `?fields=elevation,plate_id` — the datasets this request wants drawn.
///
/// Named by their identifiers in the run file, because that is what makes a
/// number on screen traceable back to the array it came from. Omitted, a request
/// gets elevation alone: a movie of topography must not pay for every layer.
#[derive(Debug, serde::Deserialize)]
struct FieldQuery {
    #[serde(default)]
    fields: Option<String>,
}

impl FieldQuery {
    fn names(&self) -> Vec<String> {
        let Some(raw) = self.fields.as_deref() else {
            return vec!["elevation".into()];
        };
        let names: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            // A dataset name, optionally qualified by its group -- `position`
            // lives in three of them, so `boundaries/position` must be sayable.
            // One slash, and nothing else that could walk out of the step group.
            .filter(|s| {
                s.matches('/').count() <= 1
                    && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '/')
                    && !s.starts_with('/') && !s.ends_with('/')
            })
            .map(str::to_owned)
            .collect();
        if names.is_empty() { vec!["elevation".into()] } else { names }
    }
}

async fn step_cloud(
    State(s): State<AppState>,
    Path((id, step)): Path<(String, u64)>,
    Query(q): Query<FieldQuery>,
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

    // Only a closed checkpoint may be opened; the in-progress file is not.
    let Some(checkpoint) = job.run_dir.checkpoint_file_for(step).await else {
        return err(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("step {step} is not readable yet"),
        );
    };

    let value = match s.pool.read_step(&checkpoint, step, &q.names()).await {
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

    // The fields, the positions of the domains they belong to, and the names the
    // run did not record -- relayed exactly as the worker read them off the file.
    // Nothing here fills a gap or renames a unit.
    let fields = value
        .get("fields")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let domains = value
        .get("domains")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let available = value
        .get("available")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let absent = value
        .get("absent")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Json(CloudFrame {
        step,
        t,
        elevation,
        // The simulation carries no water inventory, so no run records a sea
        // level. Null, never zero: the client draws absent as absent.
        sea_level: value.get("seaLevel").and_then(serde_json::Value::as_f64),
        schema_major: SCHEMA_MAJOR,
        time_myr: value.get("timeMyr").and_then(serde_json::Value::as_f64),
        fields,
        domains,
        available,
        absent,
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
