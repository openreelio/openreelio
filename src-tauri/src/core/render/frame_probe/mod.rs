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

mod artifacts;
mod file;
pub mod media;
mod sampler;
mod sheet;
mod timeline;

pub use artifacts::{
    allocate_frame_output, frame_cache_dir, frame_image_paths, image_mime_type,
    inline_frame_images, FrameArtifact, FrameOutput, InlineImage, MAX_CACHED_FRAME_DIRECTORIES,
    MAX_INLINE_FRAME_STILLS,
};
pub use media::{check_asset_media, check_sequence_media, MediaLocalityError};
pub use sampler::{
    auto_grid, Sample, SampleReason, SamplerReport, SamplerSpec, DEFAULT_AROUND_COUNT,
    DEFAULT_AROUND_SPAN_SEC,
};
pub use sheet::{
    ensure_sheet_dimensions_in_range, ensure_sheet_width_in_range, MAX_CELL_SIZE_PX,
    MAX_SHEET_DIMENSION_PX, MIN_CELL_SIZE_PX,
};
pub use timeline::{FrameSource, MIN_COMPOSITE_WINDOW_SEC};

use super::ImageFormat;
use crate::core::commands::{load_last_affected_ranges, RecordSource};
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::project::ProjectState;
use crate::core::timeline::Sequence;
use crate::core::TimeRange;
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

/// Which vocabulary a surface refuses in.
///
/// The labels alone are not enough: several messages have to name an argument
/// *with its values*, and "two numbers" is written `<START> <END>` on a command
/// line and `[start, end]` in JSON. One discriminant here keeps that difference
/// in a single place instead of duplicating every phrase per surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameProbeArgumentStyle {
    /// Long flags and angle-bracket metavariables, as clap accepts them.
    Cli,
    /// camelCase JSON keys and literal JSON values.
    Json,
}

/// How one surface spells `frame extract`'s arguments back to its own caller.
///
/// The engine is shared by three surfaces that name the same argument three
/// ways — `--cell-width` on the command line, `cellWidth` in an MCP payload or
/// an in-app IPC request — and a refusal that tells a caller to add a flag it
/// cannot type is a refusal it cannot act on. Every message the probe builds is
/// assembled from these labels, so each surface refuses in its own vocabulary
/// without the rules themselves being restated per surface.
///
/// Build one with [`FrameProbeArgumentNames::cli`] or
/// [`FrameProbeArgumentNames::api`]; the fields are public so a fourth surface
/// can spell an argument its own way — the MCP server does exactly that for
/// `sequenceId` — without a new constructor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameProbeArgumentNames {
    /// Which vocabulary the value-carrying phrases are written in.
    pub style: FrameProbeArgumentStyle,
    /// Name of the rendered-file argument.
    pub file: &'static str,
    /// Name of the argument declaring which timeline seconds a file covers.
    pub file_range: &'static str,
    /// Name of the source-asset argument.
    pub asset: &'static str,
    /// Name of the time-inside-the-asset argument.
    pub source_time: &'static str,
    /// Name of the single timeline time argument.
    pub time: &'static str,
    /// Name of the timeline time list argument.
    pub times: &'static str,
    /// Name of the sequence-selection argument.
    pub sequence: &'static str,
    /// Name of the timeline extraction mode argument.
    pub mode: &'static str,
    /// Name of the still width cap argument.
    pub max_width: &'static str,
    /// Name of the image format argument.
    pub format: &'static str,
    /// Name of the contact-sheet layout argument.
    pub grid: &'static str,
    /// Name of the sampled-range argument a contact sheet sweeps.
    pub between: &'static str,
    /// Name of the grid sample count argument.
    pub count: &'static str,
    /// Name of the contact-sheet cell width argument.
    pub cell_width: &'static str,
    /// Name of the contact-sheet cell height argument.
    pub cell_height: &'static str,
    /// Name of the cell labelling switch.
    pub label_cells: &'static str,
    /// Name of the cut sampler switch.
    pub at_cuts: &'static str,
    /// Name of the transition sampler switch.
    pub at_transitions: &'static str,
    /// Name of the caption sampler switch.
    pub at_captions: &'static str,
    /// Name of the marker sampler switch.
    pub at_markers: &'static str,
    /// Name of the per-shot sampler switch.
    pub per_shot: &'static str,
    /// Name of the centred-window sampler argument.
    pub around: &'static str,
    /// Name of the window half-width argument.
    pub span: &'static str,
    /// Name of the window sample count argument.
    pub around_count: &'static str,
    /// Name of the changed-ranges sampler switch.
    pub affected: &'static str,
    /// Name of the operation-id guard on the changed-ranges record.
    pub after_op: &'static str,
    /// Name of the caller-named ranges argument.
    pub ranges: &'static str,
    /// Name of the sampler budget argument.
    pub limit: &'static str,
}

impl FrameProbeArgumentNames {
    /// The `openreelio-cli frame extract` spelling: long flags, as clap accepts
    /// them.
    ///
    /// `ranges` is `--range` rather than `--ranges`: clap collects one range per
    /// occurrence of a repeatable flag, so the flag itself is singular.
    pub const fn cli() -> Self {
        Self {
            style: FrameProbeArgumentStyle::Cli,
            file: "--file",
            file_range: "--file-range",
            asset: "--asset",
            source_time: "--source-time",
            time: "--time",
            times: "--times",
            sequence: "--sequence",
            mode: "--mode",
            max_width: "--max-width",
            format: "--format",
            grid: "--grid",
            between: "--between",
            count: "--count",
            cell_width: "--cell-width",
            cell_height: "--cell-height",
            label_cells: "--label-cells",
            at_cuts: "--at-cuts",
            at_transitions: "--at-transitions",
            at_captions: "--at-captions",
            at_markers: "--at-markers",
            per_shot: "--per-shot",
            around: "--around",
            span: "--span",
            around_count: "--around-count",
            affected: "--affected",
            after_op: "--after-op",
            ranges: "--range",
            limit: "--limit",
        }
    }

    /// The JSON spelling shared by the MCP tool and the in-app IPC request.
    pub const fn api() -> Self {
        Self {
            style: FrameProbeArgumentStyle::Json,
            file: "file",
            file_range: "fileRange",
            asset: "asset",
            source_time: "sourceTime",
            time: "time",
            times: "times",
            sequence: "sequence",
            mode: "mode",
            max_width: "maxWidth",
            format: "format",
            grid: "grid",
            between: "between",
            count: "count",
            cell_width: "cellWidth",
            cell_height: "cellHeight",
            label_cells: "labelCells",
            at_cuts: "atCuts",
            at_transitions: "atTransitions",
            at_captions: "atCaptions",
            at_markers: "atMarkers",
            per_shot: "perShot",
            around: "around",
            span: "span",
            around_count: "aroundCount",
            affected: "affected",
            after_op: "afterOp",
            ranges: "ranges",
            limit: "limit",
        }
    }

    /// Every sampler switch, in the order the "add one of these" hints list them.
    pub fn sampler_flags(&self) -> [&'static str; 8] {
        [
            self.at_cuts,
            self.at_transitions,
            self.at_captions,
            self.at_markers,
            self.per_shot,
            self.around,
            self.affected,
            self.ranges,
        ]
    }

    /// The sampler switches as one comma-separated list for a hint.
    pub fn sampler_flag_list(&self) -> String {
        self.sampler_flags().join(", ")
    }

