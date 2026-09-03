//! Frame-probe request and result shapes for the in-app agent bridge.
//!
//! The external agents that run inside the app (Codex, Claude Code) reach the
//! project through the app's own tool bridge, and until now everything they
//! could see was text. This is the request they send and the result they get
//! back: stills and contact sheets of the **composited** edit — captions, text,
//! transforms and blends included — optionally carried back inline as base64 so
//! a vision model can look at them without a filesystem tool.
//!
//! The engine is [`crate::core::render::frame_probe`], shared verbatim with the
//! CLI, so the two surfaces cannot disagree about what a frame of the edit
//! looks like. What lives here is the boundary the app adds around it: the
//! translation into the engine's request, path confinement, and the inline
//! budget. It is deliberately Tauri-free, so all of that is unit-testable —
//! `ipc::commands` is not compiled into the test build, and the command itself
//! is a thin caller of what is here.
//!
//! # Scope
//!
//! The caller never names an output path. Every image is written into a
//! timestamped entry under `.openreelio/cache/frames/`, which bounds itself to
//! its newest entries and is safe to delete. A `file` to judge is confined to
//! the project directory, because it is a caller-supplied path handed straight
//! to FFmpeg. An `asset` is not: it is an id, and the media behind it is the
//! project's own — see [`check_asset_media`] for what is still enforced there.

use std::path::{Component, Path, PathBuf};

use crate::core::fs::{confine_media_path_to_project, is_network_path, strip_verbatim_prefix};
use crate::core::project::ProjectState;
use crate::core::render::frame_probe::{
    allocate_frame_output, frame_image_paths, image_mime_type, inline_frame_images,
    parse_image_format, FrameArtifact, FrameOutput, FrameProbePlan, FrameProbeRequest,
    MAX_INLINE_FRAME_STILLS,
};
use crate::core::render::ImageFormat;

/// What to extract, as the in-app agent bridge expresses it.
///
/// Mirrors [`FrameProbeRequest`] field for field, minus `out`: where the images
/// land is the app's decision, not the caller's. `inline` is the one addition —
/// it asks for the bytes back, not just the paths.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFrameProbeRequestDto {
    /// Sequence to read; the project's active sequence when absent.
    #[serde(default)]
    pub sequence: Option<String>,
    /// Timeline time in seconds.
    #[serde(default)]
    pub time: Option<f64>,
    /// Timeline times in seconds; a batch of stills, or a contact sheet's cells.
    #[serde(default)]
    pub times: Option<Vec<f64>>,
    /// Contact sheet grid as `COLSxROWS`, or `auto` to size it from the samples.
    #[serde(default)]
    pub grid: Option<String>,
    /// Time range a `grid` request samples, as `[start, end]`.
    #[serde(default)]
    pub between: Option<Vec<f64>>,
    /// Number of grid samples; the grid's capacity when absent.
    #[serde(default)]
    pub count: Option<usize>,
    /// Contact sheet cell width in pixels.
    #[serde(default)]
    pub cell_width: Option<u32>,
    /// Contact sheet cell height in pixels.
    #[serde(default)]
    pub cell_height: Option<u32>,
    /// Burn each cell's index and timecode into the contact sheet.
    #[serde(default)]
    pub label_cells: bool,
    /// Timeline extraction mode, `composite` (default) or `fast`.
    #[serde(default)]
    pub mode: Option<String>,
    /// Maximum output width in pixels; aspect ratio is preserved, never upscaled.
    #[serde(default)]
    pub max_width: Option<u32>,
    /// Output image format, `png` or `jpeg`. Ignored shape-wise when `inline`.
    #[serde(default)]
    pub format: Option<String>,
    /// Rendered video inside the project to read instead of the timeline.
    #[serde(default)]
    pub file: Option<String>,
    /// Asset to extract from, in the asset's own media timebase.
    #[serde(default)]
    pub asset: Option<String>,
    /// Time inside the asset's own media, in seconds.
    #[serde(default)]
    pub source_time: Option<f64>,
    /// Sample both sides of every cut.
    #[serde(default)]
    pub at_cuts: bool,
    /// Sample the start, cut and end of every two-input transition.
    #[serde(default)]
    pub at_transitions: bool,
    /// Sample the middle of every caption and text span.
    #[serde(default)]
    pub at_captions: bool,
    /// Sample every sequence marker.
    #[serde(default)]
    pub at_markers: bool,
    /// Sample the middle of every shot the export draws.
    #[serde(default)]
    pub per_shot: bool,
    /// Sample a window centred on this timeline time, in seconds.
    #[serde(default)]
    pub around: Option<f64>,
    /// Half-width of the `around` window in seconds.
    #[serde(default)]
    pub span: Option<f64>,
    /// Number of samples the `around` window produces.
    #[serde(default)]
    pub around_count: Option<usize>,
    /// Sample the timeline ranges the last applied edit changed.
    #[serde(default)]
    pub affected: bool,
    /// Largest number of sampler times to keep.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Carry the image bytes back as base64, not just their paths.
    #[serde(default)]
    pub inline: bool,
}

