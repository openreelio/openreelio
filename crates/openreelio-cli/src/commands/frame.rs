//! Frame extraction commands.
//!
//! Gives agents a way to *see* the project: single stills from a source asset
//! or a timeline position, batches of stills, and contact sheets that map grid
//! cells back to timecodes.
//!
//! With `--file` the same selectors read an already rendered video instead of
//! the timeline. That is the judging path: it inspects the artifact that was
//! actually produced, in the file's own timebase, without re-rendering anything.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use crate::validate;
use clap::{Args, Subcommand};
use openreelio_core::analysis::types::ContactSheetArtifact;
use openreelio_core::analysis::visual::{ContactSheetCellSize, VisualAnalyzer};
use openreelio_core::assets::Asset;
use openreelio_core::effects::{Effect, EffectType, IntoFFmpegFilter, ParamValue};
use openreelio_core::ffmpeg::{FFmpegRunner, FrameExtractOptions};
use openreelio_core::render::{
    build_render_graph, build_render_plan, clip_needs_transform_composition, clip_source_time_at,
    probed_image_dimensions, scaled_frame_dimensions, source_dimensions_from_audio_info,
    validate_export_settings_with_dimensions, ExportEngine, ExportSettings, ExportValidation,
    FrameExportSettings, ImageFormat, SourceDimensionMap,
};
use openreelio_core::timeline::Sequence;
use openreelio_core::ActiveProject;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default maximum still width. 1280px keeps frames readable for vision models
/// while staying well under typical image-token limits.
pub const DEFAULT_MAX_WIDTH: u32 = 1280;

/// Smallest accepted still width, in pixels.
pub const MIN_STILL_WIDTH_PX: u32 = 1;

/// Largest accepted still width, in pixels.
///
/// 4K is enough to judge fine detail in UHD footage, and it is a ceiling rather
/// than a target: extraction never upscales, so a larger request only buys
/// native-resolution pixels. Bounding it is what keeps a batch of stills a size
/// an MCP host can carry in one response, since the images travel inline.
pub const MAX_STILL_WIDTH_PX: u32 = 3840;

/// Largest contact sheet accepted, in cells.
///
/// Every cell costs one FFmpeg extraction, so an unbounded grid would turn a
/// single command into thousands of process spawns.
pub const MAX_GRID_CELLS: usize = 100;

/// Shortest composited window that FFmpeg can still render.
///
/// `normalize_output_time_range` rejects zero-length ranges, so a single
/// composited frame is rendered as a tiny non-zero window.
const MIN_COMPOSITE_WINDOW_SEC: f64 = 0.05;

/// Smallest accepted contact-sheet cell dimension.
///
/// Below this a cell carries no usable detail for a vision model, so a smaller
/// request is a mistake rather than an economy.
pub const MIN_CELL_SIZE_PX: u32 = 64;

/// Largest accepted contact-sheet cell dimension.
///
/// A full grid of 1024px cells is already a very large image; anything beyond
/// it should be extracted as individual stills instead.
pub const MAX_CELL_SIZE_PX: u32 = 1024;

/// Largest accepted contact-sheet edge, in pixels.
///
/// The cell cap and the cell-count cap bound different terms, and a sheet is
/// only useful if the vision model it is built for accepts it: mainstream image
/// APIs refuse anything past 8000px on a side, well before mjpeg's own 65500px
/// ceiling. Checking the product rejects an unrenderable sheet before a single
/// cell is extracted, instead of after the whole grid has been paid for.
pub const MAX_SHEET_DIMENSION_PX: u32 = 8000;

/// Share of a cell's height given to the burnt-in label's type size.
///
/// A twelfth of the cell puts the label at 15px on the default 320x180 cell,
/// which stays readable once the sheet is downsampled by a vision model.
const CELL_LABEL_HEIGHT_DIVISOR: f64 = 12.0;

/// Smallest label type size, in pixels.
const CELL_LABEL_MIN_FONT_PX: f64 = 10.0;

/// Largest label type size, in pixels.
///
/// Past this the label starts competing with the frame it annotates.
const CELL_LABEL_MAX_FONT_PX: f64 = 40.0;

/// Padding around the label inside its contrast box, in pixels.
const CELL_LABEL_BOX_PADDING_PX: i64 = 3;

/// Label text colour.
const CELL_LABEL_TEXT_COLOR: &str = "#FFFFFF";

/// Colour of the box drawn behind the label so it survives a bright frame.
const CELL_LABEL_BOX_COLOR: &str = "#000000";

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

    /// Rendered video file to extract from instead of the project timeline
    #[arg(long, conflicts_with_all = ["asset", "source_time", "sequence", "mode"])]
    pub file: Option<PathBuf>,

    /// Asset ID to extract from (requires --source-time)
    #[arg(long, requires = "source_time", conflicts_with_all = ["time", "times", "grid"])]
    pub asset: Option<String>,

    /// Time in seconds inside the asset's own media (requires --asset)
    #[arg(long, requires = "asset")]
    pub source_time: Option<f64>,

    /// Timeline time in seconds
    #[arg(long, conflicts_with_all = ["times", "grid"])]
    pub time: Option<f64>,

    /// Comma-separated timeline times in seconds; --out must be a directory unless --grid is given
    #[arg(long, value_delimiter = ',')]
    pub times: Option<Vec<f64>>,

    /// Sequence ID (defaults to active)
    #[arg(long)]
    pub sequence: Option<String>,

    /// Timeline extraction mode: fast (default, topmost clip only) or composite (full render)
    #[arg(long)]
    pub mode: Option<String>,

    /// Maximum output width in pixels, 1-3840 (aspect ratio preserved, never upscaled)
    #[arg(long, value_parser = still_width_parser())]
    pub max_width: Option<u32>,

    /// Output image format: png or jpeg (defaults to the --out extension, else png)
    #[arg(long)]
    pub format: Option<String>,

    /// Contact sheet grid as COLSxROWS (requires --between or --times)
    #[arg(long)]
    pub grid: Option<String>,

    /// Time range to sample for --grid
    #[arg(long, num_args = 2, value_names = ["START", "END"], requires = "grid", conflicts_with = "times")]
    pub between: Option<Vec<f64>>,

    /// Number of grid samples (defaults to columns * rows; only for --between)
    #[arg(long, requires = "grid", conflicts_with = "times")]
    pub count: Option<usize>,

    /// Contact sheet cell width in pixels (64-1024, default 320; alone it derives the height at 16:9)
    #[arg(long, requires = "grid", value_parser = cell_size_parser())]
    pub cell_width: Option<u32>,

    /// Contact sheet cell height in pixels (64-1024, default 180; alone it derives the width at 16:9)
    #[arg(long, requires = "grid", value_parser = cell_size_parser())]
    pub cell_height: Option<u32>,

    /// Burn each cell's index and timecode into the contact sheet
    #[arg(long, requires = "grid")]
    pub label_cells: bool,
}

/// Value parser enforcing the accepted contact-sheet cell dimension range.
fn cell_size_parser() -> clap::builder::RangedI64ValueParser<u32> {
    clap::value_parser!(u32).range(i64::from(MIN_CELL_SIZE_PX)..=i64::from(MAX_CELL_SIZE_PX))
}