    /// An argument written with a value, in this surface's vocabulary.
    fn with_value(&self, name: &str, cli_metavar: &str, json_hint: &str) -> String {
        match self.style {
            FrameProbeArgumentStyle::Cli => format!("{name} {cli_metavar}"),
            FrameProbeArgumentStyle::Json => {
                if json_hint.is_empty() {
                    name.to_string()
                } else {
                    format!("{name} {json_hint}")
                }
            }
        }
    }

    /// `between` written with the two values it takes.
    pub fn between_range(&self) -> String {
        self.with_value(self.between, "<START> <END>", "[start, end]")
    }

    /// `ranges` written with the values it takes.
    pub fn ranges_range(&self) -> String {
        self.with_value(self.ranges, "<START> <END>", "[[start, end]]")
    }

    /// `file_range` written with the two values it takes.
    pub fn file_range_values(&self) -> String {
        self.with_value(self.file_range, "<START> <END>", "[start, end]")
    }

    /// `grid` written with an explicit layout.
    pub fn grid_layout(&self) -> String {
        self.with_value(self.grid, "<COLSxROWS>", "\"COLSxROWS\"")
    }

    /// `around` written with its centre time.
    pub fn around_value(&self) -> String {
        self.with_value(self.around, "<SEC>", "")
    }

    /// `times` written with its list of values.
    pub fn times_values(&self) -> String {
        self.with_value(self.times, "<A,B,...>", "")
    }

    /// `source_time` written with its value.
    pub fn source_time_value(&self) -> String {
        self.with_value(self.source_time, "<SEC>", "")
    }

    /// `file` written with the render it names.
    pub fn file_value(&self) -> String {
        self.with_value(self.file, "<RENDER>", "")
    }

    /// `after_op` written with the operation id it takes.
    pub fn after_op_value(&self) -> String {
        self.with_value(self.after_op, "<OP>", "")
    }

    /// `limit` written with a count.
    pub fn limit_value(&self, count: usize) -> String {
        match self.style {
            FrameProbeArgumentStyle::Cli => format!("{} {count}", self.limit),
            FrameProbeArgumentStyle::Json => format!("{}: {count}", self.limit),
        }
    }

    /// `sequence` written with the id to pass it.
    pub fn sequence_value(&self, sequence_id: &str) -> String {
        match self.style {
            FrameProbeArgumentStyle::Cli => format!("{} {sequence_id}", self.sequence),
            FrameProbeArgumentStyle::Json => format!("{}: \"{sequence_id}\"", self.sequence),
        }
    }

    /// The two ends of a two-value argument, each named so a caller can tell
    /// which one a refusal is about.
    pub fn range_ends(&self, name: &str) -> (String, String) {
        match self.style {
            FrameProbeArgumentStyle::Cli => (format!("{name} START"), format!("{name} END")),
            FrameProbeArgumentStyle::Json => (format!("{name}[0]"), format!("{name}[1]")),
        }
    }
}

/// The command line's vocabulary, as a `'static` every request can point at.
pub const CLI_ARGUMENT_NAMES: &FrameProbeArgumentNames = &FrameProbeArgumentNames::cli();

/// The JSON vocabulary, as a `'static` every request can point at.
pub const API_ARGUMENT_NAMES: &FrameProbeArgumentNames = &FrameProbeArgumentNames::api();

/// The JSON spelling, because two of the three surfaces speak it and a request
/// built field by field is far more likely to be one of those than the CLI's.
///
/// Implemented on the reference rather than the value because that is how
/// requests carry it: thirty labels is half a kilobyte, and the request is
/// captured inside the extraction's async state machine, which runs on the
/// process's main thread.
impl Default for &'static FrameProbeArgumentNames {
    fn default() -> Self {
        API_ARGUMENT_NAMES
    }
}

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
    /// Timeline range the `file` covers, as `[start, end]` seconds.
    ///
    /// A rendered file has its own timebase starting at zero, so nothing about
    /// it says which seconds of the edit it holds. Declaring that is what lets
    /// a sampler run against one: the samplers read the timeline restricted to
    /// this range, and every time they choose is translated into the file as
    /// `t - start`. Without a sampler it is recorded on the payload and changes
    /// nothing — `times` and `between` stay file-relative either way.
    pub file_range: Option<Vec<f64>>,
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
    /// Operation id the `affected` record must end at.
    ///
    /// The hand-off file is one slot every surface overwrites, so "the last
    /// edit" is only the caller's own edit while nothing else has applied one.
    /// Naming the operation the caller's apply ended at turns that assumption
    /// into a check.
    pub after_op: Option<String>,
    /// Sample these ranges, named by the caller rather than read from the record.
    pub ranges: Option<Vec<TimeRange>>,
    /// Largest number of samples a sampler keeps.
    pub limit: Option<usize>,
    /// How the calling surface spells these arguments when a refusal has to
    /// name one.
    pub names: &'static FrameProbeArgumentNames,
}

impl FrameProbeRequest {
    /// The samplers this request asked for.
    fn sampler_spec(&self) -> SamplerSpec {
        SamplerSpec {
            names: self.names,
            at_cuts: self.at_cuts,
            at_transitions: self.at_transitions,
            at_captions: self.at_captions,
            at_markers: self.at_markers,
            per_shot: self.per_shot,
            around: self.around,
            span: self.span,
            around_count: self.around_count,
            affected: self.affected,
            ranges: self.ranges.clone(),
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
    fn resolve(raw: Option<&str>, names: &FrameProbeArgumentNames) -> FrameProbeResult<Self> {
        match raw {
            Some(value) => Self::parse(value, names),
            None => Ok(Self::Composite),
        }
    }

    fn parse(raw: &str, names: &FrameProbeArgumentNames) -> FrameProbeResult<Self> {
        match raw.trim().to_lowercase().as_str() {
            "fast" => Ok(Self::Fast),
            "composite" => Ok(Self::Composite),
            other => Err(FrameProbeError::new(format!(
                "Invalid value for {}: expected 'fast' or 'composite' (got '{}')",
                names.mode, other
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
        /// Boxed because it carries the surface's whole argument vocabulary,
        /// which is an order of magnitude larger than any other variant: stored
        /// inline it would set the size of every `Selection`, including the
        /// single-still one that is by far the most common.
        spec: Box<SamplerSpec>,
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
fn parse_grid_layout(raw: &str, names: &FrameProbeArgumentNames) -> FrameProbeResult<GridLayout> {
    if raw.trim().eq_ignore_ascii_case("auto") {
        return Ok(GridLayout::Auto);
    }

    let (columns, rows) = parse_grid_spec_named(raw, names)?;
    Ok(GridLayout::Fixed { columns, rows })
}

/// Validates that a time value in seconds is non-negative.
///
/// Mirrors the CLI's own argument validator so a request that arrives through
/// the MCP surface is refused in exactly the same words.
fn ensure_time_non_negative(value: f64, label: &str) -> FrameProbeResult<()> {
    if value.is_nan() || value.is_infinite() {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be a finite number",
            label
        )));
    }
    if value < 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: time cannot be negative (got {})",
            label, value
        )));
    }
    Ok(())
}

/// Validates that a time range is finite, non-negative and ordered.
fn ensure_time_range_ordered(
    start: f64,
    end: f64,
    start_label: &str,
    end_label: &str,
) -> FrameProbeResult<()> {
    ensure_time_non_negative(start, start_label)?;
    ensure_time_non_negative(end, end_label)?;
    if start >= end {
        return Err(FrameProbeError::new(format!(
            "Invalid time range: {} ({}) must be less than {} ({})",
            start_label, start, end_label, end
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
    let names = request.names;
    let (columns, rows) = match parse_grid_layout(grid, names)? {
        GridLayout::Fixed { columns, rows } => (columns, rows),
        // `auto` sizes itself from the samples, and without a sampler the only
        // other list whose length is known here is the caller's own time list.
        GridLayout::Auto => return resolve_auto_grid_selection(request),
    };
    let capacity = columns.checked_mul(rows).ok_or_else(|| {
        FrameProbeError::new(format!(
            "Invalid value for {}: {}x{} is too large",
            names.grid, columns, rows
        ))
    })?;
    if capacity > MAX_GRID_CELLS {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: {}x{} needs {} cells, more than the maximum of {}",
            names.grid, columns, rows, capacity, MAX_GRID_CELLS
        )));
    }

    let times = match (&request.between, &request.times) {
        (Some(range), None) => sampled_grid_times(request, range, columns, rows, capacity)?,
        (None, Some(listed)) => listed_grid_times(listed, columns, rows, capacity, names)?,
        (Some(_), Some(_)) => {
            return Err(FrameProbeError::new(format!(
                "{} takes either {} or {}, not both",
                names.grid,
                names.between_range(),
                names.times_values()
            )))
        }
        (None, None) => {
            return Err(FrameProbeError::new(format!(
                "{} requires {} or {}",
                names.grid,
                names.between_range(),
                names.times_values()
            )))
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
    let names = request.names;
    let Some(listed) = request.times.as_deref() else {
        return Err(FrameProbeError::new(format!(
            "{} 'auto' sizes the sheet from its samples, so it needs a sampler ({}) or {}. With {}, pass an explicit {}.",
            names.grid,
            names.sampler_flag_list(),
            names.times,
            names.between,
            names.grid_layout()
        )));
    };
    if listed.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} requires at least one value",
            names.times
        )));
    }
    for time in listed {
        ensure_time_non_negative(*time, names.times)?;
    }

    let (columns, rows) = auto_grid(listed.len(), names)?;

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
    let names = request.names;
    if range.len() != 2 {
        return Err(FrameProbeError::new(format!(
            "{} takes exactly two values",
            names.between
        )));
    }
    let (start_label, end_label) = names.range_ends(names.between);
    ensure_time_range_ordered(range[0], range[1], &start_label, &end_label)?;

    let count = request.count.unwrap_or(capacity);
    if count < 1 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be >= 1",
            names.count
        )));
    }
    if count > capacity {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: {} exceeds the {}x{} grid capacity of {}",
            names.count, count, columns, rows, capacity
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
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<Vec<f64>> {
    if listed.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} requires at least one value",
            names.times
        )));
    }
    for time in listed {
        ensure_time_non_negative(*time, names.times)?;
    }
    if listed.len() > capacity {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: {} values exceed the {}x{} grid capacity of {}",
            names.times,
            listed.len(),
            columns,
            rows,
            capacity
        )));
    }

    Ok(listed.to_vec())
}

