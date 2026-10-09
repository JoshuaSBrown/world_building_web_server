//! The HTTP surface. Implements `openapi.yaml`, which is the contract.
//!
//! The routing, path and query extraction, request-body checking, and the response
//! types are GENERATED from the spec (`crate::generated::server`). This file
//! implements the four generated traits -- one per tag -- on `AppState`: what each
//! endpoint does, and nothing about how a request reaches it. A new endpoint in the
//! spec is a compile error here until its method is written.
//!
//! This layer knows about requests and responses. It does not read HDF5 (that is
//! `workers`), does not walk run directories (that is `store`), and does not know
//! how a simulation is started (that is `runner`). Nothing here computes a
//! physical quantity.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::response::sse::Event as SseEvent;
use axum::Router;
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};
use tokio_stream::StreamExt;

use crate::generated::server::{
    build_router, sse_response, CreatePlanetResponse, ExportArchiveResponse,
    ExportStatusResponse, ExportsApi, GetPlanetResponse, HealthResponse, JobEventsResponse,
    JobStatusResponse, JobStepsServerResponse, JobsApi, ListPlanetsServerResponse, MetaApi,
    PlanetsApi, StartExportResponse, StartRunResponse, StepCloudResponse, StopJobResponse,
};
use crate::runner::{Event, Runner};
use crate::schema::{
    ApiError, CloudFrame, CloudFrameDomains, CloudFrameFields, CreatePlanetResponse201,
    DomainPositions, FieldData, Health, HealthStatus, JobStatus, JobStepsResponse, PlanetParams,
    PlanetSummary, RunRef, RunRequest, RunSettings, StartExportRequest, StartRunResponse202,
    SCHEMA_MAJOR,
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
    build_router(state.clone(), state.clone(), state.clone(), state)
}

fn err(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(code, message)
}

fn not_found(what: &str) -> ApiError {
    err("not_found", format!("no such {what}"))
}

/// `None` for an empty list, so the field is left out exactly as before.
fn non_empty<T>(v: Vec<T>) -> Option<Vec<T>> {
    if v.is_empty() { None } else { Some(v) }
}

// ---- meta ----------------------------------------------------------------

#[async_trait::async_trait]
impl MetaApi for AppState {
    async fn health(&self) -> HealthResponse {
        HealthResponse::Ok(Health {
            status: HealthStatus::Ok,
            schema_major: SCHEMA_MAJOR,
            // The real defaults, read off the runner, so a form showing them cannot
            // drift from what a run actually starts with. `nPoints` is the planet's
            // own, so this one stands in for a body that has not been chosen yet.
            run_defaults: self.runner.defaults(DEFAULT_POINTS),
            // No exporter is wired up. Reported, so the UI can hide the control
            // instead of offering a button that produces invented terrain.
            exporter: false,
        })
    }
}

// ---- planets -------------------------------------------------------------

#[async_trait::async_trait]
impl PlanetsApi for AppState {
    async fn list_planets(&self) -> ListPlanetsServerResponse {
        ListPlanetsServerResponse::Ok(self.catalogue.list().await)
    }

    async fn get_planet(&self, planet_id: String) -> GetPlanetResponse {
        match self.catalogue.get(&planet_id).await {
            Some(p) => GetPlanetResponse::Ok(p),
            None => GetPlanetResponse::NotFound(not_found("planet")),
        }
    }