/// Value parser enforcing the accepted still width range.
fn still_width_parser() -> clap::builder::RangedI64ValueParser<u32> {
    clap::value_parser!(u32).range(i64::from(MIN_STILL_WIDTH_PX)..=i64::from(MAX_STILL_WIDTH_PX))
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
    /// Resolves `--mode`, defaulting to the cheap topmost-clip path.
    ///
    /// The default lives here rather than in clap so an explicitly passed
    /// `--mode` stays distinguishable from an absent one, which is what lets
    /// `--file` reject it as irrelevant.
    fn resolve(raw: Option<&str>) -> anyhow::Result<Self> {
        match raw {
            Some(value) => Self::parse(value),
            None => Ok(Self::Fast),
        }
    }

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
#[derive(Debug)]
enum Selection {
    /// A single frame from an asset's own media timebase.
    AssetTime { asset_id: String, source_time: f64 },
    /// One timeline still written to `--out`.
    SingleTime(f64),
    /// Several timeline stills written into the `--out` directory.
    BatchTimes(Vec<f64>),
    /// A contact sheet, either sampled over a range or built from listed times.
    Grid {
        columns: usize,
        /// Rows the samples fill, which is fewer than `--grid` asked for when
        /// `--count` or the `--times` list does not fill the layout.
        rows: usize,
        times: Vec<f64>,
    },
}

/// Resolves a `--grid` request into the times its cells will show.
///
/// The layout accepts two sources: `--between`, which samples the range evenly,
/// and `--times`, which takes the caller's own list in the order given — that is
/// what makes cut-boundary sheets possible, since the agent already knows the
/// cut times from `timeline clips`.
fn resolve_grid_selection(args: &ExtractArgs, grid: &str) -> anyhow::Result<Selection> {
    let (columns, rows) = parse_grid_spec(grid)?;
    let capacity = columns.checked_mul(rows).ok_or_else(|| {
        anyhow::anyhow!(
            "Invalid value for --grid: {}x{} is too large",
            columns,
            rows
        )
    })?;
    if capacity > MAX_GRID_CELLS {
        return Err(anyhow::anyhow!(
            "Invalid value for --grid: {}x{} needs {} cells, more than the maximum of {}",
            columns,
            rows,
            capacity,
            MAX_GRID_CELLS
        ));
    }

    let times = match (&args.between, &args.times) {
        (Some(range), None) => sampled_grid_times(args, range, columns, rows, capacity)?,
        (None, Some(listed)) => listed_grid_times(listed, columns, rows, capacity)?,
        (Some(_), Some(_)) => {
            return Err(anyhow::anyhow!(
                "--grid takes either --between <START> <END> or --times <A,B,...>, not both"
            ))
        }
        (None, None) => {
            return Err(anyhow::anyhow!(
                "--grid requires --between <START> <END> or --times <A,B,...>"
            ))
        }
    };

    Ok(Selection::Grid {
        columns,
        // FFmpeg's `tile` filter fills unused cells with black, so a sheet
        // built from fewer samples than the requested capacity would carry
        // dead rows. Keep only the rows the samples reach.
        rows: times.len().div_ceil(columns),
        times,
    })
}

/// Evenly samples the `--between` range for a contact sheet.
fn sampled_grid_times(
    args: &ExtractArgs,
    range: &[f64],
    columns: usize,
    rows: usize,
    capacity: usize,
) -> anyhow::Result<Vec<f64>> {
    if range.len() != 2 {
        return Err(anyhow::anyhow!("--between takes exactly two values"));
    }
    validate::time_range_ordered(range[0], range[1], "between START", "between END")?;

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

    Ok(sample_times(range[0], range[1], count))
}

/// Validates an explicit `--times` list used as contact-sheet cells.
///
/// The order is the caller's: cell 0 shows the first listed time, so a list of
/// cut boundaries reads across the sheet the way the edit plays.
fn listed_grid_times(
    listed: &[f64],
    columns: usize,
    rows: usize,
    capacity: usize,
) -> anyhow::Result<Vec<f64>> {
    if listed.is_empty() {
        return Err(anyhow::anyhow!("--times requires at least one value"));
    }
    for time in listed {
        validate::time_non_negative(*time, "times")?;
    }
    if listed.len() > capacity {
        return Err(anyhow::anyhow!(
            "Invalid value for --times: {} values exceed the {}x{} grid capacity of {}",
            listed.len(),
            columns,
            rows,
            capacity
        ));
    }

    Ok(listed.to_vec())
}

/// Flags that only mean something on a contact sheet, with the spelling the
/// caller typed.
const GRID_ONLY_FLAGS: [&str; 5] = [
    "--between",
    "--count",
    "--cell-width",
    "--cell-height",
    "--label-cells",
];

/// Rejects contact-sheet flags passed without `--grid`.
///
/// clap's own `requires = "grid"` cannot carry this: it is waived whenever a
/// present argument declares a conflict with `--grid`, which `--time` and
/// `--asset` both do. Without this check the flags parse, nothing on the
/// single-still paths ever reads them, and the caller is told nothing.
fn ensure_grid_only_flags_unused(args: &ExtractArgs) -> anyhow::Result<()> {
    if args.grid.is_some() {
        return Ok(());
    }

    let present: Vec<&str> = [
        args.between.is_some(),
        args.count.is_some(),
        args.cell_width.is_some(),
        args.cell_height.is_some(),
        args.label_cells,
    ]
    .iter()
    .zip(GRID_ONLY_FLAGS)
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    Err(anyhow::anyhow!(
        "{} only applies to a contact sheet and needs --grid <COLSxROWS>. Add --grid, or drop the flag for a single still.",
        present.join(", ")
    ))
}

fn resolve_selection(args: &ExtractArgs) -> anyhow::Result<Selection> {
    ensure_grid_only_flags_unused(args)?;

    if let Some(grid) = &args.grid {
        return resolve_grid_selection(args, grid);
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
    output::print_json_pretty(&run_extract(args)?)
}

/// Runs one extraction and returns the payload the CLI would have printed.
///
/// Split from [`extract`] so the MCP server can serve the same extraction —
/// same validation, same FFmpeg resolution, same result shape — without going
/// through stdout. Every guard the CLI relies on lives here rather than in the
/// clap layer, because clap validates only the CLI's own callers.
pub fn run_extract(args: ExtractArgs) -> anyhow::Result<serde_json::Value> {
    extract_with_project(args, None)
}

/// Runs one extraction against a project the caller has already opened.
///
/// The MCP server confines the sequence's media against its own snapshot before
/// extracting. Re-opening the project here would replay `ops.jsonl` a second
/// time and extract from a snapshot the confinement never saw, so the caller
/// hands the checked project in and both halves read the same state — and a tool
/// built to be called in a judge loop pays for one replay instead of two.
pub fn run_extract_with_project(
    args: ExtractArgs,
    project: &ActiveProject,
) -> anyhow::Result<serde_json::Value> {
    extract_with_project(args, Some(project))
}

fn extract_with_project(
    args: ExtractArgs,
    project: Option<&ActiveProject>,
) -> anyhow::Result<serde_json::Value> {
    let selection = resolve_selection(&args)?;
    let format = resolve_image_format(args.format.as_deref(), &args.out)?;
    let mode = TimelineMode::resolve(args.mode.as_deref())?;
    ensure_cell_size_in_range(&args)?;
    ensure_max_width_in_range(&args)?;
    ensure_sheet_fits(&args, &selection)?;

    let ffmpeg_info = ensure_ffmpeg()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
    let runner = FFmpegRunner::new(ffmpeg_info);

    // A rendered file is self-contained, so the judge path never opens the
    // project: it costs an ops replay it has no use for, and it keeps sheeting a
    // finished render independent of whatever the project is doing meanwhile.
    if let Some(file) = args.file.clone() {
        return runtime.block_on(run_file_mode(&runner, &file, &args, format, &selection));
    }

    let opened;
    let project = match project {
        Some(project) => project,
        None => {
            opened = super::load_project(&args.path)?;
            &opened
        }
    };

    match selection {
        Selection::AssetTime {
            asset_id,
            source_time,
        } => runtime.block_on(run_asset_mode(
            project,
            &runner,
            &asset_id,
            source_time,
            &args.out,
            format,
            args.max_width,
        )),
        Selection::SingleTime(time) => runtime.block_on(run_timeline_mode(
            project,
            &runner,
            &args,
            format,
            mode,
            &[time],
            false,
        )),
        Selection::BatchTimes(times) => runtime.block_on(run_timeline_mode(
            project, &runner, &args, format, mode, &times, true,
        )),
        Selection::Grid {
            columns,
            rows,
            times,
        } => runtime.block_on(run_grid_mode(
            project, &runner, &args, format, mode, columns, rows, &times,
        )),
    }
}

/// Rejects contact-sheet cell dimensions outside the supported range.
///
/// clap enforces the same range for the CLI, but the range must hold for every
/// caller of [`run_extract`]: a cell FFmpeg's tiler cannot fill is a broken
/// sheet regardless of which surface asked for it.
fn ensure_cell_size_in_range(args: &ExtractArgs) -> anyhow::Result<()> {
    for (label, value) in [
        ("cell-width", args.cell_width),
        ("cell-height", args.cell_height),
    ] {
        let Some(value) = value else {
            continue;
        };
        if !(MIN_CELL_SIZE_PX..=MAX_CELL_SIZE_PX).contains(&value) {
            return Err(anyhow::anyhow!(
                "Invalid value for --{}: {} is outside the supported range of {}-{}",
                label,
                value,
                MIN_CELL_SIZE_PX,
                MAX_CELL_SIZE_PX
            ));
        }
    }

    Ok(())
}

/// Rejects a still width outside the supported range.
///
/// clap enforces the same range for the CLI, but every caller of
/// [`run_extract`] needs it: the width decides how many pixels one response
/// carries, and the MCP surface inlines those pixels as base64.
fn ensure_max_width_in_range(args: &ExtractArgs) -> anyhow::Result<()> {
    let Some(max_width) = args.max_width else {
        return Ok(());
    };
    if !(MIN_STILL_WIDTH_PX..=MAX_STILL_WIDTH_PX).contains(&max_width) {
        return Err(anyhow::anyhow!(
            "Invalid value for --max-width: {} is outside the supported range of {}-{}",
            max_width,
            MIN_STILL_WIDTH_PX,
            MAX_STILL_WIDTH_PX
        ));
    }

    Ok(())
}

/// Rejects a contact sheet whose finished pixel dimensions exceed the cap.
///
/// The cell cap bounds one cell and the grid cap bounds the count; only their
/// product describes the image that is actually produced. Checking it here —
/// before `ensure_ffmpeg` and before the first cell is extracted — turns a sheet
/// no encoder or vision API would accept into an argument error rather than a
/// failure paid for at full extraction cost.
fn ensure_sheet_fits(args: &ExtractArgs, selection: &Selection) -> anyhow::Result<()> {
    let Selection::Grid { columns, rows, .. } = selection else {
        return Ok(());
    };

    ensure_sheet_dimensions_in_range(*columns, *rows, args.cell_width, args.cell_height)
}

/// Rejects contact-sheet geometry whose finished image exceeds
/// [`MAX_SHEET_DIMENSION_PX`] on either edge.
///
/// Shared with the MCP surface so both reject the same geometry, in the same
/// terms, before anything is extracted.
pub fn ensure_sheet_dimensions_in_range(
    columns: usize,
    rows: usize,
    cell_width: Option<u32>,
    cell_height: Option<u32>,
) -> anyhow::Result<()> {
    let cell = cell_size(cell_width, cell_height);
    let limit = MAX_SHEET_DIMENSION_PX as usize;

    for (edge, count, size) in [
        ("width", columns, cell.width),
        ("height", rows, cell.height),
    ] {
        let total = count.saturating_mul(size);
        if total > limit {
            return Err(anyhow::anyhow!(
                "Contact sheet {} of {}px ({} cells of {}px) exceeds the maximum of {}px; \
                 ask for fewer cells or a smaller cell size",
                edge,
                total,
                count,
                size,
                MAX_SHEET_DIMENSION_PX
            ));
        }
    }

    Ok(())
}

/// A rendered file used as the extraction source, with the facts needed to
/// validate requests against it.
struct FileSource {
    path: PathBuf,
    duration_sec: f64,
    /// Duration of the video stream, when the file declares one.
    ///
    /// This is what bounds the requestable range: `duration_sec` is the
    /// container duration, i.e. the maximum across all streams, so a file whose
    /// audio outlasts its video advertises seconds that hold no picture.
    video_duration_sec: Option<f64>,
}

impl FileSource {
    /// Probes `file` and rejects anything a still cannot be taken from.
    async fn probe(runner: &FFmpegRunner, file: &Path) -> anyhow::Result<Self> {
        if !file.exists() {
            return Err(anyhow::anyhow!(
                "Render file '{}' not found",
                file.display()
            ));
        }

        let info = runner
            .probe(file)
            .await
            .map_err(|error| anyhow::anyhow!("Failed to probe '{}': {}", file.display(), error))?;
        if info.video.is_none() {
            return Err(anyhow::anyhow!(
                "'{}' has no video stream, so there is no frame to extract",
                file.display()
            ));
        }
        if !info.duration_sec.is_finite() || info.duration_sec <= 0.0 {
            return Err(anyhow::anyhow!(
                "'{}' reports no duration, so there is no frame to extract",
                file.display()
            ));
        }

        // Containers that carry no per-stream duration fall back to the
        // container's: a slightly loose guard is still better than none, and
        // `ensure_frame_written` catches whatever slips through it.
        let video_duration_sec = runner
            .probe_video_duration(file)
            .await
            .ok()
            .flatten()
            .filter(|value| value.is_finite() && *value > 0.0);

        Ok(Self {
            path: file.to_path_buf(),
            duration_sec: info.duration_sec,
            video_duration_sec,
        })
    }

    /// Last time the file can still be asked for a picture at.
    fn video_end_sec(&self) -> f64 {
        self.video_duration_sec.unwrap_or(self.duration_sec)
    }

    /// Rejects requested times the file has no frame at.
    ///
    /// The message names where the *video* ends: a judge working from a partial
    /// render, or from a file whose audio runs past its picture, needs to see
    /// that the range it asked for does not exist rather than a decoder error.
    fn ensure_times_inside(&self, times: &[f64]) -> anyhow::Result<()> {
        if let Some(before) = times.iter().find(|time| **time < 0.0) {
            return Err(anyhow::anyhow!(
                "Requested time {:.3}s is before the start of '{}'",
                before,
                self.path.display()
            ));
        }
        let video_end_sec = self.video_end_sec();
        if let Some(past_end) = times.iter().find(|time| **time >= video_end_sec) {
            return Err(anyhow::anyhow!(
                "Requested time {:.3}s is at or past the end of the video in '{}' ({:.3}s). Ask for a time inside the file.",
                past_end,
                self.path.display(),
                video_end_sec
            ));
        }

        Ok(())
    }

    /// Fast-seeks to `time_sec` and writes the frame, reporting its size.
    async fn extract(
        &self,
        runner: &FFmpegRunner,
        time_sec: f64,
        output_path: &Path,
        max_width: u32,
    ) -> anyhow::Result<(u32, u32)> {
        // Clear the target first so the check below can tell a fresh frame from
        // a leftover one. FFmpeg exits 0 and writes nothing when the seek lands
        // past the last decodable frame, and it does not truncate what is
        // already there, so without this a previous candidate's image survives
        // and gets probed and reported as the frame just requested.
        remove_stale_output(output_path)?;

        runner
            .extract_frame_with_options(
                &self.path,
                time_sec,
                output_path,
                &FrameExtractOptions {
                    overwrite: true,
                    max_width: Some(max_width),
                    quality: None,
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!("Frame extraction failed: {}", error))?;
        ensure_frame_written(output_path, time_sec, &self.path)?;

        Ok(probed_image_dimensions(runner, output_path)
            .await
            .unwrap_or((0, 0)))
    }

    fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "path": self.path.display().to_string(),
            "durationSec": self.duration_sec,
            "videoDurationSec": self.video_end_sec(),
        })
    }
}