/// Arguments that only mean something on a contact sheet, in the spelling the
/// caller's own surface uses.
fn grid_only_flags(names: &FrameProbeArgumentNames) -> [&'static str; 5] {
    [
        names.between,
        names.count,
        names.cell_width,
        names.cell_height,
        names.label_cells,
    ]
}

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

    let names = request.names;
    let present: Vec<&str> = [
        request.between.is_some(),
        request.count.is_some(),
        request.cell_width.is_some(),
        request.cell_height.is_some(),
        request.label_cells,
    ]
    .iter()
    .zip(grid_only_flags(names))
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "{} only applies to a contact sheet and needs {}. Add {}, or drop the argument for a single still.",
        present.join(", "),
        names.grid_layout(),
        names.grid
    )))
}

/// Selectors that name the times themselves, and so cannot be combined with a
/// sampler that derives them.
fn sampler_exclusive_flags(names: &FrameProbeArgumentNames) -> [&'static str; 6] {
    [
        names.time,
        names.times,
        names.between,
        names.count,
        names.asset,
        names.file,
    ]
}

/// What a caller is told when a sampler meets a rendered file with no declared
/// range.
///
/// The refusal is the same one it has always been — a file has no timeline to
/// sample — but the answer to it is now a flag rather than a different command,
/// so the message says which one.
fn file_range_hint(names: &FrameProbeArgumentNames) -> String {
    format!(
        " A rendered file can be sampled once you say which timeline seconds it covers: add {} — the range you rendered — and every sampled time is translated into the file's own timebase.",
        names.file_range_values()
    )
}

/// Rejects a sampler combined with a selector that already names its times.
///
/// Samplers union with each other, but not with a hand-written list: a request
/// carrying both is ambiguous about which times the pictures are of, and
/// silently preferring either one hides the other from the caller.
///
/// `--file` is the one selector that can be lifted: it names no times at all,
/// it names a *timebase*, and a declared [`file_range`](FrameProbeRequest::file_range)
/// is the missing half — the timeline seconds the file holds — that lets the
/// samplers run and their answers be translated into it.
fn ensure_sampler_selectors_unused(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    let names = request.names;
    let file_without_range = request.file.is_some() && request.file_range.is_none();
    let present: Vec<&str> = [
        request.time.is_some(),
        request.times.is_some(),
        request.between.is_some(),
        request.count.is_some(),
        request.asset.is_some(),
        file_without_range,
    ]
    .iter()
    .zip(sampler_exclusive_flags(names))
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    let hint = if file_without_range {
        file_range_hint(names)
    } else {
        String::new()
    };

    Err(FrameProbeError::new(format!(
        "A sampler chooses its own times, so it cannot be combined with {}. Drop the sampler arguments, or drop {}.{hint}",
        present.join(", "),
        present.join(" and ")
    )))
}

/// Resolves the timeline range a rendered `file` was declared to cover.
///
/// Validated here rather than at each surface so `--file-range 5 2` is refused
/// in the same words however it arrived. The range must be a real span: a
/// zero-width one would translate every sample onto one instant, and a reversed
/// one is a typo the caller has to see rather than a silently swapped pair.
fn resolve_file_range(request: &FrameProbeRequest) -> FrameProbeResult<Option<TimeRange>> {
    let names = request.names;
    let Some(values) = request.file_range.as_deref() else {
        return Ok(None);
    };
    if request.file.is_none() {
        return Err(FrameProbeError::new(format!(
            "{} declares which timeline seconds a rendered file covers, so it only means something with {}.",
            names.file_range,
            names.file_value()
        )));
    }
    if values.len() != 2 {
        return Err(FrameProbeError::new(format!(
            "{} takes exactly two values: START END (got {})",
            names.file_range,
            values.len()
        )));
    }
    let (start_label, end_label) = names.range_ends(names.file_range);
    ensure_time_range_ordered(values[0], values[1], &start_label, &end_label)?;

    Ok(Some(TimeRange {
        start_sec: values[0],
        end_sec: values[1],
    }))
}

/// Rejects a `ranges` list the sampler could not sample.
///
/// Every value is checked before anything is opened, because a malformed range
/// is a caller mistake and the answer to it is a message, not a picture of the
/// wrong seconds. `start == end` is allowed: that is how a marker's own instant
/// is expressed, and the sampler gives it a single middle sample.
fn ensure_ranges_valid(
    ranges: &[TimeRange],
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<()> {
    if ranges.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} requires at least one [start, end] range",
            names.ranges
        )));
    }

    let (start_label, end_label) = names.range_ends(names.ranges);
    for range in ranges {
        ensure_time_non_negative(range.start_sec, &start_label)?;
        ensure_time_non_negative(range.end_sec, &end_label)?;
        // Ordered but not strictly: unlike a `between` sweep, which has to have
        // width to sample across, a range may be a single instant.
        if range.end_sec < range.start_sec {
            return Err(FrameProbeError::new(format!(
                "Invalid time range: {} ({}) must not be after {} ({})",
                start_label, range.start_sec, end_label, range.end_sec
            )));
        }
    }

    Ok(())
}

