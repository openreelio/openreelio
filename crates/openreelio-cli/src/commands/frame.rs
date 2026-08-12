//! Frame extraction commands.
//!
//! Gives agents a way to *see* the project: single stills from a source asset
//! or a timeline position, batches of stills, and contact sheets that map grid
//! cells back to timeline timecodes.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use crate::validate;
use clap::{Args, Subcommand};
use openreelio_core::analysis::visual::{
    VisualAnalyzer, CONTACT_SHEET_CELL_HEIGHT, CONTACT_SHEET_CELL_WIDTH,
};
use openreelio_core::assets::Asset;
use openreelio_core::effects::Effect;
use openreelio_core::ffmpeg::{FFmpegRunner, FrameExtractOptions};
use openreelio_core::render::{
    build_render_graph, build_render_plan, clip_source_time_at, probed_image_dimensions,
    scaled_frame_dimensions, validate_export_settings, ExportEngine, ExportSettings,
    FrameExportSettings, ImageFormat,
};
use openreelio_core::timeline::Sequence;
use openreelio_core::ActiveProject;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default maximum still width. 1280px keeps frames readable for vision models
/// while staying well under typical image-token limits.
const DEFAULT_MAX_WIDTH: u32 = 1280;

/// Shortest composited window that FFmpeg can still render.
///
/// `normalize_output_time_range` rejects zero-length ranges, so a single
/// composited frame is rendered as a tiny non-zero window.
const MIN_COMPOSITE_WINDOW_SEC: f64 = 0.05;

#[derive(Subcommand)]
pub enum FrameAction {
    /// Extract still frames from an asset, a timeline position, or a grid of timeline positions
    Extract(ExtractArgs),
}

/// Arguments for `frame extract`.
#[derive(Args)]
pub struct ExtractArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Output image file, or output directory for --times
    #[arg(long)]
    pub out: PathBuf,

    /// Asset ID to extract from (requires --source-time)
    #[arg(long, requires = "source_time", conflicts_with_all = ["time", "times", "grid"])]
    pub asset: Option<String>,

    /// Time in seconds inside the asset's own media (requires --asset)
    #[arg(long, requires = "asset")]
    pub source_time: Option<f64>,

    /// Timeline time in seconds
    #[arg(long, conflicts_with_all = ["times", "grid"])]
    pub time: Option<f64>,

    /// Comma-separated timeline times in seconds; --out must be a directory
    #[arg(long, value_delimiter = ',', conflicts_with = "grid")]
    pub times: Option<Vec<f64>>,

    /// Sequence ID (defaults to active)
    #[arg(long)]
    pub sequence: Option<String>,

    /// Timeline extraction mode: fast (topmost clip only) or composite (full render)
    #[arg(long, default_value = "fast")]
    pub mode: String,

    /// Maximum output width in pixels (aspect ratio preserved, never upscaled)
    #[arg(long)]
    pub max_width: Option<u32>,

    /// Output image format
    #[arg(long, default_value = "png")]
    pub format: String,

    /// Contact sheet grid as COLSxROWS (requires --between)
    #[arg(long, requires = "between")]
    pub grid: Option<String>,

    /// Timeline range to sample for --grid
    #[arg(long, num_args = 2, value_names = ["START", "END"])]
    pub between: Option<Vec<f64>>,

    /// Number of grid samples (defaults to columns * rows)
    #[arg(long, requires = "grid")]
    pub count: Option<usize>,
}

pub fn execute(action: FrameAction) -> anyhow::Result<()> {
    match action {
        FrameAction::Extract(args) => extract(args),
    }
}

// ── Selection ───────────────────────────────────────────────────────────

/// Timeline extraction strategy.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TimelineMode {
    /// Topmost file-backed clip only; no effects, text, or compositing.
    Fast,
    /// Full composited render of a minimal window around the requested time.
    Composite,
}

impl TimelineMode {
    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "fast" => Ok(Self::Fast),
            "composite" => Ok(Self::Composite),
            other => Err(anyhow::anyhow!(
                "Invalid value for --mode: expected 'fast' or 'composite' (got '{}')",
                other
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Composite => "composite",
        }
    }
}

