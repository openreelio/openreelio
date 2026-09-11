//! Where libass actually put each caption, measured rather than predicted.
//!
//! QC wants one number per cue: the rectangle the burned-in caption occupies on
//! the canvas, so it can say whether the block clears the safe area, overflows
//! the frame, or collides with platform chrome. Until now that number came from
//! a per-character width model - a font size, an average advance, a guess at
//! where libass would break the line. A model is a second implementation of a
//! renderer we already ship: it is wrong about kerning, wrong about the
//! fallback face that drew the characters the primary could not, and wrong
//! about every line break in a script written without word spaces.
//!
//! So the rectangle is measured. The cue is rendered through the *same* ASS
//! script, the same embedded fonts, the same `fontsdir` decision and the same
//! `wrap_unicode` option the export burns in with, and the inked area is read
//! back with the `bbox` filter.
//!
//! # Alpha, not luma
//!
//! The colour-emoji probe next door measures luma (`format=gray,bbox`), which
//! is the right answer for a solid white marker on black. It is the wrong
//! answer here: a caption's outline, shadow and background box are usually
//! *black*, so over a black canvas they are invisible to a luma threshold - and
//! the extent QC cares about is the outer edge of the drawn decoration, not the
//! bright core of the glyphs. Measured over the same fixture, luma reports
//! `705..1215 x 970..1009` where alpha reports `703..1217 x 968..1011`: the two
//! pixels of outline on every side that a safe-area verdict lives or dies on.
//!
//! The canvas is therefore transparent and the *alpha* channel is measured.
//! Note where `format=rgba` sits in [`build_probe_args`]: it is attached to the
//! `color` source inside the `lavfi` input, not spliced into `-vf`. A bare
//! `color=c=black@0.0` negotiates a format with no alpha channel at all, and a
//! later `format=rgba` then fills alpha with 255 - which measures as a
//! full-frame box on every cue, indistinguishable from a caption that overflows
//! the frame. Attaching the conversion to the source is what makes the `@0.0`
//! survive.
//!
//! # One rectangle per frame
//!
//! `bbox` reports the bounding box of every inked pixel on the frame, so a
//! frame showing two text events at once returns their union - a rectangle that
//! belongs to neither. Rather than build a per-cue isolation script (which
//! would change the layout it is trying to measure), the cues are partitioned
//! by time: a cue whose every probe instant has no other text or caption event
//! live is *solo*, and the full-script box at those instants is that cue's box.
//! A cue that shares an instant with another event is recorded as unmeasurable
//! and left to the caller's predictor. The common project - one caption track,
//! cues back to back - is entirely solo and costs one FFmpeg run.
//!
//! # Three samples per cue
//!
//! At 25%, 50% and 75% of the cue, unioned. Not the first frame: a `{\fad}` cue
//! draws literally nothing on it, and a first-frame probe would report every
//! faded caption in the project as drawing no ink at all.

use std::{collections::HashMap, path::Path};

use super::export::{
    build_ass_text_overlay_script_in_window_with_emoji, ExportEngine, ExportError,
};
use crate::core::{
    effects::Effect,
    timeline::{Sequence, TrackKind},
};

/// How far inside a cue's end a frame time has to be to count as on the cue.
///
/// Shares its reasoning with the emoji probe's constant of the same name: a cue
/// is drawn on `[start, end)`, and `end * fps` computed in binary can land a few
/// ULPs above an integer - `(1.0 + 1.0 / 30.0) * 30.0` is `31.000000000000004` -
/// which makes `ceil` name the boundary frame as if it were one past it. A
/// nanosecond is four orders of magnitude below a frame interval at any rate
/// this renders at, so subtracting it can only ever undo that rounding.
const FRAME_BOUNDARY_EPSILON: f64 = 1e-9;

/// Where in a cue the probe samples it, as fractions of its length.
///
/// Never `0.0`. A cue carrying `{\fad(300,300)}` is fully transparent at its
/// own start, so a probe there reads an empty frame and reports the cue as
/// drawing no ink - which is the one verdict this module must never invent.
/// Three samples rather than one because a fade, a `\move` or a karaoke sweep
/// puts different pixels on screen at different moments, and the extent QC
/// wants is the union over the cue's life.
const PROBE_FRACTIONS: [f64; 3] = [0.25, 0.5, 0.75];

/// Alpha level at or above which a pixel counts as inked.
///
/// One, not zero. The filter includes every pixel whose value is `>= min_val`,
/// so `min_val=0` matches the fully transparent canvas as well and reports a
/// full-frame box for every cue - "no ink" and "overflows the frame" become the
/// same measurement. One still catches the faintest anti-aliased edge the
/// renderer can produce (alpha 1/255), and on a correct canvas it measures
/// identically to 0: the fixture in this module's tests reports the same
/// rectangle at 0, 1 and 32.
const BBOX_MIN_ALPHA: u32 = 1;

/// Ceiling on `select` terms in one probe, so a long project cannot build a
/// filtergraph argument the platform refuses to pass to a child process.
///
/// Each term is about fifteen characters, so this caps the expression near four
/// kilobytes - comfortably inside every `argv` limit this ships against, while
/// still measuring eighty cues in a single FFmpeg run.
const MAX_PROBE_FRAMES_PER_RUN: usize = 240;

/// The canvas rectangle a cue's ink occupies, as percentages of the canvas.
///
/// Percentages rather than pixels because that is the space safe-area rules are
/// written in, and because it makes the measurement independent of the size the
/// probe happened to render at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxPercent {
    /// Distance from the canvas's left edge to the box's left edge.
    pub left: f64,
    /// Distance from the canvas's left edge to the box's right edge.
    pub right: f64,
    /// Distance from the canvas's top edge to the box's top edge.
    pub top: f64,
    /// Distance from the canvas's top edge to the box's bottom edge.
    pub bottom: f64,
}

impl BoxPercent {
    /// Width of the box, in canvas percent.
    pub fn width(&self) -> f64 {
        self.right - self.left
    }

    /// Height of the box, in canvas percent.
    pub fn height(&self) -> f64 {
        self.bottom - self.top
    }
}

/// What one cue actually drew.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptionExtent {
    /// The clip that carries the cue, which is how the caller names it.
    pub clip_id: String,
    /// Cue start on the timeline's own clock, not the render window's.
    pub timeline_in_sec: f64,
    /// Cue end on the same clock.
    pub timeline_end_sec: f64,
    /// The measured rectangle, or `None` when nothing was measured.
    ///
    /// `None` with `no_ink` set is a cue that rendered nothing at all. `None`
    /// without it is a cue the probe could not run for; the coverage record
    /// says which.
    pub box_percent: Option<BoxPercent>,
    /// Whether the measured box touches a frame edge.
    ///
    /// libass clips at the frame, so an overflowing caption measures as a box
    /// flush against the edge and the overshoot is simply not in the picture.
    /// This flag says "overflow of unknown magnitude"; there is deliberately no
    /// estimate of how far, because re-rendering on a larger canvas would change
    /// the wrapping and measure a different caption.
    pub clipped: bool,
    /// Whether every sampled frame came back with no ink at all.
    ///
    /// A QC-worthy signal in its own right: a missing font, a fully transparent
    /// style, or a stray override tag that hid the text.
    pub no_ink: bool,
}