    /// The body has already been checked against `PlanetParams` in the spec --
    /// names, ranges, positivity -- before this runs; a request that broke it was
    /// refused with a 422 Problem.
    async fn create_planet(&self, params: PlanetParams) -> CreatePlanetResponse {
        // Derived quantities come from PlanetBuilder. If it cannot be reached we fail
        // the request rather than return a planet with invented properties -- this
        // repo derives nothing, and a plausible number is the worst kind of wrong.
        let derived = match self.pool.derive(&params).await {
            Ok(v) => match serde_json::from_value(v.get("derived").cloned().unwrap_or(v)) {
                Ok(d) => d,
                Err(e) => {
                    return CreatePlanetResponse::ServiceUnavailable(err(
                        "simulation_unavailable",
                        format!("the simulation returned properties this server could not read: {e}"),
                    ))
                }
            },
            Err(e) => {
                return CreatePlanetResponse::ServiceUnavailable(err(
                    "simulation_unavailable",
                    format!("could not derive this planet's properties: {e}"),
                ))
            }
        };

        // A planet's first run uses the point count it was created with. The
        // server's own defaults are not covered by the spec, so they are checked.
        let settings = self.runner.defaults(params.max_points);
        if let Err(why) = settings.validate() {
            return CreatePlanetResponse::InternalServerError(err(
                "run_defaults_invalid",
                format!("this server's run defaults are out of range: {why}"),
            ));
        }
        let job_id = match self.runner.start(&params, settings.clone()).await {
            Ok(id) => id,
            Err(e) => {
                return CreatePlanetResponse::ServiceUnavailable(err("simulation_unavailable", e))
            }
        };

        let now = crate::store::now_iso8601();
        let planet = PlanetSummary {
            id: crate::store::new_id("pl"),
            unapplied_params: non_empty(Runner::unapplied_params(&params)),
            params,
            derived,
            created_at: now.clone(),
            job_id: Some(job_id.clone()),
            runs: Some(vec![RunRef {
                kind: CORE_SURFACE_FORMATION.into(),
                job_id: job_id.clone(),
                started_at: now,
                settings: Some(settings),
            }]),
        };
        if let Err(e) = self.catalogue.put(&planet).await {
            return CreatePlanetResponse::InternalServerError(err(
                "catalogue_write_failed",
                format!("the run started but the planet could not be saved: {e}"),
            ));
        }
        CreatePlanetResponse::Created(CreatePlanetResponse201 { planet, job_id })
    }

    /// Start one simulation for a planet that already exists.
    ///
    /// Creating a planet starts its first run; this is how a second one begins --
    /// re-running a simulation, or running one that consumes what an earlier run
    /// produced. A kind this server cannot run never reaches here: the spec lists
    /// the runnable kinds, and anything else is refused with a 422 Problem.
    async fn start_run(&self, planet_id: String, req: RunRequest) -> StartRunResponse {
        let Some(mut planet) = self.catalogue.get(&planet_id).await else {
            return StartRunResponse::NotFound(not_found("planet"));
        };

        // What the caller asked for, falling back to the server's defaults for
        // anything it did not name. The planet's own point count is the default
        // point count -- it is where this body's runs start from. What the caller
        // named was range-checked by the spec; only a default can fail here.
        let d = self.runner.defaults(planet.params.max_points);
        let settings = RunSettings {
            n_points: req.n_points.unwrap_or(d.n_points),
            steps: req.steps.unwrap_or(d.steps),
            dt_myr: req.dt_myr.unwrap_or(d.dt_myr),
            checkpoint_every_steps: req.checkpoint_every_steps.unwrap_or(d.checkpoint_every_steps),
        };
        if let Err(why) = settings.validate() {
            return StartRunResponse::InternalServerError(err(
                "run_defaults_invalid",
                format!("this server's run defaults are out of range: {why}"),
            ));
        }

        let job_id = match self.runner.start(&planet.params, settings.clone()).await {
            Ok(v) => v,
            Err(e) => return StartRunResponse::ServiceUnavailable(err("simulation_unavailable", e)),
        };
        planet.runs.get_or_insert_with(Vec::new).push(RunRef {
            kind: req.kind.as_str().into(),
            job_id: job_id.clone(),
            started_at: crate::store::now_iso8601(),
            settings: Some(settings),
        });
        planet.job_id = Some(job_id.clone());
        if let Err(e) = self.catalogue.put(&planet).await {
            return StartRunResponse::InternalServerError(err(
                "catalogue_write_failed",
                format!("the run started but the planet could not be updated: {e}"),
            ));
        }
        StartRunResponse::Accepted(StartRunResponse202 { planet, job_id })
    }
}

