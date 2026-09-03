//! Frame probing — the agent's eye on a project.
//!
//! Turns a project (or an already rendered file) into still pictures: single
//! frames from a source asset or a timeline position, batches of stills, and
//! contact sheets whose grid cells map back to timecodes.
//!
//! This is the engine behind `openreelio-cli frame extract` and the
//! `openreelio.frame.extract` MCP tool. It is deliberately Tauri-free and takes
//! its FFmpeg runner and project state by parameter, so the CLI keeps only
//! argument parsing and FFmpeg resolution.
//!
//! # Sources
//!
//! - **Asset time** — one frame from an asset's own media timebase.
//! - **Timeline time** — one or many frames of the edit, in the sequence's
//!   timebase. See [`TimelineMode`] for how the picture is produced.
//! - **Rendered file** — the judging path: the frames come from the artifact
//!   that was actually produced, in the file's own timebase, without
//!   re-rendering anything.
//!
//! # Result shape
//!
//! Every payload is a JSON object carrying `status`, `mode` and `warnings`.
//! Still requests add `frames` and `count`; contact-sheet requests add `sheet`.
//! The shape is uniform on purpose, so a caller never has to branch on the mode
//! just to find the diagnostics.

mod file;
mod sampler;
mod sheet;
mod timeline;

pub use sampler::{
    auto_grid, Sample, SampleReason, SamplerReport, SamplerSpec, DEFAULT_AROUND_COUNT,
    DEFAULT_AROUND_SPAN_SEC,
};
pub use sheet::{
    ensure_sheet_dimensions_in_range, MAX_CELL_SIZE_PX, MAX_SHEET_DIMENSION_PX, MIN_CELL_SIZE_PX,
};
pub use timeline::{FrameSource, MIN_COMPOSITE_WINDOW_SEC};

use super::ImageFormat;
use crate::core::commands::load_last_affected_ranges;
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::project::ProjectState;
use crate::core::timeline::Sequence;
use sampler::{SamplerInputs, SamplerOutcome};
use serde::Serialize;
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

/// A frame probe that could not produce the pictures it was asked for.
///
/// From a caller's point of view the probe has one failure mode — the request
/// could not be served — and the message says which part of it could not be, in
/// terms the caller can act on. Every surface wraps it the same way: the CLI
/// prints the message and exits non-zero, the MCP server returns it as a tool
/// error.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct FrameProbeError(String);

impl FrameProbeError {
    /// Builds an error from an already-formatted, caller-facing message.
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<String> for FrameProbeError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

/// Result of a frame probe operation.
pub type FrameProbeResult<T> = Result<T, FrameProbeError>;

/// What to extract, exactly as the caller expressed it.
///
/// Field names mirror the CLI flags they came from. The combinations that make
/// sense are enforced by [`FrameProbePlan::resolve`] rather than by the type,
/// because every surface — clap, MCP JSON — has to be told the same thing in
/// the same words.
#[derive(Clone, Debug, Default)]
pub struct FrameProbeRequest {
    /// Output image file, or output directory for a batch of times.
    pub out: PathBuf,
    /// Rendered video file to read instead of the project timeline.
    pub file: Option<PathBuf>,
    /// Asset to extract from, in the asset's own media timebase.
    pub asset: Option<String>,
    /// Time inside the asset's own media, in seconds.
    pub source_time: Option<f64>,
    /// Timeline time in seconds.
    pub time: Option<f64>,
    /// Timeline times in seconds; a batch of stills, or a contact sheet's cells.
    pub times: Option<Vec<f64>>,
    /// Sequence to read; the project's active sequence when absent.
    pub sequence: Option<String>,
    /// Timeline extraction mode, `fast` or `composite`.
    pub mode: Option<String>,
    /// Maximum output width in pixels; aspect ratio is preserved and never upscaled.
    pub max_width: Option<u32>,
    /// Output image format, `png` or `jpeg`.
    pub format: Option<String>,
    /// Contact sheet grid as `COLSxROWS`.
    pub grid: Option<String>,
    /// Time range a `grid` request samples.
    pub between: Option<Vec<f64>>,
    /// Number of grid samples; the grid's capacity when absent.
    pub count: Option<usize>,
    /// Contact sheet cell width in pixels.
    pub cell_width: Option<u32>,
    /// Contact sheet cell height in pixels.
    pub cell_height: Option<u32>,
    /// Burn each cell's index and timecode into the contact sheet.
    pub label_cells: bool,
    /// Sample both sides of every cut.
    pub at_cuts: bool,
    /// Sample the start, cut and end of every two-input transition.
    pub at_transitions: bool,
    /// Sample the middle of every caption and text span.
    pub at_captions: bool,
    /// Sample every sequence marker.
    pub at_markers: bool,
    /// Sample the middle of every shot.
    pub per_shot: bool,
    /// Sample a window centred on this timeline time, in seconds.
    pub around: Option<f64>,
    /// Half-width of the `around` window in seconds.
    pub span: Option<f64>,
    /// Number of samples the `around` window produces.
    pub around_count: Option<usize>,
    /// Sample the ranges the last successful apply changed.
    pub affected: bool,
    /// Largest number of samples a sampler keeps.
    pub limit: Option<usize>,
}

impl FrameProbeRequest {
    /// The samplers this request asked for.
    fn sampler_spec(&self) -> SamplerSpec {
        SamplerSpec {
            at_cuts: self.at_cuts,
            at_transitions: self.at_transitions,
            at_captions: self.at_captions,
            at_markers: self.at_markers,
            per_shot: self.per_shot,
            around: self.around,
            span: self.span,
            around_count: self.around_count,
            affected: self.affected,
            limit: self.limit,
        }
    }
}

/// The project a timeline probe reads.
///
/// Passed by reference rather than opened here: a caller that already replayed
/// `ops.jsonl` — the MCP server confines the sequence's media against its own
/// snapshot before extracting — must not pay for a second replay, and both
/// halves have to read the same state.
pub struct FrameProbeProject<'a> {
    /// Project root directory, which relative asset paths resolve against.
    pub path: &'a Path,
    /// Replayed project state: sequences, assets and effects.
    pub state: &'a ProjectState,
}

