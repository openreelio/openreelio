//! Where frame-probe stills land, and how they travel back inline.
//!
//! Two surfaces hand an agent pictures of the edit — the CLI's MCP server and
//! the GUI's in-app bridge — and both face the same two problems. Neither may
//! let the caller name an output path, because an argument that decides where
//! bytes land turns a read-only tool into an arbitrary-write primitive; and
//! both have to read the finished images back as base64 so a vision model sees
//! them without a filesystem tool.
//!
//! Solving that twice is how the two surfaces drift, so the cache layout, the
//! pruning bound, the inline caps and the encoding live here once.

use super::{FrameProbeError, FrameProbeResult};
use crate::core::render::ImageFormat;
use base64::Engine as _;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Largest number of individual stills one inline response carries.
///
/// Every still is inlined as base64 into a single response and from there into
/// the caller's model context, so an unbounded batch produces a reply no client
/// can carry. A contact sheet is the cheap way to see more moments than this at
/// once — it costs one image however many cells it holds.
pub const MAX_INLINE_FRAME_STILLS: usize = 12;

/// Newest frame-cache entries kept after an extraction.
///
/// Sixteen covers the recent history of a judge loop — the last few sheets and
/// still batches an agent may want to point another tool at — without letting a
/// long session leave the whole cut on disk inside the user's project.
pub const MAX_CACHED_FRAME_DIRECTORIES: usize = 16;

/// Timestamp format an entry name starts with.
///
/// The fixed width is what makes a lexicographic sort an age sort during
/// pruning. A stamp alone does not identify an entry — two probes started in
/// the same microsecond produce the same one — so the name carries a nonce
/// after it; see [`claim_cache_entry`].
const FRAME_CACHE_STAMP: &str = "%Y%m%dT%H%M%S%6fZ";

/// Distinguishes entries whose timestamps landed in the same microsecond.
///
/// Kept process-wide rather than per call site so two concurrent probes in one
/// process can never draw the same value. A collision *between* processes is
/// still possible and is caught by [`claim_cache_entry`]'s retry, which is the
/// guarantee that matters: `create_dir` on an existing name fails rather than
/// merging two extractions into one entry.
static FRAME_CACHE_NONCE: AtomicU32 = AtomicU32::new(0);

/// Attempts made to claim a free entry name before the allocation fails.
///
/// Each attempt re-reads the clock and draws a fresh nonce, so a losing racer
/// converges immediately; a handful of tries is a bound on a pathological loop
/// rather than a number the happy path ever approaches.
const FRAME_CACHE_NAME_ATTEMPTS: usize = 8;

/// What a single extraction writes into its cache entry.
///
/// The probe is handed one `out` path, and what that path has to *be* depends
/// on the shape of the request: a file for one image, a directory for a batch
/// the probe names itself. Naming the shape here keeps both surfaces from
/// re-deriving it, and keeps a sheet recognisable on disk.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameArtifact {
    /// One still image.
    Still,
    /// One contact sheet image.
    Sheet,
    /// One image per sampled time; the probe names the files itself.
    Batch,
}

impl FrameArtifact {
    /// The file name this artifact takes inside its entry, if it is one file.
    ///
    /// The extension has to agree with the format the probe is given, because
    /// the probe reads the format back off the path when the caller named none
    /// and refuses the pair when they disagree.
    fn file_name(self, format: ImageFormat) -> Option<String> {
        match self {
            Self::Still => Some(format!("frame.{}", format.extension())),
            Self::Sheet => Some(format!("sheet.{}", format.extension())),
            Self::Batch => None,
        }
    }
}

/// One frame-cache entry, and the `out` path a probe writes inside it.
///
/// Held as a value rather than returned as a bare path so the entry's lifecycle
/// stays in one place: an extraction that produced nothing usable calls
/// [`discard`](Self::discard), and an empty entry per failed probe is how the
/// cache grows fastest.
#[derive(Clone, Debug)]
pub struct FrameOutput {
    directory: PathBuf,
    out: PathBuf,
}

impl FrameOutput {
    /// The path to hand the probe as its `out`.
    pub fn out(&self) -> &Path {
        &self.out
    }

