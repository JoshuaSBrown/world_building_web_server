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

use crate::launch_config::{self, LaunchConfig};
use crate::schema::{JobStatus, PlanetParams, RunSettings};
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
    /// Where the generated launch configs are written. Separate from the run
    /// directory on purpose: the run directory belongs to the writer and its
    /// layout is the run format's, while a config is this server's own output
    /// and a user may well want them collected somewhere they can be read, kept,
    /// or replayed by hand.
    pub configs_dir: PathBuf,
    /// The `planet_run_schema` checkout, whose validator checks a config before
    /// a subprocess is spawned.
    pub schema_repo: PathBuf,
    /// Iterations per part file. Small keeps the viewer close to live; large
    /// keeps the file count down. A configuration knob, not a design commitment.
    /// This is the config's `checkpoint_every_steps`: one knob, one meaning.
    pub split_every: u32,
    pub steps: u64,
    /// Millions of years per step. Exposed so convergence can be exercised and a
    /// run traded against wall clock, never to tune an outcome.
    pub dt_myr: f64,
}

/// How long a `running` heartbeat may go quiet before the run counts as dead.
///
/// The writer beats every recorded iteration, and a step of a coarse run takes
/// seconds; a minute of silence is a process that is not coming back.
const STALE_HEARTBEAT_SECONDS: i64 = 60;

