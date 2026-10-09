//! Reading a run directory. Knows the filesystem; knows nothing about HTTP.
//!
//! The contract this implements is `PlanetBuilder/RUN_FORMAT.md`. The one rule
//! that matters most: **the manifest is the index, not the directory listing.** A
//! part file appears on disk while it is still being written, and reading it then
//! is unsafe -- HDF5 offers SWMR for that case and the writer cannot use it,
//! because it creates a group per iteration and SWMR freezes a file's structure.
//! So a part may be opened only once its `part` line has been appended.

use std::path::PathBuf;

use serde::Deserialize;

/// How far the run says it has got: `status.json`, rewritten atomically by the
/// writer whenever anything changes.
///
/// **This is where progress comes from, and the manifest is not.** The writer
/// used to append a line per recorded iteration; the per-step scalars now live in
/// `series.h5` and the manifest is a publish log for closed parts alone. So a
/// step count is read here, from the one file the writer keeps current.
///
/// Every field is optional in this struct even though the writer states them all,
/// because the run format is still being hardened: an absent field is reported as
/// absent rather than defaulted into a number that looks like a measurement.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Status {
    #[serde(default)]
    pub state: String,
    /// When the run opened its directory, and when it last said anything.
    /// A `running` state with a stale heartbeat is a run whose process died
    /// without saying so -- the format's own words, and the only way to tell.
    #[serde(default)]
    pub started: Option<String>,
    #[serde(default)]
    pub heartbeat: Option<String>,
    /// The last iteration the run recorded. `None` before the first one.
    #[serde(default)]
    pub last_step: Option<u64>,
    #[serde(default)]
    pub steps_total: Option<u64>,
    #[serde(default, alias = "parts_closed")]
    pub checkpoints_closed: u32,
    /// Set when the writer itself saw the failure; a process killed outright
    /// leaves `state: "running"` and a heartbeat that stops.
    #[serde(default)]
    pub error: Option<String>,
}

/// One `checkpoint` line: the publish signal for a closed file.
///
/// The writer called these `part` until 2026-08-16 and now calls them
/// `checkpoint` -- a file holds enough state to RESTART the run from any step in
/// it, which "part" never said. Both spellings parse: stored runs are not
/// rewritten when a name changes, and a reader that refused the older one would
/// make every existing run unopenable.
#[derive(Debug, Clone, Deserialize)]
pub struct CheckpointLine {
    #[serde(alias = "part")]
    pub checkpoint: u32,
    pub file: String,
    /// Inclusive `[first, last]` step range held by the file.
    pub steps: [u64; 2],
    #[serde(default)]
    pub closed: bool,
}

/// `kind` is the discriminator, and it has had two values for the same thing.
/// An unrecognised kind is skipped rather than refused, so a line type added
/// later cannot stop a reader that does not know it yet.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ManifestLine {
    Checkpoint(CheckpointLine),
    /// What `checkpoint` was called before 2026-08-16.
    Part(CheckpointLine),
}

/// What the run has published so far: closed checkpoints, and nothing else.
#[derive(Debug, Default, Clone)]
pub struct Manifest {
    /// Closed checkpoints only. An unclosed line is ignored until it says so.
    pub checkpoints: Vec<CheckpointLine>,
}

impl Manifest {
    /// Which checkpoint holds `step`, if the one holding it has been closed.
    pub fn checkpoint_for(&self, step: u64) -> Option<&CheckpointLine> {
        self.checkpoints
            .iter()
            .find(|c| step >= c.steps[0] && step <= c.steps[1])
    }

    /// Every step a reader may open right now: the steps of every CLOSED
    /// checkpoint.
    ///
    /// A checkpoint declares the inclusive range it holds, and a run records
    /// every iteration, so the range enumerates the steps in the file. If a run
    /// ever thins its step groups, a step inside the range with no arrays behind
    /// it answers 404 on request rather than being drawn as something else — the
    /// range is what the writer publishes, and this reader does not guess past it.
    ///
    /// A run's progress is NOT this list: a step is recorded well before the
    /// checkpoint holding it closes. That number comes from `status.json`.
    pub fn readable_steps(&self) -> Vec<u64> {
        let mut steps: Vec<u64> = self
            .checkpoints
            .iter()
            .flat_map(|c| c.steps[0]..=c.steps[1])
            .collect();
        steps.sort_unstable();
        steps.dedup();
        steps
    }
}

impl Status {
    /// How long the run has been going, from its own two timestamps.
    ///
    /// Measured, not guessed: after a server restart the in-memory stopwatch is
    /// gone, and inventing an elapsed time would be reporting a number nothing
    /// observed.
    pub fn elapsed_seconds(&self) -> Option<f64> {
        let a = epoch_seconds(self.started.as_deref()?)?;
        let b = epoch_seconds(self.heartbeat.as_deref()?)?;
        Some((b - a).max(0) as f64)
    }

    /// Seconds since the last heartbeat, or `None` if it cannot be read.
    pub fn heartbeat_age(&self, now_iso: &str) -> Option<i64> {
        let beat = epoch_seconds(self.heartbeat.as_deref()?)?;
        Some((epoch_seconds(now_iso)? - beat).max(0))
    }
}