// ── Selection ───────────────────────────────────────────────────────────

/// Timeline extraction strategy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimelineMode {
    /// Topmost file-backed clip only; no effects, text, or compositing.
    Fast,
    /// Full composited render of a minimal window around the requested time.
    Composite,
}

impl TimelineMode {
    /// Resolves an optional `--mode`, defaulting to the composited picture.
    ///
    /// The default is what export produces — captions, text, transforms and
    /// blends included — because a still that silently drops them is a still an
    /// agent cannot judge its own edit from. `fast` stays available for "what
    /// footage is here", but only when it is asked for by name.
    ///
    /// The default lives here rather than in clap so an explicitly passed mode
    /// stays distinguishable from an absent one, which is what lets a rendered
    /// `file` request reject it as irrelevant.
    fn resolve(raw: Option<&str>) -> FrameProbeResult<Self> {
        match raw {
            Some(value) => Self::parse(value),
            None => Ok(Self::Composite),
        }
    }

    fn parse(raw: &str) -> FrameProbeResult<Self> {
        match raw.trim().to_lowercase().as_str() {
            "fast" => Ok(Self::Fast),
            "composite" => Ok(Self::Composite),
            other => Err(FrameProbeError::new(format!(
                "Invalid value for --mode: expected 'fast' or 'composite' (got '{}')",
                other
            ))),
        }
    }

    /// The mode's name as it appears in the JSON payload.
    pub fn label(self) -> &'static str {
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
    /// One timeline still written to the output path.
    SingleTime(f64),
    /// Several timeline stills written into the output directory.
    BatchTimes(Vec<f64>),
    /// A contact sheet, either sampled over a range or built from listed times.
    Grid {
        columns: usize,
        /// Rows the samples fill, which is fewer than the grid asked for when
        /// `count` or the `times` list does not fill the layout.
        rows: usize,
        times: Vec<f64>,
    },
    /// Times an event-driven sampler will choose once the sequence is known.
    ///
    /// Resolved late on purpose: a request is validated before the project is
    /// opened, and the cuts, captions and markers a sampler reads only exist
    /// after `ops.jsonl` has been replayed. Keeping the spec here preserves
    /// that ordering — [`FrameProbePlan::resolve`] still spawns nothing and
    /// reads nothing.
    Sampled {
        spec: SamplerSpec,
        /// Contact-sheet layout, or `None` for a batch of stills.
        grid: Option<GridLayout>,
    },
}

/// How a contact sheet's layout was requested.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GridLayout {
    /// `auto`: the layout follows however many samples there turn out to be.
    Auto,
    /// An explicit `COLSxROWS`.
    Fixed { columns: usize, rows: usize },
}

/// Parses a `--grid` value, which is either `auto` or `COLSxROWS`.
fn parse_grid_layout(raw: &str) -> FrameProbeResult<GridLayout> {
    if raw.trim().eq_ignore_ascii_case("auto") {
        return Ok(GridLayout::Auto);
    }

    let (columns, rows) = parse_grid_spec(raw)?;
    Ok(GridLayout::Fixed { columns, rows })
}

/// Validates that a time value in seconds is non-negative.
///
/// Mirrors the CLI's own argument validator so a request that arrives through
/// the MCP surface is refused in exactly the same words.
fn ensure_time_non_negative(value: f64, param_name: &str) -> FrameProbeResult<()> {
    if value.is_nan() || value.is_infinite() {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --{}: must be a finite number",
            param_name
        )));
    }
    if value < 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --{}: time cannot be negative (got {})",
            param_name, value
        )));
    }
    Ok(())
}

/// Validates that a time range is finite, non-negative and ordered.
fn ensure_time_range_ordered(
    start: f64,
    end: f64,
    start_name: &str,
    end_name: &str,
) -> FrameProbeResult<()> {
    ensure_time_non_negative(start, start_name)?;
    ensure_time_non_negative(end, end_name)?;
    if start >= end {
        return Err(FrameProbeError::new(format!(
            "Invalid time range: --{} ({}) must be less than --{} ({})",
            start_name, start, end_name, end
        )));
    }
    Ok(())
}