/// What the caller asked for, after argument validation.
enum Selection {
    /// A single frame from an asset's own media timebase.
    AssetTime { asset_id: String, source_time: f64 },
    /// One timeline still written to `--out`.
    SingleTime(f64),
    /// Several timeline stills written into the `--out` directory.
    BatchTimes(Vec<f64>),
    /// A contact sheet sampled over a timeline range.
    Grid {
        columns: usize,
        rows: usize,
        times: Vec<f64>,
    },
}

fn resolve_selection(args: &ExtractArgs) -> anyhow::Result<Selection> {
    if let Some(grid) = &args.grid {
        let (columns, rows) = parse_grid_spec(grid)?;
        let range = args
            .between
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("--grid requires --between <START> <END>"))?;
        if range.len() != 2 {
            return Err(anyhow::anyhow!("--between takes exactly two values"));
        }
        validate::time_range_ordered(range[0], range[1], "between START", "between END")?;

        let capacity = columns * rows;
        let count = args.count.unwrap_or(capacity);
        if count < 1 {
            return Err(anyhow::anyhow!("Invalid value for --count: must be >= 1"));
        }
        if count > capacity {
            return Err(anyhow::anyhow!(
                "Invalid value for --count: {} exceeds the {}x{} grid capacity of {}",
                count,
                columns,
                rows,
                capacity
            ));
        }

        return Ok(Selection::Grid {
            columns,
            rows,
            times: sample_times(range[0], range[1], count),
        });
    }

    if let Some(asset_id) = &args.asset {
        validate::non_empty(asset_id, "asset")?;
        let source_time = args
            .source_time
            .ok_or_else(|| anyhow::anyhow!("--asset requires --source-time <SEC>"))?;
        validate::time_non_negative(source_time, "source-time")?;
        return Ok(Selection::AssetTime {
            asset_id: asset_id.clone(),
            source_time,
        });
    }

    if let Some(times) = &args.times {
        if times.is_empty() {
            return Err(anyhow::anyhow!("--times requires at least one value"));
        }
        for time in times {
            validate::time_non_negative(*time, "times")?;
        }
        return Ok(Selection::BatchTimes(times.clone()));
    }

    if let Some(time) = args.time {
        validate::time_non_negative(time, "time")?;
        return Ok(Selection::SingleTime(time));
    }

    Err(anyhow::anyhow!(
        "Nothing to extract: pass --time, --times, --grid, or --asset with --source-time"
    ))
}

// ── Execution ───────────────────────────────────────────────────────────

fn extract(args: ExtractArgs) -> anyhow::Result<()> {
    let selection = resolve_selection(&args)?;
    let format = parse_image_format(&args.format)?;
    let mode = TimelineMode::parse(&args.mode)?;
    if let Some(max_width) = args.max_width {
        if max_width == 0 {
            return Err(anyhow::anyhow!(
                "Invalid value for --max-width: must be >= 1"
            ));
        }
    }

    let ffmpeg_info = ensure_ffmpeg()?;
    let project = super::load_project(&args.path)?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
    let runner = FFmpegRunner::new(ffmpeg_info);

    let result = match selection {
        Selection::AssetTime {
            asset_id,
            source_time,
        } => runtime.block_on(run_asset_mode(
            &project,
            &runner,
            &asset_id,
            source_time,
            &args.out,
            format,
            args.max_width,
        ))?,
        Selection::SingleTime(time) => runtime.block_on(run_timeline_mode(
            &project,
            &runner,
            &args,
            format,
            mode,
            &[time],
            false,
        ))?,
        Selection::BatchTimes(times) => runtime.block_on(run_timeline_mode(
            &project, &runner, &args, format, mode, &times, true,
        ))?,
        Selection::Grid {
            columns,
            rows,
            times,
        } => runtime.block_on(run_grid_mode(
            &project, &runner, &args, format, mode, columns, rows, &times,
        ))?,
    };

    output::print_json_pretty(&result)
}

