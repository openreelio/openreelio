//! Contact-sheet assembly for the frame probe.
//!
//! A contact sheet is the cheapest way to judge pacing and continuity: one
//! image showing many timecodes, with a `cells[]` mapping that takes any cell
//! back to the moment it came from. This module owns the cell geometry, the
//! staging directories the cells pass through, the optional burnt-in labels,
//! and the tiling itself.

use super::{FrameProbeArgumentNames, FrameProbeError, FrameProbeRequest, FrameProbeResult};
use crate::core::analysis::types::ContactSheetArtifact;
use crate::core::analysis::visual::{ContactSheetCellSize, VisualAnalyzer};
use crate::core::effects::{Effect, EffectType, IntoFFmpegFilter, ParamValue};
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::render::ImageFormat;
use std::path::{Path, PathBuf};

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

/// Rejects contact-sheet geometry whose finished image exceeds
/// [`MAX_SHEET_DIMENSION_PX`] on either edge.
///
/// Shared with every surface so all of them reject the same geometry, in the
/// same terms, before anything is extracted.
pub fn ensure_sheet_dimensions_in_range(
    columns: usize,
    rows: usize,
    cell_width: Option<u32>,
    cell_height: Option<u32>,
) -> FrameProbeResult<()> {
    let cell = cell_size(cell_width, cell_height);
    let limit = MAX_SHEET_DIMENSION_PX as usize;

    for (edge, count, size) in [
        ("width", columns, cell.width),
        ("height", rows, cell.height),
    ] {
        let total = count.saturating_mul(size);
        if total > limit {
            return Err(FrameProbeError::new(format!(
                "Contact sheet {} of {}px ({} cells of {}px) exceeds the maximum of {}px; \
                 ask for fewer cells or a smaller cell size",
                edge, total, count, size, MAX_SHEET_DIMENSION_PX
            )));
        }
    }

    Ok(())
}

/// Rejects a contact sheet whose finished *width* exceeds the cap.
///
/// The half of the geometry a sampled sheet already knows. How many rows a
/// sampler fills is not knowable until the sequence has been read, but the
/// column count is stated outright, so an 8-wide sheet of 1024px cells is a
/// 8192px image whatever the samplers find — and refusing it up front costs
/// nothing, while discovering it after sampling costs a full extraction.
pub fn ensure_sheet_width_in_range(
    columns: usize,
    cell_width: Option<u32>,
    cell_height: Option<u32>,
) -> FrameProbeResult<()> {
    // The row count is the one dimension that cannot grow the width, so a
    // single row measures exactly the edge under test.
    ensure_sheet_dimensions_in_range(columns, 1, cell_width, cell_height)
}

