//! Where libass actually put each emoji spacer, measured rather than modelled.
//!
//! The burn-in lays a caption out with a fixed-width transparent cell wherever
//! a colour emoji goes (see `append_ass_text_style_and_event`). Compositing the
//! colour picture then needs one number this process does not otherwise have:
//! the pixel rectangle that cell landed on. Text layout is libass's business -
//! shaping, kerning, bidi reordering, line breaking, the margins, the style's
//! `ScaleX`, the `\pos` the anchor wrote - and re-deriving it here would be a
//! second implementation of a renderer we already ship, wrong in a different
//! way on every caption.
//!
//! So the rectangle is measured. A second script, laid out identically by
//! construction, paints a solid box in each cell and nothing else; one FFmpeg
//! run reads the box back with the `bbox` filter.
//!
//! # Why the marker script cannot just be the real one
//!
//! `bbox` reports one rectangle for the whole frame - the bounding box of every
//! non-black pixel there is. A frame showing the caption *and* a marker returns
//! their union, which is the caption's box, not the emoji's. The marker script
//! therefore hides the text (`\1a&HFF&\3a&HFF&\4a&HFF&` on every event) and
//! paints exactly one cell, so the single rectangle `bbox` returns is the
//! answer to the question that was asked.
//!
//! That is also why one probe run cannot measure two emoji that are on screen
//! at the same instant: their two boxes would merge into one rectangle. The
//! occurrences are partitioned into batches of mutually non-overlapping cue
//! windows ([`plan_measurement_batches`]), and each batch is one script and one
//! FFmpeg run. Captions on a single track do not overlap, so the usual project
//! needs as many batches as the busiest cue has emoji - one, two, three.
//!
//! # Cost
//!
//! Zero when a project has no emoji: no occurrences means no script, no
//! subprocess, and no change to the graph. When there are emoji, the probe
//! source is `lavfi` colour rather than the real footage and `select` runs
//! *before* `subtitles`, so libass is only asked to lay out the handful of
//! frames actually being measured.

use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    path::Path,
    sync::{Mutex, OnceLock},
};

use super::export::{ExportEngine, ExportError};

/// How far inside a cue's end a frame time has to be to count as on the cue.
///
/// A cue is drawn on `[start, end)`, so the frame presented at exactly `end` is
/// not on it. `end * fps` is computed in binary, though, and a product that
/// lands a few ULPs above an integer - `(1.0 + 1.0 / 30.0) * 30.0` is
/// `31.000000000000004` - makes `ceil` name the boundary frame as if it were
/// one past it. A nanosecond is four orders of magnitude below a frame interval
/// at any rate this renders at, so subtracting it can only ever undo that
/// rounding.
const FRAME_BOUNDARY_EPSILON: f64 = 1e-9;

/// One emoji cell the burn-in script laid out, and when it is on screen.
///
/// Produced by the script builder, which is the only place that knows which
/// clusters were given a cell at all.
#[derive(Clone, Debug, PartialEq)]
pub struct EmojiOccurrence {
    /// Which `Dialogue` line carries the cell.
    pub event_index: usize,
    /// Which cell it is within that event, in reading order of the source text.
    pub run_index: usize,
    /// Cue start, already rebased onto the render's own clock.
    pub start_sec: f64,
    /// Cue end, on the same clock.
    pub end_sec: f64,
    /// Canonical identity of the emoji sequence; see
    /// [`crate::core::text::emoji::sequence_key`].
    pub sequence_key: String,
    /// Cell edge in `PlayRes` units, which is what the drawing was written in.
    pub size_play_res: u32,
    /// The event's `\frz`, in degrees, counter-clockwise as ASS measures it.
    pub rotation_deg: f64,
    /// The style's `ScaleX`, as a percentage. libass scales a `\p` drawing by
    /// it exactly as it scales a glyph, so the cell - and the picture
    /// composited into it - is this much wider than its `PlayRes` edge.
    pub scale_x_percent: f64,
    /// The style's `ScaleY`, as a percentage. The vertical half of the same.
    pub scale_y_percent: f64,
}

impl EmojiOccurrence {
    /// The instant to probe this cell at: the middle of its cue.
    ///
    /// The middle rather than the start because a cue boundary is exactly where
    /// a rounding disagreement between the graph's frame grid and libass's own
    /// timing would land, and half a cue is the furthest any instant can be
    /// from both edges.
    fn probe_instant_sec(&self) -> f64 {
        let start = self.start_sec.max(0.0);
        let end = self.end_sec.max(start);
        start + (end - start) / 2.0
    }

    /// The frame this cell can be probed on, or `None` when no frame shows it.
    ///
    /// The middle of the cue is only a *candidate*. A probe reads back a frame
    /// the graph actually produced, and the frames a cue is on are
    /// `ceil(start*fps) ..= ceil(end*fps) - 1`: frame `n` is presented at
    /// `n/fps` and draws the cue when `start <= n/fps < end`. Rounding the
    /// midpoint can land one frame outside that range for a short cue, and
    /// probing a frame the cue is not on measures nothing at all - so the
    /// candidate is clamped into the range rather than trusted.
    ///
    /// `None` is the sub-frame cue: one shorter than a frame interval can fall
    /// entirely between two presentation times, so no frame ever shows it and
    /// there is nothing to measure. The caller refuses that cell back to the
    /// monochrome glyph before the script it is written into reaches disk.
    ///
    /// The last frame is `ceil(end*fps - EPSILON) - 1` rather than
    /// `ceil(end*fps) - 1` because the range is half-open and binary rounding
    /// is not: a cue ending at `1.0 + 1/30` gives `end*fps == 31.000000000000004`
    /// at 30fps, whose `ceil` is 32 - naming frame 31 as probeable when frame 31
    /// is presented at exactly the cue end, where libass draws nothing. The
    /// epsilon is far below a frame interval at any sane rate, so it can only
    /// ever pull back a bound that landed on the boundary by rounding.
    pub fn probe_frame(&self, fps: f64) -> Option<u64> {
        if !fps.is_finite() || fps <= 0.0 {
            return None;
        }

        let start = self.start_sec.max(0.0);
        let end = self.end_sec;
        if !start.is_finite() || !end.is_finite() || end <= start {
            return None;
        }

        let first = (start * fps).ceil().max(0.0);
        // `end` is exclusive, so a frame presented exactly at it is not on the
        // cue. Nudging inwards keeps a product that rounded a hair *above* the
        // boundary - `(1.0 + 1.0/30.0) * 30.0` is `31.000000000000004` - from
        // naming that frame anyway.
        let last = (end * fps - FRAME_BOUNDARY_EPSILON).ceil() - 1.0;
        if last < first {
            return None;
        }

        let candidate = (self.probe_instant_sec() * fps).round();
        Some(candidate.clamp(first, last) as u64)
    }

    /// Whether two cells can be on screen together.
    ///
    /// Touching windows (`a.end == b.start`) do not overlap: nothing is drawn
    /// at the instant a cue ends, and treating them as a conflict would split
    /// a run of back-to-back captions into a batch each.
    fn conflicts_with(&self, other: &Self) -> bool {
        self.start_sec < other.end_sec && other.start_sec < self.end_sec
    }
}