    /// The cache entry this extraction owns.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Removes the entry whose extraction produced nothing usable.
    ///
    /// Recursive because a failure can land mid-batch: the directory was
    /// created microseconds earlier for this call alone, so whatever is in it
    /// belongs to the extraction that just failed. Best-effort — a leftover
    /// directory is not worth replacing the real error with a housekeeping one.
    pub fn discard(self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/// Root of a project's frame cache.
pub fn frame_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".openreelio").join("cache").join("frames")
}

/// Creates the entry this extraction writes into, inside the project's own
/// cache, and trims the cache back to its bound.
///
/// The caller never names an output path: a tool argument that decided where
/// bytes land would make a read-only surface an arbitrary-write primitive. A
/// timestamped directory under `.openreelio/cache/frames/` keeps concurrent
/// judgements from overwriting each other's evidence, and puts every image in a
/// place that is safe to delete.
///
/// Pruning happens here rather than after the probe so a surface cannot forget
/// it. The entry just claimed is excluded from the sweep outright rather than
/// trusted to sort last: a clock that moved backwards, or a stale entry stamped
/// in the future, would otherwise let the allocation delete the very directory
/// it was called to produce.
pub fn allocate_frame_output(
    project_dir: &Path,
    artifact: FrameArtifact,
    format: ImageFormat,
) -> FrameProbeResult<FrameOutput> {
    let root = frame_cache_dir(project_dir);
    std::fs::create_dir_all(&root).map_err(|error| {
        FrameProbeError::new(format!(
            "Failed to create the frame cache directory '{}': {error}",
            root.display()
        ))
    })?;

    let directory = claim_cache_entry(&root)?;
    prune_frame_cache_excluding(project_dir, Some(directory.as_path()));

    let out = match artifact.file_name(format) {
        Some(name) => directory.join(name),
        // A batch writes one file per time, so the extraction is handed the
        // directory and names the stills itself.
        None => directory.clone(),
    };

    Ok(FrameOutput { directory, out })
}

/// Creates a directory no other extraction owns, and returns it.
///
/// `create_dir` rather than `create_dir_all` is the whole point: the call has
/// to *fail* on a name that already exists. Two probes that agreed on a name —
/// the same microsecond in two processes — would otherwise both be handed the
/// same directory, and the second would overwrite the first's stills, or
/// `discard` them out from under a caller still reading them.
fn claim_cache_entry(root: &Path) -> FrameProbeResult<PathBuf> {
    let mut taken = Vec::new();
    for _ in 0..FRAME_CACHE_NAME_ATTEMPTS {
        // Masked to four hex digits so every entry name keeps the fixed width
        // that makes a lexicographic sort an age sort.
        let nonce = FRAME_CACHE_NONCE.fetch_add(1, Ordering::Relaxed) & 0xffff;
        let candidate = root.join(format!(
            "{}-{nonce:04x}",
            chrono::Utc::now().format(FRAME_CACHE_STAMP)
        ));

        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                taken.push(candidate);
            }
            Err(error) => {
                return Err(FrameProbeError::new(format!(
                    "Failed to create the frame cache directory '{}': {error}",
                    candidate.display()
                )));
            }
        }
    }

    Err(FrameProbeError::new(format!(
        "Failed to claim a frame cache entry under '{}' after {FRAME_CACHE_NAME_ATTEMPTS} attempts; \
         the last name tried was '{}'",
        root.display(),
        taken
            .last()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    )))
}

/// Keeps the frame cache to its most recent [`MAX_CACHED_FRAME_DIRECTORIES`]
/// entries.
///
/// The images are already inline in the response, so the on-disk copy exists
/// only for a follow-up call that wants the path. Without a bound, a judge loop
/// deposits every frame it ever looked at into the user's project directory.
/// Best-effort: an extraction whose images are already in hand must not fail
/// because the cache could not be tidied.
pub fn prune_frame_cache(project_dir: &Path) {
    prune_frame_cache_excluding(project_dir, None);
}

