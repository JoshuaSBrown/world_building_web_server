//! Starting and supervising simulation runs.
//!
//! A run is a **subprocess**, never an in-process call. Two things follow, both
//! deliberate: this crate never imports `tectonics` (siblings do not import
//! siblings), and a simulation that crashes cannot take the server down.
//!
//! The server may start a run and may stop one. **It may never steer one.**
//! Nothing here writes into a running simulation, because feeding the display
//! back into the physics would destroy both the pure-observer guarantee and
//! seeded reproducibility.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};

use crate::schema::{JobStatus, PlanetParams};
use crate::store::RunDir;

/// What goes down the SSE stream. Notifications only -- never a payload.
#[derive(Debug, Clone)]
pub enum Event {
    Status(JobStatus),
    /// A recorded step became *readable*: its part file is closed and listed.
    Step(u64),
}

pub struct Job {
    pub id: String,
    pub run_dir: RunDir,
    pub steps_total: u64,
    status: Mutex<JobStatus>,
    tx: broadcast::Sender<Event>,
    /// Set once, so a stop request can find the process.
    pid: Mutex<Option<u32>>,
}

impl Job {
    pub async fn status(&self) -> JobStatus {
        self.status.lock().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    async fn set_status(&self, next: JobStatus) {
        *self.status.lock().await = next.clone();
        // A send with no subscribers is not an error: nobody is watching yet.
        let _ = self.tx.send(Event::Status(next));
    }
}

pub struct RunnerConfig {
    pub python: String,
    /// Directory holding `evolve.py`.
    pub planet_builder: PathBuf,
    /// Parent of every run directory.
    pub runs_root: PathBuf,
    /// Iterations per part file. Small keeps the viewer close to live; large
    /// keeps the file count down. A configuration knob, not a design commitment.
    pub split_every: u32,
    pub steps: u64,
}

pub struct Runner {
    cfg: RunnerConfig,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Runner {
    pub fn new(cfg: RunnerConfig) -> Arc<Self> {
        Arc::new(Self { cfg, jobs: Mutex::new(HashMap::new()) })
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.lock().await.get(id).cloned()
    }

    /// Parameters the simulation's command line does not accept yet.
    ///
    /// Returned so the API can report them. A parameter a user set and the run
    /// silently ignored is worse than one refused: the planet would come back
    /// looking configured when it was not.
    pub fn unapplied_params(_p: &PlanetParams) -> Vec<String> {
        // `evolve.py` takes: seed, steps, dt, points, level, out, h5-every,
        // split, figs, temp-figs. Everything below is stored with the planet and
        // has nowhere to go until the CLI grows an option for it.
        vec![
            "diameterM".into(),
            "bulkDensity".into(),
            "coreFraction".into(),
            "mantlePotentialK".into(),
            "insolation".into(),
            "ageGyr".into(),
            "waterGelM".into(),
        ]
    }

    /// Start a run for `params`, returning its job id.
    pub async fn start(&self, params: &PlanetParams) -> Result<String, String> {
        let id = crate::store::new_id("job");
        let root = self.cfg.runs_root.join(&id);
        tokio::fs::create_dir_all(root.join("parts"))
            .await
            .map_err(|e| format!("could not create the run directory: {e}"))?;

        let seed = params.stable_seed();
        // The run records the integer seed it was actually given, so reproducing
        // it never depends on the text-to-integer mapping staying the same.
        let run_json = serde_json::json!({
            "schema_version": format!("{}.0", crate::schema::SCHEMA_MAJOR),
            "steps_total": self.cfg.steps,
            "seed_int": seed,
            "split_every": self.cfg.split_every,
            "params": params,
            "unapplied_params": Self::unapplied_params(params),
        });
        tokio::fs::write(
            root.join("run.json"),
            serde_json::to_vec_pretty(&run_json).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| format!("could not write run.json: {e}"))?;

        let log = std::fs::File::create(root.join("run.log"))
            .map_err(|e| format!("could not open run.log: {e}"))?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;

        let mut child = Command::new(&self.cfg.python)
            .arg(self.cfg.planet_builder.join("evolve.py"))
            .arg("--seed").arg(seed.to_string())
            .arg("--steps").arg(self.cfg.steps.to_string())
            .arg("--level").arg(params.grid_level.to_string())
            .arg("--split").arg(self.cfg.split_every.to_string())
            .arg("--out").arg(root.join("parts").join("run.h5"))
            .current_dir(&self.cfg.planet_builder)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .kill_on_drop(false)
            .spawn()
            .map_err(|e| format!("could not start the simulation: {e}"))?;

        let (tx, _) = broadcast::channel(256);
        let job = Arc::new(Job {
            id: id.clone(),
            run_dir: RunDir::new(root),
            steps_total: self.cfg.steps,
            status: Mutex::new(JobStatus::Queued { position: 0 }),
            tx,
            pid: Mutex::new(child.id()),
        });
        self.jobs.lock().await.insert(id.clone(), job.clone());

        job.set_status(JobStatus::Running {
            stage: "starting".into(),
            progress: 0.0,
            step: 0,
        })
        .await;

        // Supervisor: the process's own outcome.
        let supervised = job.clone();
        let started = Instant::now();
        tokio::spawn(async move {
            let status = match child.wait().await {
                Ok(s) if s.success() => JobStatus::Complete {
                    elapsed_seconds: started.elapsed().as_secs_f64(),
                },
                Ok(s) => JobStatus::Failed {
                    code: format!("exit_{}", s.code().unwrap_or(-1)),
                },
                Err(e) => {
                    tracing::error!("waiting on the simulation failed: {e}");
                    JobStatus::Failed { code: "wait_failed".into() }
                }
            };
            supervised.set_status(status).await;
        });

        // Watcher: what the run has published.
        tokio::spawn(watch_manifest(job.clone()));
        Ok(id)
    }

    /// Ask a run to stop. The only control this server has over a simulation.
    pub async fn stop(&self, id: &str) -> bool {
        let Some(job) = self.get(id).await else { return false };
        let pid = *job.pid.lock().await;
        let Some(pid) = pid else { return false };
        // SIGTERM, so the writer gets the chance to close its current part file
        // and leave a readable run behind.
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .await;
        true
    }
}

/// Poll the manifest and announce steps as they become readable.
///
/// Polling rather than inotify: it is a few lines instead of a dependency, it
/// behaves the same over a network filesystem, and at this cadence the cost is
/// noise. The manifest is append-only, so re-reading it is always safe.
async fn watch_manifest(job: Arc<Job>) {
    const POLL: Duration = Duration::from_millis(250);
    let mut announced: u64 = 0;

    loop {
        let manifest = job.run_dir.manifest().await;

        for step in manifest.readable_steps() {
            if step >= announced {
                announced = step + 1;
                let _ = job.tx.send(Event::Step(step));
            }
        }

        // Progress follows the SERIES, which advances every recorded iteration,
        // rather than the readable steps, which advance a part at a time. The bar
        // would otherwise jump in `split_every` increments and look stuck between.
        if let Some(last) = manifest.last_step() {
            if matches!(job.status().await, JobStatus::Running { .. }) {
                let progress = if job.steps_total > 0 {
                    (last as f64 / job.steps_total as f64).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                job.set_status(JobStatus::Running {
                    stage: "evolving".into(),
                    progress,
                    step: last,
                })
                .await;
            }
        }

        if !matches!(job.status().await, JobStatus::Running { .. } | JobStatus::Queued { .. }) {
            // One last pass has already run above, so anything the writer flushed
            // on its way out has been announced.
            break;
        }
        tokio::time::sleep(POLL).await;
    }
}