/// Rejects `ranges` and `affected` asked for together, and `after_op` asked for
/// without `affected`.
///
/// The two range sources answer the same question from different authorities —
/// what the caller says it changed, and what the project's hand-off record says
/// the last apply changed. Sampling their union would report one set of
/// pictures as though both authorities agreed on them; if they disagree, that
/// is exactly what the caller needs told.
fn ensure_range_sources_coherent(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    let names = request.names;
    if request.ranges.is_some() && request.affected {
        return Err(FrameProbeError::new(format!(
            "{} names the ranges to sample and {} reads the ones the last edit recorded; pass one or the other. Use {} when you already hold the ranges your own edit reported, and {} with {} when you do not.",
            names.ranges,
            names.affected,
            names.ranges,
            names.affected,
            names.after_op_value()
        )));
    }
    if request.after_op.is_some() && !request.affected {
        return Err(FrameProbeError::new(format!(
            "{} names the operation the recorded hand-off must end at, so it only means something with {}.",
            names.after_op, names.affected
        )));
    }

    Ok(())
}

/// Rejects arguments that only describe a timeline render, on a request that
/// reads a finished file.
///
/// A rendered file is read in its own timebase and holds frames that are
/// already composited: nothing here is ever re-rendered, so a mode is not a
/// choice the probe still has, and — outside a sampled range, which reads the
/// sequence the render came from — no sequence is opened for its pixels either.
/// clap refuses the pair for the command line; this is what refuses it for
/// every other surface, rather than accepting an argument nothing reads.
fn ensure_file_selectors_unused(request: &FrameProbeRequest) -> FrameProbeResult<()> {
    if request.file.is_none() {
        return Ok(());
    }

    let names = request.names;
    let present: Vec<&str> = [
        (request.sequence.is_some(), names.sequence),
        (request.mode.is_some(), names.mode),
    ]
    .into_iter()
    .filter_map(|(used, flag)| used.then_some(flag))
    .collect();

    if present.is_empty() {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "{} reads a rendered video, so it cannot be combined with {}",
        names.file,
        present.join(" or ")
    )))
}

fn resolve_selection(request: &FrameProbeRequest) -> FrameProbeResult<Selection> {
    let names = request.names;
    ensure_file_selectors_unused(request)?;
    ensure_range_sources_coherent(request)?;
    if let Some(ranges) = request.ranges.as_deref() {
        ensure_ranges_valid(ranges, names)?;
    }

    let spec = request.sampler_spec();
    if spec.is_active() {
        ensure_sampler_selectors_unused(request)?;
        ensure_grid_only_flags_unused(request)?;
        let grid = match request.grid.as_deref() {
            Some(raw) => Some(parse_grid_layout(raw, names)?),
            None => None,
        };
        return Ok(Selection::Sampled {
            spec: Box::new(spec),
            grid,
        });
    }

    let orphaned = spec.orphaned_modifiers();
    if !orphaned.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} only shapes a sampler. Add one of {}, or drop the argument.",
            orphaned.join(", "),
            names.sampler_flag_list()
        )));
    }

    ensure_grid_only_flags_unused(request)?;

    if let Some(grid) = &request.grid {
        return resolve_grid_selection(request, grid);
    }

    if let Some(asset_id) = &request.asset {
        if asset_id.trim().is_empty() {
            return Err(FrameProbeError::new(format!(
                "Invalid value for {}: cannot be empty",
                names.asset
            )));
        }
        let source_time = request.source_time.ok_or_else(|| {
            FrameProbeError::new(format!(
                "{} requires {}",
                names.asset,
                names.source_time_value()
            ))
        })?;
        ensure_time_non_negative(source_time, names.source_time)?;
        return Ok(Selection::AssetTime {
            asset_id: asset_id.clone(),
            source_time,
        });
    }

    if let Some(times) = &request.times {
        if times.is_empty() {
            return Err(FrameProbeError::new(format!(
                "{} requires at least one value",
                names.times
            )));
        }
        for time in times {
            ensure_time_non_negative(*time, names.times)?;
        }
        return Ok(Selection::BatchTimes(times.clone()));
    }

    if let Some(time) = request.time {
        ensure_time_non_negative(time, names.time)?;
        return Ok(Selection::SingleTime(time));
    }

    Err(FrameProbeError::new(format!(
        "Nothing to extract: pass a sampler ({}), or {}, {}, {}, or {} with {}",
        names.sampler_flag_list(),
        names.time,
        names.times,
        names.grid,
        names.asset,
        names.source_time
    )))
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
    /// Timeline range the rendered `file` was declared to cover.
    file_range: Option<TimeRange>,
}

impl FrameProbePlan {
    /// Validates `request`, rejecting anything the probe could not serve.
    ///
    /// Every guard the CLI relies on lives here rather than in its clap layer,
    /// because clap validates only the CLI's own callers.
    pub fn resolve(request: FrameProbeRequest) -> FrameProbeResult<Self> {
        let (selection, format, mode, file_range) = Self::check(&request)?;

        Ok(Self {
            request,
            selection,
            format,
            mode,
            file_range,
        })
    }

    /// Runs every guard [`resolve`](Self::resolve) runs, without consuming the
    /// request.
    ///
    /// For a caller that has to know a request is servable *before* it acquires
    /// something on the request's behalf. The GUI reserves a frame-cache entry
    /// for every extraction, and reserving one also prunes the cache — so
    /// allocating first meant a malformed request evicted a legitimate entry to
    /// make room for a directory nothing was ever written into.
    pub fn validate(request: &FrameProbeRequest) -> FrameProbeResult<()> {
        Self::check(request).map(|_| ())
    }

    /// The guards themselves, shared by [`resolve`](Self::resolve) and
    /// [`validate`](Self::validate) so the two can never disagree.
    fn check(
        request: &FrameProbeRequest,
    ) -> FrameProbeResult<(Selection, ImageFormat, TimelineMode, Option<TimeRange>)> {
        // Before the selection, so a malformed range is reported as itself
        // rather than as the sampler refusal it would otherwise trigger.
        let file_range = resolve_file_range(request)?;
        let selection = resolve_selection(request)?;
        let format = resolve_image_format(request.format.as_deref(), &request.out, request.names)?;
        let mode = TimelineMode::resolve(request.mode.as_deref(), request.names)?;
        ensure_cell_size_in_range(request)?;
        ensure_max_width_in_range(request)?;
        ensure_sheet_fits(request, &selection)?;

        Ok((selection, format, mode, file_range))
    }