/// One image an extraction produced.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFrameImageDto {
    /// Where the image was written, inside the project's frame cache.
    pub path: String,
    /// IANA media type of the file, for example `image/jpeg`.
    pub mime_type: String,
    /// Base64 image bytes with no `data:` prefix; present only when `inline`.
    pub data: Option<String>,
}

/// A finished frame probe.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFrameProbeResultDto {
    /// The probe's own JSON report — the same object the CLI prints.
    ///
    /// Passed through verbatim rather than re-typed, so the timecodes, sampler
    /// reasons and warnings an agent reasons over are identical on both
    /// surfaces and cannot drift as the engine grows.
    pub payload: serde_json::Value,
    /// The images the payload names, in payload order.
    pub images: Vec<TimelineFrameImageDto>,
}

impl TimelineFrameProbeRequestDto {
    /// Whether the layout is a contact sheet rather than separate stills.
    pub(crate) fn is_grid(&self) -> bool {
        self.grid.is_some()
    }

    /// Whether any event sampler was asked for.
    pub(crate) fn has_sampler(&self) -> bool {
        self.at_cuts
            || self.at_transitions
            || self.at_captions
            || self.at_markers
            || self.per_shot
            || self.around.is_some()
            || self.affected
    }

    /// What this request writes into its cache entry.
    pub(crate) fn artifact(&self) -> FrameArtifact {
        if self.is_grid() {
            FrameArtifact::Sheet
        } else if self.times.is_some() || self.has_sampler() {
            FrameArtifact::Batch
        } else {
            FrameArtifact::Still
        }
    }

    /// Resolves the encoding, which `inline` decides.
    ///
    /// Inline images are encoded for a vision model rather than for archival:
    /// JPEG is what keeps one response a size the bridge can carry. A caller
    /// who asked for both inline bytes and a lossless format is told so rather
    /// than quietly handed the other one.
    pub(crate) fn resolve_format(&self) -> Result<ImageFormat, String> {
        let requested = match self.format.as_deref() {
            Some(raw) => Some(parse_image_format(raw).map_err(|error| error.to_string())?),
            None => None,
        };

        if !self.inline {
            return Ok(requested.unwrap_or(ImageFormat::Png));
        }

        match requested {
            None | Some(ImageFormat::Jpeg) => Ok(ImageFormat::Jpeg),
            Some(_) => Err(format!(
                "Inline frames are encoded as JPEG so one response stays a size the agent bridge can carry; drop format '{}', or set inline to false to keep the file and read it by path.",
                self.format.as_deref().unwrap_or_default().trim()
            )),
        }
    }

    /// The sampler budget the probe is given.
    ///
    /// A batch of stills travels inline, so an unbounded sampler would build a
    /// response no host can carry. The cap is applied as the caller's own
    /// budget when they state none. A sheet needs no budget: it is one image
    /// however many cells it holds.
    pub(crate) fn resolve_limit(&self) -> Option<usize> {
        let uncapped_inline_batch = self.inline && self.has_sampler() && !self.is_grid();
        match (self.limit, uncapped_inline_batch) {
            (Some(limit), _) => Some(limit),
            (None, true) => Some(MAX_INLINE_FRAME_STILLS),
            (None, false) => None,
        }
    }

    /// Refuses a request that asks for more inline stills than one reply holds.
    ///
    /// Stated counts are refused up front rather than silently truncated at
    /// read-back, because a caller who asked for sixteen moments and got twelve
    /// would judge the edit from an answer it does not know is partial.
    pub(crate) fn validate_inline_budget(&self) -> Result<(), String> {
        if !self.inline || self.is_grid() {
            return Ok(());
        }

        if let Some(times) = self.times.as_deref() {
            if times.len() > MAX_INLINE_FRAME_STILLS {
                return Err(format!(
                    "times asks for {} inline stills, more than the maximum of {MAX_INLINE_FRAME_STILLS}. Ask for fewer, or pass grid for a contact sheet.",
                    times.len()
                ));
            }
        }

        if let Some(limit) = self.limit {
            if limit > MAX_INLINE_FRAME_STILLS {
                return Err(format!(
                    "limit asks for up to {limit} inline stills, more than the maximum of {MAX_INLINE_FRAME_STILLS}. Lower it, or pass grid for a contact sheet."
                ));
            }
        }

        Ok(())
    }