// ---- jobs ----------------------------------------------------------------

#[async_trait::async_trait]
impl JobsApi for AppState {
    async fn job_status(&self, job_id: String) -> JobStatusResponse {
        match self.runner.get(&job_id).await {
            Some(job) => JobStatusResponse::Ok(job.status().await),
            None => JobStatusResponse::NotFound(not_found("job")),
        }
    }

    async fn stop_job(&self, job_id: String) -> StopJobResponse {
        if self.runner.stop(&job_id).await {
            StopJobResponse::Accepted
        } else {
            StopJobResponse::NotFound(not_found("job"))
        }
    }

    /// Notifications only. The client pulls the data it still wants.
    async fn job_events(&self, job_id: String) -> JobEventsResponse {
        let Some(job) = self.runner.get(&job_id).await else {
            return JobEventsResponse::NotFound(not_found("job"));
        };

        // Subscribe BEFORE sending the current status, so a status change between the
        // two is queued rather than missed.
        let rx = job.subscribe();
        let current = job.status().await;

        let initial = tokio_stream::once(Ok::<_, Infallible>(sse_status(&current)));
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

        JobEventsResponse::OkStream(sse_response(with_keep_alive(initial.chain(live))))
    }

    async fn job_steps(&self, job_id: String) -> JobStepsServerResponse {
        let Some(job) = self.runner.get(&job_id).await else {
            return JobStepsServerResponse::NotFound(not_found("job"));
        };
        let steps = job.run_dir.manifest().await.readable_steps();
        JobStepsServerResponse::Ok(JobStepsResponse { steps })
    }