/// Resolves a grid request into the times its cells will show.
///
/// The layout accepts two sources: a `between` range, which is sampled evenly,
/// and `times`, which takes the caller's own list in the order given — that is
/// what makes cut-boundary sheets possible, since the agent already knows the
/// cut times from `timeline clips`.
fn resolve_grid_selection(request: &FrameProbeRequest, grid: &str) -> FrameProbeResult<Selection> {
    let (columns, rows) = match parse_grid_layout(grid)? {
        GridLayout::Fixed { columns, rows } => (columns, rows),
        // `auto` sizes itself from the samples, and without a sampler the only
        // other list whose length is known here is `--times`.
        GridLayout::Auto => return resolve_auto_grid_selection(request),
    };
    let capacity = columns.checked_mul(rows).ok_or_else(|| {
        FrameProbeError::new(format!(
            "Invalid value for --grid: {}x{} is too large",
            columns, rows
        ))
    })?;
    if capacity > MAX_GRID_CELLS {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --grid: {}x{} needs {} cells, more than the maximum of {}",
            columns, rows, capacity, MAX_GRID_CELLS
        )));
    }

    let times = match (&request.between, &request.times) {
        (Some(range), None) => sampled_grid_times(request, range, columns, rows, capacity)?,
        (None, Some(listed)) => listed_grid_times(listed, columns, rows, capacity)?,
        (Some(_), Some(_)) => {
            return Err(FrameProbeError::new(
                "--grid takes either --between <START> <END> or --times <A,B,...>, not both"
                    .to_string(),
            ))
        }
        (None, None) => {
            return Err(FrameProbeError::new(
                "--grid requires --between <START> <END> or --times <A,B,...>".to_string(),
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

/// Resolves `--grid auto` for a caller who listed the times themselves.
///
/// `auto` exists so a caller does not have to know how many samples an event
/// sampler will find. A `--between` sweep has no such unknown — the caller
/// chose the count — so it still states its own layout.
fn resolve_auto_grid_selection(request: &FrameProbeRequest) -> FrameProbeResult<Selection> {
    let Some(listed) = request.times.as_deref() else {
        return Err(FrameProbeError::new(
            "--grid auto sizes the sheet from its samples, so it needs a sampler (--at-cuts, --at-transitions, --at-captions, --at-markers, --per-shot, --around, --affected) or --times. With --between, pass an explicit --grid COLSxROWS."
                .to_string(),
        ));
    };
    if listed.is_empty() {
        return Err(FrameProbeError::new(
            "--times requires at least one value".to_string(),
        ));
    }
    for time in listed {
        ensure_time_non_negative(*time, "times")?;
    }

    let (columns, rows) = auto_grid(listed.len())?;

    Ok(Selection::Grid {
        columns,
        rows,
        times: listed.to_vec(),
    })
}

/// Evenly samples the requested range for a contact sheet.
fn sampled_grid_times(
    request: &FrameProbeRequest,
    range: &[f64],
    columns: usize,
    rows: usize,
    capacity: usize,
) -> FrameProbeResult<Vec<f64>> {
    if range.len() != 2 {
        return Err(FrameProbeError::new(
            "--between takes exactly two values".to_string(),
        ));
    }
    ensure_time_range_ordered(range[0], range[1], "between START", "between END")?;

    let count = request.count.unwrap_or(capacity);
    if count < 1 {
        return Err(FrameProbeError::new(
            "Invalid value for --count: must be >= 1".to_string(),
        ));
    }
    if count > capacity {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --count: {} exceeds the {}x{} grid capacity of {}",
            count, columns, rows, capacity
        )));
    }

    Ok(sample_times(range[0], range[1], count))
}

/// Validates an explicit time list used as contact-sheet cells.
///
/// The order is the caller's: cell 0 shows the first listed time, so a list of
/// cut boundaries reads across the sheet the way the edit plays.
fn listed_grid_times(
    listed: &[f64],
    columns: usize,
    rows: usize,
    capacity: usize,
) -> FrameProbeResult<Vec<f64>> {
    if listed.is_empty() {
        return Err(FrameProbeError::new(
            "--times requires at least one value".to_string(),
        ));
    }
    for time in listed {
        ensure_time_non_negative(*time, "times")?;
    }
    if listed.len() > capacity {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --times: {} values exceed the {}x{} grid capacity of {}",
            listed.len(),
            columns,
            rows,
            capacity
        )));
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

/// Rejects contact-sheet flags passed without a grid.
///
/// clap's own `requires = "grid"` cannot carry this: it is waived whenever a
/// present argument declares a conflict with `--grid`, which `--time` and
/// `--asset` both do. Without this check the flags parse, nothing on the
/// single-still paths ever reads them, and the caller is told nothing.
fn ensure_grid_only_flags_unused(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    if request.grid.is_some() {
        return Ok(());
    }

    let present: Vec<&str> = [
        request.between.is_some(),
        request.count.is_some(),
        request.cell_width.is_some(),
        request.cell_height.is_some(),
        request.label_cells,
    ]
    .iter()
    .zip(GRID_ONLY_FLAGS)
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "{} only applies to a contact sheet and needs --grid <COLSxROWS>. Add --grid, or drop the flag for a single still.",
        present.join(", ")
    )))
}

/// Selectors that name the times themselves, and so cannot be combined with a
/// sampler that derives them.
const SAMPLER_EXCLUSIVE_FLAGS: [&str; 6] = [
    "--time",
    "--times",
    "--between",
    "--count",
    "--asset",
    "--file",
];

/// Rejects a sampler combined with a selector that already names its times.
///
/// Samplers union with each other, but not with a hand-written list: a request
/// carrying both is ambiguous about which times the pictures are of, and
/// silently preferring either one hides the other from the caller.
fn ensure_sampler_selectors_unused(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    let present: Vec<&str> = [
        request.time.is_some(),
        request.times.is_some(),
        request.between.is_some(),
        request.count.is_some(),
        request.asset.is_some(),
        request.file.is_some(),
    ]
    .iter()
    .zip(SAMPLER_EXCLUSIVE_FLAGS)
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "A sampler chooses its own times, so it cannot be combined with {}. Drop the sampler flags, or drop {}.",
        present.join(", "),
        present.join(" and ")
    )))
}

