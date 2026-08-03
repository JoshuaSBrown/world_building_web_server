//! Reading a run directory. Knows the filesystem; knows nothing about HTTP.
//!
//! The contract this implements is `PlanetBuilder/RUN_FORMAT.md`. The one rule
//! that matters most: **the manifest is the index, not the directory listing.** A
//! part file appears on disk while it is still being written, and reading it then
//! is unsafe -- HDF5 offers SWMR for that case and the writer cannot use it,
//! because it creates a group per iteration and SWMR freezes a file's structure.
//! So a part may be opened only once its `part` line has been appended.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

/// One `step` line: the scalar diagnostics, published every recorded iteration.
///
/// These are what keeps a timeline live at full rate without opening a part file
/// at all. They are a summary of what is already inside the HDF5, not a second
/// copy of the arrays.
#[derive(Debug, Clone, Deserialize)]
pub struct StepLine {
    pub step: u64,
    #[serde(default)]
    pub time_myr: f64,
}

/// One `part` line: the publish signal for a closed file.
#[derive(Debug, Clone, Deserialize)]
pub struct PartLine {
    pub part: u32,
    pub file: String,
    /// Inclusive `[first, last]` step range held by the file.
    pub steps: [u64; 2],
    #[serde(default)]
    pub closed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ManifestLine {
    Step(StepLine),
    Part(PartLine),
}

/// What the run has published so far.
#[derive(Debug, Default, Clone)]
pub struct Manifest {
    /// Scalar rows by step, ordered.
    pub steps: BTreeMap<u64, StepLine>,
    /// Closed parts only. An unclosed line is ignored until it says otherwise.
    pub parts: Vec<PartLine>,
}

impl Manifest {
    /// Which part file holds `step`, if any part holding it has been closed.
    pub fn part_for(&self, step: u64) -> Option<&PartLine> {
        self.parts
            .iter()
            .find(|p| step >= p.steps[0] && step <= p.steps[1])
    }

    /// Every step a reader may open right now: recorded AND inside a closed part.
    ///
    /// A step can be announced in the scalar series long before its arrays are
    /// readable, so these two conditions are genuinely different and both must
    /// hold.
    pub fn readable_steps(&self) -> Vec<u64> {
        self.steps
            .keys()
            .copied()
            .filter(|s| self.part_for(*s).is_some())
            .collect()
    }

    pub fn last_step(&self) -> Option<u64> {
        self.steps.keys().next_back().copied()
    }
}

/// The run's own record of what it is.
#[derive(Debug, Clone, Deserialize)]
pub struct RunJson {
    #[serde(default)]
    pub schema_version: String,
    #[serde(default)]
    pub steps_total: u64,
}

impl RunJson {
    /// MAJOR from a `MAJOR.MINOR` string. `None` when it is missing or malformed --
    /// which is a refusal, never a default, because assuming a version is how a
    /// reader ends up trusting bytes it does not understand.
    pub fn schema_major(&self) -> Option<u32> {
        self.schema_version.split('.').next()?.parse().ok()
    }
}

/// A run directory on disk.
#[derive(Debug, Clone)]
pub struct RunDir {
    pub root: PathBuf,
}

impl RunDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.jsonl")
    }

    pub fn run_json_path(&self) -> PathBuf {
        self.root.join("run.json")
    }

    pub fn log_path(&self) -> PathBuf {
        self.root.join("run.log")
    }

    pub async fn run_json(&self) -> Option<RunJson> {
        let text = tokio::fs::read_to_string(self.run_json_path()).await.ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Parse the manifest as it stands.
    ///
    /// Tolerant by design: the file is appended to while we read it, so the final
    /// line may be torn. An unparseable line is skipped rather than failing the
    /// read -- the next poll sees it complete. Anything else would make a live
    /// reader fail intermittently for no reason.
    pub async fn manifest(&self) -> Manifest {
        let mut out = Manifest::default();
        let Ok(text) = tokio::fs::read_to_string(self.manifest_path()).await else {
            return out;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<ManifestLine>(line) {
                Ok(ManifestLine::Step(s)) => {
                    out.steps.insert(s.step, s);
                }
                Ok(ManifestLine::Part(p)) if p.closed => out.parts.push(p),
                _ => {}
            }
        }
        out
    }

    /// Absolute path of the part file holding `step`, if it is readable.
    pub async fn part_file_for(&self, step: u64) -> Option<PathBuf> {
        let m = self.manifest().await;
        let part = m.part_for(step)?;
        Some(self.root.join(&part.file))
    }
}

/// The catalogue: one JSON file per planet under `planets/`.
///
/// A directory of files rather than a database, because the whole state of this
/// server is then inspectable with `cat`, and a restart loses nothing.
#[derive(Debug, Clone)]
pub struct Catalogue {
    root: PathBuf,
}