async fn run_asset_mode(
    project: &ActiveProject,
    runner: &FFmpegRunner,
    asset_id: &str,
    source_time: f64,
    out: &Path,
    format: ImageFormat,
    max_width: Option<u32>,
) -> anyhow::Result<serde_json::Value> {
    let asset = project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| anyhow::anyhow!("Asset '{}' not found", asset_id))?;
    let media_path = asset.resolved_path(&project.path);

    let output_path = resolve_single_output_path(out, source_time, format)?;
    runner
        .extract_frame_with_options(
            &media_path,
            source_time,
            &output_path,
            &FrameExtractOptions {
                overwrite: true,
                max_width,
                quality: None,
            },
        )
        .await
        .map_err(|error| anyhow::anyhow!("Frame extraction failed: {}", error))?;

    let (width, height) = probed_image_dimensions(runner, &output_path)
        .await
        .unwrap_or_else(|| {
            asset
                .video
                .as_ref()
                .map(|video| scaled_frame_dimensions(video.width, video.height, max_width))
                .unwrap_or((0, 0))
        });

    let frame = FrameEntry {
        index: 0,
        time_sec: source_time,
        source_time_sec: Some(source_time),
        clip_id: None,
        asset_id: Some(asset_id.to_string()),
        path: output_path.display().to_string(),
        width,
        height,
        fell_back_to_composite: None,
    };

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "asset",
        "frames": [frame],
        "count": 1,
    }))
}

async fn run_timeline_mode(
    project: &ActiveProject,
    runner: &FFmpegRunner,
    args: &ExtractArgs,
    format: ImageFormat,
    mode: TimelineMode,
    times: &[f64],
    batch: bool,
) -> anyhow::Result<serde_json::Value> {
    let (sequence_id, sequence) = resolve_sequence(project, args.sequence.clone())?;
    let context = TimelineFrameContext {
        engine: ExportEngine::new(runner.clone()),
        runner,
        project,
        sequence,
        sequence_id: &sequence_id,
        format: format.clone(),
        max_width: args.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        mode,
    };

    if batch {
        std::fs::create_dir_all(&args.out).map_err(|error| {
            anyhow::anyhow!(
                "Failed to create output directory '{}': {}",
                args.out.display(),
                error
            )
        })?;
    }

    let mut frames = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        let output_path = if batch {
            args.out.join(batch_frame_name(*time, &format))
        } else {
            resolve_single_output_path(&args.out, *time, format.clone())?
        };
        frames.push(context.extract(index, *time, &output_path).await?);
    }

    Ok(serde_json::json!({
        "status": "ok",
        "mode": mode.label(),
        "frames": frames,
        "count": frames.len(),
    }))
}

#[allow(clippy::too_many_arguments)]
async fn run_grid_mode(
    project: &ActiveProject,
    runner: &FFmpegRunner,
    args: &ExtractArgs,
    format: ImageFormat,
    mode: TimelineMode,
    columns: usize,
    rows: usize,
    times: &[f64],
) -> anyhow::Result<serde_json::Value> {
    let (sequence_id, sequence) = resolve_sequence(project, args.sequence.clone())?;
    let context = TimelineFrameContext {
        engine: ExportEngine::new(runner.clone()),
        runner,
        project,
        sequence,
        sequence_id: &sequence_id,
        // Contact sheet cells are always JPEG: FFmpeg reads them back as a
        // `%d.jpg` image sequence.
        format: ImageFormat::Jpeg,
        max_width: args.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        mode,
    };

    let cell_dir = tempfile::tempdir()
        .map_err(|error| anyhow::anyhow!("Failed to create temporary cell directory: {error}"))?;

    let mut cell_paths = Vec::with_capacity(times.len());
    let mut cells = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        // The contact-sheet input pattern is a zero-based `%d.jpg` sequence.
        let cell_path = cell_dir.path().join(format!("{}.jpg", index));
        context.extract(index, *time, &cell_path).await?;
        cell_paths.push(cell_path);
        cells.push(GridCell {
            index,
            row: index / columns,
            col: index % columns,
            timeline_sec: *time,
        });
    }

    let sheet_path = normalize_extension(args.out.clone(), &format);
    let analyzer = VisualAnalyzer::new(runner.info().ffmpeg_path.clone());
    let artifact = analyzer
        .generate_contact_sheet_with_layout(&cell_paths, &sheet_path, Some((columns, rows)))
        .await
        .map_err(|error| anyhow::anyhow!("Contact sheet generation failed: {}", error))?
        .ok_or_else(|| anyhow::anyhow!("Contact sheet generation produced no output"))?;

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "grid",
        "sheet": {
            "path": artifact.path,
            "cols": artifact.columns,
            "rows": artifact.rows,
            "cellWidth": CONTACT_SHEET_CELL_WIDTH,
            "cellHeight": CONTACT_SHEET_CELL_HEIGHT,
            "cells": cells,
        },
    }))
}