fn resolve_selection(request: &FrameProbeRequest) -> FrameProbeResult<Selection> {
    let spec = request.sampler_spec();
    if spec.is_active() {
        ensure_sampler_selectors_unused(request)?;
        ensure_grid_only_flags_unused(request)?;
        let grid = match request.grid.as_deref() {
            Some(raw) => Some(parse_grid_layout(raw)?),
            None => None,
        };
        return Ok(Selection::Sampled { spec, grid });
    }

    let orphaned = spec.orphaned_modifiers();
    if !orphaned.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} only shapes a sampler. Add one of --at-cuts, --at-transitions, --at-captions, --at-markers, --per-shot, --around <SEC> or --affected, or drop the flag.",
            orphaned.join(", ")
        )));
    }

    ensure_grid_only_flags_unused(request)?;

    if let Some(grid) = &request.grid {
        return resolve_grid_selection(request, grid);
    }

    if let Some(asset_id) = &request.asset {
        if asset_id.trim().is_empty() {
            return Err(FrameProbeError::new(
                "Invalid value for --asset: cannot be empty".to_string(),
            ));
        }
        let source_time = request.source_time.ok_or_else(|| {
            FrameProbeError::new("--asset requires --source-time <SEC>".to_string())
        })?;
        ensure_time_non_negative(source_time, "source-time")?;
        return Ok(Selection::AssetTime {
            asset_id: asset_id.clone(),
            source_time,
        });
    }

    if let Some(times) = &request.times {
        if times.is_empty() {
            return Err(FrameProbeError::new(
                "--times requires at least one value".to_string(),
            ));
        }
        for time in times {
            ensure_time_non_negative(*time, "times")?;
        }
        return Ok(Selection::BatchTimes(times.clone()));
    }

    if let Some(time) = request.time {
        ensure_time_non_negative(time, "time")?;
        return Ok(Selection::SingleTime(time));
    }

    Err(FrameProbeError::new(
        "Nothing to extract: pass a sampler (--affected, --at-cuts, --at-transitions, --at-captions, --at-markers, --per-shot, --around <SEC>), or --time, --times, --grid, or --asset with --source-time"
            .to_string(),
    ))
}

// ── Plan ────────────────────────────────────────────────────────────────

/// A validated frame-probe request, ready to run.
///
/// Resolving a plan is pure argument checking: it never spawns FFmpeg and never
/// opens a project. That split is what lets a caller reject a malformed request
/// before paying to resolve FFmpeg or to replay `ops.jsonl` — and it is why
/// [`needs_project`](Self::needs_project) can be asked before either happens.
pub struct FrameProbePlan {
    request: FrameProbeRequest,
    selection: Selection,
    format: ImageFormat,
    mode: TimelineMode,
}

impl FrameProbePlan {
    /// Validates `request`, rejecting anything the probe could not serve.
    ///
    /// Every guard the CLI relies on lives here rather than in its clap layer,
    /// because clap validates only the CLI's own callers.
    pub fn resolve(request: FrameProbeRequest) -> FrameProbeResult<Self> {
        let selection = resolve_selection(&request)?;
        let format = resolve_image_format(request.format.as_deref(), &request.out)?;
        let mode = TimelineMode::resolve(request.mode.as_deref())?;
        ensure_cell_size_in_range(&request)?;
        ensure_max_width_in_range(&request)?;
        ensure_sheet_fits(&request, &selection)?;

        Ok(Self {
            request,
            selection,
            format,
            mode,
        })
    }

    /// Whether serving this plan needs the project opened.
    ///
    /// A rendered file is self-contained, so the judging path never opens the
    /// project: it costs an ops replay it has no use for, and it keeps sheeting
    /// a finished render independent of whatever the project is doing meanwhile.
    pub fn needs_project(&self) -> bool {
        self.request.file.is_none()
    }

    /// Runs the probe and returns the payload the caller reports.
    ///
    /// `project` may be `None` only when [`needs_project`](Self::needs_project)
    /// is false.
    pub async fn run(
        self,
        runner: &FFmpegRunner,
        project: Option<&FrameProbeProject<'_>>,
    ) -> FrameProbeResult<serde_json::Value> {
        if let Some(file) = self.request.file.clone() {
            return file::run_file_mode(runner, &file, &self.request, self.format, &self.selection)
                .await;
        }

        let project = project.ok_or_else(|| {
            FrameProbeError::new(
                "A timeline frame probe needs an open project; none was supplied".to_string(),
            )
        })?;

        match self.selection {
            Selection::AssetTime {
                ref asset_id,
                source_time,
            } => {
                timeline::run_asset_mode(
                    project,
                    runner,
                    asset_id,
                    source_time,
                    &self.request.out,
                    self.format,
                    self.request.max_width,
                )
                .await
            }
            Selection::SingleTime(time) => {
                timeline::run_timeline_mode(
                    project,
                    runner,
                    &self.request,
                    self.format,
                    self.mode,
                    &[time],
                    false,
                    None,
                )
                .await
            }
            Selection::BatchTimes(ref times) => {
                timeline::run_timeline_mode(
                    project,
                    runner,
                    &self.request,
                    self.format,
                    self.mode,
                    times,
                    true,
                    None,
                )
                .await
            }
            Selection::Grid {
                columns,
                rows,
                ref times,
            } => {
                timeline::run_grid_mode(
                    project,
                    runner,
                    &self.request,
                    self.format,
                    self.mode,
                    columns,
                    rows,
                    times,
                    None,
                )
                .await
            }
            Selection::Sampled { ref spec, grid } => {
                let outcome = run_samplers(project, &self.request, spec)?;
                let times: Vec<f64> = outcome
                    .samples
                    .iter()
                    .map(|sample| sample.time_sec)
                    .collect();
                let reasons: Vec<SampleReason> =
                    outcome.samples.iter().map(|sample| sample.reason).collect();
                let context = timeline::SamplerContext {
                    reasons: &reasons,
                    report: &outcome.report,
                };

                match grid {
                    Some(layout) => {
                        let (columns, rows) =
                            resolve_sampled_grid(layout, times.len(), &self.request)?;
                        timeline::run_grid_mode(
                            project,
                            runner,
                            &self.request,
                            self.format,
                            self.mode,
                            columns,
                            rows,
                            &times,
                            Some(&context),
                        )
                        .await
                    }
                    None => {
                        timeline::run_timeline_mode(
                            project,
                            runner,
                            &self.request,
                            self.format,
                            self.mode,
                            &times,
                            true,
                            Some(&context),
                        )
                        .await
                    }
                }
            }
        }
    }
}