/// Where one emoji picture goes, in output pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct EmojiPlacement {
    /// Which occurrence this measures, as an index into the request's slice.
    ///
    /// Carried rather than implied by position: the caller has to know exactly
    /// which cells came back measured, because every cell that did not has to
    /// be rebuilt as a monochrome glyph instead of left as an empty spacer.
    pub occurrence_index: usize,
    /// Left edge of the picture.
    pub x: i32,
    /// Top edge of the picture.
    pub y: i32,
    /// Width the picture is scaled to before it is drawn.
    pub size_x: u32,
    /// Height the picture is scaled to. Equal to `size_x` only when the frame
    /// and the script's `PlayRes` share an aspect and the style scales evenly.
    pub size_y: u32,
    /// Clockwise rotation to apply, in radians - FFmpeg's own sense, already
    /// negated from the ASS angle.
    pub rotation_rad: f64,
    /// Cue start on the render's clock, for the overlay's `enable`.
    pub start_sec: f64,
    /// Cue end on the same clock.
    pub end_sec: f64,
    /// Which emoji to draw.
    pub sequence_key: String,
}

/// Everything [`measure_emoji_placements`] needs that is not the engine.
pub struct EmojiMeasureRequest<'a> {
    /// The cells to measure, in the order the script emitted them.
    pub occurrences: &'a [EmojiOccurrence],
    /// Builds the marker script that paints boxes for exactly these
    /// occurrence indices and hides everything else.
    ///
    /// A closure rather than a finished script because a batch needs its *own*
    /// marker set: handing this function one script would either paint every
    /// box at once - which `bbox` cannot separate - or force the marker
    /// geometry to be spliced in by string surgery on a script whose layout is
    /// the one thing that must not change. Re-running the same builder with a
    /// different marker set is layout-identical by construction.
    /// `Send + Sync` because the whole request is held across the `await` on
    /// the probe, inside futures the render worker and the IPC layer spawn onto
    /// the multi-threaded runtime.
    #[allow(clippy::type_complexity)]
    pub build_marker_script:
        &'a (dyn Fn(&HashSet<usize>) -> Result<String, ExportError> + Send + Sync),
    /// Width of the frames the render will actually write.
    pub frame_width: u32,
    /// Height of those frames.
    pub frame_height: u32,
    /// `PlayResX` the script is authored in. libass scales a script into the
    /// frame on each axis independently - `frame_w/PlayResX` horizontally,
    /// `frame_h/PlayResY` vertically - so an export whose frame does not share
    /// the canvas aspect needs both numbers or the picture is sized wrong.
    pub play_res_x: u32,
    /// `PlayResY` the script is authored in, which fixes the vertical scale
    /// between the cell's drawing units and output pixels.
    pub play_res_y: u32,
    /// Frame rate of the render, so probe instants land on real frames.
    pub fps: f64,
    /// Occurrences that will *not* be cells in the script that is finally
    /// rendered, by index into `occurrences`.
    ///
    /// They are neither probed nor placed. The set exists because the marker
    /// script has to be laid out identically to the script that renders, and a
    /// refused cell is a monochrome glyph in both - measuring against a script
    /// that still had a spacer there would measure a line that never renders.
    pub refused: &'a HashSet<usize>,
}

/// Groups occurrences so no two in one group are ever on screen together.
///
/// Greedy colouring of the interval conflict graph: each occurrence takes the
/// first batch none of whose members it overlaps. Optimal for intervals, and
/// the ordering is the emission order, so the partition is deterministic.
///
/// Occurrences in `refused` are not measured at all: they render as the
/// monochrome glyph, so there is no rectangle to find and nothing to draw.
///
/// Returns batches of indices into the input slice.
pub fn plan_measurement_batches(
    occurrences: &[EmojiOccurrence],
    refused: &HashSet<usize>,
) -> Vec<Vec<usize>> {
    let mut batches: Vec<Vec<usize>> = Vec::new();

    for (index, occurrence) in occurrences.iter().enumerate() {
        if refused.contains(&index) {
            continue;
        }

        let slot = batches.iter().position(|batch| {
            batch
                .iter()
                .all(|member| !occurrences[*member].conflicts_with(occurrence))
        });

        match slot {
            Some(slot) => batches[slot].push(index),
            None => batches.push(vec![index]),
        }
    }

    batches
}

/// Measures every cell that can be measured, and says which those were.
///
/// An occurrence the probe could not find a box for simply has no placement in
/// the result. That is not a dropped emoji: the caller reads the placements'
/// [`EmojiPlacement::occurrence_index`] back, refuses every cell that is
/// missing, and rebuilds the script so those clusters carry the monochrome
/// glyph instead of an empty spacer. A guessed rectangle would be a colour
/// emoji somewhere it does not belong; a blank cell would be a hole.
///
/// A probe that fails outright - a binary without `bbox`, a spawn that could
/// not run - is not an export failure either. The batch is warned about and
/// left unmeasured, which reaches the same refusal path.
pub async fn measure_emoji_placements(
    engine: &ExportEngine,
    request: &EmojiMeasureRequest<'_>,
) -> Result<Vec<EmojiPlacement>, ExportError> {
    // The fast path, and the one that runs for nearly every project: no emoji
    // means no script, no temp directory and no subprocess.
    if request.occurrences.is_empty() {
        return Ok(Vec::new());
    }

    if request.frame_width == 0
        || request.frame_height == 0
        || request.play_res_x == 0
        || request.play_res_y == 0
    {
        return Err(ExportError::InvalidSettings(
            "Colour emoji measurement needs a non-zero frame size".to_string(),
        ));
    }

    let fps = if request.fps.is_finite() && request.fps > 0.0 {
        request.fps
    } else {
        30.0
    };

    let mut placements: Vec<EmojiPlacement> = Vec::with_capacity(request.occurrences.len());

    for batch in plan_measurement_batches(request.occurrences, request.refused) {
        let selection: HashSet<usize> = batch.iter().copied().collect();
        let script = (request.build_marker_script)(&selection)?;
        // One batch that could not run costs its own cells their colour and
        // nothing else. The alternative - propagating - fails an entire export
        // over a filter this build's FFmpeg happens not to carry.
        let boxes = match measure_batch(engine, request, &script, &batch, fps).await {
            Ok(boxes) => boxes,
            Err(error) => {
                tracing::warn!(
                    "Colour emoji measurement failed for {} cell(s); they keep the monochrome \
                     glyph: {error}",
                    batch.len()
                );
                continue;
            }
        };

        for (index, measured) in batch.iter().zip(boxes) {
            let occurrence = &request.occurrences[*index];
            let Some(measured) = measured else {
                tracing::warn!(
                    "No emoji marker was measurable for '{}' at {:.3}s; keeping the monochrome glyph",
                    occurrence.sequence_key,
                    occurrence.probe_instant_sec()
                );
                continue;
            };

            placements.push(placement_from_box(*index, occurrence, &measured, request));
        }
    }

    // Emission order, not batch order: the filtergraph reads this list to build
    // its overlay chain, and a stable order keeps two identical renders byte
    // identical.
    placements.sort_by(|left, right| {
        left.start_sec
            .partial_cmp(&right.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.x.cmp(&right.x))
            .then_with(|| left.y.cmp(&right.y))
    });

    Ok(placements)
}

/// Cells no frame of this render can show, by index into `occurrences`.
///
/// Refused before anything is measured, and before the script that renders is
/// written: a cue shorter than one frame interval can sit entirely between two
/// presentation times, and there is no rectangle to find for a cell that is
/// never drawn. Leaving it as a spacer would burn a blank 1.2 em hole into the
/// caption; refusing it keeps the monochrome glyph.
pub fn cells_no_frame_can_show(occurrences: &[EmojiOccurrence], fps: f64) -> HashSet<usize> {
    occurrences
        .iter()
        .enumerate()
        .filter(|(_, occurrence)| occurrence.probe_frame(fps).is_none())
        .map(|(index, _)| index)
        .collect()
}