pub struct Runner {
    cfg: RunnerConfig,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Runner {
    pub fn new(cfg: RunnerConfig) -> Arc<Self> {
        Arc::new(Self { cfg, jobs: Mutex::new(HashMap::new()) })
    }

    /// A job, live or recovered from its run directory.
    ///
    /// **A view is a function of the files.** A run's whole state is on disk, so
    /// a job the server has never heard of -- because it restarted, or because
    /// the run predates this process -- is rebuilt from `status.json` rather than
    /// reported missing. Without this, every planet in the catalogue became
    /// unviewable the moment the server was restarted.
    pub async fn get(&self, id: &str) -> Option<Arc<Job>> {
        if let Some(job) = self.jobs.lock().await.get(id).cloned() {
            return Some(job);
        }
        self.recover(id).await
    }

    /// Rebuild a job from what its directory says. Never invents a number.
    async fn recover(&self, id: &str) -> Option<Arc<Job>> {
        if !crate::store::is_safe_id(id) {
            return None;
        }
        let root = self.cfg.runs_root.join(id);
        let run_dir = RunDir::new(root);
        let status = run_dir.status().await?;
        let steps_total = status.steps_total.unwrap_or(self.cfg.steps);

        // A `running` state this process is not running is a run whose writer
        // stopped: the format says a stale heartbeat is how a reader tells, and
        // guessing "still going" would leave a viewer waiting forever.
        let stale = status
            .heartbeat_age(&crate::store::now_iso8601())
            .is_none_or(|age| age > STALE_HEARTBEAT_SECONDS);

        let recovered = match status.state.as_str() {
            "complete" => JobStatus::Complete {
                elapsed_seconds: status.elapsed_seconds().unwrap_or(f64::NAN),
                steps_total,
            },
            "failed" => JobStatus::Failed { code: "failed".into(), steps_total },
            "cancelled" => JobStatus::Cancelled {
                step: status.last_step.unwrap_or(0), steps_total,
            },
            _ if stale => JobStatus::Failed { code: "interrupted".into(), steps_total },
            _ => JobStatus::Running {
                stage: "evolving".into(),
                progress: status.last_step.map_or(0.0, |s| {
                    if steps_total > 0 { (s as f64 / steps_total as f64).clamp(0.0, 1.0) } else { 0.0 }
                }),
                step: status.last_step.unwrap_or(0),
                steps_total,
            },
        };

        let (tx, _) = broadcast::channel(256);
        let job = Arc::new(Job {
            id: id.to_string(),
            run_dir,
            steps_total,
            status: Mutex::new(recovered),
            tx,
            // No process to signal: this server did not start it.
            pid: Mutex::new(None),
        });
        self.jobs.lock().await.insert(id.to_string(), job.clone());
        // A run still being written by someone else keeps being watched, so a
        // reload during a run picks the stream back up.
        if matches!(job.status().await, JobStatus::Running { .. }) {
            tokio::spawn(watch_manifest(job.clone()));
        }
        Some(job)
    }

    /// Parameters the launch config has no key for.
    ///
    /// Returned so the API can report them. A parameter a user set and the run
    /// silently ignored is worse than one refused: the planet would come back
    /// looking configured when it was not.
    pub fn unapplied_params(_p: &PlanetParams) -> Vec<String> {
        // The config carries eleven keys, and everything else stays a default in
        // the physics code until there is a stated reason to expose it. These two
        // are stored with the planet and reach no key:
        //
        //   ageGyr    -- the run starts from a hot start and dates itself from
        //                steps * dt_myr; there is no key for starting elsewhere.
        //   waterGelM -- the simulation carries no water inventory at all, so
        //                there is nothing for a volatile budget to configure.
        vec!["ageGyr".into(), "waterGelM".into()]
    }

    /// What a run is started with when the caller names nothing.
    ///
    /// The planet supplies the point count it was created with; everything else
    /// is the server's own class-(b) choice.
    pub fn defaults(&self, n_points: u32) -> RunSettings {
        RunSettings {
            n_points,
            steps: self.cfg.steps,
            dt_myr: self.cfg.dt_myr,
            checkpoint_every_steps: self.cfg.split_every,
        }
    }

    /// Start a run for `params` with `settings`, returning its job id.
    pub async fn start(
        &self,
        params: &PlanetParams,
        settings: RunSettings,
    ) -> Result<String, String> {
        let id = crate::store::new_id("job");
        let root = self.cfg.runs_root.join(&id);
        tokio::fs::create_dir_all(root.join("parts"))
            .await
            .map_err(|e| format!("could not create the run directory: {e}"))?;
        // Absolute from here on: the simulation is a subprocess with its own
        // working directory, and a relative path in the config would resolve
        // against that instead of against this server.
        let root = tokio::fs::canonicalize(&root)
            .await
            .map_err(|e| format!("could not resolve the run directory: {e}"))?;

        let seed = params.stable_seed();
        let config_path = self.write_config(&id, params, settings, &root).await?;

        // The run records the integer seed it was actually given, so reproducing
        // it never depends on the text-to-integer mapping staying the same, and
        // the config it was launched from, which is the whole of its input.
        let run_json = serde_json::json!({
            "schema_version": format!("{}.0", crate::schema::SCHEMA_MAJOR),
            "steps_total": settings.steps,
            "seed_int": seed,
            "split_every": settings.checkpoint_every_steps,
            "settings": settings,
            "launch_config": config_path.display().to_string(),
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

        // The config is the ONLY input. No flag beside it shapes the run, so a
        // parameter can never be set somewhere the simulation forgets to read.
        let mut child = Command::new(&self.cfg.python)
            .arg(self.cfg.planet_builder.join("evolve.py"))
            .arg("--config").arg(&config_path)
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
            steps_total: settings.steps,
            status: Mutex::new(JobStatus::Queued {
                position: 0,
                steps_total: settings.steps,
            }),
            tx,
            pid: Mutex::new(child.id()),
        });
        self.jobs.lock().await.insert(id.clone(), job.clone());

        job.set_status(JobStatus::Running {
            stage: "starting".into(),
            progress: 0.0,
            step: 0,
            steps_total: settings.steps,
        })
        .await;

        // Supervisor: the process's own outcome.
        let supervised = job.clone();
        let steps_total = settings.steps;
        let started = Instant::now();
        tokio::spawn(async move {
            let status = match child.wait().await {
                // The WRITER says whether a run finished or was stopped, and it
                // says so in `status.json`. An exit code cannot: a run asked to
                // stop exits 0 because it did exactly what it was told, so
                // trusting the code alone would report every cancellation as a
                // completed planet.
                Ok(s) if s.success() => match supervised.run_dir.status().await {
                    Some(st) if st.state == "cancelled" => JobStatus::Cancelled {
                        step: st.last_step.unwrap_or(0), steps_total,
                    },
                    _ => JobStatus::Complete {
                        elapsed_seconds: started.elapsed().as_secs_f64(),
                        steps_total,
                    },
                },
                Ok(s) => JobStatus::Failed {
                    code: format!("exit_{}", s.code().unwrap_or(-1)),
                    steps_total,
                },
                Err(e) => {
                    tracing::error!("waiting on the simulation failed: {e}");
                    JobStatus::Failed { code: "wait_failed".into(), steps_total }
                }
            };
            supervised.set_status(status).await;
        });

        // Watcher: what the run has published.
        tokio::spawn(watch_manifest(job.clone()));
        Ok(id)
    }

    /// Write this run's launch config, and check it before anything is spawned.
    ///
    /// The file lands in `configs_dir`, named for the job it launches, so the
    /// input to every run is collected in one place a person can read and replay
    /// by hand: `python evolve.py --config <that file>` reproduces the run.
    ///
    /// It is checked here as well as by `evolve.py` on read. Both sides run the
    /// same validator: this side turns a bad config into an answer to the
    /// request, instead of a subprocess that dies seconds later into a log file.
    async fn write_config(
        &self,
        job_id: &str,
        params: &PlanetParams,
        settings: RunSettings,
        run_dir: &std::path::Path,
    ) -> Result<PathBuf, String> {
        tokio::fs::create_dir_all(&self.cfg.configs_dir)
            .await
            .map_err(|e| format!("could not create the config directory: {e}"))?;
        let dir = tokio::fs::canonicalize(&self.cfg.configs_dir)
            .await
            .map_err(|e| format!("could not resolve the config directory: {e}"))?;

        let config = LaunchConfig {
            planet_name: params.name.clone(),
            seed_text: params.seed.clone(),
            seed: params.stable_seed(),
            steps: settings.steps,
            dt_myr: settings.dt_myr,
            n_points: settings.n_points,
            // The request states a diameter in metres and the key carries
            // kilometres in its name. The one conversion, done once.
            diameter_km: params.diameter_m / 1.0e3,
            start_mantle_temperature_k: params.start_mantle_temperature_k,
            checkpoint_every_steps: settings.checkpoint_every_steps,
            run_dir: run_dir.to_path_buf(),
            output_path: PathBuf::from("parts").join("run.h5"),
        };

        let path = dir.join(format!("{job_id}.toml"));
        tokio::fs::write(&path, config.to_toml())
            .await
            .map_err(|e| format!("could not write the launch config: {e}"))?;
        launch_config::validate(&self.cfg.python, &self.cfg.schema_repo, &path).await?;
        tracing::info!("launch config for {job_id}: {}", path.display());
        Ok(path)
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

        // Progress is what the RUN says it has done -- `status.json`'s `last_step`,
        // rewritten every recorded iteration. Not the readable steps, which
        // advance a part at a time: a bar driven by those would jump in
        // `split_every` increments and look stuck in between.
        if let Some(last) = job.run_dir.status().await.and_then(|s| s.last_step) {
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
                    steps_total: job.steps_total,
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