/// Seconds since the epoch from `YYYY-MM-DDTHH:MM:SSZ`.
///
/// A parser rather than a date library: the format writes exactly one shape, and
/// a dependency to read twenty characters of it is not worth the supply chain.
/// Anything that does not match returns `None` -- unreadable is reported as
/// unreadable, never as the epoch.
fn epoch_seconds(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| iso.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // Days from the civil epoch (Howard Hinnant's algorithm), which handles
    // leap years and centuries without a table.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
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

    pub fn status_path(&self) -> PathBuf {
        self.root.join("status.json")
    }

    /// How far the run says it has got, or `None` before it has said anything.
    ///
    /// The writer replaces this file atomically, so a reader never catches it
    /// half-written; an unparseable read is therefore a format the reader does
    /// not understand, and reporting nothing is better than reporting a guess.
    pub async fn status(&self) -> Option<Status> {
        let text = tokio::fs::read_to_string(self.status_path()).await.ok()?;
        serde_json::from_str(&text).ok()
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
                Ok(ManifestLine::Checkpoint(c) | ManifestLine::Part(c)) if c.closed => {
                    out.checkpoints.push(c)
                }
                _ => {}
            }
        }
        out
    }

    /// Absolute path of the checkpoint holding `step`, if it is readable.
    pub async fn checkpoint_file_for(&self, step: u64) -> Option<PathBuf> {
        let m = self.manifest().await;
        let checkpoint = m.checkpoint_for(step)?;
        Some(self.root.join(&checkpoint.file))
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
                Ok(ManifestLine::Checkpoint(c) | ManifestLine::Part(c)) if c.closed => {
                    out.checkpoints.push(c)
                }
                _ => {}
            }
        }
        out
    }

    /// The writer renamed `part` to `checkpoint` on 2026-08-16, and the reader
    /// went blind: it skipped every line, offered no readable steps, and the
    /// viewer sat empty with every layer greyed out. Both spellings parse, and
    /// stored runs stay openable.
    #[test]
    fn both_spellings_of_a_published_file_are_read() {
        let m = manifest_from(&[
            r#"{"kind":"part","part":0,"file":"parts/run_p000.h5","steps":[1,2],"closed":true}"#,
            r#"{"kind": "checkpoint", "checkpoint": 1, "file": "parts/run_c001.h5", "steps": [3, 4], "closed": true}"#,
        ]);
        assert_eq!(m.readable_steps(), vec![1, 2, 3, 4]);
        assert_eq!(m.checkpoint_for(2).unwrap().file, "parts/run_p000.h5");
        assert_eq!(m.checkpoint_for(4).unwrap().file, "parts/run_c001.h5");
        assert_eq!(m.checkpoint_for(4).unwrap().checkpoint, 1, "the index, either name");
    }

    #[test]
    fn a_step_is_readable_only_once_its_part_is_closed() {
        let m = manifest_from(&[
            r#"{"kind":"part","part":0,"file":"parts/run_p000.h5","steps":[1,2],"closed":true}"#,
        ]);
        assert_eq!(m.readable_steps(), vec![1, 2]);
        assert!(m.checkpoint_for(3).is_none(), "step 3's checkpoint is unannounced");
    }

    #[test]
    fn an_unclosed_part_line_is_ignored() {
        let m = manifest_from(&[
            r#"{"kind":"part","part":1,"file":"parts/run_p001.h5","steps":[5,9],"closed":false}"#,
        ]);
        assert!(m.readable_steps().is_empty());
        assert!(m.checkpoint_for(5).is_none());
    }

    #[test]
    fn a_torn_final_line_is_skipped_not_fatal() {
        let m = manifest_from(&[
            r#"{"kind":"part","part":0,"file":"parts/run_p000.h5","steps":[1,4],"closed":true}"#,
            r#"{"kind":"part","part":1,"file":"parts/run_"#, // interrupted mid-write
        ]);
        assert_eq!(m.readable_steps(), vec![1, 2, 3, 4]);
    }

    /// A line copied verbatim out of a run `PlanetBuilder` wrote.
    ///
    /// The drift this catches is not hypothetical: the writer's step numbers come
    /// from a scalar series where every column is a float, and `"step": 1.0` does
    /// not parse into a `u64`. Fixtures beat a second reading of the prose.
    #[test]
    fn a_line_the_writer_really_wrote_parses() {
        let m = manifest_from(&[
            r#"{"kind": "part", "part": 0, "file": "parts/run_p000.h5", "steps": [1, 2], "closed": true}"#,
        ]);
        assert_eq!(m.readable_steps(), vec![1, 2]);
        assert_eq!(m.checkpoint_for(1).unwrap().file, "parts/run_p000.h5");
    }

    /// Progress comes from `status.json`, which is the only file the writer keeps
    /// current -- the manifest publishes parts and says nothing about how far the
    /// run has got.
    #[test]
    fn status_reports_progress_the_manifest_cannot() {
        let s: Status = serde_json::from_str(
            r#"{"status_version":"1.0","state":"running","started":"2026-08-14T19:49:35Z",
                "heartbeat":"2026-08-14T19:49:56Z","last_step":27,"steps_total":40,
                "checkpoints_closed":13,"exit_code":null,"error":null}"#,
        )
        .unwrap();
        assert_eq!(s.last_step, Some(27), "27 recorded...");
        assert_eq!(s.checkpoints_closed, 13, "...while only 26 are readable");
        assert_eq!(s.steps_total, Some(40));
        assert!(s.error.is_none());
    }

    #[test]
    fn a_status_that_says_nothing_yet_is_absent_not_zero() {
        let s: Status = serde_json::from_str(
            r#"{"state":"starting","last_step":null,"steps_total":40}"#,
        )
        .unwrap();
        assert!(s.last_step.is_none(), "no step has been recorded, which is not step 0");
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
