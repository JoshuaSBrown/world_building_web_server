//! The server's wire contract, checked from outside through public types only.
//!
//! `fixtures/` holds JSON this test compares against, never edits:
//!
//! - one example of every shape the server sends, written by the hand-written
//!   types `schema.rs` held before they were generated from the spec;
//! - `catalogue/`, three real planet files as the running server saved them to
//!   `runs/planets/` (no runs; two runs with settings; the newest).
//!
//! Each must load into today's type and save back as the same JSON, so the
//! browser and the stored catalogue see no change.

use world_building_web_server::schema::*;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Compared as JSON values: key ORDER differs, because the generator sorts
/// fields, and no JSON reader depends on order.
#[test]
fn golden_wire_format() {
    fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(name: &str) {
        let path = fixtures().join(format!("{name}.json"));
        let recorded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let typed: T = serde_json::from_value(recorded.clone())
            .unwrap_or_else(|e| panic!("{name} no longer parses: {e}"));
        assert_eq!(
            serde_json::to_value(&typed).unwrap(), recorded,
            "{name} no longer matches tests/fixtures/{name}.json",
        );
    }
    round_trip::<PlanetParams>("planet_params");
    round_trip::<RunSettings>("run_settings");
    for state in ["queued", "running", "complete", "failed", "cancelled"] {
        round_trip::<JobStatus>(&format!("job_{state}"));
    }
    round_trip::<CloudFrame>("cloud_frame_full");
    round_trip::<CloudFrame>("cloud_frame_minimal");
    round_trip::<Health>("health");
    round_trip::<ApiError>("error");
}

/// Real catalogue files, as `store` wrote them, must still load and save back
/// unchanged: a planet that stopped parsing would vanish from the catalogue.
#[test]
fn catalogue_files_round_trip() {
    for entry in std::fs::read_dir(fixtures().join("catalogue")).unwrap() {
        let path = entry.unwrap().path();
        let recorded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let planet: PlanetSummary = serde_json::from_value(recorded.clone())
            .unwrap_or_else(|e| panic!("{path:?} no longer parses: {e}"));
        assert_eq!(serde_json::to_value(&planet).unwrap(), recorded, "{path:?}");
    }
}