/// A rectangle the `bbox` filter reported, in output pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MeasuredBox {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

impl MeasuredBox {
    /// The centre, which is what a placement is derived from.
    ///
    /// Not the reported width and height: anti-aliasing feathers the box's
    /// edges, so a cell drawn 72 units wide measures 73 pixels. The centre is
    /// unaffected by symmetric feathering, and the size is already known
    /// exactly from the cell the script wrote.
    fn center(self) -> (f64, f64) {
        (
            f64::from(self.x1 + self.x2) / 2.0,
            f64::from(self.y1 + self.y2) / 2.0,
        )
    }
}

/// Turns one measured box into the rectangle the overlay filter draws into.
///
/// # Why the size is not one number
///
/// libass scales a script into the frame on each axis independently:
/// horizontally by `frame_width/PlayResX`, vertically by
/// `frame_height/PlayResY`. Those agree only when the frame shares the
/// script's aspect - which is the usual case and was the assumption here, and
/// which a vertical sequence exported through a 16:9 preset breaks. On top of
/// that the style's own `ScaleX`/`ScaleY` are user-settable and multiply in.
///
/// So the cell that was measured is `size_play_res` units wide *and* tall in
/// the script's space, and the pixels it occupies are not a square. The
/// picture is scaled to match, and stays centred on the measured centre -
/// which is the one number the probe reports that is immune to all of this.
fn placement_from_box(
    occurrence_index: usize,
    occurrence: &EmojiOccurrence,
    measured: &MeasuredBox,
    request: &EmojiMeasureRequest<'_>,
) -> EmojiPlacement {
    let cell = f64::from(occurrence.size_play_res);
    let ceiling = f64::from(request.frame_height.max(request.frame_width));
    let scale_x = f64::from(request.frame_width) / f64::from(request.play_res_x);
    let scale_y = f64::from(request.frame_height) / f64::from(request.play_res_y);
    let size_x = (cell * scale_x * style_scale(occurrence.scale_x_percent))
        .round()
        .clamp(1.0, ceiling);
    let size_y = (cell * scale_y * style_scale(occurrence.scale_y_percent))
        .round()
        .clamp(1.0, ceiling);

    // ASS measures `\frz` counter-clockwise; FFmpeg's `rotate` takes clockwise
    // radians. The picture has to turn the same way the cell did.
    let rotation_rad = -occurrence.rotation_deg.to_radians();
    let (center_x, center_y) = measured.center();
    // A rotated rectangle needs its axis-aligned bounding box, and that box is
    // still centred on the cell's centre, so the picture stays put.
    let (extent_x, extent_y) = rotated_extents(size_x, size_y, rotation_rad);

    EmojiPlacement {
        occurrence_index,
        x: (center_x - extent_x / 2.0).round() as i32,
        y: (center_y - extent_y / 2.0).round() as i32,
        size_x: size_x as u32,
        size_y: size_y as u32,
        rotation_rad,
        start_sec: occurrence.start_sec,
        end_sec: occurrence.end_sec,
        sequence_key: occurrence.sequence_key.clone(),
    }
}

/// A style's `ScaleX`/`ScaleY` percentage as a multiplier, defensively clamped.
///
/// The same bounds `append_ass_text_style_and_event` clamps the effect
/// parameter to, applied again here because this struct can be built by a
/// caller that never went through that clamp.
fn style_scale(percent: f64) -> f64 {
    if percent.is_finite() {
        (percent / 100.0).clamp(0.01, 10.0)
    } else {
        1.0
    }
}

/// Size of the axis-aligned box a `width` x `height` rectangle occupies once
/// rotated by `rotation_rad`.
pub(crate) fn rotated_extents(width: f64, height: f64, rotation_rad: f64) -> (f64, f64) {
    if rotation_rad == 0.0 {
        return (width, height);
    }

    let cos = rotation_rad.cos().abs();
    let sin = rotation_rad.sin().abs();

    (
        (width * cos + height * sin).ceil(),
        (width * sin + height * cos).ceil(),
    )
}

