//! The wire types, and the version gate.
//!
//! Every shape here appears in `openapi.yaml`, which is the contract: if the two
//! disagree, the YAML is right and this file is wrong. Field names are camelCase
//! on the wire because that is what the spec says and what the client reads.
//!
//! This module is the bottom of the tree. It knows nothing about HTTP, about the
//! filesystem, or about how a run is produced.

use serde::{Deserialize, Serialize};

/// The run-format MAJOR this server can read.
///
/// A run stamped with anything else is refused rather than partially rendered --
/// a viewer that guesses at a format it does not know is a viewer that lies.
/// MINOR differences are ignored on purpose: the format's rule is add-never-
/// repurpose, so an older reader can safely skip fields it has never heard of.
pub const SCHEMA_MAJOR: u32 = 1;

/// Initial conditions. Every field is an input the simulation consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetParams {
    pub name: String,
    /// Free text; `stable_seed` maps it to the integer the simulation takes.
    pub seed: String,
    pub diameter_m: f64,
    /// Kelvin. Where the two-layer energy balance BEGINS -- the post-magma-ocean
    /// initial condition, and the config's `start_mantle_temperature_k`.
    ///
    /// It replaced `mantlePotentialK`, which named an OUTCOME: the present-day
    /// mantle temperature a run evolves to. There is no key for that anywhere,
    /// because setting it would be fixing a result, so the old field could never
    /// be honoured however it was wired.
    pub start_mantle_temperature_k: f64,
    pub age_gyr: f64,
    pub water_gel_m: f64,
    /// Size of the simulated point cloud. The surface is a cloud of points,
    /// each owning a Voronoi cell; this cap fixes the finest simulated scale.
    pub max_points: u32,
}

impl PlanetParams {
    /// Ranges the simulation actually accepts. Rejected here, with a reason, rather
    /// than handed to a subprocess that will fail obscurely several seconds later.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("name must not be empty".into());
        }
        if !(100..=10_000).contains(&self.max_points) {
            return Err(format!("maxPoints must be 100-10000, got {}", self.max_points));
        }
        for (label, v) in [
            ("diameterM", self.diameter_m),
            ("startMantleTemperatureK", self.start_mantle_temperature_k),
        ] {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{label} must be a positive number, got {v}"));
            }
        }
        if self.age_gyr < 0.0 {
            return Err(format!("ageGyr must not be negative, got {}", self.age_gyr));
        }
        Ok(())
    }

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

/// Quantities `PlanetBuilder` derived. Relayed unchanged; never computed here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDerived {
    pub radius_m: f64,
    pub mass_kg: f64,
    pub surface_gravity: f64,
    pub escape_velocity_ms: f64,
    pub surface_area_m2: f64,
    pub cells: u64,
    pub sim_cell_m: f64,
    pub relief_m: f64,
}

/// The numerical choices one run was made with.
///
/// Class (b) every one of them — a resolution, a step size, a cadence — which is
/// exactly why they belong to the RUN and not to the planet. The planet's givens
/// (diameter, seed, starting temperature) are class (a) and fixed at creation: a
/// body that changed those between runs would not be one body.
///
/// Recorded with each run so the page can say what a result was computed at.
/// "500 points" is not a detail of how a picture was made; it is the finest
/// scale the physics ever saw.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSettings {
    /// Points the surface cloud starts with. The run creates and consumes them.
    pub n_points: u32,
    pub steps: u64,
    /// Millions of years per step. Exercised for convergence, never tuned.
    pub dt_myr: f64,
    /// Steps between checkpoints; also how far behind the live view runs.
    pub checkpoint_every_steps: u32,
}

impl RunSettings {
    /// The ranges a run accepts, refused here rather than by a subprocess.
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

/// One simulation that has been run for a planet.
///
/// A planet is not one run: a simulation can be re-run, and later ones consume
/// what earlier ones produced. The list is what a chooser reads to know whether
/// a simulation's prerequisites exist -- the answer is a run directory on disk,
/// never an assumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    /// Which simulation this was, e.g. `core-surface-formation`.
    pub kind: String,
    pub job_id: String,
    pub started_at: String,
    /// What it was run with. Absent on runs recorded before settings were
    /// carried -- reported as unknown rather than back-filled with today's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<RunSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetSummary {
    pub id: String,
    pub params: PlanetParams,
    pub derived: PlanetDerived,
    pub created_at: String,
    /// The most recent run. Kept for every existing client; `runs` is the full
    /// story and this is its last entry.
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<RunRef>,
    /// Parameters stored but not passed to the simulation, because its command
    /// line does not accept them. Surfaced so a value the user set is never
    /// silently dropped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unapplied_params: Vec<String>,
}

/// The simulations this server can actually start.
///
/// A kind it does not know is refused rather than queued: a planet that came
/// back unchanged because nobody ran anything is the failure this list prevents.
/// The display carries the names and the prose; this is the executable half.
pub const RUNNABLE_KINDS: &[&str] = &["core-surface-formation"];

/// Start a run: which simulation, and the numbers to run it with.
///
/// Every setting is optional and falls back to the server's default, so a
/// caller that only knows the kind still gets a run.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub kind: String,
    #[serde(default)]
    pub n_points: Option<u32>,
    #[serde(default)]
    pub steps: Option<u64>,
    #[serde(default)]
    pub dt_myr: Option<f64>,
    #[serde(default)]
    pub checkpoint_every_steps: Option<u32>,
}