/// Deletes an output file left behind by an earlier run.
///
/// A stale image at the target path is indistinguishable from a fresh one, and
/// the extraction FFmpeg silently declines to perform leaves it in place.
fn remove_stale_output(output_path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(output_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "Failed to replace '{}': {}",
            output_path.display(),
            error
        )),
    }
}

/// Rejects an extraction that produced no image.
///
/// FFmpeg reports success for an input seek that lands past the last decodable
/// frame — it simply writes nothing. Reporting that as an extracted frame is
/// the worst outcome available: the caller reads plausible dimensions probed
/// from whatever was at the path before.
fn ensure_frame_written(output_path: &Path, time_sec: f64, source: &Path) -> anyhow::Result<()> {
    let written = std::fs::metadata(output_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if written {
        return Ok(());
    }

    Err(anyhow::anyhow!(
        "FFmpeg produced no frame at {:.3}s of '{}'. The seek landed past the last decodable frame; ask for an earlier time.",
        time_sec,
        source.display()
    ))
}

/// Extracts stills or a contact sheet from a rendered file rather than the
/// project timeline.
///
/// This is the cheap judging path: the frames come from the artifact that was
/// actually produced, so no per-cell timeline render is involved and what the
/// judge sees is exactly what `verify --file` measured. All times are in the
/// file's own timebase.
async fn run_file_mode(
    runner: &FFmpegRunner,
    file: &Path,
    args: &ExtractArgs,
    format: ImageFormat,
    selection: &Selection,
) -> anyhow::Result<serde_json::Value> {
    let source = FileSource::probe(runner, file).await?;
    let max_width = args.max_width.unwrap_or(DEFAULT_MAX_WIDTH);

    match selection {
        Selection::AssetTime { .. } => Err(anyhow::anyhow!(
            "--file reads a rendered video, so it cannot be combined with --asset"
        )),
        Selection::SingleTime(time) => {
            source.ensure_times_inside(std::slice::from_ref(time))?;
            let output_path = resolve_single_output_path(&args.out, *time, format)?;
            let (width, height) = source
                .extract(runner, *time, &output_path, max_width)
                .await?;

            Ok(file_frames_payload(
                &source,
                vec![FileFrameEntry {
                    index: 0,
                    file_sec: *time,
                    path: output_path.display().to_string(),
                    width,
                    height,
                }],
            ))
        }
        Selection::BatchTimes(times) => {
            source.ensure_times_inside(times)?;
            std::fs::create_dir_all(&args.out).map_err(|error| {
                anyhow::anyhow!(
                    "Failed to create output directory '{}': {}",
                    args.out.display(),
                    error
                )
            })?;

            let mut frames = Vec::with_capacity(times.len());
            for (index, time) in times.iter().enumerate() {
                let output_path = args.out.join(batch_frame_name(*time, &format));
                let (width, height) = source
                    .extract(runner, *time, &output_path, max_width)
                    .await?;
                frames.push(FileFrameEntry {
                    index,
                    file_sec: *time,
                    path: output_path.display().to_string(),
                    width,
                    height,
                });
            }

            Ok(file_frames_payload(&source, frames))
        }
        Selection::Grid {
            columns,
            rows,
            times,
        } => run_file_grid_mode(runner, &source, args, format, *columns, *rows, times).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_file_grid_mode(
    runner: &FFmpegRunner,
    source: &FileSource,
    args: &ExtractArgs,
    format: ImageFormat,
    columns: usize,
    rows: usize,
    times: &[f64],
) -> anyhow::Result<serde_json::Value> {
    source.ensure_times_inside(times)?;
    let cell = resolve_cell_size(args);
    let staging = CellStaging::new(cell, args.label_cells)?;
    let extract_width = grid_cell_extract_width(args, cell);

    let mut cell_paths = Vec::with_capacity(times.len());
    let mut cells = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        source
            .extract(runner, *time, &staging.extract_path(index), extract_width)
            .await?;
        cell_paths.push(staging.finish(runner, index, *time).await?);
        cells.push(FileGridCell {
            index,
            row: index / columns,
            col: index % columns,
            file_sec: *time,
        });
    }

    let sheet =
        build_contact_sheet(runner, args, &format, &cell_paths, columns, rows, cell).await?;

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "file",
        "source": source.describe(),
        "sheet": {
            "path": sheet.path,
            "cols": sheet.columns,
            "rows": sheet.rows,
            "cellWidth": cell.width,
            "cellHeight": cell.height,
            "labeled": args.label_cells,
            "cells": cells,
        },
        // A rendered file carries no project styling to drop, so this is
        // always empty - it is present so every `frame extract` payload has
        // the same shape and a caller never has to branch on the mode.
        "warnings": Vec::<String>::new(),
    }))
}