/// Runs the samplers against the opened project's sequence.
fn run_samplers(
    project: &FrameProbeProject<'_>,
    request: &FrameProbeRequest,
    spec: &SamplerSpec,
) -> FrameProbeResult<SamplerOutcome> {
    let (sequence_id, sequence) = resolve_sequence(project, request.sequence.clone())?;
    let affected_ranges = if spec.affected {
        resolve_affected_ranges(project, &sequence_id)?
    } else {
        Vec::new()
    };

    sampler::run(
        spec,
        &SamplerInputs {
            sequence,
            effects: &project.state.effects,
            affected_ranges: &affected_ranges,
        },
    )
}

/// Reads the ranges the last successful apply changed.
///
/// The hand-off file is written by every mutating verb, so its absence means no
/// edit has been applied to this project through the CLI or the MCP server yet —
/// which is a different problem from an empty edit, and the message has to say
/// which one the caller is looking at.
///
/// A record whose last operation is not the project's current one is refused
/// rather than used. The file is a hand-off, not a history: an undo, a redo, or
/// an edit applied by a surface that does not record one leaves it describing a
/// state the project has left, and the sampler would then point confidently at
/// the wrong seconds — the one failure mode `--affected` exists to remove.
fn resolve_affected_ranges(
    project: &FrameProbeProject<'_>,
    sequence_id: &str,
) -> FrameProbeResult<Vec<crate::core::TimeRange>> {
    let Some(record) = load_last_affected_ranges(project.path) else {
        return Err(FrameProbeError::new(
            "--affected reads the ranges the last edit changed, and this project has none recorded. Apply an edit with `command execute` or `plan execute` first, or pass --between <START> <END> to sweep the timeline instead."
                .to_string(),
        ));
    };
    if record.sequence_id != sequence_id {
        return Err(FrameProbeError::new(format!(
            "The last recorded edit changed sequence '{}', not '{}'. Extract from that sequence with --sequence {}, apply an edit to this one first, or pass --between <START> <END>.",
            record.sequence_id, sequence_id, record.sequence_id
        )));
    }
    if record.op_ids.last().map(String::as_str) != project.state.last_op_id.as_deref() {
        return Err(FrameProbeError::new(format!(
            "The recorded hand-off ends at operation {}, but this project is at {}, so the last edit was not recorded: run the edit through `command execute` or `plan execute`, or pass --between <START> <END>.",
            describe_op_id(record.op_ids.last().map(String::as_str)),
            describe_op_id(project.state.last_op_id.as_deref()),
        )));
    }
    if record.affected_ranges.is_empty() {
        return Err(FrameProbeError::new(format!(
            "The last recorded edit on sequence '{}' moved nothing on the timeline, so --affected has nothing to look at. Pass --between <START> <END>, or a sampler such as --at-cuts.",
            sequence_id
        )));
    }

    Ok(record.affected_ranges)
}

/// Names an operation id for a message, or says there is none.
fn describe_op_id(op_id: Option<&str>) -> String {
    match op_id {
        Some(op_id) => format!("'{op_id}'"),
        None => "no operation at all".to_string(),
    }
}

/// Chooses the contact-sheet layout for a sampler's times.
///
/// An explicit grid is honoured but not padded: rows no sample reaches are
/// dropped exactly as they are for `--times`, so the sheet that is measured is
/// the sheet that gets built.
fn resolve_sampled_grid(
    layout: GridLayout,
    count: usize,
    request: &FrameProbeRequest,
) -> FrameProbeResult<(usize, usize)> {
    let (columns, rows) = match layout {
        GridLayout::Auto => auto_grid(count)?,
        GridLayout::Fixed { columns, rows } => {
            let capacity = columns.checked_mul(rows).ok_or_else(|| {
                FrameProbeError::new(format!(
                    "Invalid value for --grid: {}x{} is too large",
                    columns, rows
                ))
            })?;
            if capacity > MAX_GRID_CELLS {
                return Err(FrameProbeError::new(format!(
                    "Invalid value for --grid: {}x{} needs {} cells, more than the maximum of {}",
                    columns, rows, capacity, MAX_GRID_CELLS
                )));
            }
            if count > capacity {
                return Err(FrameProbeError::new(format!(
                    "The samplers selected {} times, more than the {}x{} grid holds ({}). Add --limit {}, or ask for a bigger grid.",
                    count, columns, rows, capacity, capacity
                )));
            }
            (columns, count.div_ceil(columns))
        }
    };

    ensure_sheet_dimensions_in_range(columns, rows, request.cell_width, request.cell_height)?;

    Ok((columns, rows))
}

/// Rejects contact-sheet cell dimensions outside the supported range.
///
/// clap enforces the same range for the CLI, but the range must hold for every
/// caller: a cell FFmpeg's tiler cannot fill is a broken sheet regardless of
/// which surface asked for it.
fn ensure_cell_size_in_range(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    for (label, value) in [
        ("cell-width", request.cell_width),
        ("cell-height", request.cell_height),
    ] {
        let Some(value) = value else {
            continue;
        };
        if !(MIN_CELL_SIZE_PX..=MAX_CELL_SIZE_PX).contains(&value) {
            return Err(FrameProbeError::new(format!(
                "Invalid value for --{}: {} is outside the supported range of {}-{}",
                label, value, MIN_CELL_SIZE_PX, MAX_CELL_SIZE_PX
            )));
        }
    }

    Ok(())
}

/// Rejects a still width outside the supported range.
///
/// clap enforces the same range for the CLI, but every caller needs it: the
/// width decides how many pixels one response carries, and the MCP surface
/// inlines those pixels as base64.
fn ensure_max_width_in_range(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    let Some(max_width) = request.max_width else {
        return Ok(());
    };
    if !(MIN_STILL_WIDTH_PX..=MAX_STILL_WIDTH_PX).contains(&max_width) {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --max-width: {} is outside the supported range of {}-{}",
            max_width, MIN_STILL_WIDTH_PX, MAX_STILL_WIDTH_PX
        )));
    }

    Ok(())
}