/// Resolves the contact-sheet cell geometry from the request.
///
/// One dimension on its own derives the other from the default cell's 16:9
/// aspect, because a cell is filled with `force_original_aspect_ratio=decrease`:
/// a 640x180 cell shows the same 320x180 picture the default does, between
/// black bars, at twice the pixel cost. Passing both keeps exactly what was
/// asked for, including a deliberately non-16:9 cell.
pub(super) fn resolve_cell_size(request: &FrameProbeRequest) -> ContactSheetCellSize {
    cell_size(request.cell_width, request.cell_height)
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
/// which is what made a larger maximum width wasted work on grids. The cell
/// width is therefore the default, and it is never *below* the cell either, so
/// a large cell width gets a correspondingly detailed source instead of an
/// upscale. An explicit maximum width remains available for callers who want to
/// oversample (portrait cells fit by height, so a wider source keeps more
/// vertical detail).
pub(super) fn grid_cell_extract_width(
    request: &FrameProbeRequest,
    cell: ContactSheetCellSize,
) -> u32 {
    request.max_width.unwrap_or(cell.width as u32)
}

/// Staging directories the contact-sheet cells pass through.
///
/// FFmpeg reads the cells back as a zero-based `%d.jpg` image sequence, so the
/// finished cells must share one directory and one naming scheme. Labelling
/// needs a second copy because FFmpeg cannot write over its own input, so the
/// raw extraction lands in `raw_dir` and the labelled result in `sheet_dir`.
pub(super) struct CellStaging {
    sheet_dir: tempfile::TempDir,
    raw_dir: Option<tempfile::TempDir>,
    cell: ContactSheetCellSize,
    /// How the calling surface spells the labelling switch.
    ///
    /// A sheet whose labels cannot be drawn is worth retrying without them, and
    /// the caller can only act on that if it is told to drop the argument *it*
    /// passed: `--label-cells` on the command line, `labelCells` in JSON.
    names: &'static FrameProbeArgumentNames,
}

impl CellStaging {
    pub(super) fn new(
        cell: ContactSheetCellSize,
        label_cells: bool,
        names: &'static FrameProbeArgumentNames,
    ) -> FrameProbeResult<Self> {
        let sheet_dir = tempfile::tempdir().map_err(|error| {
            FrameProbeError::new(format!(
                "Failed to create temporary cell directory: {error}"
            ))
        })?;
        let raw_dir = if label_cells {
            Some(tempfile::tempdir().map_err(|error| {
                FrameProbeError::new(format!(
                    "Failed to create temporary cell directory: {error}"
                ))
            })?)
        } else {
            None
        };

        Ok(Self {
            sheet_dir,
            raw_dir,
            cell,
            names,
        })
    }

    /// Path the frame extractor writes the untouched cell to.
    pub(super) fn extract_path(&self, index: usize) -> PathBuf {
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
    ///
    /// `time_sec` is the time the cell was extracted at, which is what a missing
    /// cell is reported against. `label_sec` is the time *written into the
    /// picture*, and the two differ on a sheet built from a rendered file: the
    /// extraction is file-relative, while the number a judge has to quote is the
    /// timeline second the frame belongs to. `timebase` says which of the two
    /// `label_sec` is, and is burnt in beside it.
    pub(super) async fn finish(
        &self,
        runner: &FFmpegRunner,
        index: usize,
        time_sec: f64,
        label_sec: f64,
        timebase: LabelTimebase,
    ) -> FrameProbeResult<PathBuf> {
        ensure_cell_written(&self.extract_path(index), index, time_sec)?;

        let sheet_path = self.sheet_path(index);
        if self.raw_dir.is_none() {
            return Ok(sheet_path);
        }

        let filter = build_cell_label_filter(index, label_sec, timebase, self.cell);
        runner
            .filter_image(&self.extract_path(index), &sheet_path, &filter, None)
            .await
            .map_err(|error| {
                FrameProbeError::new(format!(
                    "Failed to label contact sheet cell {}: {}. Cell labels need an FFmpeg build with the drawtext filter; drop {} to build the sheet without them.",
                    index,
                    error,
                    self.names.label_cells
                ))
            })?;
        ensure_cell_written(&sheet_path, index, time_sec)?;

        Ok(sheet_path)
    }
}

/// Rejects a contact-sheet cell that was never written.
fn ensure_cell_written(cell_path: &Path, index: usize, time_sec: f64) -> FrameProbeResult<()> {
    let written = std::fs::metadata(cell_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if written {
        return Ok(());
    }

    Err(FrameProbeError::new(format!(
        "No frame was produced for contact sheet cell {} at {:.3}s, so the sheet would show a black cell the JSON claims a timecode for. Narrow the sampled range to where the picture actually is.",
        index,
        time_sec
    )))
}

/// Which clock a burnt-in cell label is quoting.
///
/// A sheet built from a rendered file can be labelled in either: the file's own
/// offsets, or the timeline seconds those offsets translate back to. The two
/// differ by wherever the render started, so a judge quoting a number off the
/// picture has to be able to see which clock it belongs to — hence the marker
/// in the label itself rather than only in the JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LabelTimebase {
    /// Seconds of the sequence.
    Timeline,
    /// Seconds into the rendered file.
    File,
}

impl LabelTimebase {
    /// The suffix written after the timecode. Kept to one short word: the label
    /// shares a 320px cell with the picture it annotates.
    fn marker(self) -> &'static str {
        match self {
            Self::Timeline => "tl",
            Self::File => "file",
        }
    }
}

/// Text burnt into a labelled contact-sheet cell.
fn cell_label_text(index: usize, time_sec: f64, timebase: LabelTimebase) -> String {
    format!(
        "{} | {:.2}s {}",
        index,
        time_sec.max(0.0),
        timebase.marker()
    )
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
fn build_cell_label_filter(
    index: usize,
    time_sec: f64,
    timebase: LabelTimebase,
    cell: ContactSheetCellSize,
) -> String {
    let font_size = cell_label_font_size(cell.height);
    // Keep the contrast box clear of the frame edge: its border grows outward
    // from the text by the padding, so the margin has to cover it.
    let margin = (font_size * 0.5)
        .round()
        .max(CELL_LABEL_BOX_PADDING_PX as f64 + 2.0);

    let mut label = Effect::new(EffectType::TextOverlay);
    label.set_param(
        "text",
        ParamValue::String(cell_label_text(index, time_sec, timebase)),
    );
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

/// Tiles already extracted cells into the contact sheet at the output path.
pub(super) async fn build_contact_sheet(
    runner: &FFmpegRunner,
    out: &Path,
    format: &ImageFormat,
    cell_paths: &[PathBuf],
    columns: usize,
    rows: usize,
    cell: ContactSheetCellSize,
) -> FrameProbeResult<ContactSheetArtifact> {
    let sheet_path = super::normalize_extension(out.to_path_buf(), format);
    let analyzer = VisualAnalyzer::new(runner.info().ffmpeg_path.clone());
    analyzer
        .generate_contact_sheet_with_options(cell_paths, &sheet_path, Some((columns, rows)), cell)
        .await
        .map_err(|error| {
            FrameProbeError::new(format!("Contact sheet generation failed: {}", error))
        })?
        .ok_or_else(|| {
            FrameProbeError::new("Contact sheet generation produced no output".to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_request() -> FrameProbeRequest {
        FrameProbeRequest {
            out: PathBuf::from("sheet.jpg"),
            grid: Some("3x2".to_string()),
            between: Some(vec![0.0, 4.0]),
            ..FrameProbeRequest::default()
        }
    }

    #[test]
    fn cell_label_text_should_pair_the_index_with_a_timecode_and_its_timebase() {
        // Without the marker a judge reading "12.50s" off a sheet of a rendered
        // file cannot tell whether that is a second of the edit or an offset
        // into the draft, and the two differ by wherever the render started.
        assert_eq!(
            cell_label_text(3, 12.5, LabelTimebase::Timeline),
            "3 | 12.50s tl"
        );
        assert_eq!(
            cell_label_text(3, 12.5, LabelTimebase::File),
            "3 | 12.50s file"
        );
        assert_eq!(
            cell_label_text(0, 0.0, LabelTimebase::Timeline),
            "0 | 0.00s tl"
        );
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
        let filter = build_cell_label_filter(
            3,
            12.5,
            LabelTimebase::Timeline,
            ContactSheetCellSize::default(),
        );

        assert!(
            filter.starts_with(
                "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black,drawtext="
            ),
            "The cell must be fitted before the label is drawn, got: {filter}"
        );
        assert!(
            filter.contains("text='3 | 12.50s tl'"),
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
        let filter =
            build_cell_label_filter(0, 1.0, LabelTimebase::File, ContactSheetCellSize::default());

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
        let cell = resolve_cell_size(&grid_request());

        assert_eq!(cell, ContactSheetCellSize::default());
    }

    #[test]
    fn resolve_cell_size_should_derive_the_missing_dimension_from_the_default_aspect() {
        // A cell is filled with force_original_aspect_ratio=decrease, so a
        // 640x180 cell would still show a 320x180 picture between black bars.
        let mut wide = grid_request();
        wide.cell_width = Some(640);
        assert_eq!(
            resolve_cell_size(&wide),
            ContactSheetCellSize::new(640, 360)
        );

        let mut tall = grid_request();
        tall.cell_height = Some(360);
        assert_eq!(
            resolve_cell_size(&tall),
            ContactSheetCellSize::new(640, 360)
        );
    }

    #[test]
    fn resolve_cell_size_should_keep_both_dimensions_when_both_are_given() {
        let mut request = grid_request();
        request.cell_width = Some(640);
        request.cell_height = Some(180);

        assert_eq!(
            resolve_cell_size(&request),
            ContactSheetCellSize::new(640, 180)
        );
    }

    #[test]
    fn resolve_cell_size_should_keep_a_derived_dimension_inside_the_accepted_range() {
        let mut widest = grid_request();
        widest.cell_height = Some(1024);
        assert_eq!(
            resolve_cell_size(&widest).width,
            MAX_CELL_SIZE_PX as usize,
            "A derived width must stay within the range FFmpeg is asked for"
        );

        let mut narrowest = grid_request();
        narrowest.cell_width = Some(64);
        assert_eq!(
            resolve_cell_size(&narrowest).height,
            MIN_CELL_SIZE_PX as usize
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
    fn grid_cell_extract_width_should_follow_the_cell_width_by_default() {
        let mut request = grid_request();
        request.cell_width = Some(640);

        assert_eq!(
            grid_cell_extract_width(&request, resolve_cell_size(&request)),
            640,
            "Grid cells should be extracted at the size the tiler needs"
        );
    }

    #[test]
    fn grid_cell_extract_width_should_honour_an_explicit_max_width() {
        let mut request = grid_request();
        request.max_width = Some(1920);

        assert_eq!(
            grid_cell_extract_width(&request, resolve_cell_size(&request)),
            1920
        );
    }
}