/// Where a run or a bake has got to.
///
/// A tagged union on `state`, matching the client's discriminated type exactly.
/// `stepsTotal` appears in every variant because it is a property of the JOB, not
/// of the state it is in: the run is `steps` iterations long from the moment it is
/// queued, and a display that can say "18 of 40" while running should still be
/// able to say "40 of 40" when it finishes. A client then reads one field in every
/// state rather than tracking the last value it happened to see.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum JobStatus {
    #[serde(rename_all = "camelCase")]
    Queued { position: u32, steps_total: u64 },
    #[serde(rename_all = "camelCase")]
    Running {
        stage: String,
        progress: f64,
        step: u64,
        steps_total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Complete {
        elapsed_seconds: f64,
        steps_total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failed { code: String, steps_total: u64 },
    /// Stopped on purpose. NOT a failure and NOT a completion.
    ///
    /// Reporting it as failed would colour a deliberate act as an error and
    /// teach a reader to skim past the real ones; reporting it as complete would
    /// claim the planet finished evolving when it stopped part way. `step` is
    /// how far it got, which is the one number a user wants after stopping it.
    #[serde(rename_all = "camelCase")]
    Cancelled { step: u64, steps_total: u64 },
}

/// One field of one recorded step, with what the FILE says about it.
///
/// The four attributes are relayed, never invented: a colour bar labelled from
/// them says what the run said, and `units: ""` means the run declared none --
/// which the client reports rather than filling in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldData {
    /// One entry per element of `domain`. Scalars are numbers; a `vector` field
    /// is a row per element.
    pub values: serde_json::Value,
    pub units: String,
    /// `scalar`, `vector` or `category` -- the client's whole dispatch.
    pub kind: String,
    /// What the field is one value per. Never assume it matches another field's.
    pub domain: String,
    pub long_name: String,
}

/// Where the elements of one domain are on the sphere.
///
/// A field is paired with the positions of its OWN domain and no other's: the
/// cloud creates and consumes points every step, so a field computed before that
/// happens is not co-indexed with `cloud/pos` even when the lengths agree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPositions {
    /// Unit vectors, one row per element.
    pub pos: serde_json::Value,
}

/// One recorded step's surface field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFrame {
    pub step: u64,
    /// Fraction of the run's simulated span, 0-1.
    pub t: f64,
    /// One value per simulated point -- the model's own cells. Not resampled onto
    /// a grid, because interpolating would draw a surface nothing computed.
    pub elevation: Vec<f64>,
    /// `null` when the run recorded none, which is the present case: the
    /// simulation carries no water inventory. Absent is reported as absent.
    pub sea_level: Option<f64>,
    pub schema_major: u32,
    /// Simulated time of this step, as the run recorded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_myr: Option<f64>,
    /// The fields the request asked for, keyed by the name the RUN FILE gives
    /// them -- `plate_id`, not `plateId`. The key is a dataset identifier, so it
    /// is quoted rather than translated: it is what makes a number on screen
    /// traceable back to the array it came from.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub fields: std::collections::BTreeMap<String, FieldData>,
    /// Positions per domain, for the domains the returned fields belong to.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub domains: std::collections::BTreeMap<String, DomainPositions>,
    /// Every dataset this step holds, by name -- including ones this request
    /// did not ask for.
    ///
    /// A frame answers two different questions, and conflating them is a bug:
    /// "what did I ask for" (`fields`) and "what is there" (this). A display
    /// fetches only the field it draws, so without this it would conclude that
    /// a run recorded nothing except the layer already on screen.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available: Vec<String>,
    /// Requested names the run did not record. Absent is reported as absent, so
    /// the client can say a layer is not available instead of drawing zeros.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: &'static str,
    pub schema_major: u32,
    pub exporter: bool,
    /// What a run is started with unless the request says otherwise. Sent so a
    /// form can show real defaults instead of a copy that drifts from them.
    pub run_defaults: RunSettings,
}

/// The error body every failing endpoint returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    /// Stable, machine-readable.
    pub error: &'static str,
    /// A sentence a user can act on.
    pub message: String,
}

impl ApiError {
    pub fn new(error: &'static str, message: impl Into<String>) -> Self {
        Self { error, message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSpec {
    pub centre_lat: f64,
    pub centre_lon: f64,
    pub width_m: f64,
    pub height_m: f64,
    pub bearing_deg: f64,
    pub scale_error: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub engine: String,
    pub resolution: u32,
    pub tiles: u32,
    pub detail_octaves: u32,
    pub at_time: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub planet_id: String,
    pub patch: PatchSpec,
    pub spec: ExportSpec,
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
        let running = serde_json::to_value(JobStatus::Running {
            stage: "evolving".into(),
            progress: 0.5,
            step: 12,
            steps_total: 40,
        })
        .unwrap();
        assert_eq!(running["state"], "running");
        assert_eq!(running["step"], 12);
        assert_eq!(running["stepsTotal"], 40, "the run's length, in every state");
        let done = serde_json::to_value(JobStatus::Complete {
            elapsed_seconds: 1.5,
            steps_total: 40,
        })
        .unwrap();
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
            fields: Default::default(),
            domains: Default::default(),
            available: Vec::new(),
            absent: Vec::new(),
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
    fn validation_rejects_out_of_range_max_points() {
        let mut p = params();
        p.max_points = 12;
        assert!(p.validate().unwrap_err().contains("maxPoints"));
    }
}