fn file_frames_payload(source: &FileSource, frames: Vec<FileFrameEntry>) -> serde_json::Value {
    serde_json::json!({
        "status": "ok",
        "mode": "file",
        "source": source.describe(),
        "count": frames.len(),
        "frames": frames,
        // Always empty: see `run_file_grid_mode`.
        "warnings": Vec::<String>::new(),
    })
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
        // A single asset is extracted from its own media, with no sequence to
        // validate; the field is present for a uniform payload shape.
        "warnings": Vec::<String>::new(),
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
    ensure_times_inside_sequence(sequence, times)?;
    let mut context = TimelineFrameContext {
        engine: ExportEngine::new(runner.clone()),
        runner,
        project,
        sequence,
        sequence_id: &sequence_id,
        format: format.clone(),
        max_width: args.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        mode,
        source_dimensions: SourceDimensionMap::new(),
        validation: None,
    };
    context.measure_sources().await;

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
        "warnings": context.warnings(),
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
    ensure_times_inside_sequence(sequence, times)?;
    let cell = resolve_cell_size(args);
    let mut context = TimelineFrameContext {
        engine: ExportEngine::new(runner.clone()),
        runner,
        project,
        sequence,
        sequence_id: &sequence_id,
        // Contact sheet cells are always JPEG: FFmpeg reads them back as a
        // `%d.jpg` image sequence.
        format: ImageFormat::Jpeg,
        max_width: grid_cell_extract_width(args, cell),
        mode,
        source_dimensions: SourceDimensionMap::new(),
        validation: None,
    };
    context.measure_sources().await;

    let staging = CellStaging::new(cell, args.label_cells)?;

    let mut cell_paths = Vec::with_capacity(times.len());
    let mut cells = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        context
            .extract(index, *time, &staging.extract_path(index))
            .await?;
        cell_paths.push(staging.finish(runner, index, *time).await?);
        cells.push(GridCell {
            index,
            row: index / columns,
            col: index % columns,
            timeline_sec: *time,
        });
    }

    let sheet =
        build_contact_sheet(runner, args, &format, &cell_paths, columns, rows, cell).await?;

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "grid",
        "sheet": {
            "path": sheet.path,
            "cols": sheet.columns,
            "rows": sheet.rows,
            "cellWidth": cell.width,
            "cellHeight": cell.height,
            "labeled": args.label_cells,
            "cells": cells,
        },
        "warnings": context.warnings(),
    }))
}