/// What the pass could not measure, and why.
///
/// The honesty record, mirroring the shape of the QC contrast and emoji
/// coverage reports: a caller that silently treated "not measured" as "measured
/// fine" would turn a probe failure into a clean bill of health.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CaptionExtentCoverage {
    /// Cues sharing a frame with another text or caption event.
    ///
    /// Not measured: one `bbox` rectangle cannot be attributed to one of two
    /// events drawn on the same frame. The caller falls back to its predictor.
    pub shared_frame_cue_ids: Vec<String>,
    /// Cues shorter than a frame interval, which no frame of this render shows.
    pub sub_frame_cue_ids: Vec<String>,
    /// Whether at least one probe run could not be completed.
    pub probe_failed: bool,
    /// Human-readable detail, for the report the caller prints.
    pub notes: Vec<String>,
}

/// Every cue's extent, plus what the pass could not reach.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CaptionExtentMeasurement {
    /// One entry per solo cue, in timeline order.
    pub extents: Vec<CaptionExtent>,
    /// What was left out.
    pub coverage: CaptionExtentCoverage,
}

/// Everything [`measure_caption_extents`] needs that is not the engine.
pub struct CaptionExtentRequest<'a> {
    /// The sequence whose captions are measured.
    pub sequence: &'a Sequence,
    /// The project's effects, which is where a text clip's words live.
    pub effects: &'a HashMap<String, Effect>,
    /// Width of the sequence canvas.
    ///
    /// The probe renders at exactly this size, so the pixels it reports are
    /// canvas pixels and need no rescaling. libass lays a script out against the
    /// frame it is drawn into, so measuring at any other size would measure a
    /// different set of line breaks.
    pub canvas_width: u32,
    /// Height of the sequence canvas, for the same reason.
    pub canvas_height: u32,
    /// Frame rate the probe grid uses, so sample instants land on real frames.
    pub fps: f64,
    /// Where the render's own clock begins on the timeline. `0.0` for a
    /// whole-project QC pass.
    pub window_start_sec: f64,
}

/// One cue, as both the script builder and the probe see it.
#[derive(Clone, Debug, PartialEq)]
struct CaptionCue {
    /// The clip that carries it.
    clip_id: String,
    /// Cue bounds on the timeline.
    timeline_in_sec: f64,
    timeline_end_sec: f64,
    /// Cue start on the render's clock, floored at zero exactly as
    /// `ass_timecode` floors the `Dialogue` line's own start.
    render_start_sec: f64,
    /// Cue end on the render's clock.
    render_end_sec: f64,
}

impl CaptionCue {
    /// Whether this cue is drawn at `instant`, on the render's clock.
    ///
    /// Half-open, so two cues that merely touch (`a.end == b.start`) are never
    /// both live: nothing is drawn at the instant a cue ends, and treating a
    /// touch as an overlap would make every back-to-back caption track
    /// unmeasurable.
    fn is_live_at(&self, instant: f64) -> bool {
        self.render_start_sec <= instant && instant < self.render_end_sec
    }

    /// The frames this cue can be probed on, or an empty vector when no frame
    /// of this render shows it.
    ///
    /// The fractions of [`PROBE_FRACTIONS`] are only *candidates*: a probe reads
    /// back a frame the graph actually produced, and the frames a cue is on are
    /// `ceil(start*fps) ..= ceil(end*fps - EPSILON) - 1`. Rounding a fraction
    /// can land outside that span for a short cue, so each candidate is clamped
    /// into it rather than trusted, and the result is deduplicated - a cue two
    /// frames long has all three fractions collapse onto the same one or two
    /// frames.
    ///
    /// Empty is the sub-frame cue: one shorter than a frame interval can fall
    /// entirely between two presentation times, so no frame ever shows it and
    /// there is nothing to measure.
    fn probe_frames(&self, fps: f64) -> Vec<u64> {
        if !fps.is_finite() || fps <= 0.0 {
            return Vec::new();
        }

        let start = self.render_start_sec;
        let end = self.render_end_sec;
        if !start.is_finite() || !end.is_finite() || end <= start {
            return Vec::new();
        }

        let first = (start * fps).ceil().max(0.0);
        let last = (end * fps - FRAME_BOUNDARY_EPSILON).ceil() - 1.0;
        if last < first {
            return Vec::new();
        }

        let mut frames: Vec<u64> = PROBE_FRACTIONS
            .iter()
            .map(|fraction| {
                let instant = start + (end - start) * fraction;
                (instant * fps).round().clamp(first, last) as u64
            })
            .collect();
        frames.sort_unstable();
        frames.dedup();
        frames
    }
}

/// A rectangle the `bbox` filter reported, in canvas pixels.
///
/// Edges are inclusive, which is what makes the right and bottom conversions in
/// [`box_to_percent`] add one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MeasuredBox {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

impl MeasuredBox {
    /// The smallest box containing both.
    fn union(self, other: Self) -> Self {
        Self {
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
            x2: self.x2.max(other.x2),
            y2: self.y2.max(other.y2),
        }
    }
}

/// Turns an inclusive pixel box into canvas percentages.
///
/// The right and bottom edges are `x2 + 1` and `y2 + 1` because `bbox` reports
/// the last *inked column*, and the extent a layout rule reasons about runs to
/// the far side of that column.
fn box_to_percent(measured: MeasuredBox, width: u32, height: u32) -> Option<BoxPercent> {
    if width == 0 || height == 0 {
        return None;
    }

    let width = f64::from(width);
    let height = f64::from(height);

    Some(BoxPercent {
        left: 100.0 * f64::from(measured.x1) / width,
        right: 100.0 * f64::from(measured.x2 + 1) / width,
        top: 100.0 * f64::from(measured.y1) / height,
        bottom: 100.0 * f64::from(measured.y2 + 1) / height,
    })
}

/// Whether a measured box is flush against any frame edge.
///
/// libass clips its own rendering at the frame, so a caption wider than the
/// picture measures as one exactly the width of the picture. The overshoot is
/// not in the image and cannot be recovered from it, so this is reported as a
/// flag rather than turned into a number.
fn touches_frame_edge(measured: MeasuredBox, width: u32, height: u32) -> bool {
    let right_edge = i64::from(width) - 1;
    let bottom_edge = i64::from(height) - 1;

    measured.x1 <= 0
        || measured.y1 <= 0
        || i64::from(measured.x2) >= right_edge
        || i64::from(measured.y2) >= bottom_edge
}

/// Enumerates the cues the ASS script builder will emit, in emission order.
///
/// Mirrors the loop in `build_ass_text_overlay_script_in_window_with_emoji`
/// exactly - same track filter, same clip filter, same timing rejections, same
/// window rejection - because the whole design rests on this list and that
/// builder's `Dialogue` lines describing the same set of cues in the same order.
/// A test in this module holds the two against each other.
///
/// The builder has no per-cue identity to hand back (its events are named
/// `OpenReelioText<n>` by position), so identity is taken from the clip, which
/// is what the caller reports against anyway.
fn enumerate_caption_cues(sequence: &Sequence, window_start_sec: f64) -> Vec<CaptionCue> {
    let mut cues = Vec::new();

    for track in &sequence.tracks {
        if !super::export::track_included_in_media_collection(track) {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            let carries_text = match track.kind {
                TrackKind::Caption => super::export::build_caption_text_effect(clip).is_some(),
                TrackKind::Video | TrackKind::Overlay => super::export::is_text_clip(clip),
                _ => false,
            };
            if !carries_text {
                continue;
            }

            let start = clip.place.timeline_in_sec;
            let end = clip.place.timeline_out_sec();
            if !start.is_finite() || !end.is_finite() || end <= start {
                continue;
            }

            // A clip that ended before the window opened contributes no event,
            // exactly as the builder drops it.
            let render_end = end - window_start_sec;
            if render_end < 0.0 {
                continue;
            }

            cues.push(CaptionCue {
                clip_id: clip.id.clone(),
                timeline_in_sec: start,
                timeline_end_sec: end,
                // `ass_timecode` floors a negative start at zero, so a cue
                // already on screen when the window opens is drawn from the
                // window's first frame.
                render_start_sec: (start - window_start_sec).max(0.0),
                render_end_sec: render_end,
            });
        }
    }

    cues
}

