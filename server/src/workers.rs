//! A warm pool of Python worker processes.
//!
//! This is the module that exists because of one fact about HDF5: `libhdf5` is a
//! C library that takes **one global lock per process**, so threads reading it do
//! not run in parallel however many files they open. Separate processes do not
//! contend at all.
//!
//! So reads happen in child processes that already have `h5py` imported, and this
//! binary never links `libhdf5` -- no C dependency, no cross-compilation problem,
//! and a corrupt file kills one worker instead of the server.
//!
//! **Warm, not spawned per request.** A cold Python process paying `import h5py`
//! costs a few hundred milliseconds: invisible when a step lands every few
//! seconds, painfully visible while scrubbing a timeline.
//!
//! The protocol is one JSON request per line in, one JSON response per line out.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

pub struct WorkerConfig {
    /// Interpreter to run the worker with.
    pub python: String,
    /// `scripts/worker.py`.
    pub script: PathBuf,
    /// Prepended to PYTHONPATH so the worker can `import tectonics`.
    pub planet_builder: PathBuf,
    /// Upper bound on live workers.
    pub size: usize,
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Worker {
    async fn spawn(cfg: &WorkerConfig) -> std::io::Result<Self> {
        let mut child = Command::new(&cfg.python)
            .arg(&cfg.script)
            .env("PYTHONPATH", &cfg.planet_builder)
            // unbuffered: a line written by the worker must arrive now, not when
            // some block fills, or every request appears to hang
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout was piped"));
        Ok(Self { child, stdin, stdout })
    }

    /// One request, one response. An error here means the worker is not reusable.
    async fn call(&mut self, req: &Value) -> Result<Value, String> {
        let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("worker stdin: {e}"))?;
        self.stdin.flush().await.map_err(|e| format!("worker flush: {e}"))?;

        let mut out = String::new();
        let n = self
            .stdout
            .read_line(&mut out)
            .await
            .map_err(|e| format!("worker stdout: {e}"))?;
        if n == 0 {
            return Err("worker exited without answering".into());
        }
        serde_json::from_str(&out).map_err(|e| format!("worker sent invalid JSON: {e}"))
    }
}

/// Hands out warm workers, and quietly discards ones that have died.
pub struct Pool {
    cfg: WorkerConfig,
    idle: Mutex<Vec<Worker>>,
    /// Bounds live workers, including those checked out.
    permits: Arc<tokio::sync::Semaphore>,
}

impl Pool {
    pub fn new(cfg: WorkerConfig) -> Arc<Self> {
        let permits = Arc::new(tokio::sync::Semaphore::new(cfg.size));
        Arc::new(Self { cfg, idle: Mutex::new(Vec::new()), permits })
    }

    /// Bring the pool up before the first request, so nobody pays cold start.
    pub async fn warm(&self) {
        let mut idle = self.idle.lock().await;
        for _ in 0..self.cfg.size {
            match Worker::spawn(&self.cfg).await {
                Ok(w) => idle.push(w),
                Err(e) => {
                    tracing::warn!("could not start a worker: {e}");
                    break;
                }
            }
        }
        tracing::info!("worker pool warm: {} process(es)", idle.len());
    }

    /// Run one request on a worker.
    ///
    /// A worker that fails is dropped rather than returned to the pool: a process
    /// that has answered badly once has no state worth trusting.
    pub async fn call(&self, req: Value) -> Result<Value, String> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| "worker pool is shutting down".to_string())?;

        let mut worker = match self.idle.lock().await.pop() {
            Some(w) => w,
            None => Worker::spawn(&self.cfg)
                .await
                .map_err(|e| format!("could not start a worker: {e}"))?,
        };

        match worker.call(&req).await {
            Ok(v) => {
                self.idle.lock().await.push(worker);
                if let Some(err) = v.get("error").and_then(Value::as_str) {
                    return Err(err.to_string());
                }
                Ok(v)
            }
            Err(e) => {
                let _ = worker.child.start_kill();
                Err(e)
            }
        }
    }

    /// Derived planet properties, computed by `PlanetBuilder` and relayed.
    ///
    /// The server does not calculate gravity, mass or cell spacing. Those are
    /// physics, and physics lives on the other side of this boundary.
    pub async fn derive(&self, params: &crate::schema::PlanetParams) -> Result<Value, String> {
        self.call(serde_json::json!({
            "op": "derive",
            "params": params,
        }))
        .await
    }

    /// One recorded step, out of a closed part file.
    ///
    /// `fields` names the datasets the display wants. Asking for only what is
    /// drawn is what keeps a movie of elevation cheap: the run records twenty
    /// arrays per point and a frame needs one of them.
    pub async fn read_step(
        &self,
        part_file: &std::path::Path,
        step: u64,
        fields: &[String],
    ) -> Result<Value, String> {
        self.call(serde_json::json!({
            "op": "read_step",
            "file": part_file.to_string_lossy(),
            "step": step,
            "fields": fields,
        }))
        .await
    }
}