/// Staging directories the contact-sheet cells pass through.
///
/// FFmpeg reads the cells back as a zero-based `%d.jpg` image sequence, so the
/// finished cells must share one directory and one naming scheme. Labelling
/// needs a second copy because FFmpeg cannot write over its own input, so the
/// raw extraction lands in `raw_dir` and the labelled result in `sheet_dir`.
struct CellStaging {
    sheet_dir: tempfile::TempDir,
    raw_dir: Option<tempfile::TempDir>,
    cell: ContactSheetCellSize,
}

impl CellStaging {
    fn new(cell: ContactSheetCellSize, label_cells: bool) -> anyhow::Result<Self> {
        let sheet_dir = tempfile::tempdir().map_err(|error| {
            anyhow::anyhow!("Failed to create temporary cell directory: {error}")
        })?;
        let raw_dir = if label_cells {
            Some(tempfile::tempdir().map_err(|error| {
                anyhow::anyhow!("Failed to create temporary cell directory: {error}")
            })?)
        } else {
            None
        };

        Ok(Self {
            sheet_dir,
            raw_dir,
            cell,
        })
    }

    /// Path the frame extractor writes the untouched cell to.
    fn extract_path(&self, index: usize) -> PathBuf {
        match &self.raw_dir {
            Some(dir) => dir.path().join(format!("{}.jpg", index)),
            None => self.sheet_path(index),
        }
    }

    /// Path the tiler reads the finished cell from.
    fn sheet_path(&self, index: usize) -> PathBuf {
        self.sheet_dir.path().join(format!("{}.jpg", index))
    }

    /// Burns the cell label when one was requested, and reports the finished path.
    ///
    /// A cell the extractor never wrote is an error rather than a gap: the
    /// tiler reads the cells back as a `%d.jpg` image sequence, which stops at
    /// the first missing index and pads the rest of the sheet with black, while
    /// `sheet.cells` still claims a timecode for every one of them.
    async fn finish(
        &self,
        runner: &FFmpegRunner,
        index: usize,
        time_sec: f64,
    ) -> anyhow::Result<PathBuf> {
        ensure_cell_written(&self.extract_path(index), index, time_sec)?;

        let sheet_path = self.sheet_path(index);
        if self.raw_dir.is_none() {
            return Ok(sheet_path);
        }

        let filter = build_cell_label_filter(index, time_sec, self.cell);
        runner
            .filter_image(&self.extract_path(index), &sheet_path, &filter, None)
            .await
            .map_err(|error| {
                anyhow::anyhow!(
                    "Failed to label contact sheet cell {}: {}. Cell labels need an FFmpeg build with the drawtext filter; drop --label-cells to build the sheet without them.",
                    index,
                    error
                )
            })?;
        ensure_cell_written(&sheet_path, index, time_sec)?;

        Ok(sheet_path)
    }
}

/// Rejects a contact-sheet cell that was never written.
fn ensure_cell_written(cell_path: &Path, index: usize, time_sec: f64) -> anyhow::Result<()> {
    let written = std::fs::metadata(cell_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if written {
        return Ok(());
    }

    Err(anyhow::anyhow!(
        "No frame was produced for contact sheet cell {} at {:.3}s, so the sheet would show a black cell the JSON claims a timecode for. Narrow the sampled range to where the picture actually is.",
        index,
        time_sec
    ))
}

/// Text burnt into a labelled contact-sheet cell.
fn cell_label_text(index: usize, time_sec: f64) -> String {
    format!("{} | {:.2}s", index, time_sec.max(0.0))
}

/// Type size used for a cell label, in pixels of the finished cell.
fn cell_label_font_size(cell_height: usize) -> f64 {
    ((cell_height as f64) / CELL_LABEL_HEIGHT_DIVISOR)
        .round()
        .clamp(CELL_LABEL_MIN_FONT_PX, CELL_LABEL_MAX_FONT_PX)
}

/// Builds the filter chain that fits a raw cell into the sheet's cell box and
/// burns its index and timecode into the bottom-left corner.
///
/// Fitting happens here rather than in the tiler so the label is drawn at the
/// cell's final resolution: the type size is chosen against `cell`, not against
/// whatever the source frame was extracted at. The tiler's own scale/pad stage
/// then becomes a no-op on an already-fitted cell.
///
/// The drawtext parameters come from the shared text-overlay effect builder, so
/// labels resolve fonts exactly the way burnt-in captions do.
fn build_cell_label_filter(index: usize, time_sec: f64, cell: ContactSheetCellSize) -> String {
    let font_size = cell_label_font_size(cell.height);
    // Keep the contrast box clear of the frame edge: its border grows outward
    // from the text by the padding, so the margin has to cover it.
    let margin = (font_size * 0.5)
        .round()
        .max(CELL_LABEL_BOX_PADDING_PX as f64 + 2.0);

    let mut label = Effect::new(EffectType::TextOverlay);
    label.set_param("text", ParamValue::String(cell_label_text(index, time_sec)));
    label.set_param("font_size", ParamValue::Float(font_size));
    label.set_param(
        "color",
        ParamValue::String(CELL_LABEL_TEXT_COLOR.to_string()),
    );
    label.set_param(
        "background_color",
        ParamValue::String(CELL_LABEL_BOX_COLOR.to_string()),
    );
    label.set_param(
        "background_padding",
        ParamValue::Int(CELL_LABEL_BOX_PADDING_PX),
    );
    label.set_param("alignment", ParamValue::String("left".to_string()));
    label.set_param("x", ParamValue::Float(margin / cell.width as f64));
    label.set_param(
        "y",
        ParamValue::Float(1.0 - (font_size / 2.0 + margin) / cell.height as f64),
    );

    format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,{drawtext}",
        w = cell.width,
        h = cell.height,
        drawtext = label.to_filter_body(),
    )
}

/// Tiles already extracted cells into the contact sheet at `--out`.
async fn build_contact_sheet(
    runner: &FFmpegRunner,
    args: &ExtractArgs,
    format: &ImageFormat,
    cell_paths: &[PathBuf],
    columns: usize,
    rows: usize,
    cell: ContactSheetCellSize,
) -> anyhow::Result<ContactSheetArtifact> {
    let sheet_path = normalize_extension(args.out.clone(), format);
    let analyzer = VisualAnalyzer::new(runner.info().ffmpeg_path.clone());
    analyzer
        .generate_contact_sheet_with_options(cell_paths, &sheet_path, Some((columns, rows)), cell)
        .await
        .map_err(|error| anyhow::anyhow!("Contact sheet generation failed: {}", error))?
        .ok_or_else(|| anyhow::anyhow!("Contact sheet generation produced no output"))
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
    /// Source sizes measured once for the whole invocation.
    ///
    /// Export validation measures every transformed clip's source with FFprobe.
    /// The composite path validates the render it is about to run, so without a
    /// shared measurement a 4x4 contact sheet over five assets meant 160 FFprobe
    /// spawns instead of five.
    source_dimensions: SourceDimensionMap,
    /// Export validation for this sequence, run once for the whole invocation.
    ///
    /// Nothing validation inspects changes between frames of the same sequence,
    /// so running it per frame would only repeat the answer. Its warnings ride
    /// out with the payload: a still is rendered through the same path an
    /// export is, so styling the render drops - a line height libass ignores, a
    /// font nothing on the machine can supply - is missing from the picture an
    /// agent is about to judge, and nothing else would say so.
    validation: Option<ExportValidation>,
}

