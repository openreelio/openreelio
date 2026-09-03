//! Frame extraction commands.
//!
//! Gives agents a way to *see* the project: single stills from a source asset
//! or a timeline position, batches of stills, and contact sheets that map grid
//! cells back to timecodes.
//!
//! With `--file` the same selectors read an already rendered video instead of
//! the timeline. That is the judging path: it inspects the artifact that was
//! actually produced, in the file's own timebase, without re-rendering anything.
//!
//! The extraction engine itself lives in
//! [`openreelio_core::render::frame_probe`], which the MCP surface reaches
//! through this module. What stays here is the CLI's own boundary: clap
//! parsing, FFmpeg resolution, and opening the project.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use clap::{Args, Subcommand};
use openreelio_core::ffmpeg::FFmpegRunner;
use openreelio_core::render::frame_probe::{FrameProbePlan, FrameProbeProject, FrameProbeRequest};
use openreelio_core::{ActiveProject, TimeRange};
use std::path::PathBuf;

pub use openreelio_core::render::frame_probe::{
    DEFAULT_AROUND_COUNT, DEFAULT_AROUND_SPAN_SEC, DEFAULT_MAX_WIDTH, MAX_CELL_SIZE_PX,
    MAX_GRID_CELLS, MAX_SHEET_DIMENSION_PX, MAX_STILL_WIDTH_PX, MIN_CELL_SIZE_PX,
    MIN_STILL_WIDTH_PX,
};

/// Selectors that name the extraction times outright.
///
/// A sampler derives its own times, so clap refuses the pair the same way it
/// refuses `--time` with `--times` — and the engine restates the refusal for
/// callers that never run through clap.
const SAMPLER_CONFLICTS: [&str; 7] = [
    "time",
    "times",
    "between",
    "count",
    "asset",
    "source_time",
    "file",
];

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

    /// Timeline extraction mode: composite (default, full render of the edit) or fast (topmost clip only)
    #[arg(long)]
    pub mode: Option<String>,

    /// Maximum output width in pixels, 1-3840 (aspect ratio preserved, never upscaled)
    #[arg(long, value_parser = still_width_parser())]
    pub max_width: Option<u32>,

    /// Output image format: png or jpeg (defaults to the --out extension, else png)
    #[arg(long)]
    pub format: Option<String>,

    /// Contact sheet grid as COLSxROWS, or 'auto' to size the sheet from a sampler or --times
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

    /// Sample both sides of every cut: the outgoing shot's last frame and the incoming shot's first
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub at_cuts: bool,

    /// Sample the start, cut and end of every two-input transition
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub at_transitions: bool,

    /// Sample the middle of every caption and text span
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub at_captions: bool,

    /// Sample every sequence marker
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub at_markers: bool,

    /// Sample the middle of every shot on the video tracks the export includes
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub per_shot: bool,

    /// Sample a window centred on this timeline time, in seconds
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub around: Option<f64>,

    /// Half-width of the --around window in seconds (default: 0.5)
    #[arg(long, requires = "around")]
    pub span: Option<f64>,

    /// Number of --around samples (default: 5)
    #[arg(long, requires = "around")]
    pub around_count: Option<usize>,

    /// Sample the timeline ranges the last applied edit changed
    #[arg(long, conflicts_with_all = SAMPLER_CONFLICTS)]
    pub affected: bool,

    /// Operation id --affected must find the recorded hand-off ending at
    #[arg(long, requires = "affected")]
    pub after_op: Option<String>,

    /// Sample this timeline range; repeat the flag for several ranges
    #[arg(
        long = "range",
        num_args = 2,
        value_names = ["START", "END"],
        action = clap::ArgAction::Append,
        conflicts_with_all = SAMPLER_CONFLICTS,
        conflicts_with = "affected"
    )]
    pub range: Option<Vec<f64>>,

    /// Largest number of sampler times to keep; the rest are thinned out evenly
    #[arg(long)]
    pub limit: Option<usize>,
}

impl ExtractArgs {
    /// Translates the parsed flags into the engine's request, dropping `path`.
    ///
    /// The project directory is the CLI's own concern: the engine is handed the
    /// opened project instead, so a caller that already replayed `ops.jsonl`
    /// does not pay for a second replay.
    fn into_request(self) -> FrameProbeRequest {
        FrameProbeRequest {
            out: self.out,
            file: self.file,
            asset: self.asset,
            source_time: self.source_time,
            time: self.time,
            times: self.times,
            sequence: self.sequence,
            mode: self.mode,
            max_width: self.max_width,
            format: self.format,
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
            after_op: self.after_op,
            ranges: self.range.as_deref().map(pair_ranges),
            limit: self.limit,
        }
    }
}

/// Turns the flat `--range START END` values clap collects into ranges.
///
/// clap appends every occurrence into one list, two values at a time, so the
/// pairs are recovered here. A trailing odd value cannot occur —
/// `num_args = 2` refuses the occurrence — and is dropped rather than guessed
/// at if it ever did.
///
/// Built field by field rather than through [`TimeRange::new`], which silently
/// swaps a reversed pair: a caller who typed `--range 5 2` has to be told, and
/// the engine's own validation is what tells them.
fn pair_ranges(values: &[f64]) -> Vec<TimeRange> {
    values
        .chunks_exact(2)
        .map(|pair| TimeRange {
            start_sec: pair[0],
            end_sec: pair[1],
        })
        .collect()
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

fn extract(args: ExtractArgs) -> anyhow::Result<()> {
    output::print_json_pretty(&run_extract(args)?)
}

/// Runs one extraction and returns the payload the CLI would have printed.
///
/// Split from [`extract`] so the MCP server can serve the same extraction —
/// same validation, same FFmpeg resolution, same result shape — without going
/// through stdout.
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
    let project_path = args.path.clone();
    let plan = FrameProbePlan::resolve(args.into_request())?;

    let ffmpeg_info = ensure_ffmpeg()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
    let runner = FFmpegRunner::new(ffmpeg_info);

    if !plan.needs_project() {
        return Ok(runtime.block_on(plan.run(&runner, None))?);
    }

    let opened;
    let project = match project {
        Some(project) => project,
        None => {
            opened = super::load_project(&project_path)?;
            &opened
        }
    };
    let probe_project = FrameProbeProject {
        path: &project.path,
        state: &project.state,
    };

    Ok(runtime.block_on(plan.run(&runner, Some(&probe_project)))?)
}

/// Rejects contact-sheet geometry whose finished image exceeds the pixel cap.
///
/// Shared with the MCP surface so both reject the same geometry, in the same
/// terms, before anything is extracted.
pub fn ensure_sheet_dimensions_in_range(
    columns: usize,
    rows: usize,
    cell_width: Option<u32>,
    cell_height: Option<u32>,
) -> anyhow::Result<()> {
    Ok(
        openreelio_core::render::frame_probe::ensure_sheet_dimensions_in_range(
            columns,
            rows,
            cell_width,
            cell_height,
        )?,
    )
}

/// Parses a `COLSxROWS` grid specification.
pub fn parse_grid_spec(raw: &str) -> anyhow::Result<(usize, usize)> {
    Ok(openreelio_core::render::frame_probe::parse_grid_spec(raw)?)
}

/// Chooses a contact-sheet layout for a known number of samples.
///
/// Shared with the MCP surface so `grid: "auto"` means the same shape there as
/// it does on the command line.
pub fn auto_grid(count: usize) -> anyhow::Result<(usize, usize)> {
    Ok(openreelio_core::render::frame_probe::auto_grid(count)?)
}
