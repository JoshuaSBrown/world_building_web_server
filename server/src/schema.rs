//! The wire types, and the version gate.
//!
//! The wire types themselves are GENERATED from `api/openapi.yaml` into
//! `crate::generated::api` (see `scripts/gen-api.sh`) and re-exported here, so the
//! spec is the one place a field is defined and a disagreement is a compile error.
//! This module keeps only what a spec cannot say: the run-format version gate, the
//! seed hash, the checks on the server's own run defaults, and constructors that
//! keep the runner's code readable. Never edit `src/generated/` by hand.
//!
//! This module is the bottom of the tree. It knows nothing about HTTP, about the
//! filesystem, or about how a run is produced.

pub use crate::generated::types::*;

/// The error body every failing endpoint returns, under the name the handlers use.
pub use crate::generated::types::Error as ApiError;

/// The run-format MAJOR this server can read.
///
/// A run stamped with anything else is refused rather than partially rendered --
/// a viewer that guesses at a format it does not know is a viewer that lies.
/// MINOR differences are ignored on purpose: the format's rule is add-never-
/// repurpose, so an older reader can safely skip fields it has never heard of.
pub const SCHEMA_MAJOR: u32 = 1;

impl PlanetParams {
    /// A stable integer seed from the free-text one.
    ///
    /// FNV-1a, chosen because it is short enough to read and does not change
    /// between releases of anything. The integer is recorded with the run, so
    /// reproducing it never depends on this function staying the same.
    pub fn stable_seed(&self) -> u32 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in self.seed.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        (h & 0x7fff_ffff) as u32
    }
}

impl RunSettings {
    /// The ranges a run accepts.
    ///
    /// A REQUEST is checked against the same ranges by the generated validator
    /// before a handler runs (`RunSettings` and `RunRequest` in the spec). This
    /// remains for the settings the server builds itself -- its defaults come from
    /// `STEPS`, `DT_MYR` and `SPLIT_EVERY`, which no schema checks -- so a
    /// misconfigured server refuses to start a run rather than handing a
    /// subprocess numbers it will fail on. Keep the limits equal to the spec's.
    pub fn validate(&self) -> Result<(), String> {
        if !(100..=10_000).contains(&self.n_points) {
            return Err(format!("nPoints must be 100-10000, got {}", self.n_points));
        }
        if !(1..=100_000).contains(&self.steps) {
            return Err(format!("steps must be 1-100000, got {}", self.steps));
        }
        if !(self.dt_myr.is_finite() && self.dt_myr > 0.0) {
            return Err(format!("dtMyr must be a positive number, got {}", self.dt_myr));
        }
        if self.checkpoint_every_steps > 10_000 {
            return Err(format!(
                "checkpointEverySteps must be 0-10000, got {}",
                self.checkpoint_every_steps,
            ));
        }
        Ok(())
    }
}

impl ApiError {
    pub fn new(error: &str, message: impl Into<String>) -> Self {
        Self { error: error.to_owned(), message: message.into() }
    }
}

/// Where a run or a bake has got to.
///
/// `stepsTotal` is in every state because it is a property of the JOB, not of the
/// state it is in: the run is `steps` iterations long from the moment it is queued,
/// so a display can still say "40 of 40" when it finishes. `Cancelled` is stopped
/// on purpose -- NOT a failure and NOT a completion; `step` is how far it got.
impl JobStatus {
    pub fn queued(position: u32, steps_total: u64) -> Self {
        Self::JobQueued(JobQueued { state: JobQueuedState::Queued, position, steps_total })
    }

    pub fn running(stage: &str, progress: f64, step: u64, steps_total: u64) -> Self {
        Self::JobRunning(JobRunning {
            state: JobRunningState::Running,
            stage: stage.to_owned(),
            progress,
            step,
            steps_total,
        })
    }

    pub fn complete(elapsed_seconds: f64, steps_total: u64) -> Self {
        Self::JobComplete(JobComplete {
            state: JobCompleteState::Complete,
            elapsed_seconds,
            steps_total,
        })
    }

    pub fn failed(code: impl Into<String>, steps_total: u64) -> Self {
        Self::JobFailed(JobFailed { state: JobFailedState::Failed, code: code.into(), steps_total })
    }

    pub fn cancelled(step: u64, steps_total: u64) -> Self {
        Self::JobCancelled(JobCancelled { state: JobCancelledState::Cancelled, step, steps_total })
    }

    pub fn is_running(&self) -> bool {
        matches!(self, Self::JobRunning(_))
    }

    pub fn is_queued(&self) -> bool {
        matches!(self, Self::JobQueued(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> PlanetParams {
        PlanetParams {
            name: "Kestrel".into(),
            seed: "kestrel-1".into(),
            diameter_m: 12_742_000.0,
            start_mantle_temperature_k: 1650.0,
            age_gyr: 0.05,
            water_gel_m: 2700.0,
            max_points: 500,
        }
    }

    #[test]
    fn params_are_camel_case_on_the_wire() {
        let v = serde_json::to_value(params()).unwrap();
        assert!(v.get("diameterM").is_some(), "wire name must match the spec");
        assert!(v.get("maxPoints").is_some());
        assert!(v.get("startMantleTemperatureK").is_some());
        assert!(v.get("diameter_m").is_none(), "snake_case must not leak out");
    }

    #[test]
    fn status_is_tagged_by_state() {
        let running = serde_json::to_value(JobStatus::running("evolving", 0.5, 12, 40)).unwrap();
        assert_eq!(running["state"], "running");
        assert_eq!(running["step"], 12);
        assert_eq!(running["stepsTotal"], 40, "the run's length, in every state");
        let done = serde_json::to_value(JobStatus::complete(1.5, 40)).unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["elapsedSeconds"], 1.5);
        assert_eq!(done["stepsTotal"], 40);
    }

    #[test]
    fn absent_sea_level_serialises_as_null_not_zero() {
        let f = CloudFrame {
            step: 1,
            t: 0.0,
            elevation: vec![1.0],
            sea_level: None,
            schema_major: SCHEMA_MAJOR,
            time_myr: None,
            fields: None,
            domains: None,
            available: None,
            absent: None,
        };
        let v = serde_json::to_value(f).unwrap();
        assert!(v["seaLevel"].is_null(), "absent must stay absent");
    }

    #[test]
    fn seed_hash_is_stable_and_deterministic() {
        assert_eq!(params().stable_seed(), params().stable_seed());
        let mut other = params();
        other.seed = "kestrel-2".into();
        assert_ne!(params().stable_seed(), other.stable_seed());
    }

    #[test]
    fn server_defaults_are_checked_against_the_spec_ranges() {
        let mut s = RunSettings { n_points: 500, steps: 40, dt_myr: 8.0, checkpoint_every_steps: 2 };
        assert!(s.validate().is_ok());
        s.n_points = 12;
        assert!(s.validate().unwrap_err().contains("nPoints"));
    }
}