/// Prunes the cache while leaving `keep` alone, whatever its name sorts as.
///
/// An extraction in flight owns its entry, and an entry name is a wall-clock
/// stamp: a clock that stepped backwards, or a directory left behind stamped in
/// the future, makes the newest entry no longer the last one in name order. The
/// caller therefore names what it is holding instead of relying on the sort.
fn prune_frame_cache_excluding(project_dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(frame_cache_dir(project_dir)) else {
        return;
    };

    let mut directories: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    if directories.len() <= MAX_CACHED_FRAME_DIRECTORIES {
        return;
    }

    // Entry names start with a fixed-width UTC timestamp, so sorting them by
    // name sorts them by age.
    directories.sort();
    // `keep` still counts towards the bound — it is a cache entry like any
    // other — it is only excluded from what may be deleted.
    let stale = directories.len() - MAX_CACHED_FRAME_DIRECTORIES;
    for directory in directories
        .into_iter()
        .filter(|path| keep != Some(path.as_path()))
        .take(stale)
    {
        let _ = std::fs::remove_dir_all(directory);
    }
}

/// One image an extraction produced, ready to travel inline.
#[derive(Clone, Debug)]
pub struct InlineImage {
    /// Where the image was written.
    pub path: PathBuf,
    /// IANA media type of `data`, for example `image/jpeg`.
    pub mime_type: String,
    /// Base64-encoded image bytes, with no `data:` URI prefix.
    pub data: String,
}