/// Rejects a contact sheet whose finished pixel dimensions exceed the cap.
///
/// The cell cap bounds one cell and the grid cap bounds the count; only their
/// product describes the image that is actually produced. Checking it here —
/// before FFmpeg is resolved and before the first cell is extracted — turns a
/// sheet no encoder or vision API would accept into an argument error rather
/// than a failure paid for at full extraction cost.
fn ensure_sheet_fits(request: &FrameProbeRequest, selection: &Selection) -> FrameProbeResult<()> {
    let Selection::Grid { columns, rows, .. } = selection else {
        return Ok(());
    };

    ensure_sheet_dimensions_in_range(*columns, *rows, request.cell_width, request.cell_height)
}

// ── Output payloads ─────────────────────────────────────────────────────

/// One extracted still in the JSON payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FrameEntry {
    pub index: usize,
    pub time_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_time_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Which tier produced the picture: `cache`, `composite` or `source`.
    pub source: FrameSource,
    /// Whether a `fast` request had to composite after all.
    ///
    /// `null` outside `fast` mode, where the question does not arise. Kept
    /// alongside `source` because callers written against the old payload read
    /// it, and it still answers a different question: `source` says what
    /// produced the picture, this says whether `fast` could keep its promise.
    pub fell_back_to_composite: Option<bool>,
    /// Why a sampler chose this time; absent when the caller named it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SampleReason>,
}

/// One contact-sheet cell, mapping a grid position back to a timeline time.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GridCell {
    pub index: usize,
    pub row: usize,
    pub col: usize,
    pub timeline_sec: f64,
    /// Why a sampler chose this cell's time; absent when the caller named it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SampleReason>,
}

/// One still extracted from a rendered file, in that file's own timebase.
///
/// The time field is deliberately not `timeSec`: a rendered range starts at
/// zero regardless of where it sat on the timeline, so calling it a timeline
/// time would be a lie the judge could act on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileFrameEntry {
    pub index: usize,
    pub file_sec: f64,
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// One contact-sheet cell mapped back to a rendered file's timebase.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileGridCell {
    pub index: usize,
    pub row: usize,
    pub col: usize,
    pub file_sec: f64,
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Last timeline position the sequence renders any content at.
///
/// Delegates to [`Sequence::output_duration`] — the length the render pipeline
/// pads its output to — because a still is extracted by rendering a window and
/// the window is snapped against that length. Measuring the clips directly here
/// looked equivalent but was not: it kept clips on tracks the export drops, so
/// a muted twenty-second music bed made a four-second edit report twenty
/// seconds. Every time then snapped against a different length than the
/// renderer used, and two samples a frame apart could resolve to one frame —
/// `cutBefore` and `cutAfter` returning the same picture, which reads as a cut
/// that is not there.
fn sequence_duration_sec(sequence: &Sequence) -> f64 {
    sequence.output_duration()
}

/// Rejects requested times the sequence has no content at.
///
/// Without this the request reaches the renderer and comes back as an internal
/// "output range is empty" message that says nothing about what the caller
/// asked for. The common trigger is a sampled window wider than the edit.
fn ensure_times_inside_sequence(sequence: &Sequence, times: &[f64]) -> FrameProbeResult<()> {
    let duration_sec = sequence_duration_sec(sequence);
    if duration_sec <= 0.0 {
        return Err(FrameProbeError::new(format!(
            "Sequence '{}' is empty, so there is no frame to extract",
            sequence.name
        )));
    }

    if let Some(out_of_range) = times.iter().find(|time| **time >= duration_sec) {
        return Err(FrameProbeError::new(format!(
            "Requested time {:.3}s is at or past the end of sequence '{}' ({:.3}s). Ask for a time inside the sequence, or narrow --between to the edited range.",
            out_of_range,
            sequence.name,
            duration_sec
        )));
    }

    Ok(())
}

/// Resolves the target sequence, defaulting to the project's active sequence.
fn resolve_sequence<'a>(
    project: &'a FrameProbeProject<'_>,
    sequence: Option<String>,
) -> FrameProbeResult<(String, &'a Sequence)> {
    let sequence_id = sequence
        .or_else(|| project.state.active_sequence_id.clone())
        .ok_or_else(|| {
            FrameProbeError::new("No sequence specified and no active sequence set".to_string())
        })?;
    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| FrameProbeError::new(format!("Sequence '{}' not found", sequence_id)))?;

    Ok((sequence_id, sequence))
}

fn parse_image_format(raw: &str) -> FrameProbeResult<ImageFormat> {
    match raw.trim().to_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        other => Err(FrameProbeError::new(format!(
            "Invalid value for --format: expected 'png' or 'jpeg' (got '{}')",
            other
        ))),
    }
}

/// Reads the image format the output path already names, if any.
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
/// The output extension wins by default so `--out sheet.jpg` writes a JPEG at
/// exactly that path. `--format` stays available as an explicit override for
/// extensionless or directory outputs, but a `--format` that contradicts a
/// recognised extension is rejected rather than silently redirecting the write
/// to a different file.
fn resolve_image_format(explicit: Option<&str>, out: &Path) -> FrameProbeResult<ImageFormat> {
    let from_path = image_format_from_path(out);

    let Some(raw) = explicit else {
        return Ok(from_path.unwrap_or(ImageFormat::Png));
    };

    let requested = parse_image_format(raw)?;
    if let Some(path_format) = from_path {
        if path_format != requested {
            return Err(FrameProbeError::new(format!(
                "Conflicting output format: --format {} does not match the '.{}' extension of --out '{}'. Drop --format to follow the extension, or point --out at a .{} file.",
                raw.trim(),
                out.extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_default(),
                out.display(),
                requested.extension()
            )));
        }
    }

    Ok(requested)
}

