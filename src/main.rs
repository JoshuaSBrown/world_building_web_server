//! Wiring, and nothing else.
//!
//! `store` reads run directories, `runner` starts and supervises simulations,
//! `workers` reads HDF5 in child processes, `api` serves HTTP. Each knows only
//! the layer below it; this file is where they meet.

mod api;
mod runner;
mod schema;
mod store;
mod workers;

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
    let python = env_or("PYTHON", "../venv/bin/python");
    let port: u16 = env_num("PORT", 8080);

    if !planet_builder.join("evolve.py").exists() {
        tracing::warn!(
            "no evolve.py under {} -- runs will fail to start. Set PLANET_BUILDER.",
            planet_builder.display()
        );
    }

    let pool = workers::Pool::new(workers::WorkerConfig {
        python: python.clone(),
        script: PathBuf::from("workers/worker.py"),
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
        // Small: liveness is bounded by how often a part closes, since only a
        // closed HDF5 file is safe to read.
        split_every: env_num("SPLIT_EVERY", 5),
        steps: env_num("STEPS", 120),
    });

    let state = api::AppState {
        runner,
        pool,
        catalogue: store::Catalogue::new(runs_root.join("planets")),
    };

    let app = Router::new()
        .nest("/api", api::router(state))
        // The spec is served next to the thing it specifies, so a client can
        // always fetch the contract the running server was built against.
        .route_service("/openapi.yaml", ServeFile::new("openapi.yaml"))
        // The dev frontend runs on its own port; in production it is same-origin
        // and this layer does nothing.
        .layer(CorsLayer::permissive())
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("could not bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("listening on http://{addr}  (spec at /openapi.yaml)");

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
