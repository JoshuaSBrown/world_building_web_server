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
    pub bulk_density: f64,
    pub core_fraction: f64,
    pub mantle_potential_k: f64,
    pub insolation: f64,
    pub age_gyr: f64,
    pub water_gel_m: f64,
    pub grid_level: u32,
}

impl PlanetParams {
    /// Ranges the simulation actually accepts. Rejected here, with a reason, rather
    /// than handed to a subprocess that will fail obscurely several seconds later.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("name must not be empty".into());
        }
        if !(4..=7).contains(&self.grid_level) {
            return Err(format!("gridLevel must be 4-7, got {}", self.grid_level));
        }
        for (label, v) in [
            ("diameterM", self.diameter_m),
            ("bulkDensity", self.bulk_density),
            ("mantlePotentialK", self.mantle_potential_k),
        ] {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{label} must be a positive number, got {v}"));
            }
        }
        if !(0.0..1.0).contains(&self.core_fraction) {
            return Err(format!(
                "coreFraction must be in [0, 1), got {}",
                self.core_fraction
            ));
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetSummary {
    pub id: String,
    pub params: PlanetParams,
    pub derived: PlanetDerived,
    pub created_at: String,
    pub job_id: Option<String>,
    /// Parameters stored but not passed to the simulation, because its command
    /// line does not accept them. Surfaced so a value the user set is never
    /// silently dropped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unapplied_params: Vec<String>,
}

/// Where a run or a bake has got to.
///
/// A tagged union on `state`, matching the client's discriminated type exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum JobStatus {
    #[serde(rename_all = "camelCase")]
    Queued { position: u32 },
    #[serde(rename_all = "camelCase")]
    Running {
        stage: String,
        progress: f64,
        step: u64,
    },
    #[serde(rename_all = "camelCase")]
    Complete { elapsed_seconds: f64 },
    #[serde(rename_all = "camelCase")]
    Failed { code: String },
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: &'static str,
    pub schema_major: u32,
    pub exporter: bool,
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
            bulk_density: 5513.0,
            core_fraction: 0.546,
            mantle_potential_k: 1650.0,
            insolation: 1361.0,
            age_gyr: 0.05,
            water_gel_m: 2700.0,
            grid_level: 5,
        }
    }

    #[test]
    fn params_are_camel_case_on_the_wire() {
        let v = serde_json::to_value(params()).unwrap();
        assert!(v.get("diameterM").is_some(), "wire name must match the spec");
        assert!(v.get("gridLevel").is_some());
        assert!(v.get("diameter_m").is_none(), "snake_case must not leak out");
    }

    #[test]
    fn status_is_tagged_by_state() {
        let running = serde_json::to_value(JobStatus::Running {
            stage: "evolving".into(),
            progress: 0.5,
            step: 12,
        })
        .unwrap();
        assert_eq!(running["state"], "running");
        let done = serde_json::to_value(JobStatus::Complete { elapsed_seconds: 1.5 }).unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["elapsedSeconds"], 1.5);
    }

    #[test]
    fn absent_sea_level_serialises_as_null_not_zero() {
        let f = CloudFrame {
            step: 1,
            t: 0.0,
            elevation: vec![1.0],
            sea_level: None,
            schema_major: SCHEMA_MAJOR,
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
    fn validation_rejects_out_of_range_grid_level() {
        let mut p = params();
        p.grid_level = 9;
        assert!(p.validate().unwrap_err().contains("gridLevel"));
    }
}