/// A cue with its probe frames, and whether it can be attributed a box.
#[derive(Clone, Debug, PartialEq)]
struct PlannedCue {
    cue: CaptionCue,
    /// Frames to probe. Empty for a sub-frame cue.
    frames: Vec<u64>,
    /// Whether another event is drawn on at least one of those frames.
    shares_a_frame: bool,
}

/// Splits the cues into the ones a single full-script probe can attribute and
/// the ones it cannot.
///
/// Purely a question of timing, answered before anything is rendered: a cue is
/// solo when no *other* cue is live at any of its probe instants. That is the
/// exact condition under which the one rectangle `bbox` reports for the frame is
/// this cue's rectangle and nothing else's.
///
/// The instants are frame times rather than the raw fractions, because a frame
/// time is what libass is actually asked to draw - two cues whose spans overlap
/// by less than half a frame may still never share a rendered frame.
fn plan_cues(cues: Vec<CaptionCue>, fps: f64) -> Vec<PlannedCue> {
    let framed: Vec<Vec<u64>> = cues.iter().map(|cue| cue.probe_frames(fps)).collect();

    cues.iter()
        .enumerate()
        .map(|(index, cue)| {
            let frames = framed[index].clone();
            let shares_a_frame = frames.iter().any(|frame| {
                let instant = *frame as f64 / fps;
                cues.iter()
                    .enumerate()
                    .any(|(other, candidate)| other != index && candidate.is_live_at(instant))
            });

            PlannedCue {
                cue: cue.clone(),
                frames,
                shares_a_frame,
            }
        })
        .collect()
}