    /// Translates the request into the engine's own, with the paths the app chose.
    pub(crate) fn into_probe_request(
        self,
        out: PathBuf,
        file: Option<PathBuf>,
        format: ImageFormat,
        limit: Option<usize>,
    ) -> FrameProbeRequest {
        FrameProbeRequest {
            out,
            file,
            asset: self.asset,
            source_time: self.source_time,
            time: self.time,
            times: self.times,
            sequence: self.sequence,
            mode: self.mode,
            max_width: self.max_width,
            // Stated rather than left to the extension so a batch — whose `out`
            // is a directory and names no format at all — encodes the same way
            // a single still does.
            format: Some(format.extension().to_string()),
            grid: self.grid,
            between: self.between,
            count: self.count,
            cell_width: self.cell_width,
            cell_height: self.cell_height,
            label_cells: self.label_cells,
            at_cuts: self.at_cuts,
            at_transitions: self.at_transitions,
            at_captions: self.at_captions,
            at_markers: self.at_markers,
            per_shot: self.per_shot,
            around: self.around,
            span: self.span,
            around_count: self.around_count,
            affected: self.affected,
            limit,
        }
    }
}

/// Validates the request, then reserves the cache entry it writes into.
///
/// The order is the point. Reserving an entry creates a directory *and prunes
/// the cache back to its bound*, so doing it first meant a request the engine
/// was always going to refuse — an empty `{}`, a grid past the cell cap —
/// evicted a legitimate entry to make room for a directory nothing was ever
/// written into. Every guard the probe applies runs before anything is created.
///
/// Blocking on purpose: both halves touch the filesystem, so callers on an
/// async runtime hand the whole thing to a blocking thread rather than stalling
/// the one that is also driving the UI.
pub(crate) fn plan_frame_probe(
    project_dir: &Path,
    request: TimelineFrameProbeRequestDto,
    file: Option<PathBuf>,
    format: ImageFormat,
    limit: Option<usize>,
) -> Result<(FrameProbePlan, FrameOutput), String> {
    let artifact = request.artifact();
    // `out` is not known until an entry is reserved, and reserving one is
    // exactly what must not happen yet. The engine reads `out` only to infer a
    // format the caller did not state, and this request always states one.
    let mut probe_request = request.into_probe_request(PathBuf::new(), file, format, limit);
    FrameProbePlan::validate(&probe_request).map_err(|error| error.to_string())?;

    let output =
        allocate_frame_output(project_dir, artifact, format).map_err(|error| error.to_string())?;
    probe_request.out = output.out().to_path_buf();

    match FrameProbePlan::resolve(probe_request) {
        Ok(plan) => Ok((plan, output)),
        Err(error) => {
            // Unreachable while `validate` and `resolve` run the same guards,
            // but an entry left behind by a refusal is residue either way.
            output.discard();
            Err(error.to_string())
        }
    }
}

/// Describes every image the payload names, reading back only what was asked for.
///
/// The read-and-encode pass is handed to a blocking thread: the images can run
/// to megabytes and base64 is pure CPU on a runtime that is also driving the UI.
///
/// An inline request that produced more stills than one reply carries is a hard
/// failure, not a partial answer. [`TimelineFrameProbeRequestDto::resolve_limit`]
/// and [`validate_inline_budget`](TimelineFrameProbeRequestDto::validate_inline_budget)
/// are supposed to make that unreachable, so reaching it means the budget and
/// the extraction disagree — and the one thing that must not happen then is
/// handing an agent a batch where some stills quietly carry no bytes, which it
/// would judge as if it had seen them.
pub(crate) async fn collect_images(
    payload: &serde_json::Value,
    inline: bool,
) -> Result<Vec<TimelineFrameImageDto>, String> {
    let paths = frame_image_paths(payload);

    let inlined = if inline {
        let payload = payload.clone();
        tokio::task::spawn_blocking(move || inline_frame_images(&payload, MAX_INLINE_FRAME_STILLS))
            .await
            .map_err(|error| format!("Frame encoding task failed: {error}"))?
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };

    if inline && inlined.len() < paths.len() {
        return Err(format!(
            "The extraction produced {} stills, more than the {MAX_INLINE_FRAME_STILLS} one inline reply carries. Ask for fewer times, lower limit, or pass grid for a contact sheet.",
            paths.len()
        ));
    }

    // `inline_frame_images` reads the same payload in the same order and takes a
    // prefix of it, so zipping by position pairs each still with its own bytes.
    let mut inlined = inlined.into_iter();
    paths
        .into_iter()
        .map(|path| {
            let (mime_type, data) = match inlined.next() {
                Some(image) => (image.mime_type, Some(image.data)),
                None => (
                    image_mime_type(&path).map_err(|error| error.to_string())?,
                    None,
                ),
            };
            Ok(TimelineFrameImageDto {
                path: path.to_string_lossy().to_string(),
                mime_type,
                data,
            })
        })
        .collect()
}