/// Runs one probe and reads back one box per occurrence in `batch`.
///
/// The returned vector is parallel to `batch`; a `None` is an occurrence whose
/// marker the probe never saw.
async fn measure_batch(
    engine: &ExportEngine,
    request: &EmojiMeasureRequest<'_>,
    marker_script: &str,
    batch: &[usize],
    fps: f64,
) -> Result<Vec<Option<MeasuredBox>>, ExportError> {
    // `probe_frame` clamps the cue's midpoint into the frames the cue is
    // actually on, so a short cue is probed on a frame that draws it rather
    // than on the frame rounding happened to land on. A cell with no such
    // frame is refused before it ever reaches a batch.
    let instants: Vec<(usize, f64)> = batch
        .iter()
        .filter_map(|index| {
            let frame = request.occurrences[*index].probe_frame(fps)?;
            Some((frame as usize, frame as f64 / fps))
        })
        .collect();

    if instants.len() != batch.len() {
        return Err(ExportError::InvalidSettings(
            "A colour emoji cell with no frame to probe reached measurement".to_string(),
        ));
    }

    // The same answer the probe's own filtergraph is built from, read once so
    // the key and the graph cannot disagree about how this script wraps.
    let wraps_unicode = engine.wraps_unicode_captions();
    if let Some(cached) = cached_measurement(marker_script, request, &instants, wraps_unicode) {
        return Ok(cached);
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("openreelio-emoji-probe-")
        .tempdir()
        .map_err(ExportError::IoError)?;
    let script_path = temp_dir.path().join("emoji-markers.ass");
    crate::core::fs::validate_filter_safe_path(&script_path, "Emoji marker script path")
        .map_err(ExportError::InvalidSettings)?;
    tokio::fs::write(&script_path, marker_script)
        .await
        .map_err(ExportError::IoError)?;

    let output = run_probe(engine, request, &script_path, &instants, fps).await?;
    let measured = match_boxes_to_instants(&output, &instants, fps);

    // Only a complete answer is remembered. A `None` is "the probe did not see
    // this cell", which the caller turns into a refusal for this render - and
    // caching it would make that refusal stick for the life of the process,
    // long after whatever made the probe miss has gone away.
    if measured.iter().all(Option::is_some) {
        store_measurement(marker_script, request, &instants, wraps_unicode, &measured);
    }

    Ok(measured)
}

/// Builds and runs the probe command, returning the metadata text it printed.
///
/// The command has to parse on every FFmpeg this ships against, not just the
/// bundled one: a rejected option is an exit before decoding, which arrives
/// here as an empty report and turns every cell into a refusal. That is why the
/// frame-timing flag is `-fps_mode passthrough` and not the `-vsync 0` it
/// replaced - see the comment beside it.
async fn run_probe(
    engine: &ExportEngine,
    request: &EmojiMeasureRequest<'_>,
    script_path: &Path,
    instants: &[(usize, f64)],
    fps: f64,
) -> Result<String, ExportError> {
    use crate::core::effects::escape_ffmpeg_filter_value;

    let last_instant = instants
        .iter()
        .map(|(_, time)| *time)
        .fold(0.0_f64, f64::max);
    // Two frames of slack so the last probed frame is comfortably inside the
    // source rather than on its final presentation time.
    let duration = last_instant + 2.0 / fps;

    let select = instants
        .iter()
        .map(|(frame, _)| format!("eq(n\\,{frame})"))
        .collect::<Vec<_>>()
        .join("+");

    let script_text = script_path.to_string_lossy();
    let escaped_script = escape_ffmpeg_filter_value(script_text.as_ref());

    // `select` sits *before* `subtitles` on purpose. libass then lays out only
    // the frames being measured instead of every frame of the cue, which is the
    // difference between a probe that costs milliseconds and one that costs as
    // much as a render. `select` preserves presentation timestamps, so the
    // subtitle timing the filter reads is unchanged.
    // `metadata=mode=print` with no `file` writes through `av_log` at info
    // level, which `-loglevel error` throws away - the probe then reports that
    // every cell is unmeasurable while FFmpeg exits cleanly. `file=-` sends the
    // report to stdout instead, where nothing else in this command writes: the
    // `null` muxer produces no bytes.
    //
    // The same `wrap_unicode` the burn-in graph names, from the same probe.
    // This measurement exists to find where libass puts each cell, so a probe
    // that breaks lines differently from the render measures a layout the
    // render never draws - and every emoji in an unspaced Japanese or Chinese
    // cue would be composited against the wrong line.
    let wrap_unicode_option = if engine.wraps_unicode_captions() {
        super::export::SUBTITLES_WRAP_UNICODE_OPTION
    } else {
        ""
    };
    let filter = format!(
        "select='{select}',subtitles=filename='{escaped_script}'{wrap_unicode_option},format=gray,bbox=min_val=32,metadata=mode=print:file=-"
    );

    let args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!(
            "color=c=black:s={}x{}:r={}:d={:.6}",
            request.frame_width,
            request.frame_height,
            format_probe_number(fps),
            duration
        ),
        "-vf".to_string(),
        filter,
        // `-fps_mode passthrough`, not `-vsync 0`: FFmpeg 9 removed `-vsync`
        // outright, and an unrecognised option is a parse error before a single
        // frame is decoded - which reaches this pass as "no cell could be
        // measured" and quietly turns the whole colour feature off on every
        // host with a modern binary. `passthrough` is the documented successor,
        // means the same thing (keep the frames `select` let through on their
        // own timestamps rather than resampling to the output rate) and is
        // accepted by 8.x and 9.x alike.
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];

    let output = super::executor::execute_ffmpeg_output(engine.ffmpeg_path(), &args).await?;

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Formats a frame rate for an `lavfi` source without exponent notation.
fn format_probe_number(value: f64) -> String {
    let text = format!("{value:.6}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Reads `metadata=mode=print` output into one box per probed instant.
///
/// Frames whose bbox the filter never printed - which is what an entirely black
/// frame produces, not a zero-sized box - come back as `None`.
fn match_boxes_to_instants(
    output: &str,
    instants: &[(usize, f64)],
    fps: f64,
) -> Vec<Option<MeasuredBox>> {
    let printed = parse_bbox_frames(output);
    // Half a frame: every probed instant is a frame time by construction, so
    // anything further away is a different frame.
    let tolerance = 0.5 / fps.max(f64::MIN_POSITIVE);

    instants
        .iter()
        .map(|(_, instant)| {
            printed
                .iter()
                .find(|(time, _)| (time - instant).abs() <= tolerance)
                .map(|(_, measured)| *measured)
        })
        .collect()
}

/// Extracts `(pts_time, box)` pairs from the filter's printed metadata.
fn parse_bbox_frames(output: &str) -> Vec<(f64, MeasuredBox)> {
    let mut frames: Vec<(f64, MeasuredBox)> = Vec::new();
    let mut current_time: Option<f64> = None;
    let mut edges: HashMap<&str, i32> = HashMap::new();

    let mut flush = |time: &mut Option<f64>, edges: &mut HashMap<&str, i32>| {
        if let (Some(time), Some(x1), Some(y1), Some(x2), Some(y2)) = (
            *time,
            edges.get("x1").copied(),
            edges.get("y1").copied(),
            edges.get("x2").copied(),
            edges.get("y2").copied(),
        ) {
            frames.push((time, MeasuredBox { x1, y1, x2, y2 }));
        }
        edges.clear();
    };

    for line in output.lines() {
        let line = line.trim();

        if let Some(rest) = line.strip_prefix("frame:") {
            flush(&mut current_time, &mut edges);
            current_time = rest
                .split_whitespace()
                .find_map(|field| field.strip_prefix("pts_time:"))
                .and_then(|value| value.parse::<f64>().ok());
            continue;
        }

        if let Some(rest) = line.strip_prefix("lavfi.bbox.") {
            let mut parts = rest.splitn(2, '=');
            let (Some(name), Some(value)) = (parts.next(), parts.next()) else {
                continue;
            };
            if let Ok(value) = value.trim().parse::<i32>() {
                match name {
                    "x1" => edges.insert("x1", value),
                    "y1" => edges.insert("y1", value),
                    "x2" => edges.insert("x2", value),
                    "y2" => edges.insert("y2", value),
                    _ => None,
                };
            }
        }
    }

    flush(&mut current_time, &mut edges);

    frames
}

/// Measurements already made in this process, keyed by layout rather than time.
///
/// Layout is window-independent: rebasing a render moves every cue's timecodes
/// and moves nothing on the frame. The key therefore normalizes the timecodes
/// out of the marker script, so the preview cache filling one segment after
/// another reuses the boxes it measured for the first one instead of spawning
/// an FFmpeg per segment.
type MeasurementCache = HashMap<u64, Vec<Option<MeasuredBox>>>;

fn measurement_cache() -> &'static Mutex<MeasurementCache> {
    static CACHE: OnceLock<Mutex<MeasurementCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ceiling on remembered measurements, so a long session cannot grow forever.
///
/// Each entry is a handful of integers per emoji; the cap exists to bound the
/// map, not because the entries are large. Reaching it clears the map rather
/// than evicting cleverly - the next render re-measures once and refills.
const MAX_CACHED_MEASUREMENTS: usize = 512;

/// The cache key: what the boxes actually depend on.
///
/// `wraps_unicode` is one of them. It is a property of the binary rather than
/// of the script, and a process can change binaries under this cache - the
/// resolver picks a different FFmpeg after a managed install, a test drives two
/// engines - so a key without it would hand a render measured with the Unicode
/// line-breaking algorithm the boxes measured without it, which is a different
/// set of line breaks and so a different place for every cell.
fn measurement_key(
    marker_script: &str,
    request: &EmojiMeasureRequest<'_>,
    instants: &[(usize, f64)],
    wraps_unicode: bool,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for line in marker_script.lines() {
        // Everything but a `Dialogue` line is layout; a `Dialogue` line is
        // layout except for its two timecode columns, which is exactly what a
        // rebased window changes.
        if let Some(rest) = line.strip_prefix("Dialogue:") {
            let mut fields = rest.splitn(4, ',');
            let layer = fields.next().unwrap_or("");
            let _start = fields.next();
            let _end = fields.next();
            let tail = fields.next().unwrap_or("");
            "Dialogue:".hash(&mut hasher);
            layer.hash(&mut hasher);
            tail.hash(&mut hasher);
        } else {
            line.hash(&mut hasher);
        }
    }
    request.frame_width.hash(&mut hasher);
    request.frame_height.hash(&mut hasher);
    request.play_res_x.hash(&mut hasher);
    request.play_res_y.hash(&mut hasher);
    instants.len().hash(&mut hasher);
    wraps_unicode.hash(&mut hasher);
    hasher.finish()
}

fn cached_measurement(
    marker_script: &str,
    request: &EmojiMeasureRequest<'_>,
    instants: &[(usize, f64)],
    wraps_unicode: bool,
) -> Option<Vec<Option<MeasuredBox>>> {
    let key = measurement_key(marker_script, request, instants, wraps_unicode);
    measurement_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
}

fn store_measurement(
    marker_script: &str,
    request: &EmojiMeasureRequest<'_>,
    instants: &[(usize, f64)],
    wraps_unicode: bool,
    measured: &[Option<MeasuredBox>],
) {
    let key = measurement_key(marker_script, request, instants, wraps_unicode);
    if let Ok(mut cache) = measurement_cache().lock() {
        if cache.len() >= MAX_CACHED_MEASUREMENTS {
            cache.clear();
        }
        cache.insert(key, measured.to_vec());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occurrence(start: f64, end: f64, key: &str) -> EmojiOccurrence {
        EmojiOccurrence {
            event_index: 0,
            run_index: 0,
            start_sec: start,
            end_sec: end,
            sequence_key: key.to_string(),
            size_play_res: 72,
            rotation_deg: 0.0,
            scale_x_percent: 100.0,
            scale_y_percent: 100.0,
        }
    }

    #[test]
    fn two_emoji_in_one_cue_are_never_measured_in_the_same_batch() {
        let occurrences = vec![
            occurrence(1.0, 3.0, "1f600"),
            occurrence(1.0, 3.0, "1f44d"),
            occurrence(1.0, 3.0, "1f525"),
        ];

        let batches = plan_measurement_batches(&occurrences, &HashSet::new());

        assert_eq!(batches, vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn cues_that_never_share_a_frame_are_measured_in_one_batch() {
        let occurrences = vec![
            occurrence(0.0, 1.0, "1f600"),
            occurrence(1.0, 2.0, "1f44d"),
            occurrence(2.0, 3.0, "1f525"),
        ];

        let batches = plan_measurement_batches(&occurrences, &HashSet::new());

        assert_eq!(batches, vec![vec![0, 1, 2]]);
    }

    #[test]
    fn a_partially_overlapping_cue_takes_the_next_batch() {
        let occurrences = vec![
            occurrence(0.0, 2.0, "1f600"),
            occurrence(1.0, 3.0, "1f44d"),
            occurrence(2.5, 4.0, "1f525"),
        ];

        let batches = plan_measurement_batches(&occurrences, &HashSet::new());

        assert_eq!(batches, vec![vec![0, 2], vec![1]]);
    }

    #[test]
    fn no_occurrences_means_no_batches_at_all() {
        assert!(plan_measurement_batches(&[], &HashSet::new()).is_empty());
    }

    /// Feature: colour emoji measurement
    /// Scenario: a cue no frame shows has nothing to measure
    ///
    /// A cue shorter than a frame interval can sit entirely between two
    /// presentation times. Probing it reads back a frame the caption is not on,
    /// which measures nothing - and the cell, left as a spacer, would burn a
    /// blank 1.2 em hole into the caption. It is refused instead.
    #[test]
    fn a_cue_that_falls_between_two_frames_has_no_frame_to_probe() {
        // 0.98s to 1.0s at 30fps: the frames are at 0.9667 and 1.0, and the cue
        // is on neither - the first is before it and the second is after its
        // end.
        let between = occurrence(0.98, 1.0, "1f600");
        assert_eq!(between.probe_frame(30.0), None);

        // The same cue at 60fps is on frame 59, and is measured normally.
        assert_eq!(between.probe_frame(60.0), Some(59));

        let occurrences = vec![occurrence(0.0, 1.0, "1f525"), between];
        assert_eq!(
            cells_no_frame_can_show(&occurrences, 30.0),
            [1usize].into_iter().collect::<HashSet<usize>>()
        );
    }

    /// Feature: colour emoji measurement
    /// Scenario: the probe instant is clamped into the cue's own frames
    ///
    /// The midpoint is a real number and the probe reads a frame, so rounding
    /// can land one frame past the cue's last. That frame draws nothing, the
    /// cell measures as unmeasurable, and a caption that was perfectly
    /// renderable loses its colour - or worse, before the refusal path existed,
    /// kept an empty spacer.
    #[test]
    fn a_probe_instant_is_clamped_into_the_frames_the_cue_is_on() {
        // Frames 29 and 30 at 30fps are 0.9667 and 1.0. The cue covers frame 29
        // and ends exactly on frame 30, so 29 is its last frame - and its
        // midpoint, 0.9833, rounds to frame 30.
        let cue = occurrence(29.0 / 30.0, 1.0, "1f600");

        assert_eq!(cue.probe_frame(30.0), Some(29));
    }

    /// Feature: colour emoji measurement
    /// Scenario: the frame presented at the cue end is never probed
    ///
    /// The range of frames a cue is on is half-open - frame `n` draws it when
    /// `start <= n/fps < end` - but `end * fps` is arithmetic in binary, and a
    /// product landing a few ULPs above an integer makes `ceil` name one frame
    /// too many. A one-frame cue at 24fps is the smallest case where that costs
    /// something real: `(25/24 + 1/24) * 24` is `26.000000000000004`, so the
    /// unnudged bound offers frame 26 - presented at exactly the cue end, where
    /// libass draws nothing - and the midpoint rounds straight onto it. The
    /// probe then reads a blank frame, the cell measures as unmeasurable, and a
    /// perfectly renderable emoji loses its colour.
    #[test]
    fn the_frame_presented_at_the_cue_end_is_not_probeable() {
        let start = 25.0 / 24.0;
        let cue = occurrence(start, start + 1.0 / 24.0, "1f600");

        assert_eq!(
            cue.probe_frame(24.0),
            Some(25),
            "frame 25 is the only frame this cue is on"
        );

        // The cue is still measurable, so it is never refused for want of a
        // frame - which is what the bound naming frame 26 used to cause once
        // the probe came back empty.
        assert!(cells_no_frame_can_show(&[cue], 24.0).is_empty());
    }

    /// Feature: colour emoji measurement
    /// Scenario: a probe that cannot run costs the colour, not the export
    ///
    /// A binary without `bbox`, a spawn that fails, a non-zero exit: none of
    /// them are reasons to fail a render. Every cell in the failed batch comes
    /// back unmeasured, which the caller turns into a refusal back to the
    /// monochrome glyph.
    #[tokio::test]
    async fn a_probe_that_cannot_run_leaves_every_cell_unmeasured() {
        let engine = ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
            crate::core::ffmpeg::FFmpegInfo {
                ffmpeg_path: std::path::PathBuf::from("ffmpeg-that-cannot-possibly-exist"),
                ffprobe_path: std::path::PathBuf::from("ffprobe-that-cannot-possibly-exist"),
                version: "test".to_string(),
                is_bundled: false,
                source: crate::core::ffmpeg::FFmpegSource::System,
            },
        ));
        let occurrences = vec![occurrence(0.0, 2.0, "1f600")];
        let request = EmojiMeasureRequest {
            occurrences: &occurrences,
            build_marker_script: &|_| Ok("[Events]\n".to_string()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };

        let placements = measure_emoji_placements(&engine, &request)
            .await
            .expect("a probe that cannot run is not an export failure");

        assert!(placements.is_empty());
    }

    /// Feature: colour emoji measurement
    /// Scenario: a refused cell is never probed
    #[test]
    fn a_refused_cell_is_left_out_of_every_batch() {
        let occurrences = vec![
            occurrence(0.0, 1.0, "1f600"),
            occurrence(2.0, 3.0, "1f44d"),
            occurrence(4.0, 5.0, "1f525"),
        ];
        let refused: HashSet<usize> = [1usize].into_iter().collect();

        assert_eq!(
            plan_measurement_batches(&occurrences, &refused),
            vec![vec![0, 2]]
        );
    }

    /// Feature: colour emoji compositing
    /// Scenario: a frame that does not share the script's aspect sizes the
    /// picture on each axis separately
    ///
    /// libass scales a script into the frame by `frame_w/PlayResX` across and
    /// `frame_h/PlayResY` down. Assuming one number for both drew the emoji at
    /// the vertical scale in both directions, so a 16:9 script rendered into a
    /// square frame composited a picture nearly twice as wide as the cell it
    /// was measured in.
    #[test]
    fn a_frame_of_a_different_aspect_sizes_the_picture_on_each_axis() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1080,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        // A 72-unit cell in a 1920-wide script is 40.5 pixels across a
        // 1080-wide frame, and a full 72 down a 1080-tall one.
        let measured = MeasuredBox {
            x1: 500,
            y1: 500,
            x2: 540,
            y2: 571,
        };

        let placement = placement_from_box(0, &occurrence(0.0, 1.0, "1f600"), &measured, &request);

        assert_eq!((placement.size_x, placement.size_y), (41, 72));
    }

    /// Feature: colour emoji compositing
    /// Scenario: a stretched style stretches the picture with it
    ///
    /// `ScaleX` is a caption parameter a user can set, and libass applies it to
    /// a `\p` drawing exactly as it applies it to a glyph - so the cell that
    /// was measured really is twice as wide, and the picture composited into it
    /// has to be too.
    #[test]
    fn a_style_scale_stretches_the_picture_the_way_it_stretched_the_cell() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let mut stretched = occurrence(0.0, 1.0, "1f600");
        stretched.scale_x_percent = 200.0;
        let measured = MeasuredBox {
            x1: 100,
            y1: 100,
            x2: 243,
            y2: 171,
        };

        let placement = placement_from_box(0, &stretched, &measured, &request);

        assert_eq!((placement.size_x, placement.size_y), (144, 72));
        // Still centred on the box that was measured, which is the whole point
        // of measuring it.
        assert_eq!(placement.x, 100);
        assert_eq!(placement.y, 100);
    }

    /// Feature: colour emoji compositing
    /// Scenario: a vertical export sizes the picture from its own frame
    #[test]
    fn a_vertical_export_sizes_the_picture_from_its_own_frame() {
        // A 9:16 canvas authors the script at 608x1080; exporting it at
        // 1080x1920 scales by 1.776 across and 1.778 down.
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1080,
            frame_height: 1920,
            play_res_x: 608,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let measured = MeasuredBox {
            x1: 400,
            y1: 900,
            x2: 527,
            y2: 1027,
        };

        let placement = placement_from_box(0, &occurrence(0.0, 1.0, "1f600"), &measured, &request);

        assert_eq!((placement.size_x, placement.size_y), (128, 128));
    }

    /// Feature: colour emoji compositing
    /// Scenario: a rotated rectangle reports the box it actually occupies
    #[test]
    fn a_rotated_rectangle_takes_a_box_of_its_own_shape() {
        assert_eq!(rotated_extents(100.0, 50.0, 0.0), (100.0, 50.0));

        // A quarter turn swaps the axes. Within a pixel, because `cos` of a
        // quarter turn is not exactly zero in binary and the extent is ceiled -
        // which is the direction that matters: an extent is a box the picture
        // has to fit inside, so rounding it up is never wrong.
        let (width, height) = rotated_extents(100.0, 50.0, std::f64::consts::FRAC_PI_2);
        assert!((width - 50.0).abs() <= 1.0, "got {width}");
        assert!((height - 100.0).abs() <= 1.0, "got {height}");
    }

    #[test]
    fn a_bbox_report_is_read_back_per_frame() {
        let output = "frame:0    pts:10      pts_time:0.333333\n\
                      lavfi.bbox.x1=924\n\
                      lavfi.bbox.x2=995\n\
                      lavfi.bbox.y1=878\n\
                      lavfi.bbox.y2=950\n\
                      lavfi.bbox.w=72\n\
                      lavfi.bbox.h=73\n\
                      frame:1    pts:45      pts_time:1.5\n\
                      lavfi.bbox.x1=100\n\
                      lavfi.bbox.x2=172\n\
                      lavfi.bbox.y1=200\n\
                      lavfi.bbox.y2=272\n";

        let frames = parse_bbox_frames(output);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].1.center(), (959.5, 914.0));
        assert_eq!(frames[1].0, 1.5);
    }

    #[test]
    fn a_frame_the_filter_printed_no_box_for_reports_no_measurement() {
        // An entirely black frame makes `bbox` print nothing at all, which is
        // how a cell that libass never drew reaches this code.
        let output = "frame:0    pts:10      pts_time:0.333333\n\
                      lavfi.bbox.x1=924\n\
                      lavfi.bbox.x2=995\n\
                      lavfi.bbox.y1=878\n\
                      lavfi.bbox.y2=950\n";

        let measured = match_boxes_to_instants(output, &[(10, 0.333333), (200, 6.666667)], 30.0);

        assert!(measured[0].is_some());
        assert!(measured[1].is_none());
    }

    #[test]
    fn a_placement_is_centred_on_the_measured_box_not_sized_by_it() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        // The real numbers a 72-unit cell measures at 1080p. `bbox` reports
        // inclusive edges, so the span is 72 pixels and its centre falls on a
        // half pixel - which is exactly why the placement is derived from the
        // centre and the known cell size rather than from the reported width,
        // which anti-aliasing puts at 73.
        let measured = MeasuredBox {
            x1: 924,
            y1: 878,
            x2: 995,
            y2: 949,
        };

        let placement = placement_from_box(0, &occurrence(0.0, 1.0, "1f600"), &measured, &request);

        assert_eq!((placement.size_x, placement.size_y), (72, 72));
        assert_eq!(placement.x, 924);
        assert_eq!(placement.y, 878);
    }

    #[test]
    fn a_placement_scales_the_cell_from_play_res_into_output_pixels() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 3840,
            frame_height: 2160,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let measured = MeasuredBox {
            x1: 1000,
            y1: 1000,
            x2: 1144,
            y2: 1144,
        };

        let placement = placement_from_box(0, &occurrence(0.0, 1.0, "1f600"), &measured, &request);

        assert_eq!((placement.size_x, placement.size_y), (144, 144));
        assert_eq!(placement.x, 1000);
        assert_eq!(placement.y, 1000);
    }

    #[test]
    fn an_ass_rotation_turns_the_picture_the_other_way() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let mut rotated = occurrence(0.0, 1.0, "1f600");
        rotated.rotation_deg = 90.0;
        let measured = MeasuredBox {
            x1: 100,
            y1: 100,
            x2: 172,
            y2: 172,
        };

        let placement = placement_from_box(0, &rotated, &measured, &request);

        assert!((placement.rotation_rad + std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    }

    #[tokio::test]
    async fn a_project_with_no_emoji_never_builds_a_marker_script() {
        let built = std::sync::atomic::AtomicUsize::new(0);
        let engine = ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
            crate::core::ffmpeg::FFmpegInfo {
                ffmpeg_path: std::path::PathBuf::from("ffmpeg-that-must-never-run"),
                ffprobe_path: std::path::PathBuf::from("ffprobe-that-must-never-run"),
                version: "test".to_string(),
                is_bundled: false,
                source: crate::core::ffmpeg::FFmpegSource::System,
            },
        ));
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| {
                built.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(String::new())
            },
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };

        let placements = measure_emoji_placements(&engine, &request)
            .await
            .expect("no occurrences is not an error");

        assert!(placements.is_empty());
        assert_eq!(built.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    // =========================================================================
    // Against a real libass
    // =========================================================================
    //
    // Everything above reasons about strings and numbers. These hand the real
    // binary the real script and read back what libass actually did, because
    // the whole design rests on two claims no unit test can check: that a `\p`
    // drawing advances a line by exactly its bounding-box width, and that
    // painting inside it changes nothing about where anything else lands.

    /// A script in the shape the export writes, with one cell in `text`.
    ///
    /// Deliberately not built through the sequence emitter: these tests are
    /// about libass, and a fixture that went through the whole caption pipeline
    /// would fail for a dozen reasons that have nothing to do with the cell.
    fn probe_script(text: &str) -> String {
        probe_script_with(r"\an2", text)
    }

    /// [`probe_script`] as the measurement pre-pass writes it: text hidden, so
    /// the one rectangle `bbox` reports is the painted cell and nothing else.
    fn probe_marker_script(text: &str) -> String {
        probe_script_with(
            &format!(
                r"\an2{}",
                crate::core::render::export::ASS_EMOJI_MARKER_HIDE_TAGS
            ),
            text,
        )
    }

    /// [`probe_script`], with the event's leading override block spelled out.
    fn probe_script_with(tags: &str, text: &str) -> String {
        format!(
            "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\
             PlayResX: 1920\nPlayResY: 1080\n\n\
             [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
             OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, \
             Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, \
             Encoding\n\
             Style: T,Arial,60.00,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100.00,\
             100.00,0,0,1,2.00,0.00,2,60,60,60,1\n\n\
             [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, \
             Text\n\
             Dialogue: 0,0:00:00.00,0:00:05.00,T,,60,60,60,,{{{tags}}}{text}\n"
        )
    }

    /// Renders one frame of `script` over black and reads its bounding box.
    ///
    /// `None` when the frame is entirely black, which is what libass drawing
    /// nothing at all looks like from here.
    ///
    /// Carries `wrap_unicode` under the same probe the render path uses, so a
    /// script measured here is laid out the way the burn-in lays it out.
    fn measure_script(ffmpeg: &Path, script: &str) -> Option<MeasuredBox> {
        use crate::core::effects::escape_ffmpeg_filter_value;

        let wrap_unicode_option =
            if crate::core::ffmpeg::binary_supports_subtitles_wrap_unicode(ffmpeg) {
                super::super::export::SUBTITLES_WRAP_UNICODE_OPTION
            } else {
                ""
            };

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("probe.ass");
        std::fs::write(&path, script).expect("write script");
        let path_text = path.to_string_lossy().to_string();

        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        let output = command
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=1920x1080:r=30:d=1",
                "-vf",
                &format!(
                    "select='eq(n\\,10)',subtitles=filename='{}'{wrap_unicode_option},\
                     format=gray,bbox=min_val=32,metadata=mode=print:file=-",
                    escape_ffmpeg_filter_value(&path_text)
                ),
                // Matches `run_probe`; see the note there for why this is not
                // `-vsync 0`.
                "-fps_mode",
                "passthrough",
                "-f",
                "null",
                "-",
            ])
            .output()
            .expect("ffmpeg runs");

        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        parse_bbox_frames(&String::from_utf8_lossy(&output.stdout))
            .first()
            .map(|(_, measured)| *measured)
    }

    /// Inclusive width of a measured box, in pixels.
    fn width_of(measured: MeasuredBox) -> i32 {
        measured.x2 - measured.x1 + 1
    }

    /// Feature: colour emoji measurement
    /// Scenario: a cell advances the line by exactly its own width
    ///
    /// The load-bearing claim. If a `\p` drawing advanced by anything other
    /// than its bounding box - by the font's advance for the glyph it replaced,
    /// say, or by nothing at all - the colour picture would be composited into
    /// a hole of a different size than the one that was measured, and every
    /// caption with an emoji in it would be subtly wrong.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_cell_advances_the_line_by_exactly_its_own_width() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let size = 72;
        let without =
            measure_script(&ffmpeg, &probe_script("AAABBB")).expect("plain text draws something");
        let with_cell = measure_script(
            &ffmpeg,
            &probe_script(&format!(
                "AAA{}BBB",
                crate::core::render::export::ass_emoji_spacer_run(size)
            )),
        )
        .expect("the same text still draws");

        assert_eq!(
            width_of(with_cell),
            width_of(without) + i32::try_from(size).expect("a small cell"),
            "the cell has to advance exactly {size} units and change nothing else"
        );
    }

    /// Feature: colour emoji measurement
    /// Scenario: painting the cell does not move the line
    ///
    /// The other half. The marker script differs from the render script only in
    /// what is painted inside the cell and in the alphas that hide the text -
    /// this is the assertion that libass agrees neither of those is layout.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn painting_a_cell_leaves_the_line_exactly_where_it_was() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let size = 72;
        let spacer = crate::core::render::export::ass_emoji_spacer_run(size);
        let marker = crate::core::render::export::ass_emoji_marker_run(size);

        // Centred text, with the cell in the middle of it. If painting the cell
        // changed its advance by so much as a unit, the whole line would
        // re-centre and the first glyph's left edge would move.
        let rendered =
            measure_script(&ffmpeg, &probe_script(&format!("AAA{spacer}BBB"))).expect("a line");
        let painted = measure_script(&ffmpeg, &probe_script(&format!("AAA{marker}BBB")))
            .expect("a line with the cell painted");

        assert_eq!(
            painted.x1, rendered.x1,
            "painting the cell must not re-centre the line: {painted:?} against {rendered:?}"
        );

        // And the cell itself, measured the way the pre-pass measures it, is
        // exactly one cell wide - plus the pixel anti-aliasing feathers onto.
        let cell = measure_script(&ffmpeg, &probe_marker_script(&format!("AAA{marker}BBB")))
            .expect("a painted cell");
        assert_eq!(width_of(cell), i32::try_from(size).expect("a small cell"));
        assert!(
            cell.x1 > rendered.x1 && cell.x2 < rendered.x2,
            "and sits inside the line it was laid out in: {cell:?} in {rendered:?}"
        );
    }

    /// Feature: colour emoji measurement
    /// Scenario: an emoji after a line wrap is measured on the line it wrapped to
    ///
    /// Line breaking is libass's, and this is what "measure it rather than
    /// model it" buys: nothing in this crate knows how wide the words were or
    /// where the break fell, and each cell is still found on its own line.
    ///
    /// Two cells in the same wrapped block, one in the middle and one at the
    /// end, must come back on different lines. Comparing them against each
    /// other rather than against an absolute pixel row keeps the assertion
    /// about *wrapping* instead of about this build's font metrics.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn an_emoji_after_a_line_wrap_is_measured_on_the_line_it_wrapped_to() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let size = 72;
        let marker = crate::core::render::export::ass_emoji_marker_run(size);
        // Long enough that it cannot fit on two lines either, so a cell halfway
        // through it and a cell at its end are always separated by at least one
        // break however this build's font measures the words.
        let words = "wrapping ".repeat(40);
        let block = measure_script(&ffmpeg, &probe_script(&format!("{words}END")))
            .expect("a wrapped block");
        assert!(
            block.y2 - block.y1 > 80,
            "the fixture has to actually wrap; got {block:?}"
        );

        let half = words.len() / 2;
        let in_the_middle = measure_script(
            &ffmpeg,
            &probe_marker_script(&format!("{}{marker}{}", &words[..half], &words[half..])),
        )
        .expect("a cell mid-block");
        let at_the_end = measure_script(&ffmpeg, &probe_marker_script(&format!("{words}{marker}")))
            .expect("a cell at the end");

        assert!(
            in_the_middle.y1 < at_the_end.y1,
            "a cell in the middle of a wrapped block sits on an earlier line than one at its \
             end: {in_the_middle:?} against {at_the_end:?}"
        );
        // Within a pixel: a cell whose origin lands mid-pixel feathers one more
        // column into the box. The placement is derived from the centre and the
        // cell size the script wrote, never from this width, so a pixel of
        // anti-aliasing costs nothing.
        for cell in [in_the_middle, at_the_end] {
            assert!(
                (width_of(cell) - i32::try_from(size).expect("a small cell")).abs() <= 1,
                "a wrapped cell keeps its width: {cell:?}"
            );
        }
    }

    /// Feature: colour emoji measurement
    /// Scenario: a right-to-left line is measured where libass drew it
    ///
    /// Characterization, deliberately. Where a drawing lands inside a bidi
    /// paragraph is libass's decision and not one this crate should encode an
    /// expectation about - the entire point of measuring is that it does not
    /// have to. What is asserted is what actually matters: an RTL line does not
    /// break measurement, and the cell comes back inside the line it belongs to
    /// at exactly its own width.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn an_rtl_line_is_measured_wherever_libass_reordered_the_cell_to() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let size = 72;
        // Hebrew, which is strongly right-to-left, so the paragraph direction
        // is unambiguous whatever font ends up drawing the letters.
        let rtl = "\u{05E9}\u{05DC}\u{05D5}\u{05DD} \u{05E2}\u{05D5}\u{05DC}\u{05DD}";
        let line = measure_script(
            &ffmpeg,
            &probe_script(&format!(
                "{rtl}{}",
                crate::core::render::export::ass_emoji_spacer_run(size)
            )),
        );
        let Some(line) = line else {
            // No Hebrew face on this machine and nothing else painted: there is
            // no line to measure a cell inside of, which is a fact about the
            // host's fonts rather than a failure of this code.
            eprintln!("Skipping: this host draws no Hebrew, so there is no RTL line");
            return;
        };

        let cell = measure_script(
            &ffmpeg,
            &probe_marker_script(&format!(
                "{rtl}{}",
                crate::core::render::export::ass_emoji_marker_run(size)
            )),
        )
        .expect("the painted cell is always drawn, whatever draws the letters");

        // Within a pixel: bidi reordering can leave the cell's origin on a
        // sub-pixel boundary, where anti-aliasing feathers one more column into
        // the box than a left-to-right line does. The placement is derived from
        // the centre for exactly this reason, so a pixel here costs nothing.
        assert!(
            (width_of(cell) - i32::try_from(size).expect("a small cell")).abs() <= 1,
            "the cell keeps its width through bidi reordering: {cell:?}"
        );
        // Adjacent to the letters on one side or the other. Which side is
        // libass's bidi decision about a drawing inside a right-to-left
        // paragraph, and encoding an expectation about it here would be
        // modelling the layout again - the thing this whole module exists to
        // avoid. What matters is that the cell is part of the same line, and a
        // cell measured on the wrong side of a two-hundred-pixel line would
        // still fail this.
        let gap = (cell.x1 - line.x2).max(line.x1 - cell.x2);
        assert!(
            gap.abs() <= i32::try_from(size).expect("a small cell"),
            "the cell has to sit against the line it belongs to: cell {cell:?}, line {line:?}"
        );
    }

    /// Feature: colour emoji measurement
    /// Scenario: two emoji in one cue are measured independently
    ///
    /// End to end through the real batching, the real probe and the real
    /// parser: two cells that share a cue can never be measured in one frame,
    /// so this only passes if the partition, the per-batch script and the
    /// matching of boxes back to occurrences all agree.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn two_emoji_in_one_cue_are_measured_independently() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let size = 72;
        let engine = ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
            crate::core::ffmpeg::FFmpegInfo {
                ffmpeg_path: ffmpeg,
                ffprobe_path: std::path::PathBuf::from("ffprobe"),
                version: "test".to_string(),
                is_bundled: false,
                source: crate::core::ffmpeg::FFmpegSource::System,
            },
        ));

        let occurrences = vec![
            EmojiOccurrence {
                event_index: 0,
                run_index: 0,
                start_sec: 0.0,
                end_sec: 5.0,
                sequence_key: "1f525".to_string(),
                size_play_res: size,
                rotation_deg: 0.0,
                scale_x_percent: 100.0,
                scale_y_percent: 100.0,
            },
            EmojiOccurrence {
                event_index: 0,
                run_index: 1,
                start_sec: 0.0,
                end_sec: 5.0,
                sequence_key: "1f600".to_string(),
                size_play_res: size,
                rotation_deg: 0.0,
                scale_x_percent: 100.0,
                scale_y_percent: 100.0,
            },
        ];

        let spacer = crate::core::render::export::ass_emoji_spacer_run(size);
        let marker = crate::core::render::export::ass_emoji_marker_run(size);
        let build_marker_script = move |markers: &HashSet<usize>| {
            let cell = |index: usize| {
                if markers.contains(&index) {
                    marker.clone()
                } else {
                    spacer.clone()
                }
            };
            // The text is hidden exactly the way the real emitter hides it,
            // so only the selected cell is on the frame.
            Ok(probe_script_with(
                &format!(
                    r"\an2{}",
                    crate::core::render::export::ASS_EMOJI_MARKER_HIDE_TAGS
                ),
                &format!("AAA{} BBB {}", cell(0), cell(1)),
            ))
        };

        let placements = measure_emoji_placements(
            &engine,
            &EmojiMeasureRequest {
                occurrences: &occurrences,
                build_marker_script: &build_marker_script,
                frame_width: 1920,
                frame_height: 1080,
                play_res_x: 1920,
                play_res_y: 1080,
                fps: 30.0,
                refused: &HashSet::new(),
            },
        )
        .await
        .expect("measurement runs");

        assert_eq!(placements.len(), 2, "both cells have to be found");
        assert_ne!(
            placements[0].x, placements[1].x,
            "two cells in one cue are at two different places: {placements:?}"
        );
        for placement in &placements {
            assert_eq!((placement.size_x, placement.size_y), (size, size));
        }
    }

    #[test]
    fn the_cache_key_ignores_the_window_a_script_was_rebased_into() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let at_zero = "[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,S,,0,0,0,,{\\an2}hi\n";
        let rebased = "[Events]\nDialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,{\\an2}hi\n";
        let instants = [(30usize, 1.0_f64)];

        assert_eq!(
            measurement_key(at_zero, &request, &instants, true),
            measurement_key(rebased, &request, &instants, true)
        );
    }

    #[test]
    fn the_cache_key_still_separates_two_different_layouts() {
        let request = EmojiMeasureRequest {
            occurrences: &[],
            build_marker_script: &|_| Ok(String::new()),
            frame_width: 1920,
            frame_height: 1080,
            play_res_x: 1920,
            play_res_y: 1080,
            fps: 30.0,
            refused: &HashSet::new(),
        };
        let one = "[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,S,,0,0,0,,{\\an2}hi\n";
        let other = "[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,S,,0,0,0,,{\\an2}hello\n";
        let instants = [(30usize, 1.0_f64)];

        assert_ne!(
            measurement_key(one, &request, &instants, true),
            measurement_key(other, &request, &instants, true)
        );

        // And the wrap setting is part of the layout, not part of the request:
        // the same script laid out with and without the Unicode line-breaking
        // algorithm breaks in different places, so it cannot share a key.
        assert_ne!(
            measurement_key(one, &request, &instants, true),
            measurement_key(one, &request, &instants, false),
            "boxes measured under one wrap setting must not be served for the other"
        );
    }
}