// ── Timeline frame extraction ───────────────────────────────────────────

/// Everything needed to turn a timeline time into a still image.
struct TimelineFrameContext<'a> {
    engine: ExportEngine,
    runner: &'a FFmpegRunner,
    project: &'a ActiveProject,
    sequence: &'a Sequence,
    sequence_id: &'a str,
    format: ImageFormat,
    max_width: u32,
    mode: TimelineMode,
}

impl TimelineFrameContext<'_> {
    fn assets(&self) -> &HashMap<String, Asset> {
        &self.project.state.assets
    }

    fn effects(&self) -> &HashMap<String, Effect> {
        &self.project.state.effects
    }

    /// Extracts one timeline still, falling back to a composited render when
    /// fast mode cannot serve the requested time (title cards, gaps).
    async fn extract(
        &self,
        index: usize,
        time_sec: f64,
        output_path: &Path,
    ) -> anyhow::Result<FrameEntry> {
        if self.mode == TimelineMode::Fast {
            if let Some((clip, _)) =
                self.engine
                    .find_topmost_clip_at_time(self.sequence, self.assets(), time_sec)
            {
                let settings = FrameExportSettings {
                    time_sec,
                    format: self.format.clone(),
                    output_path: output_path.to_path_buf(),
                    quality: None,
                    max_width: Some(self.max_width),
                };
                let result = self
                    .engine
                    .export_frame(self.sequence, self.assets(), &self.project.path, &settings)
                    .await
                    .map_err(|error| anyhow::anyhow!("Frame export failed: {}", error))?;

                return Ok(FrameEntry {
                    index,
                    time_sec,
                    source_time_sec: Some(clip_source_time_at(clip, time_sec)),
                    clip_id: Some(clip.id.clone()),
                    asset_id: Some(clip.asset_id.clone()),
                    path: result.output_path.display().to_string(),
                    width: result.width,
                    height: result.height,
                    fell_back_to_composite: None,
                });
            }
        }

        let fell_back = self.mode == TimelineMode::Fast;
        let (width, height) = self.render_composite(time_sec, output_path).await?;

        Ok(FrameEntry {
            index,
            time_sec,
            source_time_sec: None,
            clip_id: None,
            asset_id: None,
            path: output_path.display().to_string(),
            width,
            height,
            fell_back_to_composite: fell_back.then_some(true),
        })
    }

    /// Renders a minimal composited window around `time_sec` and grabs its
    /// first frame.
    ///
    /// Range renders decode from timeline zero, so the cost grows with
    /// `time_sec` — this is the accurate but slow path.
    async fn render_composite(
        &self,
        time_sec: f64,
        output_path: &Path,
    ) -> anyhow::Result<(u32, u32)> {
        let fps = self.sequence.format.fps.as_f64();
        let window = if fps > 0.0 {
            (2.0 / fps).max(MIN_COMPOSITE_WINDOW_SEC)
        } else {
            MIN_COMPOSITE_WINDOW_SEC
        };

        let temp_dir = tempfile::tempdir().map_err(|error| {
            anyhow::anyhow!("Failed to create temporary render directory: {error}")
        })?;
        let temp_render = temp_dir.path().join("composite.mp4");

        let canvas = &self.sequence.format.canvas;
        let (width, height) =
            scaled_frame_dimensions(canvas.width, canvas.height, Some(self.max_width));

        let mut settings =
            ExportSettings::preview(temp_render.clone(), Some(time_sec), Some(time_sec + window));
        settings.width = Some(width);
        settings.height = Some(height);

        let validation =
            validate_export_settings(self.sequence, self.assets(), self.effects(), &settings);
        if !validation.is_valid {
            return Err(anyhow::anyhow!(
                "Composite render validation failed: {}",
                validation.errors.join("; ")
            ));
        }

        let graph = build_render_graph(&self.project.state, self.sequence_id)
            .map_err(|error| anyhow::anyhow!("Failed to build render graph: {}", error))?;
        let render_plan = build_render_plan(&graph, self.assets(), self.effects(), &settings);
        if !render_plan.validation.is_valid {
            return Err(anyhow::anyhow!(
                "Composite render plan validation failed: {}",
                render_plan.validation.errors.join("; ")
            ));
        }

        self.engine
            .export_sequence_with_effects_for_plan(
                self.sequence,
                self.assets(),
                self.effects(),
                &settings,
                &render_plan,
                None,
                None,
            )
            .await
            .map_err(|error| anyhow::anyhow!("Composite render failed: {}", error))?;

        self.runner
            .extract_frame_with_options(
                &temp_render,
                0.0,
                output_path,
                &FrameExtractOptions {
                    overwrite: true,
                    max_width: None,
                    quality: None,
                },
            )
            .await
            .map_err(|error| {
                anyhow::anyhow!("Frame extraction from composite render failed: {}", error)
            })?;

        Ok(probed_image_dimensions(self.runner, output_path)
            .await
            .unwrap_or((width, height)))
    }
}

