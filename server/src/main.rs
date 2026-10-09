//! Wiring, and nothing else.
//!
//! `store` reads run directories, `runner` starts and supervises simulations,
//! `workers` reads HDF5 in child processes, `api` serves HTTP. Each knows only
//! the layer below it; this file is where they meet.

mod api;
mod launch_config;
mod runner;
mod store;
mod workers;

// The wire contract lives in the library (`lib.rs`) so `tests/` can reach it;
// imported here so the modules above keep calling it `crate::schema`.
use world_building_web_server::{generated, schema};

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

/// Read an env var, or fall back.
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let planet_builder = PathBuf::from(env_or("PLANET_BUILDER", "../PlanetBuilder"));
    let runs_root = PathBuf::from(env_or("RUNS_DIR", "./runs"));
    // Where the launch config of every run is written. Its own directory, not the
    // run's: a config is this server's output and the run directory belongs to the
    // writer, so collecting them is a deployment's choice to make.
    let configs_dir = PathBuf::from(env_or("CONFIGS_DIR", "./configs"));
    let schema_repo = PathBuf::from(env_or("RUN_SCHEMA", "../planet_run_schema"));
    let python = env_or("PYTHON", "../venv/bin/python");
    let port: u16 = env_num("PORT", 8080);

    if !planet_builder.join("evolve.py").exists() {
        tracing::warn!(
            "no evolve.py under {} -- runs will fail to start. Set PLANET_BUILDER.",
            planet_builder.display()
        );
    }
    // A config nothing checked is the failure the config was built to end, so this
    // is said at startup rather than discovered at the first launch.
    if !launch_config::validator_path(&schema_repo).exists() {
        tracing::warn!(
            "no validate_config.py under {} -- runs will refuse to start, because a \
             launch config nobody checked is how a parameter gets dropped unnoticed. \
             Set RUN_SCHEMA.",
            schema_repo.display()
        );
    }

    // Refused here rather than written into every config and rejected by the
    // schema at the first launch.
    let dt_myr: f64 = env_num("DT_MYR", 8.0);
    if !(dt_myr.is_finite() && dt_myr > 0.0) {
        tracing::error!("DT_MYR must be a positive number of millions of years, got {dt_myr}");
        std::process::exit(1);
    }

    let worker_script = PathBuf::from(env_or("WORKER_SCRIPT", "scripts/worker.py"));
    // Every read of a part file goes through this script, so a wrong path is a
    // server that starts and then fails every request. Said once, here.
    if !worker_script.exists() {
        tracing::warn!(
            "no worker script at {} -- every HDF5 read will fail. Set WORKER_SCRIPT.",
            worker_script.display()
        );
    }

    let pool = workers::Pool::new(workers::WorkerConfig {
        python: python.clone(),
        script: worker_script,
        planet_builder: planet_builder.clone(),
        size: env_num("WORKERS", 4),
    });
    // Warm before serving: a cold `import h5py` costs a few hundred milliseconds,
    // which is invisible per step and very visible while scrubbing a timeline.
    pool.warm().await;

    let runner = runner::Runner::new(runner::RunnerConfig {
        python,
        planet_builder,
        runs_root: runs_root.clone(),
        configs_dir,
        schema_repo,
        // Small: liveness is bounded by how often a part closes, since only a
        // closed HDF5 file is safe to read.
        split_every: env_num("SPLIT_EVERY", 5),
        steps: env_num("STEPS", 120),
        // The physics must not depend on this; it is exposed so convergence can
        // be exercised and a run traded against wall clock.
        dt_myr,
    });

    let state = api::AppState {
        runner,
        pool,
        catalogue: store::Catalogue::new(runs_root.join("planets")),
    };

    let app = Router::new()
        .nest("/api/v1", api::router(state))
        // The spec is served next to the thing it specifies, so a client can
        // always fetch the contract the running server was built against.
        .route_service("/openapi.yaml", ServeFile::new(env_or("OPENAPI", "api/openapi.yaml")))
        // The dev frontend runs on its own port; in production it is same-origin
        // and this layer does nothing.
        .layer(CorsLayer::permissive())
        .layer(tower_http::trace::TraceLayer::new_for_http());

    // Loopback by default: a development server has no business on every
    // interface. A container has to bind 0.0.0.0 to be reachable at all, so the
    // compose stack sets BIND explicitly rather than this default being widened
    // for everyone.
    let bind = env_or("BIND", "127.0.0.1");
    let addr: std::net::SocketAddr = match format!("{bind}:{port}").parse() {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("BIND={bind} is not an address this server can bind: {e}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("could not bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("listening on http://{addr}  (API at /api/v1, spec at /openapi.yaml)");

    let server = axum::serve(listener, app);
    if let Err(e) = server
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await
    {
        tracing::error!("server error: {e}");
    }
}

/// Keeps `Arc` in scope for the module docs above; also a compile-time check that
/// the layering compiles as described.
#[allow(dead_code)]
fn _layering_is_as_documented(_: Arc<runner::Runner>, _: Arc<workers::Pool>) {}