/// One rejection message for every way a `file` fails to land in the project.
///
/// Absolute-elsewhere, traversing, symlinked and simply-missing paths all fail
/// with the same words, and the words name neither the project's resolved
/// location nor whether the file exists. Two separate messages made the probe an
/// existence oracle for the whole disk — "does not exist" versus "outside the
/// project" answers `file` for any path a caller cares to try — and the
/// second of them printed the canonical project path back to the caller.
fn probe_file_escape_error(requested: &str) -> String {
    format!("file '{requested}' must resolve inside the project directory")
}

/// Confines a rendered file the caller asked to judge to the project directory.
///
/// The same rule the MCP server applies: an unconfined path handed to FFmpeg
/// turns a read-only tool into a whole-disk existence oracle and an outbound
/// connection primitive. A relative path is read against the project root, so
/// the natural spelling of a render inside the project keeps working.
///
/// Rejection is lexical *before* it is filesystem-based, and that ordering is
/// the point: a URL, a UNC/device path, a `..` escape or a non-disk prefix is
/// refused without anything being stat'd, so a hostile value cannot make the
/// app open an outbound SMB connection (and leak an NTLM handshake on Windows)
/// merely by being validated. Only a path already known to be spelled inside
/// the project is resolved on disk, where symlinks are caught.
///
/// The returned path carries no `\\?\` verbatim prefix: it is handed to FFmpeg
/// and echoed back to the caller, and neither should see a spelling the caller
/// never wrote.
pub(crate) fn confine_probe_file(
    canonical_project: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err("file must not be empty".to_string());
    }
    if trimmed.contains("://") {
        return Err(
            "file must be a filesystem path inside the project directory, not a URL".to_string(),
        );
    }
    // Matched on the raw string: a platform whose path parser does not
    // recognise `\\server\share` as a network path would treat it as a file
    // name and only fail later, after having tried to reach the share.
    if is_network_path(trimmed) {
        return Err(
            "file must be a filesystem path inside the project directory; UNC, device, and network paths are rejected"
                .to_string(),
        );
    }

    let requested_path = Path::new(trimmed);
    let escapes_lexically = requested_path
        .components()
        .any(|component| match component {
            Component::ParentDir => true,
            Component::Prefix(prefix) => !matches!(prefix.kind(), std::path::Prefix::Disk(_)),
            _ => false,
        });
    if escapes_lexically {
        return Err(probe_file_escape_error(trimmed));
    }

    // The project root is the app's own, not the caller's, so it is safe to
    // spell plainly; joining a relative path onto the verbatim form would hand
    // FFmpeg a `\\?\` path it never asked for.
    let project_root =
        PathBuf::from(strip_verbatim_prefix(&canonical_project.to_string_lossy()).into_owned());
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        project_root.join(requested_path)
    };

    // Only now is touching the filesystem safe. Resolution is what catches a
    // symlink inside the project that points out of it, and every rejection it
    // can produce — including "does not exist" — collapses into one message.
    let resolved = confine_media_path_to_project(canonical_project, &candidate.to_string_lossy())
        .map_err(|_| probe_file_escape_error(trimmed))?;

    Ok(PathBuf::from(
        strip_verbatim_prefix(&resolved.to_string_lossy()).into_owned(),
    ))
}