// ── Output payloads ─────────────────────────────────────────────────────

/// One extracted still in the JSON payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameEntry {
    index: usize,
    time_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_time_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clip_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_id: Option<String>,
    path: String,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    fell_back_to_composite: Option<bool>,
}

/// One contact-sheet cell, mapping a grid position back to a timeline time.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GridCell {
    index: usize,
    row: usize,
    col: usize,
    timeline_sec: f64,
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Resolves the target sequence, defaulting to the project's active sequence.
fn resolve_sequence(
    project: &ActiveProject,
    sequence: Option<String>,
) -> anyhow::Result<(String, &Sequence)> {
    let sequence_id = super::resolve_sequence_id(project, sequence)?;
    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))?;

    Ok((sequence_id, sequence))
}

fn parse_image_format(raw: &str) -> anyhow::Result<ImageFormat> {
    match raw.trim().to_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        other => Err(anyhow::anyhow!(
            "Invalid value for --format: expected 'png' or 'jpeg' (got '{}')",
            other
        )),
    }
}

/// Parses a `COLSxROWS` grid specification.
fn parse_grid_spec(raw: &str) -> anyhow::Result<(usize, usize)> {
    let normalized = raw.trim().to_lowercase();
    let (columns, rows) = normalized.split_once('x').ok_or_else(|| {
        anyhow::anyhow!("Invalid value for --grid: expected COLSxROWS (e.g. 3x2)")
    })?;

    let parse_part = |value: &str, name: &str| -> anyhow::Result<usize> {
        let parsed: usize = value.trim().parse().map_err(|_| {
            anyhow::anyhow!(
                "Invalid value for --grid: {} must be a positive integer (got '{}')",
                name,
                value
            )
        })?;
        if parsed == 0 {
            return Err(anyhow::anyhow!(
                "Invalid value for --grid: {} must be >= 1",
                name
            ));
        }
        Ok(parsed)
    };

    Ok((parse_part(columns, "columns")?, parse_part(rows, "rows")?))
}

/// Samples `count` evenly spaced times inside `[start, end]`.
///
/// Samples sit at the centre of `count` equal sub-intervals so neither
/// boundary is hit exactly — timeline edges are frequently outside any clip.
fn sample_times(start: f64, end: f64, count: usize) -> Vec<f64> {
    if count == 0 {
        return Vec::new();
    }
    let span = end - start;
    (0..count)
        .map(|index| start + span * (index as f64 + 0.5) / count as f64)
        .collect()
}

/// Builds the file name used for `--times` batch output.
fn batch_frame_name(time_sec: f64, format: &ImageFormat) -> String {
    let millis = (time_sec * 1000.0).round().max(0.0) as u64;
    format!("frame_{}.{}", millis, format.extension())
}