/// Parses a `COLSxROWS` grid specification.
pub fn parse_grid_spec(raw: &str) -> FrameProbeResult<(usize, usize)> {
    let normalized = raw.trim().to_lowercase();
    let (columns, rows) = normalized.split_once('x').ok_or_else(|| {
        FrameProbeError::new("Invalid value for --grid: expected COLSxROWS (e.g. 3x2)".to_string())
    })?;

    let parse_part = |value: &str, name: &str| -> FrameProbeResult<usize> {
        let parsed: usize = value.trim().parse().map_err(|_| {
            FrameProbeError::new(format!(
                "Invalid value for --grid: {} must be a positive integer (got '{}')",
                name, value
            ))
        })?;
        if parsed == 0 {
            return Err(FrameProbeError::new(format!(
                "Invalid value for --grid: {} must be >= 1",
                name
            )));
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

/// Builds the file name used for batch output.
fn batch_frame_name(time_sec: f64, format: &ImageFormat) -> String {
    let millis = (time_sec * 1000.0).round().max(0.0) as u64;
    format!("frame_{}.{}", millis, format.extension())
}

/// Resolves the output path for a single still: an existing directory receives
/// a generated file name, otherwise the path is used as-is.
fn resolve_single_output_path(
    out: &Path,
    time_sec: f64,
    format: ImageFormat,
) -> FrameProbeResult<PathBuf> {
    if out.is_dir() {
        return Ok(out.join(batch_frame_name(time_sec, &format)));
    }
    if out.as_os_str().is_empty() {
        return Err(FrameProbeError::new(
            "Invalid value for --out: cannot be empty".to_string(),
        ));
    }
    Ok(normalize_extension(out.to_path_buf(), &format))
}

/// Forces the output extension to match the requested format so the encoder
/// FFmpeg picks always agrees with the format.
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

/// Creates the output directory a batch of stills is written into.
fn create_batch_output_dir(out: &Path) -> FrameProbeResult<()> {
    std::fs::create_dir_all(out).map_err(|error| {
        FrameProbeError::new(format!(
            "Failed to create output directory '{}': {}",
            out.display(),
            error
        ))
    })
}

/// Deletes an output file left behind by an earlier run.
///
/// A stale image at the target path is indistinguishable from a fresh one, and
/// the extraction FFmpeg silently declines to perform leaves it in place.
fn remove_stale_output(output_path: &Path) -> FrameProbeResult<()> {
    match std::fs::remove_file(output_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FrameProbeError::new(format!(
            "Failed to replace '{}': {}",
            output_path.display(),
            error
        ))),
    }
}

/// Rejects an extraction that produced no image.
///
/// FFmpeg reports success for an input seek that lands past the last decodable
/// frame — it simply writes nothing. Reporting that as an extracted frame is
/// the worst outcome available: the caller reads plausible dimensions probed
/// from whatever was at the path before.
fn ensure_frame_written(output_path: &Path, time_sec: f64, source: &Path) -> FrameProbeResult<()> {
    let written = std::fs::metadata(output_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if written {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "FFmpeg produced no frame at {:.3}s of '{}'. The seek landed past the last decodable frame; ask for an earlier time.",
        time_sec,
        source.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_request(grid: &str, count: Option<usize>) -> FrameProbeRequest {
        FrameProbeRequest {
            out: PathBuf::from("sheet.jpg"),
            grid: Some(grid.to_string()),
            between: Some(vec![0.0, 4.0]),
            count,
            ..FrameProbeRequest::default()
        }
    }

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
    fn resolve_selection_should_build_a_grid_from_an_explicit_time_list() {
        let mut request = grid_request("3x2", None);
        request.between = None;
        request.times = Some(vec![4.0, 1.5, 9.25]);

        let Selection::Grid {
            columns,
            rows,
            times,
        } = resolve_selection(&request).expect("selection resolves")
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
        let mut request = grid_request("2x2", None);
        request.between = None;
        request.times = Some(vec![0.0, 1.0, 2.0, 3.0, 4.0]);

        let error = resolve_selection(&request).expect_err("Five times cannot fill a 2x2 sheet");

        let message = error.to_string();
        assert!(
            message.contains("--times") && message.contains("capacity"),
            "Error should name the flag and the capacity, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_reject_a_grid_without_a_time_source() {
        let mut request = grid_request("2x2", None);
        request.between = None;

        let error = resolve_selection(&request).expect_err("A grid needs times to show");

        let message = error.to_string();
        assert!(
            message.contains("--between") && message.contains("--times"),
            "Error should name both accepted sources, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_reject_contact_sheet_flags_without_a_grid() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.time = Some(12.5);
        request.cell_width = Some(640);
        request.label_cells = true;

        let error = resolve_selection(&request).expect_err("Cell flags need a grid to apply to");

        let message = error.to_string();
        assert!(
            message.contains("--cell-width")
                && message.contains("--label-cells")
                && message.contains("--grid"),
            "Error should name the ignored flags and the flag they need, got: {message}"
        );
    }

    #[test]
    fn ensure_max_width_in_range_should_bound_both_ends() {
        let mut request = grid_request("2x2", None);

        request.max_width = None;
        assert!(ensure_max_width_in_range(&request).is_ok());

        request.max_width = Some(0);
        assert!(ensure_max_width_in_range(&request).is_err());

        request.max_width = Some(MAX_STILL_WIDTH_PX);
        assert!(ensure_max_width_in_range(&request).is_ok());

        request.max_width = Some(MAX_STILL_WIDTH_PX + 1);
        let message = ensure_max_width_in_range(&request)
            .expect_err("An unbounded width is what makes a response unreadable")
            .to_string();
        assert!(
            message.contains(&MAX_STILL_WIDTH_PX.to_string()),
            "Error should name the cap, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_accept_a_single_still_without_contact_sheet_flags() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.time = Some(12.5);

        assert!(matches!(
            resolve_selection(&request).expect("A plain still is still valid"),
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
    fn remove_stale_output_should_clear_a_previous_frame_and_tolerate_a_missing_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("frame.png");
        std::fs::write(&target, b"previous candidate").expect("write file");

        remove_stale_output(&target).expect("stale output is removed");
        assert!(!target.exists());
        remove_stale_output(&target).expect("a missing output is not an error");
    }

    #[test]
    fn resolve_selection_should_defer_a_sampler_until_the_sequence_is_known() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.at_cuts = true;
        request.affected = true;

        let Selection::Sampled { spec, grid } =
            resolve_selection(&request).expect("a sampler resolves without a project")
        else {
            panic!("Expected a deferred sampler selection");
        };
        assert!(spec.at_cuts && spec.affected);
        assert!(grid.is_none(), "no --grid means a batch of stills");
    }

    #[test]
    fn resolve_selection_should_reject_a_sampler_combined_with_an_explicit_time_list() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.times = Some(vec![1.0, 2.0]);
        request.at_cuts = true;

        let message = resolve_selection(&request)
            .expect_err("a sampler and a hand-written list describe different pictures")
            .to_string();

        assert!(
            message.contains("--times") && message.contains("sampler"),
            "Error should name the conflicting selector, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_reject_a_sampler_over_a_rendered_file() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.file = Some(PathBuf::from("render.mp4"));
        request.per_shot = true;

        assert!(
            resolve_selection(&request).is_err(),
            "a rendered file has no timeline to sample"
        );
    }

    #[test]
    fn resolve_selection_should_reject_limit_without_a_sampler_to_shape() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.time = Some(1.0);
        request.limit = Some(4);

        let message = resolve_selection(&request)
            .expect_err("a budget nothing reads is a budget nothing honours")
            .to_string();

        assert!(
            message.contains("--limit") && message.contains("--at-cuts"),
            "Error should name the flag and a sampler to pair it with, got: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_carry_an_auto_grid_through_to_the_sampler() {
        let mut request = grid_request("3x2", None);
        request.grid = Some("AUTO".to_string());
        request.between = None;
        request.at_markers = true;

        let Selection::Sampled { grid, .. } =
            resolve_selection(&request).expect("auto resolves alongside a sampler")
        else {
            panic!("Expected a deferred sampler selection");
        };
        assert_eq!(grid, Some(GridLayout::Auto));
    }

    #[test]
    fn resolve_selection_should_size_an_auto_grid_from_a_listed_time_count() {
        let mut request = grid_request("3x2", None);
        request.grid = Some("auto".to_string());
        request.between = None;
        request.times = Some(vec![0.0, 1.0, 2.0, 3.0, 4.0]);

        let Selection::Grid { columns, rows, .. } =
            resolve_selection(&request).expect("auto sizes itself from the list")
        else {
            panic!("Expected a grid selection");
        };
        assert_eq!((columns, rows), (3, 2), "five samples fill a 3-wide sheet");
    }

    #[test]
    fn resolve_selection_should_reject_an_auto_grid_over_a_sampled_range() {
        let mut request = grid_request("auto", None);

        let message = resolve_selection(&request.clone())
            .expect_err("--between already fixes its own count")
            .to_string();
        assert!(
            message.contains("--between") && message.contains("COLSxROWS"),
            "Error should point at an explicit layout, got: {message}"
        );

        request.between = None;
        assert!(resolve_selection(&request).is_err());
    }

    #[test]
    fn resolve_sampled_grid_should_refuse_more_samples_than_an_explicit_grid_holds() {
        let request = FrameProbeRequest {
            out: PathBuf::from("sheet.jpg"),
            ..FrameProbeRequest::default()
        };

        let message = resolve_sampled_grid(
            GridLayout::Fixed {
                columns: 2,
                rows: 2,
            },
            6,
            &request,
        )
        .expect_err("six samples cannot fill four cells")
        .to_string();

        assert!(
            message.contains("--limit") && message.contains('6'),
            "Error should name the count and the way out, got: {message}"
        );
        assert_eq!(
            resolve_sampled_grid(
                GridLayout::Fixed {
                    columns: 3,
                    rows: 3
                },
                4,
                &request
            )
            .expect("a short list drops the rows it does not reach"),
            (3, 2)
        );
    }

    #[test]
    fn parse_grid_layout_should_accept_auto_and_explicit_layouts() {
        assert_eq!(parse_grid_layout(" Auto ").unwrap(), GridLayout::Auto);
        assert_eq!(
            parse_grid_layout("4x3").unwrap(),
            GridLayout::Fixed {
                columns: 4,
                rows: 3
            }
        );
        assert!(parse_grid_layout("automatic").is_err());
    }

    #[test]
    fn resolve_selection_should_reject_grids_beyond_the_cell_budget() {
        assert!(resolve_selection(&grid_request("11x11", None)).is_err());
    }

    #[test]
    fn resolve_selection_should_reject_a_grid_whose_capacity_overflows() {
        let spec = format!("{}x2", usize::MAX);

        assert!(resolve_selection(&grid_request(&spec, None)).is_err());
    }

    #[test]
    fn resolve_selection_should_drop_rows_no_sample_reaches() {
        let selection =
            resolve_selection(&grid_request("3x3", Some(5))).expect("selection resolves");

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
    fn timeline_mode_should_default_to_the_composited_picture() {
        assert_eq!(
            TimelineMode::resolve(None).expect("an absent mode resolves"),
            TimelineMode::Composite,
            "The default has to be what export produces, captions and text included"
        );
        assert_eq!(
            TimelineMode::resolve(Some("fast")).expect("an explicit mode resolves"),
            TimelineMode::Fast,
            "fast stays available, but only by name"
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