/// Checks the media behind an asset id before FFmpeg is asked to read it.
///
/// Deliberately *not* a project-directory confinement. The GUI imports media by
/// reference: the file stays where the user put it, and
/// [`Asset::resolved_path`](crate::core::assets::Asset::resolved_path) hands
/// back that original absolute path. Confining it would refuse the ordinary
/// case — every asset of every project whose footage lives in a camera dump or
/// a shared drive — while protecting nothing, because the sequence those same
/// assets are cut into is already rendered, previewed and exported from
/// wherever the media lies.
///
/// What is enforced is what the frame probe itself adds: it must not be the
/// thing that reaches off-host. A UNC or network path is refused lexically,
/// before anything stats it, because on Windows the stat *is* the outbound SMB
/// connection and the NTLM handshake that leaks with it. Existence is checked
/// so the caller is told the media is gone rather than reading an FFmpeg error
/// about a file it cannot see.
pub(crate) fn check_asset_media(
    project_path: &Path,
    project_state: &ProjectState,
    asset_id: &str,
) -> Result<(), String> {
    let Some(asset) = project_state.assets.get(asset_id) else {
        // A missing asset is the probe's error to report, in its own words.
        return Ok(());
    };

    let media_path = asset.resolved_path(project_path);
    let media = media_path.to_string_lossy();
    if is_network_path(&media) {
        return Err(format!(
            "Asset '{asset_id}' resolves to media on a UNC or network path; frame extraction only reads local media"
        ));
    }
    if !media_path.exists() {
        return Err(format!(
            "Asset '{asset_id}' resolves to media that is not on this machine: '{media}'"
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, VideoInfo};
    use serde_json::json;

    fn sampler_request() -> TimelineFrameProbeRequestDto {
        TimelineFrameProbeRequestDto {
            per_shot: true,
            inline: true,
            ..Default::default()
        }
    }

    #[test]
    fn should_choose_the_artifact_from_the_shape_of_the_request() {
        let still = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            ..Default::default()
        };
        assert_eq!(still.artifact(), FrameArtifact::Still);

        let batch = TimelineFrameProbeRequestDto {
            times: Some(vec![0.0, 1.0]),
            ..Default::default()
        };
        assert_eq!(batch.artifact(), FrameArtifact::Batch);
        assert_eq!(sampler_request().artifact(), FrameArtifact::Batch);

        let sheet = TimelineFrameProbeRequestDto {
            per_shot: true,
            grid: Some("auto".to_string()),
            ..Default::default()
        };
        assert_eq!(sheet.artifact(), FrameArtifact::Sheet);
    }

    #[test]
    fn should_force_jpeg_for_inline_frames_and_refuse_a_contradiction() {
        assert_eq!(
            sampler_request().resolve_format().expect("inline defaults"),
            ImageFormat::Jpeg
        );

        let explicit_jpeg = TimelineFrameProbeRequestDto {
            format: Some("jpg".to_string()),
            ..sampler_request()
        };
        assert_eq!(
            explicit_jpeg.resolve_format().expect("jpeg agrees"),
            ImageFormat::Jpeg
        );

        // A silent downgrade would hand back a JPEG to a caller who asked for a
        // lossless still and never told them.
        let contradiction = TimelineFrameProbeRequestDto {
            format: Some("png".to_string()),
            ..sampler_request()
        };
        let error = contradiction
            .resolve_format()
            .expect_err("inline png must be refused");
        assert!(
            error.contains("JPEG") && error.contains("inline"),
            "the refusal should say why, got: {error}"
        );
    }

    #[test]
    fn should_keep_the_requested_format_when_nothing_travels_inline() {
        let png = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            ..Default::default()
        };
        assert_eq!(png.resolve_format().expect("default"), ImageFormat::Png);

        let jpeg = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            format: Some("jpeg".to_string()),
            ..Default::default()
        };
        assert_eq!(jpeg.resolve_format().expect("jpeg"), ImageFormat::Jpeg);

        let invalid = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            format: Some("gif".to_string()),
            ..Default::default()
        };
        assert!(invalid.resolve_format().is_err());
    }

    #[test]
    fn should_cap_an_inline_sampler_batch_and_leave_a_sheet_uncapped() {
        assert_eq!(
            sampler_request().resolve_limit(),
            Some(MAX_INLINE_FRAME_STILLS)
        );

        let stated = TimelineFrameProbeRequestDto {
            limit: Some(4),
            ..sampler_request()
        };
        assert_eq!(stated.resolve_limit(), Some(4));

        // One image however many cells it holds, so a sheet needs no budget.
        let sheet = TimelineFrameProbeRequestDto {
            grid: Some("auto".to_string()),
            ..sampler_request()
        };
        assert_eq!(sheet.resolve_limit(), None);

        // Nothing travels inline, so nothing bounds the caller's own request.
        let offline = TimelineFrameProbeRequestDto {
            inline: false,
            ..sampler_request()
        };
        assert_eq!(offline.resolve_limit(), None);
    }

    #[test]
    fn should_refuse_more_inline_stills_than_one_reply_holds() {
        let times = TimelineFrameProbeRequestDto {
            times: Some(vec![0.0; MAX_INLINE_FRAME_STILLS + 1]),
            inline: true,
            ..Default::default()
        };
        assert!(times.validate_inline_budget().is_err());

        let limit = TimelineFrameProbeRequestDto {
            limit: Some(MAX_INLINE_FRAME_STILLS + 1),
            ..sampler_request()
        };
        assert!(limit.validate_inline_budget().is_err());

        // A sheet is one image, and an offline batch is only paths.
        let sheet = TimelineFrameProbeRequestDto {
            grid: Some("auto".to_string()),
            ..limit.clone()
        };
        assert!(sheet.validate_inline_budget().is_ok());
        let offline = TimelineFrameProbeRequestDto {
            inline: false,
            ..limit
        };
        assert!(offline.validate_inline_budget().is_ok());
    }

    #[test]
    fn should_carry_every_selector_through_to_the_probe_request() {
        let request = TimelineFrameProbeRequestDto {
            sequence: Some("seq".to_string()),
            times: Some(vec![0.0, 1.5]),
            grid: Some("2x1".to_string()),
            between: Some(vec![0.0, 4.0]),
            count: Some(3),
            cell_width: Some(512),
            cell_height: Some(288),
            label_cells: true,
            mode: Some("composite".to_string()),
            max_width: Some(1920),
            asset: Some("asset-1".to_string()),
            source_time: Some(2.5),
            at_cuts: true,
            at_transitions: true,
            at_captions: true,
            at_markers: true,
            per_shot: true,
            around: Some(4.25),
            span: Some(0.75),
            around_count: Some(7),
            affected: true,
            time: Some(9.5),
            ..Default::default()
        };

        let probe = request.into_probe_request(
            PathBuf::from("cache/entry/sheet.jpg"),
            Some(PathBuf::from("render.mp4")),
            ImageFormat::Jpeg,
            Some(6),
        );

        // Every field here decides what FFmpeg is actually asked for, and the
        // mapping is written out by hand: a transposed pair would still compile.
        assert_eq!(probe.out, PathBuf::from("cache/entry/sheet.jpg"));
        assert_eq!(probe.file, Some(PathBuf::from("render.mp4")));
        assert_eq!(probe.sequence.as_deref(), Some("seq"));
        assert_eq!(probe.time, Some(9.5));
        assert_eq!(probe.times, Some(vec![0.0, 1.5]));
        assert_eq!(probe.grid.as_deref(), Some("2x1"));
        assert_eq!(probe.between, Some(vec![0.0, 4.0]));
        assert_eq!(probe.count, Some(3));
        assert_eq!(probe.cell_width, Some(512));
        assert_eq!(probe.cell_height, Some(288));
        assert!(probe.label_cells);
        assert_eq!(probe.mode.as_deref(), Some("composite"));
        assert_eq!(probe.max_width, Some(1920));
        assert_eq!(probe.asset.as_deref(), Some("asset-1"));
        assert_eq!(probe.source_time, Some(2.5));
        assert!(probe.at_cuts);
        assert!(probe.at_transitions);
        assert!(probe.at_captions);
        assert!(probe.at_markers);
        assert!(probe.per_shot);
        assert_eq!(probe.around, Some(4.25));
        assert_eq!(probe.span, Some(0.75));
        assert_eq!(probe.around_count, Some(7));
        assert!(probe.affected);
        assert_eq!(probe.limit, Some(6));
        // Stated rather than inferred: a batch's `out` is a directory and names
        // no format at all.
        assert_eq!(probe.format.as_deref(), Some("jpg"));
    }

    #[test]
    fn should_default_to_the_composited_picture() {
        // `mode` reaching the engine as None is what makes the still show
        // captions, text and blends; a stray default of "fast" here would hand
        // agents a topmost-clip frame that silently drops the edit.
        let probe = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            ..Default::default()
        }
        .into_probe_request(PathBuf::from("frame.png"), None, ImageFormat::Png, None);
        assert!(probe.mode.is_none());
    }

    #[tokio::test]
    async fn should_describe_every_frame_and_inline_only_what_was_asked_for() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let first = temp.path().join("frame_000.jpg");
        let second = temp.path().join("frame_001.jpg");
        std::fs::write(&first, b"first").expect("still");
        std::fs::write(&second, b"second").expect("still");
        let payload = json!({
            "frames": [
                { "path": first.to_string_lossy() },
                { "path": second.to_string_lossy() },
            ]
        });

        let offline = collect_images(&payload, false).await.expect("paths only");
        assert_eq!(offline.len(), 2);
        assert!(offline.iter().all(|image| image.data.is_none()));
        assert_eq!(offline[0].mime_type, "image/jpeg");

        let inlined = collect_images(&payload, true).await.expect("inlined");
        assert_eq!(inlined.len(), 2);
        assert_eq!(inlined[0].path, first.to_string_lossy());
        assert!(inlined.iter().all(|image| image.data.is_some()));
    }

    #[tokio::test]
    async fn should_fail_rather_than_inline_only_part_of_a_batch() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let mut frames = Vec::new();
        for index in 0..MAX_INLINE_FRAME_STILLS + 2 {
            let still = temp.path().join(format!("frame_{index:03}.jpg"));
            std::fs::write(&still, b"bytes").expect("still");
            frames.push(json!({ "path": still.to_string_lossy() }));
        }
        let payload = json!({ "frames": frames });

        // Handing back a batch where the last two stills quietly carry no bytes
        // would have an agent judge moments it never saw. The budget guards are
        // supposed to make this unreachable; if they ever disagree with the
        // extraction, the call has to fail rather than answer partially.
        let error = collect_images(&payload, true)
            .await
            .expect_err("a batch past the inline cap must not be answered partially");
        assert!(
            error.contains(&(MAX_INLINE_FRAME_STILLS + 2).to_string())
                && error.contains(&MAX_INLINE_FRAME_STILLS.to_string()),
            "the error should name the count and the cap, got: {error}"
        );

        // Nothing travels inline, so every still is described by path and the
        // same payload is fine.
        assert_eq!(
            collect_images(&payload, false)
                .await
                .expect("paths only")
                .len(),
            MAX_INLINE_FRAME_STILLS + 2
        );
    }

    #[tokio::test]
    async fn should_report_a_sheet_as_one_image() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let sheet = temp.path().join("sheet.jpg");
        std::fs::write(&sheet, b"sheet").expect("sheet");
        let payload = json!({
            "sheet": { "path": sheet.to_string_lossy(), "columns": 3, "rows": 2 },
            "frames": []
        });

        let images = collect_images(&payload, true).await.expect("inlined");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].mime_type, "image/jpeg");
        assert!(images[0].data.is_some());
    }

    /// Builds a project whose single asset points at `media`.
    fn project_with_asset(media: &Path) -> ProjectState {
        let mut state = ProjectState::new("confinement");
        let mut asset = Asset::new_video(
            "clip.mp4",
            &media.to_string_lossy(),
            VideoInfo {
                width: 1920,
                height: 1080,
                ..VideoInfo::default()
            },
        );
        asset.id = "asset-1".to_string();
        // `resolved_path` prefers the relative path when one is stored, and the
        // media under test is addressed absolutely.
        asset.relative_path = None;
        state.assets.insert(asset.id.clone(), asset);
        state
    }

    #[test]
    fn should_read_ordinary_gui_asset_media_from_where_the_user_keeps_it() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project");
        // What GUI import actually produces: the footage stays in the camera
        // dump the user pointed at, and the asset carries its absolute path.
        let outside = temp.path().join("camera_dump.mp4");
        std::fs::write(&outside, b"media").expect("media");

        let state = project_with_asset(&outside);
        assert!(
            check_asset_media(&project, &state, "asset-1").is_ok(),
            "the project's own media must be readable from wherever it lives"
        );

        // An unknown id is the probe's error to report, in its own words.
        assert!(check_asset_media(&project, &state, "missing").is_ok());
    }

    #[test]
    fn should_refuse_asset_media_that_is_not_local_or_not_there() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project");

        // Stat'ing a share is itself the outbound SMB connection, so the
        // refusal has to happen on the string.
        let share = project_with_asset(Path::new(r"\\attacker\share\clip.mp4"));
        let error = check_asset_media(&project, &share, "asset-1")
            .expect_err("network media must not be reached");
        assert!(
            error.contains("asset-1") && error.contains("network"),
            "the refusal should name the asset and the reason, got: {error}"
        );

        let gone = project_with_asset(&temp.path().join("relinked_away.mp4"));
        let error = check_asset_media(&project, &gone, "asset-1")
            .expect_err("media that is not on this machine must be reported");
        assert!(
            error.contains("asset-1"),
            "the refusal should name the asset, got: {error}"
        );
    }

    #[test]
    fn should_confine_a_rendered_file_to_the_project_directory() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("exports")).expect("project");
        std::fs::write(project.join("exports").join("cut.mp4"), b"render").expect("render");
        let outside = temp.path().join("outside.mp4");
        std::fs::write(&outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let inside = confine_probe_file(&canonical, "exports/cut.mp4").expect("a render inside");
        assert!(inside.ends_with("cut.mp4"));
        // The path is handed to FFmpeg and echoed back to the caller, so it
        // must not carry a spelling the caller never wrote.
        assert!(
            !inside.to_string_lossy().contains(r"\\?\"),
            "the accepted path must carry no verbatim prefix: {}",
            inside.display()
        );

        for escape in [
            outside.to_string_lossy().to_string(),
            "../outside.mp4".to_string(),
            r"\\attacker\share\cut.mp4".to_string(),
            "https://example.com/cut.mp4".to_string(),
            "  ".to_string(),
        ] {
            assert!(
                confine_probe_file(&canonical, &escape).is_err(),
                "'{escape}' must not be readable through the frame probe"
            );
        }
    }

    #[test]
    fn should_not_tell_a_caller_whether_a_file_outside_the_project_exists() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project");
        let existing_outside = temp.path().join("secret.mp4");
        std::fs::write(&existing_outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        // Distinguishable refusals turn the probe into a whole-disk existence
        // oracle: ask for a path, read which way it was refused.
        let outside = confine_probe_file(&canonical, &existing_outside.to_string_lossy())
            .expect_err("a render outside the project must be refused");
        let missing = confine_probe_file(&canonical, "exports/never_rendered.mp4")
            .expect_err("a render that was never produced must be refused");

        assert_eq!(
            missing, "file 'exports/never_rendered.mp4' must resolve inside the project directory",
            "the refusal must not say whether the file exists"
        );
        assert!(
            outside.starts_with(&format!("file '{}'", existing_outside.to_string_lossy()))
                && outside.ends_with("must resolve inside the project directory"),
            "both refusals must read identically, got: {outside}"
        );
        // Neither may echo where the project actually resolved to.
        for message in [&outside, &missing] {
            assert!(
                !message.contains(&canonical.to_string_lossy().to_string()),
                "the refusal must not leak the canonical project path: {message}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn should_refuse_a_symlink_inside_the_project_that_points_outside() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("exports")).expect("project");
        let outside = temp.path().join("secret.mp4");
        std::fs::write(&outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let link = project.join("exports").join("cut.mp4");
        // Creating a symlink needs Developer Mode or an elevated shell; a
        // machine that refuses is not evidence about the guard either way.
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }

        // The path is spelled entirely inside the project, so only resolving it
        // catches this one.
        let error = confine_probe_file(&canonical, "exports/cut.mp4")
            .expect_err("a symlink out of the project must be refused");
        assert_eq!(
            error,
            "file 'exports/cut.mp4' must resolve inside the project directory"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn should_refuse_a_symlink_inside_the_project_that_points_outside() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("exports")).expect("project");
        let outside = temp.path().join("secret.mp4");
        std::fs::write(&outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let link = project.join("exports").join("cut.mp4");
        if std::os::unix::fs::symlink(&outside, &link).is_err() {
            return;
        }

        let error = confine_probe_file(&canonical, "exports/cut.mp4")
            .expect_err("a symlink out of the project must be refused");
        assert_eq!(
            error,
            "file 'exports/cut.mp4' must resolve inside the project directory"
        );
    }

    #[test]
    fn should_not_touch_the_frame_cache_for_a_request_the_engine_refuses() {
        use crate::core::render::frame_probe::{frame_cache_dir, MAX_CACHED_FRAME_DIRECTORIES};

        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let cache_root = frame_cache_dir(&project);
        std::fs::create_dir_all(&cache_root).expect("cache root");

        // A cache already at its bound. Reserving an entry prunes, so a
        // rejected request that allocated first would evict a real judgement's
        // evidence to make room for a directory nothing is written into.
        let seeded: Vec<String> = (0..MAX_CACHED_FRAME_DIRECTORIES)
            .map(|index| format!("20260816T120000{index:06}Z-0000"))
            .collect();
        for stamp in &seeded {
            std::fs::create_dir_all(cache_root.join(stamp)).expect("cache entry");
        }

        let refused = [
            // No time source at all.
            json!({}),
            // A grid past the cell cap.
            json!({ "grid": "11x11", "between": [0.0, 4.0] }),
        ];
        for arguments in refused {
            let request: TimelineFrameProbeRequestDto =
                serde_json::from_value(arguments.clone()).expect("the request deserializes");
            let format = request.resolve_format().expect("format");
            let limit = request.resolve_limit();

            assert!(
                plan_frame_probe(&project, request, None, format, limit).is_err(),
                "{arguments} must be refused"
            );

            let mut remaining: Vec<String> = std::fs::read_dir(&cache_root)
                .expect("cache root")
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect();
            remaining.sort();
            assert_eq!(
                remaining, seeded,
                "a refused request must leave the cache exactly as it found it"
            );
        }
    }

    #[test]
    fn should_reserve_a_cache_entry_once_the_request_is_servable() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");

        let request = TimelineFrameProbeRequestDto {
            time: Some(1.0),
            ..Default::default()
        };
        let format = request.resolve_format().expect("format");
        let limit = request.resolve_limit();

        let (_plan, output) =
            plan_frame_probe(&project, request, None, format, limit).expect("a servable request");

        assert!(output.directory().is_dir());
        assert_eq!(
            output.out().file_name().and_then(|name| name.to_str()),
            Some("frame.png")
        );
    }

    #[test]
    fn should_reject_an_empty_request_with_the_engines_own_words() {
        // `{}` is what a bridge sends when the model names no time source at
        // all. It has to deserialize — the DTO is all-optional — and then be
        // refused by the engine's own guard, so the GUI and the CLI say the
        // same thing about the same mistake.
        let request: TimelineFrameProbeRequestDto =
            serde_json::from_value(json!({})).expect("an empty request must still deserialize");
        assert!(request.validate_inline_budget().is_ok());
        let format = request.resolve_format().expect("format");
        let limit = request.resolve_limit();

        let probe = request.into_probe_request(PathBuf::new(), None, format, limit);
        let error = crate::core::render::frame_probe::FrameProbePlan::validate(&probe)
            .expect_err("a request naming no time source must be refused");

        assert!(
            error.to_string().contains("Nothing to extract"),
            "the refusal should be the engine's own, got: {error}"
        );
    }
}
