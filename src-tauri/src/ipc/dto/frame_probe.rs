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
//! its newest entries and is safe to delete. A `file` to judge and an `asset`
//! to sample are both confined to the project directory, because those are the
//! two arguments that reach FFmpeg as a path.

use std::path::{Path, PathBuf};

use crate::core::fs::{confine_media_path_to_project, ProjectMediaRejection};
use crate::core::project::ProjectState;
use crate::core::render::frame_probe::{
    frame_image_paths, image_mime_type, inline_frame_images, parse_image_format, FrameArtifact,
    FrameProbeRequest, MAX_INLINE_FRAME_STILLS,
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

/// Describes every image the payload names, reading back only what was asked for.
///
/// The read-and-encode pass is handed to a blocking thread: the images can run
/// to megabytes and base64 is pure CPU on a runtime that is also driving the UI.
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

/// Confines a rendered file the caller asked to judge to the project directory.
///
/// The same rule the MCP server applies: an unconfined path handed to FFmpeg
/// turns a read-only tool into a whole-disk existence oracle and an outbound
/// connection primitive. A relative path is read against the project root, so
/// the natural spelling of a render inside the project keeps working.
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

    let requested_path = Path::new(trimmed);
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_project.join(requested_path)
    };

    confine_media_path_to_project(canonical_project, &candidate.to_string_lossy()).map_err(
        |rejection| match rejection {
            ProjectMediaRejection::Unresolved => {
                format!("file '{trimmed}' does not exist inside the project directory")
            }
            _ => format!(
                "file '{trimmed}' must resolve inside the project directory '{}'",
                canonical_project.display()
            ),
        },
    )
}

/// Confines the media behind an asset id before FFmpeg is asked to read it.
///
/// Project state is data the app reads, not a grant: an asset's `uri` can come
/// from an imported project or an `UpdateAsset` an agent plan applied, so the
/// path it resolves to is checked rather than trusted.
pub(crate) fn confine_asset_media(
    canonical_project: &Path,
    project_path: &Path,
    project_state: &ProjectState,
    asset_id: &str,
) -> Result<(), String> {
    let Some(asset) = project_state.assets.get(asset_id) else {
        // A missing asset is the probe's error to report, in its own words.
        return Ok(());
    };

    let media_path = asset.resolved_path(project_path);
    confine_media_path_to_project(canonical_project, &media_path.to_string_lossy()).map_err(
        |_| {
            format!(
                "Asset '{asset_id}' resolves to media outside the project directory; frame extraction only reads media inside the open project"
            )
        },
    )?;

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
    fn should_confine_asset_media_to_the_project_directory() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("media")).expect("project");
        let inside = project.join("media").join("clip.mp4");
        std::fs::write(&inside, b"media").expect("media");
        let outside = temp.path().join("elsewhere.mp4");
        std::fs::write(&outside, b"media").expect("outside media");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let state = project_with_asset(&inside);
        assert!(confine_asset_media(&canonical, &project, &state, "asset-1").is_ok());

        // An asset uri is project data, not a grant: an imported project or an
        // agent's UpdateAsset can point it anywhere on the disk.
        let escaped = project_with_asset(&outside);
        let error = confine_asset_media(&canonical, &project, &escaped, "asset-1")
            .expect_err("media outside the project must not be readable");
        assert!(
            error.contains("asset-1") && error.contains("outside"),
            "the refusal should name the asset and the reason, got: {error}"
        );

        // An unknown id is the probe's error to report, in its own words.
        assert!(confine_asset_media(&canonical, &project, &state, "missing").is_ok());
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

        for escape in [
            outside.to_string_lossy().to_string(),
            "../outside.mp4".to_string(),
            "https://example.com/cut.mp4".to_string(),
            "  ".to_string(),
        ] {
            assert!(
                confine_probe_file(&canonical, &escape).is_err(),
                "'{escape}' must not be readable through the frame probe"
            );
        }
    }
}