/// Groups solo cues into runs small enough for one FFmpeg invocation.
///
/// Chunked on cue boundaries rather than frame boundaries so a cue's three
/// samples are never split across two runs: a run that failed would then leave
/// a cue with a partial union, which is a box smaller than the one that rendered
/// and therefore a safe-area verdict that is wrong in the dangerous direction.
fn chunk_by_frame_budget(indices: &[usize], frames_per_cue: &[usize]) -> Vec<Vec<usize>> {
    let mut chunks: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut budget = 0usize;

    for index in indices {
        let cost = frames_per_cue[*index];
        if !current.is_empty() && budget + cost > MAX_PROBE_FRAMES_PER_RUN {
            chunks.push(std::mem::take(&mut current));
            budget = 0;
        }
        current.push(*index);
        budget += cost;
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Measures every caption cue this render can attribute a rectangle to.
///
/// Only a setup error the caller could have avoided - a canvas with no pixels in
/// it, a frame rate that is not a number - is an `Err`. Everything else degrades
/// into [`CaptionExtentCoverage`]: a cue sharing a frame with another event, a
/// cue no frame shows, a probe run that could not spawn. A measurement pass that
/// failed an export would be a QC tool that broke the thing it was checking.
pub async fn measure_caption_extents(
    engine: &ExportEngine,
    request: &CaptionExtentRequest<'_>,
) -> Result<CaptionExtentMeasurement, ExportError> {
    if request.canvas_width == 0 || request.canvas_height == 0 {
        return Err(ExportError::InvalidSettings(
            "Caption extent measurement needs a non-zero canvas size".to_string(),
        ));
    }

    let fps = if request.fps.is_finite() && request.fps > 0.0 {
        request.fps
    } else {
        30.0
    };

    let cues = enumerate_caption_cues(request.sequence, request.window_start_sec);
    if cues.is_empty() {
        return Ok(CaptionExtentMeasurement::default());
    }

    // Built once. Every probe run reads the same script the burn-in would, so
    // the fonts, the `PlayRes`, the margins and the wrapping are the export's
    // and not a reconstruction of them.
    let Some(script) = build_ass_text_overlay_script_in_window_with_emoji(
        request.sequence,
        request.effects,
        request.window_start_sec,
        None,
    )?
    else {
        return Ok(CaptionExtentMeasurement::default());
    };

    let planned = plan_cues(cues, fps);
    let mut coverage = CaptionExtentCoverage::default();
    let mut solo: Vec<usize> = Vec::new();

    for (index, entry) in planned.iter().enumerate() {
        if entry.frames.is_empty() {
            coverage.sub_frame_cue_ids.push(entry.cue.clip_id.clone());
        } else if entry.shares_a_frame {
            coverage
                .shared_frame_cue_ids
                .push(entry.cue.clip_id.clone());
        } else {
            solo.push(index);
        }
    }

    if !coverage.shared_frame_cue_ids.is_empty() {
        coverage.notes.push(format!(
            "{} cue(s) share a frame with another text or caption event; one bbox rectangle cannot \
             be attributed to one of them",
            coverage.shared_frame_cue_ids.len()
        ));
    }
    if !coverage.sub_frame_cue_ids.is_empty() {
        coverage.notes.push(format!(
            "{} cue(s) are shorter than a frame at {fps:.3} fps, so no rendered frame shows them",
            coverage.sub_frame_cue_ids.len()
        ));
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("openreelio-caption-extent-")
        .tempdir()
        .map_err(ExportError::IoError)?;
    let script_path = temp_dir.path().join("caption-extent.ass");
    crate::core::fs::validate_filter_safe_path(&script_path, "Caption extent script path")
        .map_err(ExportError::InvalidSettings)?;
    tokio::fs::write(&script_path, &script.script)
        .await
        .map_err(ExportError::IoError)?;

    let frames_per_cue: Vec<usize> = planned.iter().map(|entry| entry.frames.len()).collect();
    let mut boxes: HashMap<usize, Option<MeasuredBox>> = HashMap::new();
    let mut failed: Vec<usize> = Vec::new();

    for chunk in chunk_by_frame_budget(&solo, &frames_per_cue) {
        let instants: Vec<(usize, u64, f64)> = chunk
            .iter()
            .flat_map(|index| {
                planned[*index]
                    .frames
                    .iter()
                    .map(move |frame| (*index, *frame, *frame as f64 / fps))
            })
            .collect();

        match run_probe(engine, request, &script, &script_path, &instants, fps).await {
            Ok(report) => {
                let printed = parse_bbox_frames(&report);
                for (index, _, instant) in &instants {
                    let measured = match_box_to_instant(&printed, *instant, fps);
                    let slot = boxes.entry(*index).or_default();
                    *slot = match (*slot, measured) {
                        (Some(existing), Some(found)) => Some(existing.union(found)),
                        (Some(existing), None) => Some(existing),
                        (None, found) => found,
                    };
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Caption extent measurement failed for {} cue(s); they keep the predicted \
                     extent: {error}",
                    chunk.len()
                );
                failed.extend(chunk.iter().copied());
            }
        }
    }

    if !failed.is_empty() {
        coverage.probe_failed = true;
        coverage.notes.push(format!(
            "{} cue(s) could not be probed; FFmpeg did not complete the measurement run",
            failed.len()
        ));
    }

    let extents = solo
        .iter()
        .filter(|index| !failed.contains(index))
        .map(|index| {
            let cue = &planned[*index].cue;
            let measured = boxes.get(index).copied().flatten();

            CaptionExtent {
                clip_id: cue.clip_id.clone(),
                timeline_in_sec: cue.timeline_in_sec,
                timeline_end_sec: cue.timeline_end_sec,
                box_percent: measured.and_then(|measured| {
                    box_to_percent(measured, request.canvas_width, request.canvas_height)
                }),
                clipped: measured.is_some_and(|measured| {
                    touches_frame_edge(measured, request.canvas_width, request.canvas_height)
                }),
                // Every sampled frame came back with no ink. Not a probe
                // failure - the run completed and libass drew nothing.
                no_ink: measured.is_none(),
            }
        })
        .collect();

    Ok(CaptionExtentMeasurement { extents, coverage })
}

// TODO(caption-extent-cache): adopt the process-global cache `emoji_measure`
// keeps, once a caller runs this more than once per project. The key has to
// carry everything the boxes depend on and nothing they do not: the script with
// its `Dialogue` timecode columns normalized out (layout does not move when a
// render window is rebased), the canvas width and height, the frame rate, the
// `wrap_unicode` answer for the binary in use, and the `fontsdir` option - the
// last two because they are properties of the host rather than of the script,
// and a process can change binaries under the cache. Left out of this first cut
// deliberately: the engine is correct without it and a wrong key would hand a
// caller boxes measured against a different layout.

/// Builds the probe command for one run.
///
/// Split out from the spawn so a test can assert on the exact graph without
/// needing FFmpeg - the graph is the load-bearing part of this module, and every
/// option in it is there to make the probe lay the script out the way the
/// burn-in does.
fn build_probe_args(
    request: &CaptionExtentRequest<'_>,
    script_path: &Path,
    instants: &[(usize, u64, f64)],
    fps: f64,
    fonts_dir_option: &str,
    wrap_unicode_option: &str,
) -> Vec<String> {
    use crate::core::effects::escape_ffmpeg_filter_value;

    let last_instant = instants
        .iter()
        .map(|(_, _, time)| *time)
        .fold(0.0_f64, f64::max);
    // Two frames of slack so the last probed frame is comfortably inside the
    // source rather than on its final presentation time.
    let duration = last_instant + 2.0 / fps;

    let mut frames: Vec<u64> = instants.iter().map(|(_, frame, _)| *frame).collect();
    frames.sort_unstable();
    frames.dedup();
    let select = frames
        .iter()
        .map(|frame| format!("eq(n\\,{frame})"))
        .collect::<Vec<_>>()
        .join("+");

    let script_text = script_path.to_string_lossy();
    let escaped_script = escape_ffmpeg_filter_value(script_text.as_ref());

    // `select` sits *before* `subtitles` so libass lays out only the frames
    // being measured rather than every frame of every cue. `select` preserves
    // presentation timestamps, so the timing the filter reads is unchanged.
    //
    // `metadata=mode=print` with no `file` writes through `av_log` at info
    // level, which `-loglevel error` throws away. `file=-` sends the report to
    // stdout, where nothing else in this command writes: the `null` muxer
    // produces no bytes.
    let filter = format!(
        "select='{select}',subtitles=filename='{escaped_script}':alpha=1{fonts_dir_option}\
         {wrap_unicode_option},alphaextract,bbox=min_val={BBOX_MIN_ALPHA},\
         metadata=mode=print:file=-"
    );

    vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        // `format=rgba` belongs to the *source*, not to `-vf`. A bare
        // `color=c=black@0.0` negotiates whatever format the next filter
        // accepts, which is routinely one without an alpha channel - and a
        // `format=rgba` further down then fills alpha with 255, so every cue
        // measures as a full-frame box. Converting at the source is what makes
        // the `@0.0` reach `alphaextract`.
        "-i".to_string(),
        format!(
            "color=c=black@0.0:s={}x{}:r={}:d={:.6},format=rgba",
            request.canvas_width,
            request.canvas_height,
            format_probe_number(fps),
            duration
        ),
        "-vf".to_string(),
        filter,
        // `-fps_mode passthrough`, not `-vsync 0`: FFmpeg 9 removed `-vsync`
        // outright, and an unrecognised option is a parse error before a single
        // frame is decoded - which reaches this pass as "nothing could be
        // measured". `passthrough` means the same thing and is accepted by 8.x
        // and 9.x alike.
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ]
}

/// Runs one probe and returns the metadata text it printed.
async fn run_probe(
    engine: &ExportEngine,
    request: &CaptionExtentRequest<'_>,
    script: &super::export::AssTextOverlayScript,
    script_path: &Path,
    instants: &[(usize, u64, f64)],
    fps: f64,
) -> Result<String, ExportError> {
    // Both spliced from the same answers the burn-in graph uses. A probe that
    // resolves fonts or breaks lines differently from the render measures a
    // layout the render never draws - and for a text-extent measurement that is
    // not a rounding error, it is a different rectangle.
    let fonts_dir_option = super::export::ass_fonts_dir_option(script.uses_host_fonts);
    let wrap_unicode_option = if engine.wraps_unicode_captions() {
        super::export::SUBTITLES_WRAP_UNICODE_OPTION
    } else {
        ""
    };

    let args = build_probe_args(
        request,
        script_path,
        instants,
        fps,
        &fonts_dir_option,
        wrap_unicode_option,
    );
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

/// Finds the box printed for one probe instant, if any.
///
/// Frames the filter printed no box for - which is what a frame with no ink on
/// it produces, not a zero-sized box at the origin - come back as `None`.
fn match_box_to_instant(
    printed: &[(f64, MeasuredBox)],
    instant: f64,
    fps: f64,
) -> Option<MeasuredBox> {
    // Half a frame: every probed instant is a frame time by construction, so
    // anything further away is a different frame.
    let tolerance = 0.5 / fps.max(f64::MIN_POSITIVE);

    printed
        .iter()
        .find(|(time, _)| (time - instant).abs() <= tolerance)
        .map(|(_, measured)| *measured)
}

/// Extracts `(pts_time, box)` pairs from the filter's printed metadata.
///
/// Adapted from the emoji probe's parser: same `metadata=mode=print` shape, and
/// the same rule that a frame whose four edges did not all arrive contributes
/// nothing rather than a partial rectangle.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track};

    // =========================================================================
    // Fixtures
    // =========================================================================

    fn cue(clip_id: &str, start: f64, end: f64) -> CaptionCue {
        CaptionCue {
            clip_id: clip_id.to_string(),
            timeline_in_sec: start,
            timeline_end_sec: end,
            render_start_sec: start,
            render_end_sec: end,
        }
    }

    /// A caption style in the shape `build_caption_text_effect` reads.
    fn caption_style(font_size: f64) -> serde_json::Value {
        serde_json::json!({
            "fontFamily": "Inter",
            "fontSize": font_size,
            "color": "#FFFFFF",
        })
    }

    /// A sequence with one caption track carrying `cues` of `(text, in, out)`.
    fn sequence_with_captions(cues: &[(&str, f64, f64)]) -> Sequence {
        sequence_with_captions_sized(cues, SequenceFormat::youtube_1080())
    }

    fn sequence_with_captions_sized(cues: &[(&str, f64, f64)], format: SequenceFormat) -> Sequence {
        let mut sequence = Sequence::new("Test", format);
        let mut track = Track::new_caption("Captions");

        for (text, start, end) in cues {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, end - start)
                .place_at(*start);
            clip.label = Some((*text).to_string());
            clip.caption_style = Some(caption_style(64.0));
            track.add_clip(clip);
        }

        sequence.add_track(track);
        sequence
    }

    /// An engine pointed at a binary that cannot possibly exist.
    fn engine_that_cannot_run() -> ExportEngine {
        ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
            crate::core::ffmpeg::FFmpegInfo {
                ffmpeg_path: std::path::PathBuf::from("ffmpeg-that-cannot-possibly-exist"),
                ffprobe_path: std::path::PathBuf::from("ffprobe-that-cannot-possibly-exist"),
                version: "test".to_string(),
                is_bundled: false,
                source: crate::core::ffmpeg::FFmpegSource::System,
            },
        ))
    }

    // =========================================================================
    // Box arithmetic
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: an inclusive pixel box becomes a canvas percentage
    ///
    /// The right and bottom edges advance by one because `bbox` names the last
    /// inked column, and a layout rule reasons about the far side of it. Getting
    /// this wrong by a pixel is invisible; getting it wrong by a column is a
    /// safe-area verdict that is off by a character.
    #[test]
    fn a_measured_box_converts_to_canvas_percent() {
        let measured = MeasuredBox {
            x1: 192,
            y1: 108,
            x2: 1727,
            y2: 971,
        };

        let percent = box_to_percent(measured, 1920, 1080).expect("a sized canvas converts");

        assert!((percent.left - 10.0).abs() < 1e-9, "{percent:?}");
        assert!((percent.right - 90.0).abs() < 1e-9, "{percent:?}");
        assert!((percent.top - 10.0).abs() < 1e-9, "{percent:?}");
        assert!((percent.bottom - 90.0).abs() < 1e-9, "{percent:?}");
        assert!((percent.width() - 80.0).abs() < 1e-9);
        assert!((percent.height() - 80.0).abs() < 1e-9);
    }

    /// Feature: caption extent measurement
    /// Scenario: a single inked pixel is one canvas pixel wide, not zero
    #[test]
    fn a_one_pixel_box_is_one_pixel_wide_in_percent() {
        let percent = box_to_percent(
            MeasuredBox {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            100,
            100,
        )
        .expect("a sized canvas converts");

        assert!((percent.width() - 1.0).abs() < 1e-9, "{percent:?}");
        assert!((percent.height() - 1.0).abs() < 1e-9, "{percent:?}");
    }

    /// Feature: caption extent measurement
    /// Scenario: a box against any frame edge is an overflow of unknown size
    ///
    /// libass clips at the frame, so a caption wider than the picture measures
    /// as one exactly the width of the picture. Reporting that as a clean
    /// "fits inside the frame" is the failure this flag exists to prevent.
    #[test]
    fn a_box_touching_any_frame_edge_is_flagged_as_clipped() {
        let inside = MeasuredBox {
            x1: 1,
            y1: 1,
            x2: 1918,
            y2: 1078,
        };
        assert!(!touches_frame_edge(inside, 1920, 1080));

        for edge in [
            MeasuredBox {
                x1: 0,
                y1: 1,
                x2: 1918,
                y2: 1078,
            },
            MeasuredBox {
                x1: 1,
                y1: 0,
                x2: 1918,
                y2: 1078,
            },
            MeasuredBox {
                x1: 1,
                y1: 1,
                x2: 1919,
                y2: 1078,
            },
            MeasuredBox {
                x1: 1,
                y1: 1,
                x2: 1918,
                y2: 1079,
            },
        ] {
            assert!(
                touches_frame_edge(edge, 1920, 1080),
                "{edge:?} sits on a frame edge"
            );
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: the samples of one cue are unioned, not averaged
    ///
    /// A `\move` or a karaoke sweep puts different pixels on screen at each
    /// sample, and the extent QC asks about is everything the cue ever covered.
    #[test]
    fn the_samples_of_one_cue_union_into_the_area_it_ever_covered() {
        let early = MeasuredBox {
            x1: 100,
            y1: 900,
            x2: 500,
            y2: 950,
        };
        let late = MeasuredBox {
            x1: 400,
            y1: 880,
            x2: 900,
            y2: 940,
        };

        assert_eq!(
            early.union(late),
            MeasuredBox {
                x1: 100,
                y1: 880,
                x2: 900,
                y2: 950
            }
        );
    }

    // =========================================================================
    // Sampling
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: a cue is sampled away from both of its edges
    ///
    /// Never the first frame: a `{\fad}` cue is fully transparent at its own
    /// start, and a first-frame probe reports every faded caption in a project
    /// as drawing no ink at all.
    #[test]
    fn a_cue_is_sampled_at_a_quarter_a_half_and_three_quarters() {
        // 0s to 4s at 30fps: the cue is on frames 0..=119, and the quarter,
        // half and three-quarter marks are 1s, 2s and 3s.
        assert_eq!(cue("a", 0.0, 4.0).probe_frames(30.0), vec![30, 60, 90]);
    }

    /// Feature: caption extent measurement
    /// Scenario: a short cue's samples collapse onto the frames it is on
    ///
    /// The fractions are real numbers and the probe reads frames, so rounding
    /// can name a frame the cue is not on. Probing that frame measures the cue
    /// that comes *next*, which is worse than measuring nothing.
    #[test]
    fn a_short_cues_samples_are_clamped_into_the_frames_it_is_on() {
        // Two frames at 30fps: 1.0 and 1.0333. All three fractions must land on
        // one of those two and nowhere else.
        let frames = cue("a", 1.0, 1.0 + 2.0 / 30.0).probe_frames(30.0);

        assert!(!frames.is_empty());
        for frame in &frames {
            assert!((30..=31).contains(frame), "frame {frame} is not on the cue");
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: the frame presented at the cue end is never sampled
    ///
    /// The span of frames a cue is on is half-open, but `end * fps` in binary is
    /// not: a product landing a few ULPs above an integer makes `ceil` offer the
    /// frame presented at exactly the cue end, where libass draws nothing.
    #[test]
    fn the_frame_presented_at_the_cue_end_is_never_sampled() {
        let start = 25.0 / 24.0;
        let frames = cue("a", start, start + 1.0 / 24.0).probe_frames(24.0);

        assert_eq!(
            frames,
            vec![25],
            "frame 25 is the only frame this cue is on"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue shorter than a frame has nothing to measure
    ///
    /// It can sit entirely between two presentation times, so no frame of this
    /// render shows it. Recorded as uncovered rather than measured as empty:
    /// "never drawn" and "drew nothing" are different QC findings.
    #[test]
    fn a_cue_that_falls_between_two_frames_has_no_frame_to_sample() {
        // 0.98s to 1.0s at 30fps: the frames are at 0.9667 and 1.0, and the cue
        // is on neither.
        let between = cue("a", 0.98, 1.0);
        assert!(between.probe_frames(30.0).is_empty());

        // The same cue at 60fps is on frame 59, and is measured normally.
        assert_eq!(between.probe_frames(60.0), vec![59]);
    }

    /// Feature: caption extent measurement
    /// Scenario: a nonsensical frame rate yields no samples rather than panics
    #[test]
    fn a_frame_rate_that_is_not_a_rate_yields_no_samples() {
        assert!(cue("a", 0.0, 4.0).probe_frames(0.0).is_empty());
        assert!(cue("a", 0.0, 4.0).probe_frames(f64::NAN).is_empty());
        assert!(cue("a", 0.0, f64::INFINITY).probe_frames(30.0).is_empty());
    }

    // =========================================================================
    // Solo versus shared
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: a single caption track is entirely measurable
    ///
    /// Back-to-back cues touch at their boundary, and a touch is not an overlap:
    /// nothing is drawn at the instant a cue ends. Treating it as one would make
    /// the ordinary project - one caption track, cues end to end - completely
    /// unmeasurable.
    #[test]
    fn back_to_back_cues_on_one_track_are_all_solo() {
        let planned = plan_cues(
            vec![cue("a", 0.0, 2.0), cue("b", 2.0, 4.0), cue("c", 4.0, 6.0)],
            30.0,
        );

        assert!(
            planned.iter().all(|entry| !entry.shares_a_frame),
            "{planned:#?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: two events live at once cannot be told apart
    ///
    /// `bbox` reports one rectangle per frame: the union of every inked pixel on
    /// it. A caption drawn at the same instant as a text overlay gives a box
    /// that belongs to neither, and attributing it to one of them would be a
    /// fabricated measurement.
    #[test]
    fn cues_that_share_a_frame_are_both_refused() {
        let planned = plan_cues(vec![cue("a", 0.0, 4.0), cue("b", 1.0, 3.0)], 30.0);

        assert!(
            planned.iter().all(|entry| entry.shares_a_frame),
            "{planned:#?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: an overlap that misses every sample instant is still solo
    ///
    /// The partition is about the frames actually probed, not about whether the
    /// spans intersect at all: a cue overlapping another only near its very end
    /// can still have all three of its own samples to itself.
    #[test]
    fn an_overlap_that_misses_every_sample_leaves_both_cues_solo() {
        // `a` samples at 1s, 2s and 3s; `b` samples at 4.25s, 4.5s and 4.75s.
        // They overlap on [3.9, 4.0) and share no sample instant.
        let planned = plan_cues(vec![cue("a", 0.0, 4.0), cue("b", 3.9, 5.0)], 30.0);

        assert!(!planned[0].shares_a_frame, "{planned:#?}");
        assert!(!planned[1].shares_a_frame, "{planned:#?}");
    }

    /// Feature: caption extent measurement
    /// Scenario: a sub-frame cue is uncovered, not shared
    #[test]
    fn a_sub_frame_cue_is_planned_with_no_frames_at_all() {
        let planned = plan_cues(vec![cue("a", 0.98, 1.0)], 30.0);

        assert!(planned[0].frames.is_empty());
        assert!(!planned[0].shares_a_frame);
    }

    // =========================================================================
    // Batching
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: a whole project's cues go into one FFmpeg run
    #[test]
    fn a_small_project_is_measured_in_a_single_run() {
        let frames = vec![3usize; 20];
        let indices: Vec<usize> = (0..20).collect();

        assert_eq!(chunk_by_frame_budget(&indices, &frames).len(), 1);
    }

    /// Feature: caption extent measurement
    /// Scenario: a long project is chunked on cue boundaries
    ///
    /// On cue boundaries rather than frame boundaries: a run that failed would
    /// otherwise leave a cue with a partial union, which is a box smaller than
    /// the one that rendered - a safe-area verdict wrong in the dangerous
    /// direction.
    #[test]
    fn a_long_project_is_chunked_without_splitting_a_cue() {
        let count = 200;
        let frames = vec![3usize; count];
        let indices: Vec<usize> = (0..count).collect();

        let chunks = chunk_by_frame_budget(&indices, &frames);

        assert!(chunks.len() > 1, "600 frames cannot be one run");
        assert_eq!(
            chunks.iter().map(Vec::len).sum::<usize>(),
            count,
            "every cue is measured exactly once"
        );
        for chunk in &chunks {
            assert!(chunk.len() * 3 <= MAX_PROBE_FRAMES_PER_RUN, "{chunk:?}");
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue larger than the budget still gets its own run
    #[test]
    fn a_cue_that_alone_exceeds_the_budget_is_not_dropped() {
        let frames = vec![MAX_PROBE_FRAMES_PER_RUN + 10, 3];

        assert_eq!(
            chunk_by_frame_budget(&[0, 1], &frames),
            vec![vec![0], vec![1]]
        );
    }

    // =========================================================================
    // Parsing
    // =========================================================================

    #[test]
    fn a_bbox_report_is_read_back_per_frame() {
        let output = "frame:0    pts:30      pts_time:1\n\
                      lavfi.bbox.x1=703\n\
                      lavfi.bbox.x2=1217\n\
                      lavfi.bbox.y1=968\n\
                      lavfi.bbox.y2=1011\n\
                      lavfi.bbox.w=515\n\
                      lavfi.bbox.h=44\n\
                      frame:1    pts:60      pts_time:2\n\
                      lavfi.bbox.x1=100\n\
                      lavfi.bbox.x2=172\n\
                      lavfi.bbox.y1=200\n\
                      lavfi.bbox.y2=272\n";

        let frames = parse_bbox_frames(output);

        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0].1,
            MeasuredBox {
                x1: 703,
                y1: 968,
                x2: 1217,
                y2: 1011
            }
        );
        assert_eq!(frames[1].0, 2.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a frame with no ink prints no box at all
    ///
    /// Absent tags are "libass drew nothing here", not a zero-sized box at the
    /// origin. Reading them as the latter would put every un-drawn cue in the
    /// top-left corner of the canvas, which a safe-area rule would happily pass.
    #[test]
    fn a_frame_the_filter_printed_no_box_for_is_no_measurement() {
        let printed = parse_bbox_frames(
            "frame:0    pts:30      pts_time:1\n\
             lavfi.bbox.x1=703\n\
             lavfi.bbox.x2=1217\n\
             lavfi.bbox.y1=968\n\
             lavfi.bbox.y2=1011\n",
        );

        assert!(match_box_to_instant(&printed, 1.0, 30.0).is_some());
        assert!(match_box_to_instant(&printed, 6.0, 30.0).is_none());
    }

    /// Feature: caption extent measurement
    /// Scenario: a half-printed frame contributes nothing
    #[test]
    fn a_frame_missing_an_edge_is_not_half_measured() {
        let printed = parse_bbox_frames(
            "frame:0    pts:30      pts_time:1\n\
             lavfi.bbox.x1=703\n\
             lavfi.bbox.y1=968\n",
        );

        assert!(printed.is_empty());
    }

    // =========================================================================
    // Cue enumeration
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: the cue list and the script describe the same events
    ///
    /// The load-bearing parity claim. The script builder names its events by
    /// position, so this module re-walks the sequence to attach a clip id to
    /// each one. If the two loops ever disagree about which clips become events,
    /// every measurement after the first disagreement is attributed to the wrong
    /// caption.
    #[test]
    fn every_enumerated_cue_is_an_event_the_script_emits() {
        let sequence = sequence_with_captions(&[
            ("First cue", 0.0, 2.0),
            ("Second cue", 2.0, 4.0),
            ("Third cue", 4.0, 6.0),
        ]);

        let cues = enumerate_caption_cues(&sequence, 0.0);
        let script = build_ass_text_overlay_script_in_window_with_emoji(
            &sequence,
            &HashMap::new(),
            0.0,
            None,
        )
        .expect("the script builds")
        .expect("the script has events");

        let dialogue_lines = script
            .script
            .lines()
            .filter(|line| line.starts_with("Dialogue:"))
            .count();

        assert_eq!(cues.len(), 3);
        assert_eq!(cues.len(), dialogue_lines);
    }

    /// Feature: caption extent measurement
    /// Scenario: an empty caption is not a cue
    ///
    /// `build_caption_text_effect` refuses a blank label, so the script emits no
    /// event for it - and a cue list that counted it would shift every
    /// subsequent attribution by one.
    #[test]
    fn a_caption_with_no_words_is_not_enumerated() {
        let sequence = sequence_with_captions(&[("   ", 0.0, 2.0), ("Real cue", 2.0, 4.0)]);

        let cues = enumerate_caption_cues(&sequence, 0.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 2.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a disabled clip draws nothing and is not enumerated
    #[test]
    fn a_disabled_caption_is_not_enumerated() {
        let mut sequence = sequence_with_captions(&[("Hidden", 0.0, 2.0), ("Shown", 2.0, 4.0)]);
        sequence.tracks[0].clips[0].enabled = false;

        let cues = enumerate_caption_cues(&sequence, 0.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 2.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a ranged render rebases the cue onto its own clock
    ///
    /// The probe's frame grid starts at the window, and `ass_timecode` floors a
    /// negative start at zero - so a cue already on screen when the window opens
    /// is drawn from the window's first frame, and has to be sampled there. The
    /// timeline bounds the caller reports against are untouched.
    #[test]
    fn a_ranged_render_rebases_the_cue_onto_the_windows_clock() {
        let sequence = sequence_with_captions(&[("Spanning", 8.0, 14.0)]);

        let cues = enumerate_caption_cues(&sequence, 10.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 8.0);
        assert_eq!(cues[0].timeline_end_sec, 14.0);
        assert_eq!(cues[0].render_start_sec, 0.0, "floored at the window");
        assert_eq!(cues[0].render_end_sec, 4.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue entirely in front of the window is dropped
    #[test]
    fn a_cue_that_ended_before_the_window_opened_is_not_enumerated() {
        let sequence = sequence_with_captions(&[("Gone", 0.0, 2.0), ("Here", 10.0, 12.0)]);

        let cues = enumerate_caption_cues(&sequence, 10.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 10.0);
    }

    // =========================================================================
    // The graph
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: the probe measures alpha over a transparent canvas
    ///
    /// Every clause here is load-bearing and was empirically wrong in at least
    /// one earlier shape:
    ///
    /// - `format=rgba` on the *source*. Spliced into `-vf` instead, the `color`
    ///   source negotiates a format with no alpha, the later conversion fills
    ///   alpha with 255, and every cue measures as a full-frame box.
    /// - `alpha=1` on `subtitles`. Without it libass leaves the alpha channel
    ///   untouched, and the probe reads the empty canvas it started with.
    /// - `min_val=1`, not 0. The filter includes pixels `>= min_val`, so 0
    ///   matches the transparent canvas too and makes "no ink" and "fills the
    ///   frame" the same measurement.
    /// - `select` before `subtitles`, so libass lays out three frames per cue
    ///   rather than every frame of the project.
    #[test]
    fn the_probe_graph_measures_alpha_over_a_transparent_canvas() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        let args = build_probe_args(
            &request,
            Path::new("script.ass"),
            &[(0, 30, 1.0), (0, 60, 2.0), (0, 90, 3.0)],
            30.0,
            "",
            "",
        );
        let input = args.iter().position(|arg| arg == "-i").expect("an input");
        let filter = args
            .iter()
            .position(|arg| arg == "-vf")
            .expect("a filter chain");

        assert_eq!(
            args[input + 1],
            "color=c=black@0.0:s=1920x1080:r=30:d=3.066667,format=rgba"
        );
        assert_eq!(
            args[filter + 1],
            "select='eq(n\\,30)+eq(n\\,60)+eq(n\\,90)',subtitles=filename='script.ass':alpha=1,\
             alphaextract,bbox=min_val=1,metadata=mode=print:file=-"
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-fps_mode", "passthrough"]));
    }

    /// Feature: caption extent measurement
    /// Scenario: the probe splices the same font and wrapping options the
    /// burn-in does
    ///
    /// Font determinism is fatal here in a way it is not for a colour emoji: the
    /// measurement *is* a statement about glyph metrics, so a probe that
    /// resolved a different face or broke lines differently measures a caption
    /// the export never draws.
    #[test]
    fn the_probe_graph_carries_the_burn_ins_fontsdir_and_wrapping() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1080,
            canvas_height: 1920,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        let args = build_probe_args(
            &request,
            Path::new("script.ass"),
            &[(0, 30, 1.0)],
            30.0,
            ":fontsdir='/usr/share/fonts'",
            super::super::export::SUBTITLES_WRAP_UNICODE_OPTION,
        );
        let filter = args
            .iter()
            .position(|arg| arg == "-vf")
            .expect("a filter chain");

        assert_eq!(
            args[filter + 1],
            "select='eq(n\\,30)',subtitles=filename='script.ass':alpha=1:\
             fontsdir='/usr/share/fonts':wrap_unicode=1,alphaextract,bbox=min_val=1,\
             metadata=mode=print:file=-"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: the probe renders at the sequence canvas, whatever it is
    ///
    /// libass lays a script out against the frame it is drawn into, so a probe
    /// at any other size measures a different set of line breaks. Rendering at
    /// the canvas also makes the reported pixels directly canvas-relative.
    #[test]
    fn the_probe_renders_at_the_sequence_canvas() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1080,
            canvas_height: 1920,
            fps: 25.0,
            window_start_sec: 0.0,
        };

        let args = build_probe_args(&request, Path::new("s.ass"), &[(0, 25, 1.0)], 25.0, "", "");
        let input = args.iter().position(|arg| arg == "-i").expect("an input");

        assert!(
            args[input + 1].contains("s=1080x1920"),
            "{}",
            args[input + 1]
        );
        assert!(args[input + 1].contains(":r=25:"), "{}", args[input + 1]);
    }

    // =========================================================================
    // Degradation
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: a canvas with no pixels is the one unrecoverable error
    #[tokio::test]
    async fn a_canvas_with_no_pixels_is_rejected() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 0,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        assert!(measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .is_err());
    }

    /// Feature: caption extent measurement
    /// Scenario: a project with no captions costs nothing
    #[tokio::test]
    async fn a_project_with_no_captions_never_spawns_a_probe() {
        let sequence = Sequence::new("Empty", SequenceFormat::youtube_1080());
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("no captions is not an error");

        assert_eq!(measurement, CaptionExtentMeasurement::default());
    }

    /// Feature: caption extent measurement
    /// Scenario: a probe that cannot run degrades into the coverage record
    ///
    /// A binary without `alphaextract`, a spawn that fails, a non-zero exit:
    /// none of them are reasons to fail the caller. The cues come back
    /// unmeasured and the coverage says so, which is what sends the caller back
    /// to its predictor.
    #[tokio::test]
    async fn a_probe_that_cannot_run_reports_a_failure_rather_than_an_empty_box() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0), ("Again", 4.0, 8.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("a probe that cannot run is not an error");

        assert!(measurement.coverage.probe_failed);
        assert!(
            measurement.extents.is_empty(),
            "a failed probe must not invent a no-ink verdict: {:?}",
            measurement.extents
        );
        assert!(!measurement.coverage.notes.is_empty());
    }

    /// Feature: caption extent measurement
    /// Scenario: overlapping cues are named in the coverage, not measured
    #[tokio::test]
    async fn overlapping_cues_are_recorded_as_unattributable() {
        let sequence = sequence_with_captions(&[("Under", 0.0, 4.0), ("Over", 1.0, 3.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("overlap is not an error");

        assert_eq!(measurement.coverage.shared_frame_cue_ids.len(), 2);
        assert!(measurement.extents.is_empty());
        // Nothing to probe, so nothing failed.
        assert!(!measurement.coverage.probe_failed);
    }

    // =========================================================================
    // Against a real libass
    // =========================================================================
    //
    // Everything above reasons about strings and numbers. These hand the real
    // binary a real script and read back what libass actually did, because the
    // design rests on claims no unit test can check: that a transparent canvas
    // survives to `alphaextract`, that the alpha box is the outer edge of the
    // decoration rather than the bright core of the glyphs, and that a faded cue
    // is still measurable away from its edges.

    /// The probe graph, run standalone against `script`, for one frame.
    ///
    /// Returns the box for that frame, or `None` when the frame carried no ink.
    fn probe_script(ffmpeg: &Path, script: &str, frame: u64, fps: f64) -> Option<MeasuredBox> {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("extent.ass");
        std::fs::write(&path, script).expect("write script");

        let wrap = if crate::core::ffmpeg::binary_supports_subtitles_wrap_unicode(ffmpeg) {
            super::super::export::SUBTITLES_WRAP_UNICODE_OPTION
        } else {
            ""
        };
        // Host fonts, always: these fixtures are hand-written and name families
        // the script carries no `[Fonts]` section for.
        let fonts = super::super::export::ass_fonts_dir_option(true);

        let sequence = Sequence::new("Probe", SequenceFormat::youtube_1080());
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps,
            window_start_sec: 0.0,
        };
        let args = build_probe_args(
            &request,
            &path,
            &[(0, frame, frame as f64 / fps)],
            fps,
            &fonts,
            wrap,
        );

        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        let output = command.args(&args).output().expect("ffmpeg runs");
        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        parse_bbox_frames(&String::from_utf8_lossy(&output.stdout))
            .first()
            .map(|(_, measured)| *measured)
    }

    /// A hand-written script in the shape the export writes.
    fn fixture_script(tags: &str, text: &str) -> String {
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
             Dialogue: 0,0:00:00.00,0:00:04.00,T,,60,60,60,,{{{tags}}}{text}\n"
        )
    }

    /// Feature: caption extent measurement
    /// Scenario: an ordinary caption measures to a sane box inside the frame
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn an_ordinary_caption_measures_inside_the_frame() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let measured = probe_script(
            &ffmpeg,
            &fixture_script(r"\an2", "Hello measured world"),
            30,
            30.0,
        )
        .expect("an ordinary caption draws ink");

        assert!(!touches_frame_edge(measured, 1920, 1080), "{measured:?}");

        let percent = box_to_percent(measured, 1920, 1080).expect("a sized canvas");
        assert!(
            percent.width() > 5.0 && percent.width() < 95.0,
            "a line of text is neither a dot nor the whole canvas: {percent:?}"
        );
        assert!(
            percent.height() > 1.0 && percent.height() < 25.0,
            "one line is one line tall: {percent:?}"
        );
        assert!(
            percent.bottom > 60.0,
            "an `\\an2` caption sits low in the frame: {percent:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: the alpha channel sees the decoration the luma channel cannot
    ///
    /// The premise of the whole module. A caption's outline and shadow are
    /// black, so over a black canvas a luma threshold measures only the bright
    /// core of the glyphs and reports a box a couple of pixels too small on
    /// every side - which is exactly the margin a safe-area verdict turns on.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn alpha_measures_the_outline_that_luma_is_blind_to() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let script = fixture_script(r"\an2", "Hello measured world");
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("extent.ass");
        std::fs::write(&path, &script).expect("write script");

        let alpha = probe_script(&ffmpeg, &script, 30, 30.0).expect("alpha sees the caption");

        // The emoji probe's graph, for comparison: luma over an opaque black
        // canvas.
        let escaped =
            crate::core::effects::escape_ffmpeg_filter_value(path.to_string_lossy().as_ref());
        let mut command = std::process::Command::new(&ffmpeg);
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
                "color=c=black:s=1920x1080:r=30:d=4",
                "-vf",
                &format!(
                    "select='eq(n\\,30)',subtitles=filename='{escaped}'{},format=gray,\
                     bbox=min_val=32,metadata=mode=print:file=-",
                    super::super::export::ass_fonts_dir_option(true)
                ),
                "-fps_mode",
                "passthrough",
                "-f",
                "null",
                "-",
            ])
            .output()
            .expect("ffmpeg runs");
        let luma = parse_bbox_frames(&String::from_utf8_lossy(&output.stdout))
            .first()
            .map(|(_, measured)| *measured)
            .expect("luma sees the glyph cores");

        assert!(
            alpha.x1 < luma.x1 && alpha.y1 < luma.y1 && alpha.x2 > luma.x2 && alpha.y2 > luma.y2,
            "the alpha box has to contain the luma box on every side: {alpha:?} against {luma:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a faded cue is still measured
    ///
    /// The reason the samples are at 25/50/75 rather than at the cue's first
    /// frame. A `{\fad(300,300)}` cue is fully transparent at its own start, so
    /// a first-frame probe reports it as drawing nothing - and a QC pass would
    /// call every faded caption in the project a rendering failure.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_faded_cue_is_measured_away_from_its_edges() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let script = fixture_script(r"\an2\fad(300,300)", "Fading in and out");

        // Frame 0 is the cue's own start, where the fade is fully transparent.
        assert!(
            probe_script(&ffmpeg, &script, 0, 30.0).is_none(),
            "a `\\fad` cue draws no ink on its first frame"
        );

        // The quarter mark, which is where this module actually samples.
        let measured = probe_script(&ffmpeg, &script, 30, 30.0)
            .expect("a faded cue is fully drawn a quarter of the way in");
        assert!(!touches_frame_edge(measured, 1920, 1080), "{measured:?}");
    }

    /// Feature: caption extent measurement
    /// Scenario: an unspaced run too long for the frame is flagged as clipped
    ///
    /// libass crops at the frame edge, so the overflow is simply not in the
    /// picture and its magnitude cannot be recovered. The flag is the honest
    /// answer; an estimate would be a number nobody measured.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_run_wider_than_the_frame_is_flagged_as_clipped() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        // No spaces and no wrapping opportunity in any script, so libass has
        // nowhere to break it.
        let overflowing = "M".repeat(200);
        let measured = probe_script(&ffmpeg, &fixture_script(r"\an2", &overflowing), 30, 30.0)
            .expect("an overflowing run still draws");

        assert!(
            touches_frame_edge(measured, 1920, 1080),
            "a 200-character unspaced run cannot fit in 1920px: {measured:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue with nothing to draw reports no ink
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_whitespace_only_cue_draws_no_ink() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        assert!(
            probe_script(&ffmpeg, &fixture_script(r"\an2", "     "), 30, 30.0).is_none(),
            "whitespace inks nothing"
        );
        assert!(
            probe_script(&ffmpeg, &fixture_script(r"\an2", ""), 30, 30.0).is_none(),
            "an empty cue inks nothing"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: an unspaced CJK cue wraps and measures inside the frame
    ///
    /// Japanese and Chinese are written without word spaces, so the only thing
    /// that makes libass break the line is `wrap_unicode` - the option the probe
    /// splices in because the burn-in does. Without it this cue lays out as a
    /// single line and crops at the frame edge, and the measurement would be a
    /// statement about a caption the export never draws.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn an_unspaced_cjk_cue_measures_inside_the_frame() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };
        if !crate::core::ffmpeg::binary_supports_subtitles_wrap_unicode(&ffmpeg) {
            eprintln!("Skipping test: this FFmpeg's subtitles filter has no wrap_unicode option");
            return;
        }

        // Long enough that a single line could not possibly fit.
        let cjk = "日本語のキャプションは単語の区切りに空白を使いません".repeat(2);
        let measured = probe_script(&ffmpeg, &fixture_script(r"\an2", &cjk), 30, 30.0)
            .expect("a CJK cue draws ink");

        let percent = box_to_percent(measured, 1920, 1080).expect("a sized canvas");
        assert!(
            measured.y2 - measured.y1 > 60,
            "the cue has to actually wrap onto several lines: {measured:?}"
        );
        assert!(
            percent.left > 0.0 && percent.right < 100.0,
            "a wrapped CJK cue stays inside the frame: {percent:?}"
        );
    }
}