/// The image paths an extraction reported, in payload order.
///
/// Read from the payload rather than from the request, so a caller can never
/// describe a file the extraction did not actually produce.
pub fn frame_image_paths(payload: &Value) -> Vec<PathBuf> {
    match payload.pointer("/sheet/path").and_then(Value::as_str) {
        Some(sheet) => vec![PathBuf::from(sheet)],
        None => payload
            .get("frames")
            .and_then(Value::as_array)
            .map(|frames| {
                frames
                    .iter()
                    .filter_map(|frame| frame.get("path").and_then(Value::as_str))
                    .map(PathBuf::from)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Reads back the images an extraction wrote and encodes them for the wire.
///
/// `cap` bounds how many are carried, because the bytes end up in a model's
/// context. It is a backstop rather than the primary control — a surface states
/// the budget up front as the probe's `limit` — and the payload still names
/// every frame, so a caller can see on disk what was not inlined.
pub fn inline_frame_images(payload: &Value, cap: usize) -> FrameProbeResult<Vec<InlineImage>> {
    frame_image_paths(payload)
        .iter()
        .take(cap)
        .map(|path| encode_inline_image(path))
        .collect()
}

/// Reads one extracted image and encodes it for the wire.
pub fn encode_inline_image(path: &Path) -> FrameProbeResult<InlineImage> {
    let mime_type = image_mime_type(path)?;
    let bytes = std::fs::read(path).map_err(|error| {
        FrameProbeError::new(format!(
            "Failed to read the extracted frame '{}': {error}",
            path.display()
        ))
    })?;

    Ok(InlineImage {
        path: path.to_path_buf(),
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Names the image type from what was actually written.
///
/// Derived from the file rather than assumed, so a block's `mimeType` cannot
/// drift from its `data` if the extraction's output format ever changes.
pub fn image_mime_type(path: &Path) -> FrameProbeResult<String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => Ok("image/jpeg".to_string()),
        Some("png") => Ok("image/png".to_string()),
        Some("tif" | "tiff") => Ok("image/tiff".to_string()),
        _ => Err(FrameProbeError::new(format!(
            "Extracted frame '{}' has no recognised image type",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frame_cache_dir_should_stay_inside_the_project() {
        let root = Path::new("C:/projects/cut");
        assert_eq!(
            frame_cache_dir(root),
            root.join(".openreelio").join("cache").join("frames")
        );
    }

    #[test]
    fn allocate_frame_output_should_name_the_file_after_the_artifact_and_format() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");

        let still = allocate_frame_output(&project, FrameArtifact::Still, ImageFormat::Jpeg)
            .expect("a still entry is allocated");
        assert_eq!(
            still.out().file_name().and_then(|n| n.to_str()),
            Some("frame.jpg")
        );
        assert!(still.out().starts_with(frame_cache_dir(&project)));

        let sheet = allocate_frame_output(&project, FrameArtifact::Sheet, ImageFormat::Png)
            .expect("a sheet entry is allocated");
        assert_eq!(
            sheet.out().file_name().and_then(|n| n.to_str()),
            Some("sheet.png")
        );

        // A batch is handed the directory: the probe names one file per time.
        let batch = allocate_frame_output(&project, FrameArtifact::Batch, ImageFormat::Jpeg)
            .expect("a batch entry is allocated");
        assert_eq!(batch.out(), batch.directory());
        assert!(batch.out().is_dir());
    }

    /// Seeds a cache with entries stamped `offset` away from now, oldest first.
    ///
    /// Stamps are written relative to the clock rather than pinned to a literal
    /// date: an entry seeded in 2026 stops being "older than now" the moment the
    /// machine's clock passes it, and the test would then assert the opposite of
    /// what it was written to check.
    fn seed_cache_entries(
        cache_root: &Path,
        count: usize,
        offset: impl Fn(i64) -> chrono::Duration,
    ) -> Vec<String> {
        let now = chrono::Utc::now();
        let stamps: Vec<String> = (0..count)
            .map(|index| {
                let at = now + offset(index as i64);
                format!("{}-0000", at.format(FRAME_CACHE_STAMP))
            })
            .collect();
        for stamp in &stamps {
            let entry = cache_root.join(stamp);
            std::fs::create_dir_all(&entry).expect("cache entry");
            std::fs::write(entry.join("sheet.jpg"), b"sheet bytes").expect("cache image");
        }
        stamps
    }

    /// Reads back the entry names a cache holds, in age order.
    fn cache_entry_names(cache_root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(cache_root)
            .expect("cache root")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn allocate_frame_output_should_prune_to_the_newest_entries() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let cache_root = frame_cache_dir(&project);
        std::fs::create_dir_all(&cache_root).expect("cache root");

        let seeded = MAX_CACHED_FRAME_DIRECTORIES + 4;
        // Oldest first, every one of them behind the clock the allocation reads.
        let stamps = seed_cache_entries(&cache_root, seeded, |index| {
            chrono::Duration::seconds(index - seeded as i64)
        });

        let allocated = allocate_frame_output(&project, FrameArtifact::Sheet, ImageFormat::Jpeg)
            .expect("a new entry is allocated");

        let remaining = cache_entry_names(&cache_root);

        assert_eq!(remaining.len(), MAX_CACHED_FRAME_DIRECTORIES);
        // The entry just allocated carries the newest stamp, so pruning must
        // never be able to delete the extraction it was called for.
        assert!(allocated.directory().is_dir());
        // The survivors are the newest, not an arbitrary set: the five oldest
        // seeded stamps are gone and the rest are still there.
        for stale in &stamps[..5] {
            assert!(
                !remaining.contains(stale),
                "pruning must drop the oldest entries, {stale} survived"
            );
        }
        for kept in &stamps[5..] {
            assert!(
                remaining.contains(kept),
                "pruning must keep the newest entries, {kept} was dropped"
            );
        }
    }

    #[test]
    fn allocate_frame_output_should_keep_its_own_entry_when_stale_ones_are_stamped_in_the_future() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let cache_root = frame_cache_dir(&project);
        std::fs::create_dir_all(&cache_root).expect("cache root");

        // A project copied from a machine whose clock runs ahead — or a clock
        // that stepped backwards — leaves entries that sort *after* the one
        // being allocated, which makes the new entry the apparent oldest and
        // the first candidate for deletion.
        seed_cache_entries(&cache_root, MAX_CACHED_FRAME_DIRECTORIES + 4, |index| {
            chrono::Duration::hours(index + 1)
        });

        let allocated = allocate_frame_output(&project, FrameArtifact::Batch, ImageFormat::Jpeg)
            .expect("a new entry is allocated");

        assert!(
            allocated.directory().is_dir(),
            "pruning deleted the entry the allocation was called to produce: {}",
            allocated.directory().display()
        );
        assert_eq!(
            cache_entry_names(&cache_root).len(),
            MAX_CACHED_FRAME_DIRECTORIES,
            "the cache must still come back to its bound"
        );
    }

    #[test]
    fn allocate_frame_output_should_give_every_call_its_own_entry() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");

        // The system clock is far coarser than the microsecond the stamp
        // records, so a tight loop reproduces exactly what two concurrent
        // judgements do: several calls read the same instant. Sharing an entry
        // would let one extraction overwrite another's stills, or `discard`
        // them out from under a caller still reading them.
        let mut claimed = std::collections::HashSet::new();
        for _ in 0..MAX_CACHED_FRAME_DIRECTORIES {
            let output = allocate_frame_output(&project, FrameArtifact::Batch, ImageFormat::Jpeg)
                .expect("an entry is allocated");
            assert!(
                claimed.insert(output.directory().to_path_buf()),
                "two extractions were handed the same cache entry: {}",
                output.directory().display()
            );
        }
    }

    #[test]
    fn prune_frame_cache_should_tolerate_a_cache_that_does_not_exist_yet() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        // The first extraction on a project prunes before anything was cached,
        // and housekeeping must never be able to fail a successful call.
        prune_frame_cache(&temp.path().join("never_extracted"));
    }

    #[test]
    fn discard_should_remove_the_entry_a_failed_extraction_left() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let output = allocate_frame_output(&project, FrameArtifact::Batch, ImageFormat::Jpeg)
            .expect("a batch entry is allocated");
        let directory = output.directory().to_path_buf();
        std::fs::write(directory.join("frame_000.jpg"), b"partial").expect("partial still");

        output.discard();

        assert!(!directory.exists(), "a discarded entry must be gone");
    }

    #[test]
    fn frame_image_paths_should_read_only_what_the_payload_reports() {
        let sheet = json!({ "sheet": { "path": "cache/sheet.jpg" }, "frames": [] });
        assert_eq!(
            frame_image_paths(&sheet),
            vec![PathBuf::from("cache/sheet.jpg")]
        );

        let batch = json!({
            "frames": [
                { "path": "cache/a.jpg", "time": 0.0 },
                { "time": 1.0 },
                { "path": "cache/b.jpg", "time": 2.0 }
            ]
        });
        assert_eq!(
            frame_image_paths(&batch),
            vec![PathBuf::from("cache/a.jpg"), PathBuf::from("cache/b.jpg")]
        );

        // Nothing about the request reaches this: a payload that named no
        // picture inlines none.
        assert!(frame_image_paths(&json!({ "status": "ok" })).is_empty());
    }

    #[test]
    fn image_mime_type_should_follow_the_written_extension() {
        assert_eq!(image_mime_type(Path::new("a.jpg")).unwrap(), "image/jpeg");
        assert_eq!(image_mime_type(Path::new("a.JPEG")).unwrap(), "image/jpeg");
        assert_eq!(image_mime_type(Path::new("a.png")).unwrap(), "image/png");
        assert_eq!(image_mime_type(Path::new("a.tiff")).unwrap(), "image/tiff");
        assert!(image_mime_type(Path::new("a.bin")).is_err());
        assert!(image_mime_type(Path::new("a")).is_err());
    }

    #[test]
    fn inline_frame_images_should_encode_the_bytes_that_were_written() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let image = temp.path().join("frame.png");
        std::fs::write(&image, b"pretend png").expect("still");

        let payload = json!({ "frames": [{ "path": image.to_string_lossy() }] });
        let images = inline_frame_images(&payload, MAX_INLINE_FRAME_STILLS).expect("inlined");

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].path, image);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&images[0].data)
                .expect("valid base64"),
            b"pretend png"
        );
    }

    #[test]
    fn inline_frame_images_should_stop_at_the_cap() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let mut frames = Vec::new();
        for index in 0..MAX_INLINE_FRAME_STILLS + 3 {
            let image = temp.path().join(format!("frame_{index:03}.jpg"));
            std::fs::write(&image, b"bytes").expect("still");
            frames.push(json!({ "path": image.to_string_lossy() }));
        }
        let payload = json!({ "frames": frames });

        let images = inline_frame_images(&payload, MAX_INLINE_FRAME_STILLS).expect("inlined");
        assert_eq!(images.len(), MAX_INLINE_FRAME_STILLS);
        assert_eq!(inline_frame_images(&payload, 2).expect("inlined").len(), 2);
        assert!(inline_frame_images(&payload, 0)
            .expect("inlined")
            .is_empty());
    }

    #[test]
    fn inline_frame_images_should_fail_on_a_frame_it_cannot_read() {
        let payload = json!({ "frames": [{ "path": "does/not/exist.jpg" }] });
        let error = inline_frame_images(&payload, MAX_INLINE_FRAME_STILLS)
            .expect_err("a missing still cannot be inlined");
        assert!(
            error.to_string().contains("does/not/exist.jpg"),
            "the error should name the frame it could not read, got: {error}"
        );
    }
}
