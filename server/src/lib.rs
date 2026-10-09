//! The part of the server other crates may see: the wire contract, and nothing else.
//!
//! The server is a program (`main.rs`); this library exists so the integration
//! tests in `tests/` can hold the program to its contract the way a client would,
//! through public types only. It exposes the smallest thing that does that --
//! the wire types (`schema`) and the code generated from `api/openapi.yaml` that
//! they come from. Running a simulation, reading run directories and serving HTTP
//! stay private to the program.

/// Wire types and routing generated from `api/openapi.yaml` by
/// `scripts/gen-api.sh`. Never edited by hand. It covers the whole spec, so
/// response cases no handler returns yet (the exporter's) are unused, not wrong.
#[allow(dead_code)]
pub mod generated;
pub mod schema;