impl Catalogue {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, id: &str) -> Option<PathBuf> {
        is_safe_id(id).then(|| self.root.join(format!("{id}.json")))
    }

    pub async fn put(&self, planet: &crate::schema::PlanetSummary) -> std::io::Result<()> {
        let dest = self.path(&planet.id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsafe planet id")
        })?;
        tokio::fs::create_dir_all(&self.root).await?;
        let body = serde_json::to_vec_pretty(planet)?;
        // temp + rename: a reader listing the catalogue never sees half a file
        let tmp = dest.with_extension("json.tmp");
        tokio::fs::write(&tmp, body).await?;
        tokio::fs::rename(tmp, dest).await
    }

    pub async fn get(&self, id: &str) -> Option<crate::schema::PlanetSummary> {
        let text = tokio::fs::read_to_string(self.path(id)?).await.ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Newest first.
    pub async fn list(&self) -> Vec<crate::schema::PlanetSummary> {
        let mut out = Vec::new();
        let Ok(mut dir) = tokio::fs::read_dir(&self.root).await else {
            return out;
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = tokio::fs::read_to_string(&p).await {
                if let Ok(planet) = serde_json::from_str(&text) {
                    out.push(planet);
                }
            }
        }
        out.sort_by(|a: &crate::schema::PlanetSummary, b| b.created_at.cmp(&a.created_at));
        out
    }
}

/// An ISO-8601 UTC timestamp, seconds precision.
///
/// Hand-rolled rather than pulling in a date crate for one string. Correct for
/// the proleptic Gregorian calendar, which is all a `createdAt` needs.
pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil-from-days (Howard Hinnant's algorithm), shifted to a March-based year
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// A short, filesystem-safe id with a readable prefix.
pub fn new_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // counter breaks ties within the same nanosecond tick
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}_{:x}{:x}", nanos as u64 & 0xffff_ffff, n & 0xfff)
}

/// May this id be used to build a filename?
///
/// An id arrives from the URL, so it is untrusted input -- and `../../etc/passwd`
/// is a perfectly good id as far as the router is concerned. Allow-listing the
/// characters is stricter and easier to check than canonicalising afterwards,
/// and every id this server mints already satisfies it.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_from(lines: &[&str]) -> Manifest {
        let mut out = Manifest::default();
        for line in lines {
            match serde_json::from_str::<ManifestLine>(line) {
                Ok(ManifestLine::Step(s)) => {
                    out.steps.insert(s.step, s);
                }
                Ok(ManifestLine::Part(p)) if p.closed => out.parts.push(p),
                _ => {}
            }
        }
        out
    }

    #[test]
    fn a_step_is_readable_only_once_its_part_is_closed() {
        let m = manifest_from(&[
            r#"{"kind":"step","step":0,"time_myr":0.0}"#,
            r#"{"kind":"step","step":1,"time_myr":10.0}"#,
            r#"{"kind":"part","part":0,"file":"parts/run_p000.h5","steps":[0,0],"closed":true}"#,
        ]);
        assert_eq!(m.readable_steps(), vec![0], "step 1's part is still open");
        assert_eq!(m.last_step(), Some(1), "but the series knows about it");
    }

    #[test]
    fn an_unclosed_part_line_is_ignored() {
        let m = manifest_from(&[
            r#"{"kind":"step","step":5,"time_myr":50.0}"#,
            r#"{"kind":"part","part":1,"file":"parts/run_p001.h5","steps":[5,9],"closed":false}"#,
        ]);
        assert!(m.readable_steps().is_empty());
        assert!(m.part_for(5).is_none());
    }

    #[test]
    fn a_torn_final_line_is_skipped_not_fatal() {
        let m = manifest_from(&[
            r#"{"kind":"part","part":0,"file":"parts/run_p000.h5","steps":[0,4],"closed":true}"#,
            r#"{"kind":"step","step":0,"time_myr":0.0}"#,
            r#"{"kind":"step","step":1,"time_m"#, // interrupted mid-write
        ]);
        assert_eq!(m.readable_steps(), vec![0]);
    }

    #[test]
    fn schema_major_is_parsed_and_never_defaulted() {
        let r = RunJson { schema_version: "1.4".into(), steps_total: 10 };
        assert_eq!(r.schema_major(), Some(1));
        let missing = RunJson { schema_version: String::new(), steps_total: 0 };
        assert_eq!(missing.schema_major(), None, "absent must not become 0 or 1");
    }

    #[test]
    fn timestamp_is_iso8601() {
        let s = now_iso8601();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z') && s.contains('T'), "{s}");
    }

    #[test]
    fn path_traversal_ids_are_refused() {
        assert!(is_safe_id("pl_1a2b"));
        assert!(!is_safe_id("../../etc/passwd"));
        assert!(!is_safe_id("pl/../../x"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("pl 1"), "a space is not in the allow-list");
        let c = Catalogue::new("/tmp/does-not-matter");
        assert!(c.path("../secret").is_none(), "no path is built at all");
    }

    #[test]
    fn ids_are_unique_within_a_tick() {
        let a = new_id("job");
        let b = new_id("job");
        assert_ne!(a, b);
        assert!(a.starts_with("job_"));
    }
}