/// Resolves `--out` for a single still: an existing directory receives a
/// generated file name, otherwise the path is used as-is.
fn resolve_single_output_path(
    out: &Path,
    time_sec: f64,
    format: ImageFormat,
) -> anyhow::Result<PathBuf> {
    if out.is_dir() {
        return Ok(out.join(batch_frame_name(time_sec, &format)));
    }
    if out.as_os_str().is_empty() {
        return Err(anyhow::anyhow!("Invalid value for --out: cannot be empty"));
    }
    Ok(normalize_extension(out.to_path_buf(), &format))
}

/// Forces the output extension to match the requested format so the encoder
/// FFmpeg picks always agrees with `--format`.
fn normalize_extension(path: PathBuf, format: &ImageFormat) -> PathBuf {
    let matches = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_lowercase();
            match format {
                ImageFormat::Png => ext == "png",
                ImageFormat::Jpeg => ext == "jpg" || ext == "jpeg",
                ImageFormat::Tiff => ext == "tif" || ext == "tiff",
            }
        })
        .unwrap_or(false);

    if matches {
        path
    } else {
        path.with_extension(format.extension())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_grid_spec_should_accept_cols_by_rows() {
        assert_eq!(parse_grid_spec("3x2").unwrap(), (3, 2));
        assert_eq!(parse_grid_spec(" 4X4 ").unwrap(), (4, 4));
    }

    #[test]
    fn parse_grid_spec_should_reject_malformed_input() {
        assert!(parse_grid_spec("3").is_err());
        assert!(parse_grid_spec("3x").is_err());
        assert!(parse_grid_spec("0x2").is_err());
        assert!(parse_grid_spec("2x0").is_err());
        assert!(parse_grid_spec("ax2").is_err());
    }

    #[test]
    fn sample_times_should_space_samples_evenly_inside_the_range() {
        assert_eq!(sample_times(0.0, 4.0, 4), vec![0.5, 1.5, 2.5, 3.5]);
    }

    #[test]
    fn sample_times_should_return_the_midpoint_for_a_single_sample() {
        assert_eq!(sample_times(2.0, 6.0, 1), vec![4.0]);
    }

    #[test]
    fn sample_times_should_stay_inside_the_range_and_ascend() {
        let samples = sample_times(1.0, 3.0, 5);
        assert_eq!(samples.len(), 5);
        assert!(samples.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(samples.iter().all(|time| *time > 1.0 && *time < 3.0));
    }

    #[test]
    fn sample_times_should_return_nothing_for_zero_count() {
        assert!(sample_times(0.0, 4.0, 0).is_empty());
    }

    #[test]
    fn batch_frame_name_should_encode_milliseconds_and_format() {
        assert_eq!(batch_frame_name(1.25, &ImageFormat::Png), "frame_1250.png");
        assert_eq!(batch_frame_name(0.0, &ImageFormat::Jpeg), "frame_0.jpg");
        assert_eq!(
            batch_frame_name(12.3456, &ImageFormat::Png),
            "frame_12346.png"
        );
    }

    #[test]
    fn normalize_extension_should_keep_matching_extensions() {
        assert_eq!(
            normalize_extension(PathBuf::from("a/b.png"), &ImageFormat::Png),
            PathBuf::from("a/b.png")
        );
        assert_eq!(
            normalize_extension(PathBuf::from("a/b.JPEG"), &ImageFormat::Jpeg),
            PathBuf::from("a/b.JPEG")
        );
    }

    #[test]
    fn normalize_extension_should_replace_mismatched_extensions() {
        assert_eq!(
            normalize_extension(PathBuf::from("a/b.jpg"), &ImageFormat::Png),
            PathBuf::from("a/b.png")
        );
        assert_eq!(
            normalize_extension(PathBuf::from("a/b"), &ImageFormat::Jpeg),
            PathBuf::from("a/b.jpg")
        );
    }

    #[test]
    fn timeline_mode_should_parse_known_values() {
        assert!(TimelineMode::parse("fast").is_ok());
        assert!(TimelineMode::parse("COMPOSITE").is_ok());
        assert!(TimelineMode::parse("turbo").is_err());
    }

    #[test]
    fn parse_image_format_should_accept_png_and_jpeg_aliases() {
        assert_eq!(parse_image_format("png").unwrap(), ImageFormat::Png);
        assert_eq!(parse_image_format("JPG").unwrap(), ImageFormat::Jpeg);
        assert!(parse_image_format("gif").is_err());
    }
}