    async fn step_cloud(
        &self,
        job_id: String,
        step: u64,
        fields: Option<String>,
    ) -> StepCloudResponse {
        let Some(job) = self.runner.get(&job_id).await else {
            return StepCloudResponse::NotFound(not_found("job"));
        };

        // Refuse a format we do not understand rather than half-read it.
        if let Some(run) = job.run_dir.run_json().await {
            match run.schema_major() {
                Some(major) if major == SCHEMA_MAJOR => {}
                Some(major) => {
                    return StepCloudResponse::Conflict(err(
                        "schema_major_unsupported",
                        format!("this run is schema MAJOR {major}; this server reads {SCHEMA_MAJOR}"),
                    ))
                }
                None => {
                    return StepCloudResponse::Conflict(err(
                        "schema_major_unsupported",
                        "this run declares no schema_version, so its format cannot be trusted",
                    ))
                }
            }
        }

        // Only a closed checkpoint may be opened; the in-progress file is not.
        let Some(checkpoint) = job.run_dir.checkpoint_file_for(step).await else {
            return StepCloudResponse::NotFound(err(
                "not_found",
                format!("step {step} is not readable yet"),
            ));
        };

        let value = match self.pool.read_step(&checkpoint, step, &field_names(fields.as_deref())).await {
            Ok(v) => v,
            Err(e) => {
                return StepCloudResponse::ServiceUnavailable(err(
                    "read_failed",
                    format!("could not read step {step}: {e}"),
                ))
            }
        };

        let elevation: Vec<f64> = value
            .get("elevation")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        if elevation.is_empty() {
            return StepCloudResponse::NotFound(err(
                "not_found",
                format!("step {step} recorded no elevation field"),
            ));
        }

        let t = if job.steps_total > 0 {
            (step as f64 / job.steps_total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // The fields, the positions of the domains they belong to, and the names the
        // run did not record -- relayed exactly as the worker read them off the file.
        // Nothing here fills a gap or renames a unit. A field or domain the worker
        // returned in a shape the spec does not allow is reported, not dropped.
        let fields: std::collections::BTreeMap<String, FieldData> =
            match relay(&value, "fields") {
                Ok(v) => v,
                Err(e) => return StepCloudResponse::ServiceUnavailable(err("read_failed", e)),
            };
        let domains: std::collections::BTreeMap<String, DomainPositions> =
            match relay(&value, "domains") {
                Ok(v) => v,
                Err(e) => return StepCloudResponse::ServiceUnavailable(err("read_failed", e)),
            };
        let available: Vec<String> = value
            .get("available")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let absent: Vec<String> = value
            .get("absent")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        StepCloudResponse::Ok(CloudFrame {
            step,
            t,
            elevation,
            // The simulation carries no water inventory, so no run records a sea
            // level. Null, never zero: the client draws absent as absent.
            sea_level: value.get("seaLevel").and_then(serde_json::Value::as_f64),
            schema_major: SCHEMA_MAJOR,
            time_myr: value.get("timeMyr").and_then(serde_json::Value::as_f64),
            fields: (!fields.is_empty())
                .then_some(CloudFrameFields { additional_properties: fields }),
            domains: (!domains.is_empty())
                .then_some(CloudFrameDomains { additional_properties: domains }),
            available: non_empty(available),
            absent: non_empty(absent),
        })
    }
}

/// The events, plus a `: keep-alive` comment every 15 s while the stream is open,
/// so a proxy does not close a quiet connection between steps.
///
/// Axum's own `Sse::keep_alive` would wrap the stream in a type the generated
/// `OkStream` does not accept, so the comments are added here instead: a task
/// forwards each event and, between them, a comment when the interval ticks. It
/// stops when the events end or the browser goes away.
fn with_keep_alive<S>(events: S) -> ReceiverStream<Result<SseEvent, Infallible>>
where
    S: futures_core::Stream<Item = Result<SseEvent, Infallible>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        let mut events = std::pin::pin!(events);
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        tick.tick().await; // the first tick is immediate; the first comment is not
        loop {
            let next = tokio::select! {
                event = events.next() => match event {
                    Some(event) => event,
                    None => break,
                },
                _ = tick.tick() => Ok(SseEvent::default().comment("keep-alive")),
            };
            if tx.send(next).await.is_err() {
                break;
            }
        }
    });
    ReceiverStream::new(rx)
}

fn sse_status(st: &JobStatus) -> SseEvent {
    SseEvent::default()
        .event("status")
        .data(serde_json::to_string(st).unwrap_or_else(|_| "{}".into()))
}

/// One map the worker read off the file, in the spec's shape. Absent is empty;
/// present but malformed is an error naming which map.
fn relay<T: serde::de::DeserializeOwned + Default>(
    value: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    match value.get(key) {
        None => Ok(T::default()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| format!("the run's `{key}` do not match the API's shape: {e}")),
    }
}

/// `?fields=elevation,plate_id` — the datasets this request wants drawn.
///
/// Named by their identifiers in the run file, because that is what makes a
/// number on screen traceable back to the array it came from. Omitted, a request
/// gets elevation alone: a movie of topography must not pay for every layer.
fn field_names(fields: Option<&str>) -> Vec<String> {
    let Some(raw) = fields else {
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

// ---- exports -------------------------------------------------------------

#[async_trait::async_trait]
impl ExportsApi for AppState {
    async fn start_export(&self, _body: StartExportRequest) -> StartExportResponse {
        // 501, not a stub archive. An exporter that returns invented terrain is worse
        // than one that says it does not exist: the file would look like a result.
        StartExportResponse::Status501(err(
            "exporter_unavailable",
            "no exporter is wired up yet, so no heightmap can be baked",
        ))
    }

    async fn export_status(&self, _export_id: String) -> ExportStatusResponse {
        ExportStatusResponse::NotFound(not_found("export"))
    }

    async fn export_archive(&self, _export_id: String) -> ExportArchiveResponse {
        ExportArchiveResponse::NotFound(not_found("export"))
    }
}