impl TimelineFrameContext<'_> {
    fn assets(&self) -> &HashMap<String, Asset> {
        &self.project.state.assets
    }

    fn effects(&self) -> &HashMap<String, Effect> {
        &self.project.state.effects
    }

    /// Measures every asset once, then validates the sequence against it.
    ///
    /// Both are per-invocation, not per-frame: without the shared measurement a
    /// 4x4 contact sheet over five assets meant 160 FFprobe spawns instead of
    /// five, and the validation that consumes it answers the same for every
    /// frame of one sequence.
    async fn measure_sources(&mut self) {
        let audio_info = self
            .engine
            .probe_assets_for_audio(self.sequence, self.assets())
            .await;
        self.source_dimensions = source_dimensions_from_audio_info(&audio_info);

        // Validated at the canvas size the stills are cut down from, with no
        // time window: nothing this reports varies across the frames of one
        // sequence, so a representative range is the whole range.
        let canvas = &self.sequence.format.canvas;
        let (width, height) =
            scaled_frame_dimensions(canvas.width, canvas.height, Some(self.max_width));
        let mut settings = ExportSettings::preview(PathBuf::from("frame-extract.mp4"), None, None);
        settings.width = Some(width);
        settings.height = Some(height);

        self.validation = Some(validate_export_settings_with_dimensions(
            self.sequence,
            self.assets(),
            self.effects(),
            &settings,
            Some(&self.source_dimensions),
        ));
    }

    /// Warnings the caller should see alongside the stills.
    fn warnings(&self) -> Vec<String> {
        self.validation
            .as_ref()
            .map(|validation| validation.warnings.clone())
            .unwrap_or_default()
    }

    /// Extracts one timeline still, falling back to a composited render when
    /// fast mode cannot serve the requested time (title cards, gaps) or cannot
    /// show what the timeline actually says (transformed clips).
    async fn extract(
        &mut self,
        index: usize,
        time_sec: f64,
        output_path: &Path,
    ) -> anyhow::Result<FrameEntry> {
        if self.mode == TimelineMode::Fast {
            // Fast mode reads the topmost clip's source file directly, so a clip
            // that is moved, scaled, rotated or faded would come back looking
            // untouched — an agent checking its own transform edit would see no
            // change. Compositing is the only way to show it.
            let fast_clip = self
                .engine
                .find_topmost_clip_at_time(self.sequence, self.assets(), time_sec)
                .filter(|(clip, _)| !clip_needs_transform_composition(clip));

            if let Some((clip, _)) = fast_clip {
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
        &mut self,
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

        // The compositing path is the one an invalid sequence would actually
        // break, so the stored verdict is only enforced here - a fast-mode
        // still of one untouched clip is unaffected by, say, a layered overlap
        // elsewhere on the timeline and is still worth handing back.
        if let Some(validation) = self.validation.as_ref() {
            if !validation.is_valid {
                return Err(anyhow::anyhow!(
                    "Composite render validation failed: {}",
                    validation.errors.join("; ")
                ));
            }
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

/// One still extracted from a rendered file, in that file's own timebase.
///
/// The time field is deliberately not `timeSec`: a rendered range starts at
/// zero regardless of where it sat on the timeline, so calling it a timeline
/// time would be a lie the judge could act on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileFrameEntry {
    index: usize,
    file_sec: f64,
    path: String,
    width: u32,
    height: u32,
}

/// One contact-sheet cell mapped back to a rendered file's timebase.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileGridCell {
    index: usize,
    row: usize,
    col: usize,
    file_sec: f64,
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Last timeline position the sequence has any content at.
fn sequence_duration_sec(sequence: &Sequence) -> f64 {
    sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .filter(|clip| clip.enabled)
        .map(|clip| clip.place.timeline_out_sec())
        .filter(|end| end.is_finite())
        .fold(0.0_f64, f64::max)
}

/// Rejects requested times the sequence has no content at.
///
/// Without this the request reaches the renderer and comes back as an internal
/// "output range is empty" message that says nothing about what the caller
/// asked for. The common trigger is a `--between` window wider than the edit.
fn ensure_times_inside_sequence(sequence: &Sequence, times: &[f64]) -> anyhow::Result<()> {
    let duration_sec = sequence_duration_sec(sequence);
    if duration_sec <= 0.0 {
        return Err(anyhow::anyhow!(
            "Sequence '{}' is empty, so there is no frame to extract",
            sequence.name
        ));
    }

    if let Some(out_of_range) = times.iter().find(|time| **time >= duration_sec) {
        return Err(anyhow::anyhow!(
            "Requested time {:.3}s is at or past the end of sequence '{}' ({:.3}s). Ask for a time inside the sequence, or narrow --between to the edited range.",
            out_of_range,
            sequence.name,
            duration_sec
        ));
    }

    Ok(())
}

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

/// Reads the image format the `--out` path already names, if any.
///
/// Returns `None` for directories and for extensions that name no supported
/// image format, so the caller can fall back to the default.
fn image_format_from_path(out: &Path) -> Option<ImageFormat> {
    if out.is_dir() {
        return None;
    }
    let extension = out.extension()?.to_str()?.to_lowercase();
    match extension.as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        _ => None,
    }
}

/// Decides the output image format.
///
/// The `--out` extension wins by default so `--out sheet.jpg` writes a JPEG at
/// exactly that path. `--format` stays available as an explicit override for
/// extensionless or directory outputs, but a `--format` that contradicts a
/// recognised extension is rejected rather than silently redirecting the write
/// to a different file.
fn resolve_image_format(explicit: Option<&str>, out: &Path) -> anyhow::Result<ImageFormat> {
    let from_path = image_format_from_path(out);

    let Some(raw) = explicit else {
        return Ok(from_path.unwrap_or(ImageFormat::Png));
    };

    let requested = parse_image_format(raw)?;
    if let Some(path_format) = from_path {
        if path_format != requested {
            return Err(anyhow::anyhow!(
                "Conflicting output format: --format {} does not match the '.{}' extension of --out '{}'. Drop --format to follow the extension, or point --out at a .{} file.",
                raw.trim(),
                out.extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_default(),
                out.display(),
                requested.extension()
            ));
        }
    }

    Ok(requested)
}

/// Resolves the contact-sheet cell geometry from the CLI flags.
///
/// One dimension on its own derives the other from the default cell's 16:9
/// aspect, because a cell is filled with `force_original_aspect_ratio=decrease`:
/// a 640x180 cell shows the same 320x180 picture the default does, between
/// black bars, at twice the pixel cost. Passing both keeps exactly what was
/// asked for, including a deliberately non-16:9 cell.
fn resolve_cell_size(args: &ExtractArgs) -> ContactSheetCellSize {
    cell_size(args.cell_width, args.cell_height)
}

/// Derives the cell geometry a sheet will actually be tiled at.
///
/// Split from [`resolve_cell_size`] so the pixel-dimension guard can measure the
/// same cell the tiler will use, including a derived partner dimension.
fn cell_size(cell_width: Option<u32>, cell_height: Option<u32>) -> ContactSheetCellSize {
    let default = ContactSheetCellSize::default();
    let (width, height) = match (cell_width, cell_height) {
        (Some(width), Some(height)) => (width as usize, height as usize),
        (Some(width), None) => (
            width as usize,
            derived_cell_size(width as usize, default.height, default.width),
        ),
        (None, Some(height)) => (
            derived_cell_size(height as usize, default.width, default.height),
            height as usize,
        ),
        (None, None) => (default.width, default.height),
    };

    ContactSheetCellSize::new(width, height)
}

/// Scales `given` by `numerator / denominator`, kept inside the accepted range.
///
/// The clamp matters at the extremes: deriving a 1024px cell's partner at 16:9
/// would leave the accepted range, and a cell FFmpeg would refuse is worse than
/// a slightly squarer one.
fn derived_cell_size(given: usize, numerator: usize, denominator: usize) -> usize {
    let scaled = (given as f64 * numerator as f64 / denominator as f64).round() as usize;
    scaled.clamp(MIN_CELL_SIZE_PX as usize, MAX_CELL_SIZE_PX as usize)
}

/// Width the grid's source cells are extracted at.
///
/// The tiler fits every cell into a `cellWidth x cellHeight` box, so extracting
/// wider than the cell only pays for pixels the tiler immediately discards —
/// which is what made `--max-width` wasted work on grids. The cell width is
/// therefore the default, and it is never *below* the cell either, so a large
/// `--cell-width` gets a correspondingly detailed source instead of an upscale.
/// `--max-width` remains an explicit override for callers who want to oversample
/// (portrait cells fit by height, so a wider source keeps more vertical detail).
fn grid_cell_extract_width(args: &ExtractArgs, cell: ContactSheetCellSize) -> u32 {
    args.max_width.unwrap_or(cell.width as u32)
}

/// Parses a `COLSxROWS` grid specification.
pub fn parse_grid_spec(raw: &str) -> anyhow::Result<(usize, usize)> {
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

    fn grid_args(grid: &str, count: Option<usize>) -> ExtractArgs {
        ExtractArgs {
            path: PathBuf::from("."),
            out: PathBuf::from("sheet.jpg"),
            file: None,
            asset: None,
            source_time: None,
            time: None,
            times: None,
            sequence: None,
            mode: None,
            max_width: None,
            format: None,
            grid: Some(grid.to_string()),
            between: Some(vec![0.0, 4.0]),
            count,
            cell_width: None,
            cell_height: None,
            label_cells: false,
        }
    }

    #[test]
    fn resolve_selection_should_build_a_grid_from_an_explicit_time_list() {
        let mut args = grid_args("3x2", None);
        args.between = None;
        args.times = Some(vec![4.0, 1.5, 9.25]);

        let Selection::Grid {
            columns,
            rows,
            times,
        } = resolve_selection(&args).expect("selection resolves")
        else {
            panic!("Expected a grid selection");
        };
        assert_eq!(columns, 3);
        assert_eq!(rows, 1, "Three samples over three columns fill one row");
        assert_eq!(
            times,
            vec![4.0, 1.5, 9.25],
            "Listed times must keep the caller's order"
        );
    }

    #[test]
    fn resolve_selection_should_reject_more_listed_times_than_the_grid_holds() {
        let mut args = grid_args("2x2", None);
        args.between = None;
        args.times = Some(vec![0.0, 1.0, 2.0, 3.0, 4.0]);

        let error = resolve_selection(&args).expect_err("Five times cannot fill a 2x2 sheet");

        let message = error.to_string();
        assert!(
            message.contains("--times") && message.contains("capacity"),
            "Error should name the flag and the capacity, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_reject_a_grid_without_a_time_source() {
        let mut args = grid_args("2x2", None);
        args.between = None;

        let error = resolve_selection(&args).expect_err("A grid needs times to show");

        let message = error.to_string();
        assert!(
            message.contains("--between") && message.contains("--times"),
            "Error should name both accepted sources, got: {message}"
        );
    }

    #[test]
    fn cell_label_text_should_pair_the_index_with_a_timecode() {
        assert_eq!(cell_label_text(3, 12.5), "3 | 12.50s");
        assert_eq!(cell_label_text(0, 0.0), "0 | 0.00s");
    }

    #[test]
    fn cell_label_font_size_should_scale_with_the_cell_and_stay_readable() {
        assert_eq!(cell_label_font_size(180), 15.0);
        assert_eq!(cell_label_font_size(360), 30.0);
        assert_eq!(
            cell_label_font_size(64),
            CELL_LABEL_MIN_FONT_PX,
            "A tiny cell must not get an illegible label"
        );
        assert_eq!(
            cell_label_font_size(1024),
            CELL_LABEL_MAX_FONT_PX,
            "A large cell must not get a label that swamps the frame"
        );
    }

    #[test]
    fn build_cell_label_filter_should_fit_the_cell_then_draw_the_label() {
        let filter = build_cell_label_filter(3, 12.5, ContactSheetCellSize::default());

        assert!(
            filter.starts_with(
                "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black,drawtext="
            ),
            "The cell must be fitted before the label is drawn, got: {filter}"
        );
        assert!(
            filter.contains("text='3 | 12.50s'"),
            "Label should carry the index and timecode, got: {filter}"
        );
        assert!(
            filter.contains("fontsize=15"),
            "Label should be sized against the cell, got: {filter}"
        );
        assert!(
            filter.contains("box=1") && filter.contains("boxcolor=0x000000"),
            "Label needs a contrasting box to survive a bright frame, got: {filter}"
        );
    }

    #[test]
    fn build_cell_label_filter_should_keep_the_label_inside_the_bottom_left_corner() {
        let filter = build_cell_label_filter(0, 1.0, ContactSheetCellSize::default());

        // Left-aligned at a small margin, near the bottom edge but not on it.
        assert!(
            filter.contains("x=(w*0.0250)"),
            "Label should sit just inside the left edge, got: {filter}"
        );
        assert!(
            filter.contains("y=(h*0.9139)-(text_h/2)"),
            "Label should sit just inside the bottom edge, got: {filter}"
        );
    }

    #[test]
    fn resolve_cell_size_should_default_to_the_shared_contact_sheet_geometry() {
        let cell = resolve_cell_size(&grid_args("3x2", None));

        assert_eq!(cell, ContactSheetCellSize::default());
    }

    #[test]
    fn resolve_cell_size_should_derive_the_missing_dimension_from_the_default_aspect() {
        // A cell is filled with force_original_aspect_ratio=decrease, so a
        // 640x180 cell would still show a 320x180 picture between black bars.
        let mut wide = grid_args("3x2", None);
        wide.cell_width = Some(640);
        assert_eq!(
            resolve_cell_size(&wide),
            ContactSheetCellSize::new(640, 360)
        );

        let mut tall = grid_args("3x2", None);
        tall.cell_height = Some(360);
        assert_eq!(
            resolve_cell_size(&tall),
            ContactSheetCellSize::new(640, 360)
        );
    }

    #[test]
    fn resolve_cell_size_should_keep_both_dimensions_when_both_are_given() {
        let mut args = grid_args("3x2", None);
        args.cell_width = Some(640);
        args.cell_height = Some(180);

        assert_eq!(
            resolve_cell_size(&args),
            ContactSheetCellSize::new(640, 180)
        );
    }

    #[test]
    fn resolve_cell_size_should_keep_a_derived_dimension_inside_the_accepted_range() {
        let mut widest = grid_args("3x2", None);
        widest.cell_height = Some(1024);
        assert_eq!(
            resolve_cell_size(&widest).width,
            MAX_CELL_SIZE_PX as usize,
            "A derived width must stay within the range FFmpeg is asked for"
        );

        let mut narrowest = grid_args("3x2", None);
        narrowest.cell_width = Some(64);
        assert_eq!(
            resolve_cell_size(&narrowest).height,
            MIN_CELL_SIZE_PX as usize
        );
    }

    #[test]
    fn resolve_selection_should_reject_contact_sheet_flags_without_a_grid() {
        let mut args = grid_args("3x2", None);
        args.grid = None;
        args.between = None;
        args.time = Some(12.5);
        args.cell_width = Some(640);
        args.label_cells = true;

        let error = resolve_selection(&args).expect_err("Cell flags need a grid to apply to");

        let message = error.to_string();
        assert!(
            message.contains("--cell-width")
                && message.contains("--label-cells")
                && message.contains("--grid"),
            "Error should name the ignored flags and the flag they need, got: {message}"
        );
    }

    #[test]
    fn ensure_sheet_dimensions_in_range_should_reject_a_sheet_past_the_pixel_cap() {
        // 64 cells is inside the cell-count cap and 1024px is the documented
        // maximum cell, yet the product is a sheet no vision API accepts.
        let error = ensure_sheet_dimensions_in_range(8, 8, Some(MAX_CELL_SIZE_PX), None)
            .expect_err("Eight 1024px columns exceed the sheet cap");

        let message = error.to_string();
        assert!(
            message.contains("8192") && message.contains(&MAX_SHEET_DIMENSION_PX.to_string()),
            "Error should name the computed size and the limit, got: {message}"
        );
    }

    #[test]
    fn ensure_sheet_dimensions_in_range_should_measure_the_derived_cell_dimension() {
        // Only `cell_height` is given, so the width the tiler uses is derived —
        // measuring the requested dimension alone would miss the overflow.
        let error = ensure_sheet_dimensions_in_range(10, 1, None, Some(MAX_CELL_SIZE_PX))
            .expect_err("A derived 1024px width over ten columns exceeds the cap");
        assert!(error.to_string().contains("width"));

        assert!(
            ensure_sheet_dimensions_in_range(7, 7, Some(MAX_CELL_SIZE_PX), None).is_ok(),
            "A sheet inside the cap must still be accepted"
        );
    }

    #[test]
    fn ensure_max_width_in_range_should_bound_both_ends() {
        let mut args = grid_args("2x2", None);

        args.max_width = None;
        assert!(ensure_max_width_in_range(&args).is_ok());

        args.max_width = Some(0);
        assert!(ensure_max_width_in_range(&args).is_err());

        args.max_width = Some(MAX_STILL_WIDTH_PX);
        assert!(ensure_max_width_in_range(&args).is_ok());

        args.max_width = Some(MAX_STILL_WIDTH_PX + 1);
        let message = ensure_max_width_in_range(&args)
            .expect_err("An unbounded width is what makes a response unreadable")
            .to_string();
        assert!(
            message.contains(&MAX_STILL_WIDTH_PX.to_string()),
            "Error should name the cap, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_accept_a_single_still_without_contact_sheet_flags() {
        let mut args = grid_args("3x2", None);
        args.grid = None;
        args.between = None;
        args.time = Some(12.5);

        assert!(matches!(
            resolve_selection(&args).expect("A plain still is still valid"),
            Selection::SingleTime(_)
        ));
    }

    #[test]
    fn ensure_frame_written_should_reject_a_missing_or_empty_output() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("missing.png");
        let error = ensure_frame_written(&missing, 1.99, Path::new("render.mp4"))
            .expect_err("A frame FFmpeg never wrote is not an extraction");
        let message = error.to_string();
        assert!(
            message.contains("1.990s") && message.contains("render.mp4"),
            "Error should name the requested time and the source, got: {message}"
        );

        let empty = dir.path().join("empty.png");
        std::fs::write(&empty, b"").expect("write empty file");
        assert!(ensure_frame_written(&empty, 1.0, Path::new("render.mp4")).is_err());

        let written = dir.path().join("written.png");
        std::fs::write(&written, b"not empty").expect("write file");
        assert!(ensure_frame_written(&written, 1.0, Path::new("render.mp4")).is_ok());
    }

    #[test]
    fn ensure_cell_written_should_reject_a_cell_the_extractor_skipped() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("3.jpg");

        let error = ensure_cell_written(&missing, 3, 2.25)
            .expect_err("A missing cell would tile as black under a claimed timecode");

        let message = error.to_string();
        assert!(
            message.contains("cell 3") && message.contains("2.250s"),
            "Error should name the cell and its time, got: {message}"
        );
    }

    #[test]
    fn remove_stale_output_should_clear_a_previous_frame_and_tolerate_a_missing_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("frame.png");
        std::fs::write(&target, b"previous candidate").expect("write file");

        remove_stale_output(&target).expect("stale output is removed");
        assert!(!target.exists());
        remove_stale_output(&target).expect("a missing output is not an error");
    }

    #[test]
    fn grid_cell_extract_width_should_follow_the_cell_width_by_default() {
        let mut args = grid_args("3x2", None);
        args.cell_width = Some(640);

        assert_eq!(
            grid_cell_extract_width(&args, resolve_cell_size(&args)),
            640,
            "Grid cells should be extracted at the size the tiler needs"
        );
    }

    #[test]
    fn grid_cell_extract_width_should_honour_an_explicit_max_width() {
        let mut args = grid_args("3x2", None);
        args.max_width = Some(1920);

        assert_eq!(
            grid_cell_extract_width(&args, resolve_cell_size(&args)),
            1920
        );
    }

    #[test]
    fn resolve_selection_should_reject_grids_beyond_the_cell_budget() {
        assert!(resolve_selection(&grid_args("11x11", None)).is_err());
    }

    #[test]
    fn resolve_selection_should_reject_a_grid_whose_capacity_overflows() {
        let spec = format!("{}x2", usize::MAX);

        assert!(resolve_selection(&grid_args(&spec, None)).is_err());
    }

    #[test]
    fn resolve_selection_should_drop_rows_no_sample_reaches() {
        let selection = resolve_selection(&grid_args("3x3", Some(5))).expect("selection resolves");

        let Selection::Grid {
            columns,
            rows,
            times,
        } = selection
        else {
            panic!("Expected a grid selection");
        };
        assert_eq!(columns, 3);
        assert_eq!(rows, 2, "Five samples over three columns fill two rows");
        assert_eq!(times.len(), 5);
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

    #[test]
    fn resolve_image_format_should_follow_the_out_extension_when_format_is_omitted() {
        assert_eq!(
            resolve_image_format(None, Path::new("sheet.jpg")).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(None, Path::new("a/b/sheet.JPEG")).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame.png")).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_image_format_should_default_to_png_without_a_recognised_extension() {
        assert_eq!(
            resolve_image_format(None, Path::new("./stills/")).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame")).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame.bin")).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_image_format_should_apply_explicit_format_when_the_path_names_none() {
        assert_eq!(
            resolve_image_format(Some("jpeg"), Path::new("./stills/")).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(Some("jpeg"), Path::new("frame")).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn resolve_image_format_should_reject_a_format_that_contradicts_the_out_extension() {
        let error = resolve_image_format(Some("jpeg"), Path::new("frame.png"))
            .expect_err("Conflicting format and extension must be rejected");

        let message = error.to_string();
        assert!(
            message.contains("--format") && message.contains("frame.png"),
            "Error should name both sides of the conflict, got: {message}"
        );
        assert!(resolve_image_format(Some("png"), Path::new("sheet.jpg")).is_err());
    }

    #[test]
    fn resolve_image_format_should_accept_a_format_that_agrees_with_the_out_extension() {
        assert_eq!(
            resolve_image_format(Some("jpg"), Path::new("sheet.jpeg")).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(Some("png"), Path::new("frame.PNG")).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_single_output_path_should_keep_a_jpg_path_when_format_follows_the_extension() {
        let format = resolve_image_format(None, Path::new("sheet.jpg")).unwrap();

        assert_eq!(
            resolve_single_output_path(Path::new("sheet.jpg"), 0.0, format).unwrap(),
            PathBuf::from("sheet.jpg")
        );
    }
}