    /// Whether serving this plan needs the project opened.
    ///
    /// A rendered file is normally self-contained, so the judging path skips the
    /// project: it costs an ops replay it has no use for, and it keeps sheeting
    /// a finished render independent of whatever the project is doing meanwhile.
    ///
    /// A sampled file is the exception. The times come from the timeline — cuts,
    /// captions, markers, changed ranges — and only their translation into the
    /// file's timebase comes from the declared range, so the sequence has to be
    /// read even though not one pixel comes from it.
    pub fn needs_project(&self) -> bool {
        self.request.file.is_none() || matches!(self.selection, Selection::Sampled { .. })
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
            if let Selection::Sampled { ref spec, grid } = self.selection {
                let range = self.file_range.clone().ok_or_else(|| {
                    FrameProbeError::new(format!(
                        "A sampler reads the timeline, and a rendered file has none.{}",
                        file_range_hint(self.request.names)
                    ))
                })?;
                let project = project.ok_or_else(|| {
                    FrameProbeError::new(
                        "Sampling a rendered file reads the timeline it was rendered from, so it needs an open project; none was supplied"
                            .to_string(),
                    )
                })?;
                let (outcome, warnings) =
                    run_samplers(project, &self.request, spec, Some(range.clone()))?;

                return file::run_file_sampled_mode(
                    runner,
                    &file,
                    &self.request,
                    self.format,
                    &range,
                    outcome,
                    grid,
                    warnings,
                )
                .await;
            }

            return file::run_file_mode(
                runner,
                &file,
                &self.request,
                self.format,
                &self.selection,
                self.file_range.as_ref(),
            )
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
                let (outcome, warnings) = run_samplers(project, &self.request, spec, None)?;
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
                    warnings: &warnings,
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
///
/// Returns the sampler outcome alongside any warnings the range resolution
/// raised — a hand-off record that turned out to describe somebody else's edit
/// is not a failure, but it is something the caller has to be told before it
/// judges the pictures as its own.
/// `restrict` bounds every sampler to one stretch of the timeline. It is what a
/// rendered file's declared range becomes: the samplers must not choose seconds
/// the file does not hold, or the judge would be handed a picture of the wrong
/// moment under the right label.
fn run_samplers(
    project: &FrameProbeProject<'_>,
    request: &FrameProbeRequest,
    spec: &SamplerSpec,
    restrict: Option<TimeRange>,
) -> FrameProbeResult<(SamplerOutcome, Vec<String>)> {
    let (sequence_id, sequence) =
        resolve_sequence(project, request.sequence.clone(), request.names)?;
    let (affected_ranges, warnings) = if spec.affected {
        resolve_affected_ranges(
            project,
            &sequence_id,
            request.after_op.as_deref(),
            request.names,
        )?
    } else {
        (Vec::new(), Vec::new())
    };

    let outcome = sampler::run(
        spec,
        &SamplerInputs {
            sequence,
            effects: &project.state.effects,
            affected_ranges: &affected_ranges,
            restrict,
        },
    )?;

    Ok((outcome, warnings))
}

/// Reads the ranges the last successful apply changed.
///
/// The hand-off file is written by every mutating verb, so its absence means no
/// edit has been applied to this project yet — which is a different problem
/// from an empty edit, and the message has to say which one the caller is
/// looking at.
///
/// A record whose last operation is not the project's current one is refused
/// rather than used. The file is a hand-off, not a history: an undo, a redo, or
/// an edit applied by a surface that does not record one leaves it describing a
/// state the project has left, and the sampler would then point confidently at
/// the wrong seconds — the one failure mode `--affected` exists to remove.
///
/// # Whose edit
///
/// The record is a single slot, and the app's own edit path writes it too. A
/// caller that applied an edit, and then had a person drag a clip in the app
/// before it looked, would find a record that passes every check above and
/// describes the *person's* edit. Two answers to that, in order of certainty:
///
/// - `after_op` names the operation the caller's own apply ended at. The record
///   must end there, so an edit that landed in between is a refusal naming both
///   operations rather than a confident picture of the wrong seconds.
/// - passing the ranges outright (`--range`, `ranges`) skips the record
///   entirely, which is what a caller that already holds them should do.
///
/// Without `after_op` the record is used as before, and a record the app's own
/// edit path wrote is reported as a warning on the payload: the pictures are of
/// a real edit, just not necessarily of the caller's.
fn resolve_affected_ranges(
    project: &FrameProbeProject<'_>,
    sequence_id: &str,
    after_op: Option<&str>,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<(Vec<crate::core::TimeRange>, Vec<String>)> {
    let Some(record) = load_last_affected_ranges(project.path) else {
        return Err(FrameProbeError::new(format!(
            "{} reads the ranges the last edit changed, and this project has none recorded. Apply an edit first — `command execute`, `plan execute`, the other editing verbs and the app's own edit commands all record where one landed — or pass {} with the ranges your edit reported, or {} to sweep the timeline instead.",
            names.affected,
            names.ranges_range(),
            names.between_range()
        )));
    };
    if record.sequence_id != sequence_id {
        return Err(FrameProbeError::new(format!(
            "The last recorded edit changed sequence '{}', not '{}'. Extract from that sequence with {}, apply an edit to this one first, or pass {}.",
            record.sequence_id,
            sequence_id,
            names.sequence_value(&record.sequence_id),
            names.between_range()
        )));
    }
    let record_op = record.op_ids.last().map(String::as_str);
    if record_op != project.state.last_op_id.as_deref() {
        return Err(FrameProbeError::new(format!(
            "The recorded hand-off ends at operation {}, but this project is at {}, so the last edit was not recorded — an undo or a redo leaves it describing a state the project has left. Re-apply the edit, or pass {}.",
            describe_op_id(record_op),
            describe_op_id(project.state.last_op_id.as_deref()),
            names.between_range()
        )));
    }
    if let Some(expected) = after_op {
        if record_op != Some(expected) {
            return Err(FrameProbeError::new(format!(
                "The recorded hand-off ends at operation {}, but {} expected '{expected}'. Another edit was applied after yours — the record is a single slot every surface overwrites — so these ranges are not the ones you asked about. Pass {} with the ranges your own edit reported, or re-apply and look again.",
                describe_op_id(record_op),
                names.after_op,
                names.ranges_range()
            )));
        }
    }
    if record.affected_ranges.is_empty() {
        return Err(FrameProbeError::new(format!(
            "The last recorded edit on sequence '{}' moved nothing on the timeline, so {} has nothing to look at. Pass {}, or a sampler such as {}.",
            sequence_id,
            names.affected,
            names.between_range(),
            names.at_cuts
        )));
    }

    let mut warnings = Vec::new();
    if after_op.is_none() && record.source == RecordSource::Gui {
        warnings.push(format!(
            "These ranges were recorded by the app's own edit path — an interactive edit in the timeline, at operation {} — not by an apply this caller made. Pass afterOp with the operation your edit ended at to have that checked, or pass the ranges outright.",
            describe_op_id(record_op),
        ));
    }

    Ok((record.affected_ranges, warnings))
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
    let names = request.names;
    let (columns, rows) = match layout {
        GridLayout::Auto => auto_grid(count, names)?,
        GridLayout::Fixed { columns, rows } => {
            let capacity = columns.checked_mul(rows).ok_or_else(|| {
                FrameProbeError::new(format!(
                    "Invalid value for {}: {}x{} is too large",
                    names.grid, columns, rows
                ))
            })?;
            if capacity > MAX_GRID_CELLS {
                return Err(FrameProbeError::new(format!(
                    "Invalid value for {}: {}x{} needs {} cells, more than the maximum of {}",
                    names.grid, columns, rows, capacity, MAX_GRID_CELLS
                )));
            }
            if count > capacity {
                return Err(FrameProbeError::new(format!(
                    "The samplers selected {} times, more than the {}x{} grid holds ({}). Add {}, or ask for a bigger grid.",
                    count,
                    columns,
                    rows,
                    capacity,
                    names.limit_value(capacity)
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
    let names = request.names;
    for (label, value) in [
        (names.cell_width, request.cell_width),
        (names.cell_height, request.cell_height),
    ] {
        let Some(value) = value else {
            continue;
        };
        if !(MIN_CELL_SIZE_PX..=MAX_CELL_SIZE_PX).contains(&value) {
            return Err(FrameProbeError::new(format!(
                "Invalid value for {}: {} is outside the supported range of {}-{}",
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
            "Invalid value for {}: {} is outside the supported range of {}-{}",
            request.names.max_width, max_width, MIN_STILL_WIDTH_PX, MAX_STILL_WIDTH_PX
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
    match selection {
        Selection::Grid { columns, rows, .. } => ensure_sheet_dimensions_in_range(
            *columns,
            *rows,
            request.cell_width,
            request.cell_height,
        ),
        // A sampler's row count is only known once the sequence has been read,
        // and `resolve_sampled_grid` measures the finished sheet there. The
        // column count is stated here, though, so the width is already decided
        // — and a sheet too wide to build is worth refusing before a project is
        // opened rather than after every cell has been extracted.
        Selection::Sampled {
            grid: Some(GridLayout::Fixed { columns, .. }),
            ..
        } => ensure_sheet_width_in_range(*columns, request.cell_width, request.cell_height),
        _ => Ok(()),
    }
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
/// time would be a lie the judge could act on. When the caller declared the
/// range the file covers, the timeline second the picture came from is carried
/// alongside it as `timelineSec` — both are true, and each answers a different
/// question ("where in this file" versus "where in the edit").
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileFrameEntry {
    pub index: usize,
    pub file_sec: f64,
    /// Timeline second this file time was translated from.
    ///
    /// Absent unless a declared `file_range` made the translation possible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_sec: Option<f64>,
    /// Why a sampler chose this time; absent when the caller named it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SampleReason>,
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
    /// Timeline second this cell's file time was translated from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_sec: Option<f64>,
    /// Why a sampler chose this cell's time; absent when the caller named it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SampleReason>,
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
fn ensure_times_inside_sequence(
    sequence: &Sequence,
    times: &[f64],
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<()> {
    let duration_sec = sequence_duration_sec(sequence);
    if duration_sec <= 0.0 {
        return Err(FrameProbeError::new(format!(
            "Sequence '{}' is empty, so there is no frame to extract",
            sequence.name
        )));
    }

    if let Some(out_of_range) = times.iter().find(|time| **time >= duration_sec) {
        return Err(FrameProbeError::new(format!(
            "Requested time {:.3}s is at or past the end of sequence '{}' ({:.3}s). Ask for a time inside the sequence, or narrow {} to the edited range.",
            out_of_range,
            sequence.name,
            duration_sec,
            names.between
        )));
    }

    Ok(())
}

/// Resolves the target sequence, defaulting to the project's active sequence.
fn resolve_sequence<'a>(
    project: &'a FrameProbeProject<'_>,
    sequence: Option<String>,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<(String, &'a Sequence)> {
    let sequence_id = sequence
        .or_else(|| project.state.active_sequence_id.clone())
        .ok_or_else(|| {
            FrameProbeError::new(format!(
                "No sequence specified and no active sequence set; name one with {}",
                names.sequence
            ))
        })?;
    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| FrameProbeError::new(format!("Sequence '{}' not found", sequence_id)))?;

    Ok((sequence_id, sequence))
}

/// Parses a caller-stated output image format.
///
/// Public so every surface — clap, MCP JSON, the in-app IPC bridge — accepts
/// the same spellings and refuses the rest in the same words.
pub fn parse_image_format(
    raw: &str,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<ImageFormat> {
    match raw.trim().to_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        other => Err(FrameProbeError::new(format!(
            "Invalid value for {}: expected 'png' or 'jpeg' (got '{}')",
            names.format, other
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
fn resolve_image_format(
    explicit: Option<&str>,
    out: &Path,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<ImageFormat> {
    let from_path = image_format_from_path(out);

    let Some(raw) = explicit else {
        return Ok(from_path.unwrap_or(ImageFormat::Png));
    };

    let requested = parse_image_format(raw, names)?;
    if let Some(path_format) = from_path {
        if path_format != requested {
            return Err(FrameProbeError::new(format!(
                "Conflicting output format: {} {} does not match the '.{}' extension of the output path '{}'. Drop {} to follow the extension, or write to a .{} file.",
                names.format,
                raw.trim(),
                out.extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_default(),
                out.display(),
                names.format,
                requested.extension()
            )));
        }
    }

    Ok(requested)
}

/// Parses a `COLSxROWS` grid specification, refusing in the CLI's vocabulary.
///
/// Kept for callers that have no surface to speak for; use
/// [`parse_grid_spec_named`] wherever the caller's own spelling is known.
pub fn parse_grid_spec(raw: &str) -> FrameProbeResult<(usize, usize)> {
    parse_grid_spec_named(raw, CLI_ARGUMENT_NAMES)
}

/// Parses a `COLSxROWS` grid specification in one surface's vocabulary.
pub fn parse_grid_spec_named(
    raw: &str,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<(usize, usize)> {
    let normalized = raw.trim().to_lowercase();
    let (columns, rows) = normalized.split_once('x').ok_or_else(|| {
        FrameProbeError::new(format!(
            "Invalid value for {}: expected COLSxROWS (e.g. 3x2)",
            names.grid
        ))
    })?;

    let parse_part = |value: &str, name: &str| -> FrameProbeResult<usize> {
        let parsed: usize = value.trim().parse().map_err(|_| {
            FrameProbeError::new(format!(
                "Invalid value for {}: {} must be a positive integer (got '{}')",
                names.grid, name, value
            ))
        })?;
        if parsed == 0 {
            return Err(FrameProbeError::new(format!(
                "Invalid value for {}: {} must be >= 1",
                names.grid, name
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

    /// The CLI vocabulary, which most of these tests read their refusals in.
    fn names() -> &'static FrameProbeArgumentNames {
        CLI_ARGUMENT_NAMES
    }

    /// An empty request that refuses in long flags.
    ///
    /// The engine's own default is the JSON vocabulary, because two of the
    /// three surfaces speak it; these tests assert the command line's, so they
    /// say so rather than relying on which default happens to be in force.
    fn cli_request() -> FrameProbeRequest {
        FrameProbeRequest {
            names: names(),
            ..FrameProbeRequest::default()
        }
    }

    fn grid_request(grid: &str, count: Option<usize>) -> FrameProbeRequest {
        FrameProbeRequest {
            out: PathBuf::from("sheet.jpg"),
            grid: Some(grid.to_string()),
            between: Some(vec![0.0, 4.0]),
            count,
            ..cli_request()
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

    /// A project sitting at `last_op_id`, with one sequence to measure against.
    fn project_at_op(last_op_id: &str) -> (ProjectState, String) {
        let mut state = ProjectState::new("Hand-off");
        let sequence_id = state
            .sequences
            .keys()
            .next()
            .cloned()
            .expect("a new project has a sequence");
        state.last_op_id = Some(last_op_id.to_string());
        (state, sequence_id)
    }

    /// The race the hand-off record cannot resolve on its own.
    ///
    /// An agent applies a plan (`op-a`), a person drags a clip in the app
    /// (`op-b`, overwriting the single-slot record), and the agent then asks for
    /// "the last edit". Every check the record supports passes — the sequence
    /// matches and the record ends at the project's current operation — so the
    /// ranges come back, and they are the *person's*. This is exactly why
    /// `--after-op` and `--range` exist, and both are asserted here.
    #[test]
    fn resolve_affected_ranges_should_flag_and_refuse_another_surfaces_edit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (state, sequence_id) = project_at_op("op-b");

        // The agent's own apply recorded op-a; the interactive edit that landed
        // afterwards overwrote it.
        crate::core::commands::record_affected_ranges(
            dir.path(),
            &sequence_id,
            vec!["op-b".to_string()],
            &[TimeRange::new(12.0, 14.0)],
            RecordSource::Gui,
        )
        .expect("the hand-off is written");

        let project = FrameProbeProject {
            path: dir.path(),
            state: &state,
        };

        // Without `after_op` the ranges are served — they are a real edit — but
        // the caller is told whose.
        let (ranges, warnings) = resolve_affected_ranges(&project, &sequence_id, None, names())
            .expect("the record passes every check it supports");
        assert_eq!(ranges, vec![TimeRange::new(12.0, 14.0)]);
        assert_eq!(
            warnings.len(),
            1,
            "the caller must be told, got {warnings:?}"
        );
        assert!(
            warnings[0].contains("interactive edit") && warnings[0].contains("op-b"),
            "the warning should say whose edit and which operation, got: {}",
            warnings[0]
        );

        // With it, the mismatch is a refusal that names both operations.
        let message = resolve_affected_ranges(&project, &sequence_id, Some("op-a"), names())
            .expect_err("these are not the ranges the caller asked about")
            .to_string();
        assert!(
            message.contains("'op-b'") && message.contains("'op-a'"),
            "the refusal should name the recorded and the expected operation, got: {message}"
        );
    }

    #[test]
    fn resolve_affected_ranges_should_accept_the_callers_own_operation_silently() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (state, sequence_id) = project_at_op("op-a");

        crate::core::commands::record_affected_ranges(
            dir.path(),
            &sequence_id,
            vec!["op-a".to_string()],
            &[TimeRange::new(1.0, 2.0)],
            RecordSource::AgentPlan,
        )
        .expect("the hand-off is written");

        let project = FrameProbeProject {
            path: dir.path(),
            state: &state,
        };

        let (ranges, warnings) =
            resolve_affected_ranges(&project, &sequence_id, Some("op-a"), names())
                .expect("the record is the caller's own apply");
        assert_eq!(ranges, vec![TimeRange::new(1.0, 2.0)]);
        assert!(
            warnings.is_empty(),
            "an agent's own apply needs no warning, got {warnings:?}"
        );
    }

    #[test]
    fn resolve_selection_should_carry_named_ranges_through_as_a_sampler() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.ranges = Some(vec![TimeRange::new(1.0, 2.0), TimeRange::new(5.0, 5.0)]);

        let Selection::Sampled { spec, .. } =
            resolve_selection(&request).expect("named ranges resolve without a project")
        else {
            panic!("Expected a deferred sampler selection");
        };
        assert_eq!(spec.kinds(), vec!["ranges".to_string()]);
        assert!(
            !spec.affected,
            "named ranges must not read the hand-off record"
        );
    }

    #[test]
    fn resolve_selection_should_reject_named_ranges_alongside_the_recorded_ones() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.ranges = Some(vec![TimeRange::new(1.0, 2.0)]);
        request.affected = true;

        let message = resolve_selection(&request)
            .expect_err("two authorities on the same question cannot both be honoured")
            .to_string();

        assert!(
            message.contains("--range") && message.contains("--affected"),
            "Error should name both sources, got: {message}"
        );
    }

    /// Spellings that exist only in the JSON vocabulary.
    ///
    /// A command-line user cannot type any of these, so a refusal reaching one
    /// must not contain them — just as a JSON caller cannot type a long flag,
    /// which is what the `--` check covers from the other side.
    const JSON_ONLY_LABELS: [&str; 13] = [
        "cellWidth",
        "cellHeight",
        "labelCells",
        "maxWidth",
        "atCuts",
        "atTransitions",
        "atCaptions",
        "atMarkers",
        "perShot",
        "aroundCount",
        "afterOp",
        "fileRange",
        "sourceTime",
    ];

    /// Every refusal a caller can reach before the project is opened, driven
    /// through both vocabularies.
    ///
    /// The wording is not what is under test — the *vocabulary* is. Every one of
    /// these messages tells the caller which argument to add, drop or correct,
    /// and a message that names an argument the caller's surface does not have
    /// is a message it cannot act on. The MCP server and the in-app bridge both
    /// reach these same guards, and both used to be told to pass `--grid`.
    #[test]
    fn every_refusal_should_speak_the_calling_surfaces_vocabulary() {
        type Malform = fn(&mut FrameProbeRequest);
        let cases: [(&str, Malform); 12] = [
            ("nothing to extract", |_request| {}),
            ("sheet flags without a grid", |request| {
                request.between = Some(vec![0.0, 4.0]);
            }),
            ("a sampler beside a listed time", |request| {
                request.at_cuts = true;
                request.times = Some(vec![1.0]);
            }),
            ("a sampler on a file with no range", |request| {
                request.at_cuts = true;
                request.file = Some(PathBuf::from("proxy.mp4"));
            }),
            ("an auto grid with nothing to size it", |request| {
                request.grid = Some("auto".to_string());
                request.between = Some(vec![0.0, 4.0]);
            }),
            ("two authorities on the same ranges", |request| {
                request.affected = true;
                request.ranges = Some(vec![TimeRange {
                    start_sec: 0.0,
                    end_sec: 1.0,
                }]);
            }),
            ("an operation id with no record to check", |request| {
                request.after_op = Some("op-a".to_string());
            }),
            ("a declared range with no file", |request| {
                request.file_range = Some(vec![0.0, 4.0]);
            }),
            ("a shaping argument with nothing to shape", |request| {
                request.span = Some(0.5);
            }),
            ("an unknown extraction mode", |request| {
                request.time = Some(1.0);
                request.mode = Some("turbo".to_string());
            }),
            ("an asset with no time inside it", |request| {
                request.asset = Some("asset-1".to_string());
            }),
            ("a mode on a rendered file", |request| {
                request.file = Some(PathBuf::from("proxy.mp4"));
                request.time = Some(1.0);
                request.mode = Some("fast".to_string());
            }),
        ];

        for (label, malform) in cases {
            let mut command_line = FrameProbeRequest {
                names: CLI_ARGUMENT_NAMES,
                ..FrameProbeRequest::default()
            };
            malform(&mut command_line);
            let message = FrameProbePlan::validate(&command_line)
                .expect_err(&format!("{label} must be refused"))
                .to_string();
            for json_only in JSON_ONLY_LABELS {
                assert!(
                    !message.contains(json_only),
                    "{label}: a command-line caller cannot type '{json_only}', got: {message}"
                );
            }

            let mut json = FrameProbeRequest {
                names: API_ARGUMENT_NAMES,
                ..FrameProbeRequest::default()
            };
            malform(&mut json);
            let message = FrameProbePlan::validate(&json)
                .expect_err(&format!("{label} must be refused"))
                .to_string();
            assert!(
                !message.contains("--"),
                "{label}: a JSON caller has no flags to pass, got: {message}"
            );
        }
    }

    #[test]
    fn resolve_selection_should_reject_a_malformed_range() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;

        request.ranges = Some(Vec::new());
        assert!(
            resolve_selection(&request).is_err(),
            "an empty list names no seconds to look at"
        );

        // Built field by field rather than through `TimeRange::new`, which
        // silently swaps a reversed pair: the caller has to be told instead.
        request.ranges = Some(vec![TimeRange {
            start_sec: 5.0,
            end_sec: 2.0,
        }]);
        let message = resolve_selection(&request)
            .expect_err("a reversed range is a caller mistake, not a picture")
            .to_string();
        assert!(
            message.contains("--range START") && message.contains("--range END"),
            "Error should name the offending values, got: {message}"
        );

        request.ranges = Some(vec![TimeRange {
            start_sec: -1.0,
            end_sec: 2.0,
        }]);
        assert!(resolve_selection(&request).is_err());
    }

    #[test]
    fn resolve_selection_should_reject_after_op_without_the_record_it_checks() {
        let mut request = grid_request("3x2", None);
        request.grid = None;
        request.between = None;
        request.at_cuts = true;
        request.after_op = Some("op-1".to_string());

        let message = resolve_selection(&request)
            .expect_err("there is no record to check against without --affected")
            .to_string();

        assert!(
            message.contains("--after-op") && message.contains("--affected"),
            "Error should name the flag it needs, got: {message}"
        );
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
            ..cli_request()
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
        assert_eq!(
            parse_grid_layout(" Auto ", names()).unwrap(),
            GridLayout::Auto
        );
        assert_eq!(
            parse_grid_layout("4x3", names()).unwrap(),
            GridLayout::Fixed {
                columns: 4,
                rows: 3
            }
        );
        assert!(parse_grid_layout("automatic", names()).is_err());
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
            TimelineMode::resolve(None, names()).expect("an absent mode resolves"),
            TimelineMode::Composite,
            "The default has to be what export produces, captions and text included"
        );
        assert_eq!(
            TimelineMode::resolve(Some("fast"), names()).expect("an explicit mode resolves"),
            TimelineMode::Fast,
            "fast stays available, but only by name"
        );
    }

    #[test]
    fn timeline_mode_should_parse_known_values() {
        assert!(TimelineMode::parse("fast", names()).is_ok());
        assert!(TimelineMode::parse("COMPOSITE", names()).is_ok());
        assert!(TimelineMode::parse("turbo", names()).is_err());
    }

    #[test]
    fn parse_image_format_should_accept_png_and_jpeg_aliases() {
        assert_eq!(
            parse_image_format("png", names()).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            parse_image_format("JPG", names()).unwrap(),
            ImageFormat::Jpeg
        );
        assert!(parse_image_format("gif", names()).is_err());
    }

    #[test]
    fn resolve_image_format_should_follow_the_out_extension_when_format_is_omitted() {
        assert_eq!(
            resolve_image_format(None, Path::new("sheet.jpg"), names()).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(None, Path::new("a/b/sheet.JPEG"), names()).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame.png"), names()).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_image_format_should_default_to_png_without_a_recognised_extension() {
        assert_eq!(
            resolve_image_format(None, Path::new("./stills/"), names()).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame"), names()).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            resolve_image_format(None, Path::new("frame.bin"), names()).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_image_format_should_apply_explicit_format_when_the_path_names_none() {
        assert_eq!(
            resolve_image_format(Some("jpeg"), Path::new("./stills/"), names()).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(Some("jpeg"), Path::new("frame"), names()).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn resolve_image_format_should_reject_a_format_that_contradicts_the_out_extension() {
        let error = resolve_image_format(Some("jpeg"), Path::new("frame.png"), names())
            .expect_err("Conflicting format and extension must be rejected");

        let message = error.to_string();
        assert!(
            message.contains("--format") && message.contains("frame.png"),
            "Error should name both sides of the conflict, got: {message}"
        );
        assert!(resolve_image_format(Some("png"), Path::new("sheet.jpg"), names()).is_err());
    }

    #[test]
    fn resolve_image_format_should_accept_a_format_that_agrees_with_the_out_extension() {
        assert_eq!(
            resolve_image_format(Some("jpg"), Path::new("sheet.jpeg"), names()).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            resolve_image_format(Some("png"), Path::new("frame.PNG"), names()).unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn resolve_single_output_path_should_keep_a_jpg_path_when_format_follows_the_extension() {
        let format = resolve_image_format(None, Path::new("sheet.jpg"), names()).unwrap();

        assert_eq!(
            resolve_single_output_path(Path::new("sheet.jpg"), 0.0, format).unwrap(),
            PathBuf::from("sheet.jpg")
        );
    }

    /// A request that judges a rendered proxy of a range with `--at-cuts`.
    fn sampled_file_request(file_range: Option<Vec<f64>>) -> FrameProbeRequest {
        FrameProbeRequest {
            out: PathBuf::from("cuts.jpg"),
            file: Some(PathBuf::from("proxy.mp4")),
            file_range,
            at_cuts: true,
            grid: Some("auto".to_string()),
            ..cli_request()
        }
    }

    #[test]
    fn resolve_selection_should_refuse_a_sampler_on_a_file_with_no_declared_range() {
        let error = resolve_selection(&sampled_file_request(None))
            .expect_err("a rendered file alone has no timeline to sample");

        let message = error.to_string();
        assert!(
            message.contains("--file"),
            "the refusal must name the flag it is about: {message}"
        );
        assert!(
            message.contains("--file-range"),
            "the refusal must name the flag that lifts it: {message}"
        );
    }

    #[test]
    fn resolve_selection_should_sample_a_file_that_declares_its_range() {
        let selection = resolve_selection(&sampled_file_request(Some(vec![2.0, 6.0])))
            .expect("a declared range makes the render samplable");

        let Selection::Sampled { spec, grid } = selection else {
            panic!("Expected a sampled selection");
        };
        assert!(spec.at_cuts);
        assert_eq!(grid, Some(GridLayout::Auto));
    }

    #[test]
    fn resolve_file_range_should_reject_a_range_no_file_was_named_for() {
        let request = FrameProbeRequest {
            out: PathBuf::from("frame.png"),
            time: Some(1.0),
            file_range: Some(vec![2.0, 6.0]),
            ..cli_request()
        };

        let error = resolve_file_range(&request).expect_err("a range without a file means nothing");
        assert!(error.to_string().contains("--file"), "{error}");
    }

    #[test]
    fn resolve_file_range_should_reject_a_malformed_range() {
        for values in [
            vec![6.0, 2.0],
            vec![2.0, 2.0],
            vec![-1.0, 6.0],
            vec![f64::NAN, 6.0],
            vec![2.0, f64::INFINITY],
            vec![2.0],
            vec![2.0, 4.0, 6.0],
        ] {
            let mut request = sampled_file_request(Some(values.clone()));
            request.at_cuts = false;
            request.grid = None;
            request.time = Some(1.0);

            assert!(
                resolve_file_range(&request).is_err(),
                "{values:?} is not a usable range"
            );
        }
    }

    #[test]
    fn resolve_file_range_should_accept_a_declared_range_without_a_sampler() {
        // Harmless and useful: `--times` stays file-relative, and the payload
        // still records which seconds of the edit the file holds.
        let mut request = sampled_file_request(Some(vec![2.0, 6.0]));
        request.at_cuts = false;
        request.grid = None;
        request.times = Some(vec![0.5, 1.5]);

        assert_eq!(
            resolve_file_range(&request).expect("a declared range needs no sampler"),
            Some(TimeRange {
                start_sec: 2.0,
                end_sec: 6.0,
            })
        );
        assert!(matches!(
            resolve_selection(&request).expect("a file-relative batch is unaffected"),
            Selection::BatchTimes(_)
        ));
    }

    #[test]
    fn needs_project_should_be_true_only_for_a_sampled_file() {
        let sampled = FrameProbePlan::resolve(sampled_file_request(Some(vec![2.0, 6.0])))
            .expect("a declared range makes the render samplable");
        assert!(
            sampled.needs_project(),
            "the times come from the timeline even though the pixels do not"
        );

        let mut listed = sampled_file_request(Some(vec![2.0, 6.0]));
        listed.at_cuts = false;
        listed.grid = None;
        listed.times = Some(vec![0.5, 1.5]);
        listed.out = PathBuf::from("stills");
        let listed = FrameProbePlan::resolve(listed).expect("a file-relative batch resolves");
        assert!(!listed.needs_project());
    }
}
