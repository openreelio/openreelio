//! Caption legibility against the rendered picture.
//!
//! Every other caption check reads the timeline: where the words sit, how long
//! they are up, whether two cues collide. None of them can answer the question
//! a viewer asks first — can I read this? — because that depends on what is
//! *behind* the words, and the timeline does not know. A run of white captions
//! over a white studio wall passed every check while being invisible.
//!
//! This module closes that hole from the pixels. For each caption cue that the
//! rendered file covers, it decodes one frame at the cue's midpoint, measures
//! the luminance of the band the cue occupies, and compares it with the
//! luminance of the text itself. A cue whose style already carries a background
//! box or an outline is never decoded: the mitigation settles the question
//! before a pixel is read, and skipping it keeps the pass cheap on the ordinary
//! project where every caption is outlined.
//!
//! # Two halves
//!
//! [`sample_caption_bands`] is the measurement — it needs FFmpeg, the rendered
//! file and the sequence — and [`CaptionContrastRule`] is the judgement, a pure
//! function of the samples carried in [`RenderMeasurements`]. The split is the
//! same one every other rendered check uses, so the rule stays testable without
//! a video file and the measurement pass stays outside the rule engine.
//!
//! # Mirroring the renderer
//!
//! "Already protected" has to mean what the *export* draws, not what the data
//! model would draw if every field were filled in. [`caption_paint`] therefore
//! reproduces the export pipeline's own gates, field for field:
//!
//! * **Outline** — `build_caption_text_effect` (`core::render::export`) copies
//!   `outline_color` into the effect only when the style JSON carries a
//!   parseable `outlineColor`/`outline_color`. Both renderers then key the
//!   stroke off that param's presence — the ASS path at the
//!   `effect.get_param("outline_color").is_some()` gate, the `drawtext` path at
//!   `if let Some(outline_color) = …` — with `outline_width` defaulting to 2
//!   only once the colour is there. A style carrying `outlineWidth` and no
//!   colour therefore renders bare, and so does a style with no `caption_style`
//!   at all.
//! * **Box** — same shape for `backgroundColor`/`background_color`, and a box
//!   whose alpha is zero is painted at zero opacity, which protects nothing.
//! * **Text colour** — the renderers fall back to `#FFFFFF`, not to
//!   [`CaptionStyle::default`](crate::core::captions::CaptionStyle::default), when the blob names no readable colour.
//!
//! Deriving any of this from [`CaptionStyle::default`](crate::core::captions::CaptionStyle::default) — which *does* carry a
//! two-pixel black outline — made the check skip exactly the bare captions it
//! exists to catch. The ideal fix is one shared predicate both sides call; the
//! renderer's gates are private to a module this check must not reach into, so
//! the mirror is pinned instead by
//! `should_agree_with_the_renderer_about_protection`, which drives the real
//! `drawtext` seam over the same fixtures this module grades.
//!
//! # Luminance
//!
//! Both sides are measured the same way: Rec. 709 weights over *gamma-encoded*
//! sRGB components, scaled to `0.0`–`1.0`. That is a perceptual proxy rather
//! than WCAG relative luminance (which linearises first), and it is used on
//! both sides of the comparison, so [`DEFAULT_MIN_CONTRAST`] is calibrated on
//! this scale and must not be read as a WCAG ratio.
//!
//! # Grading
//!
//! A band is judged on two numbers, because one is not enough. The mean answers
//! "is the picture the same tone as the words?", which catches white-on-white.
//! It says nothing about a band that is half black and half white: the mean
//! lands in the middle, every text colour clears it, and half the line is still
//! unreadable. So the spread is graded too — a band whose luminance standard
//! deviation exceeds [`DEFAULT_MAX_BAND_STDDEV`] is a mixed background, and a
//! cue with nothing to separate it from one is reported whatever the mean says.
//! Both numbers reach the report as `bandLuminance` and `bandLuminanceStddev`,
//! so an agent can see which half of the rule fired.
//!
//! # Coverage
//!
//! Not every candidate cue can be measured: a decode can fail, the run can hit
//! its deadline, the per-run frame cap can bite, and a cue can lie past the end
//! of a file shorter than the window that was declared for it. Those counts are
//! carried in [`CaptionSampleCoverage`] and reported as an informational
//! finding, because "we measured none of them" must never reach an agent as
//! `passed`.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use super::context::QCContext;
use super::rules::{CheckCategory, QCRule, RuleConfig};
use super::violation::{QCViolation, Severity, ViolationFix};
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::process::configure_tokio_command;
use crate::core::project::ProjectState;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::{CoreError, CoreResult};

/// Stable check ID reported to agents.
pub const CAPTION_CONTRAST_CHECK_ID: &str = "caption.contrast";

/// Smallest luminance separation, on 0–1, a bare caption needs to be legible.
///
/// Below this the words and the picture behind them read as one tone. It is a
/// difference on the gamma-encoded scale described in the module docs, not a
/// WCAG contrast ratio.
pub const DEFAULT_MIN_CONTRAST: f64 = 0.35;

/// Largest luminance spread, on 0–1, a band may have and still be one tone.
///
/// Above this the band is not a background the text sits on, it is several: a
/// caption crossing a hard edge between a dark shot and a blown-out window is
/// unreadable over half its length however comfortable the mean looks. See the
/// module docs for why both numbers are graded.
pub const DEFAULT_MAX_BAND_STDDEV: f64 = 0.2;

/// Most frames one run will decode, however many cues need looking at.
///
/// A talk with auto-generated captions has hundreds of cues, and a check that
/// spawns hundreds of FFmpeg seeks is a check nobody runs. Beyond the cap the
/// candidates are sampled evenly across the file and the report says so.
pub const DEFAULT_MAX_SAMPLED_FRAMES: usize = 60;

/// Width the sampled frame is scaled to before the band is cropped.
///
/// The measurement is a mean and a spread over a band, both of which survive
/// downscaling; decoding a 4K frame to compute them does not pay for itself.
const SAMPLE_MAX_WIDTH: u32 = 320;

/// Watchdog for a single frame decode.
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Budget for the whole sampling pass when the caller names none.
const SAMPLE_RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Largest raw frame payload read from one decode, in bytes.
///
/// The pipe is bounded by construction (`SAMPLE_MAX_WIDTH` × one band × 3), so
/// this only bites if FFmpeg is asked for something other than what this module
/// asks for. It is enforced *while* reading rather than afterwards, so a wrong
/// filter can never buffer a whole 4K frame into memory before being refused.
const MAX_RAW_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Largest diagnostic payload kept from one decode, in bytes.
const MAX_STDERR_BYTES: u64 = 64 * 1024;

/// Caption pack suggested for a cue that cannot be read.
///
/// `standard-outline` and not `boxed-contrast`, even though both now render
/// (background boxes burn in since the ASS border-colour fix): an outline
/// survives *any* background, including the mixed one this check also grades,
/// while a box is a design decision about the frame that the project may not
/// want. The weaker-looking fix is the one that is always right.
const CONTRAST_STYLE_PACK: &str = "standard-outline";

// =============================================================================
// Samples
// =============================================================================

/// One caption cue's band, as measured in the rendered file.
///
/// Carried in [`RenderMeasurements`](super::context::RenderMeasurements) so the
/// grading rule is a pure function of measured numbers, exactly like the black,
/// freeze and loudness checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionBandSample {
    /// Caption clip the sample belongs to
    pub clip_id: String,
    /// Track the caption clip sits on
    pub track_id: String,
    /// First timeline second of the cue
    pub start_sec: f64,
    /// Timeline second the cue ends on
    pub end_sec: f64,
    /// Timeline second the decoded frame was taken at
    pub sampled_at_sec: f64,
    /// Mean luminance of the caption band, 0–1
    pub band_luminance: f64,
    /// Standard deviation of luminance across the band, 0–1
    pub band_luminance_stddev: f64,
    /// Luminance of the cue's effective text colour, 0–1
    pub text_luminance: f64,
    /// Whether the cue carries an opaque-enough background box
    pub has_box: bool,
    /// Whether the cue carries an outline
    pub has_outline: bool,
}

impl CaptionBandSample {
    /// Separation between the text and what sits behind it, 0–1.
    pub fn contrast(&self) -> f64 {
        (self.text_luminance - self.band_luminance).abs()
    }
}

/// How much of the work a sampling pass actually got done.
///
/// A rendered check that measured nothing looks exactly like one that measured
/// everything and found nothing wrong, so the counts travel with the samples
/// and the rule reports what it could not look at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSampleCoverage {
    /// Unprotected cues the declared window holds
    pub cues: usize,
    /// Cues whose band was measured
    pub sampled: usize,
    /// Cues whose frame could not be decoded
    pub decode_failures: usize,
    /// Cues lying past the end of the file that was measured
    pub beyond_file: usize,
    /// Cues dropped by the per-run frame cap
    pub over_cap: usize,
    /// Cues dropped because the pass ran out of time
    pub timed_out: usize,
}

impl CaptionSampleCoverage {
    /// Cues that were candidates and never produced a measurement.
    pub fn unmeasured(&self) -> usize {
        self.cues.saturating_sub(self.sampled)
    }

    /// Why cues went unmeasured, as a phrase for the report, or `None`.
    pub fn reasons(&self) -> Option<String> {
        let parts: Vec<String> = [
            (self.decode_failures, "could not decode"),
            (self.beyond_file, "beyond the file"),
            (self.over_cap, "over the frame cap"),
            (self.timed_out, "out of time"),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, reason)| format!("{count} {reason}"))
        .collect();

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(", "))
        }
    }
}

/// Everything one sampling pass produced, including what it could not do.
#[derive(Debug, Clone, Default)]
pub struct CaptionBandSampling {
    /// Bands that were measured
    pub samples: Vec<CaptionBandSample>,
    /// What the pass managed to cover
    pub coverage: CaptionSampleCoverage,
    /// Remarks worth putting in the report's `warnings`
    pub notes: Vec<String>,
}

/// How the sampling pass is bounded.
#[derive(Debug, Clone)]
pub struct CaptionSampleOptions {
    /// Most frames to decode in one run
    pub max_frames: usize,
    /// Width the frame is scaled to before cropping the band
    pub max_width: u32,
    /// Watchdog for a single decode
    pub timeout: Duration,
    /// Budget for the whole pass, across every decode it makes
    ///
    /// A per-decode watchdog alone cannot bound the pass: sixty cues each
    /// stopping one second short of their own timeout is still an hour. The
    /// caller's `--timeout-sec` is the run's budget, so it belongs here.
    pub run_timeout: Duration,
    /// Running time of the file being measured, when it is known
    ///
    /// A file can be shorter than the window declared for it — a render that
    /// stopped early, a window that overshoots the edit — and seeking past its
    /// end returns the last frame rather than nothing. A cue past this point is
    /// reported as unmeasurable instead of graded against the wrong shot.
    pub file_duration_sec: Option<f64>,
}

impl Default for CaptionSampleOptions {
    fn default() -> Self {
        Self {
            max_frames: DEFAULT_MAX_SAMPLED_FRAMES,
            max_width: SAMPLE_MAX_WIDTH,
            timeout: SAMPLE_TIMEOUT,
            run_timeout: SAMPLE_RUN_TIMEOUT,
            file_duration_sec: None,
        }
    }
}

// =============================================================================
// Style reading
// =============================================================================

/// What a cue's style says about the words themselves.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CaptionPaint {
    /// Luminance of the text colour, 0–1
    text_luminance: f64,
    /// Whether a background box will be drawn behind the words
    has_box: bool,
    /// Whether the glyphs are outlined
    has_outline: bool,
}

impl CaptionPaint {
    /// Whether the style already protects the words from their background.
    fn is_mitigated(&self) -> bool {
        self.has_box || self.has_outline
    }
}

/// Luminance of a colour the renderer resolved, on gamma-encoded RGB, 0–1.
fn rgb_luminance(red: f64, green: f64, blue: f64) -> f64 {
    (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0
}

/// Text colour the renderers fall back to when the style names none.
const DEFAULT_TEXT_LUMINANCE: f64 = 1.0;

/// A colour a caption style named, as the renderer reads it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PaintColour {
    luminance: f64,
    /// Alpha on 0–1; `1.0` when the style names none, as the renderer assumes
    alpha: f64,
}

impl PaintColour {
    /// Whether the viewer can see anything of this colour at all.
    fn is_visible(&self) -> bool {
        self.alpha > 0.0
    }
}

/// Reads a colour the way `parse_caption_color` does in the export pipeline.
///
/// Accepts both shapes the stored style uses — a `#RGB`/`#RGBA`/`#RRGGBB`/
/// `#RRGGBBAA` string and an `{r, g, b, a}` object — because both reach the
/// renderer and both must reach this check the same way. Anything else is no
/// colour at all, which is how the renderer treats it too.
fn parse_paint_colour(value: &serde_json::Value) -> Option<PaintColour> {
    if let Some(text) = value.as_str() {
        return parse_hex_paint_colour(text);
    }

    let object = value.as_object()?;
    let red = json_number(object.get("r").or_else(|| object.get("red"))?)?.clamp(0.0, 255.0);
    let green = json_number(object.get("g").or_else(|| object.get("green"))?)?.clamp(0.0, 255.0);
    let blue = json_number(object.get("b").or_else(|| object.get("blue"))?)?.clamp(0.0, 255.0);
    let alpha = object
        .get("a")
        .or_else(|| object.get("alpha"))
        .and_then(json_number)
        .map(|alpha| alpha.clamp(0.0, 255.0) / 255.0)
        .unwrap_or(1.0);

    Some(PaintColour {
        luminance: rgb_luminance(red, green, blue),
        alpha,
    })
}

/// Reads a hex colour string, with or without its alpha pair.
fn parse_hex_paint_colour(raw: &str) -> Option<PaintColour> {
    let mut hex = raw.trim().trim_start_matches('#').to_string();
    if hex.is_empty() || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return None;
    }
    if hex.len() == 3 || hex.len() == 4 {
        hex = hex
            .chars()
            .flat_map(|character| [character, character])
            .collect();
    }
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }

    let component = |offset: usize| -> Option<f64> {
        u8::from_str_radix(hex.get(offset..offset + 2)?, 16)
            .ok()
            .map(f64::from)
    };
    let alpha = if hex.len() == 8 {
        component(6)? / 255.0
    } else {
        1.0
    };

    Some(PaintColour {
        luminance: rgb_luminance(component(0)?, component(2)?, component(4)?),
        alpha,
    })
}

/// Reads a number the way the export pipeline's `parse_json_number` does.
fn json_number(value: &serde_json::Value) -> Option<f64> {
    let parsed = match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    };
    parsed.filter(|number| number.is_finite())
}

/// Returns the first of `keys` present in a JSON object.
fn style_field<'a>(
    style: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|key| style.get(*key))
}

/// Reads the paint a caption clip's stored style JSON will actually render as.
///
/// This is the mirror of the export pipeline described in the module docs: a
/// style is protection only when the renderer would draw it, so a missing blob,
/// a blob that is not an object, an outline width with no outline colour and a
/// fully transparent box all come back bare.
fn caption_paint(style: Option<&serde_json::Value>) -> CaptionPaint {
    let bare = CaptionPaint {
        text_luminance: DEFAULT_TEXT_LUMINANCE,
        has_box: false,
        has_outline: false,
    };

    // `build_caption_text_effect` reads `clip.caption_style.as_object()`; a
    // missing or non-object blob sets no style param at all, and the renderers
    // then draw white text with no decoration whatsoever.
    let Some(style) = style.and_then(serde_json::Value::as_object) else {
        return bare;
    };

    let text_luminance = style_field(style, &["color"])
        .and_then(parse_paint_colour)
        .map(|colour| colour.luminance)
        .unwrap_or(DEFAULT_TEXT_LUMINANCE);

    let has_box = style_field(style, &["backgroundColor", "background_color"])
        .and_then(parse_paint_colour)
        .is_some_and(|colour| colour.is_visible());

    // The outline is keyed off the colour, exactly as both renderers key it:
    // no `outlineColor`, no stroke, whatever `outlineWidth` says. The width
    // then defaults to the renderer's own 2 and is rounded the same way, so a
    // sub-half-pixel width reads as the nothing it renders as.
    let has_outline = style_field(style, &["outlineColor", "outline_color"])
        .and_then(parse_paint_colour)
        .is_some_and(|colour| {
            let width = style_field(style, &["outlineWidth", "outline_width"])
                .and_then(json_number)
                .unwrap_or(2.0)
                .clamp(0.0, 100.0)
                .round();
            colour.is_visible() && width > 0.0
        });

    CaptionPaint {
        text_luminance,
        has_box,
        has_outline,
    }
}

// =============================================================================
// Cue selection
// =============================================================================

/// A caption cue that is a candidate for sampling.
#[derive(Debug, Clone)]
struct CaptionCue {
    clip_id: String,
    track_id: String,
    start_sec: f64,
    end_sec: f64,
    /// Timeline second the frame is taken at
    midpoint_sec: f64,
    /// Band the words occupy, as `(top, bottom)` percentages of canvas height
    band_percent: (f64, f64),
    paint: CaptionPaint,
}

/// Returns the caption cues a file covering `window` could be asked about.
///
/// Cues with no text are not cues, and cues the style already protects are
/// excluded here rather than after decoding: the mitigation is the answer, and
/// paying for a frame to confirm it would make the check cost scale with the
/// captions that are already fine.
fn sampling_candidates(
    sequence: &Sequence,
    window: (f64, f64),
    canvas_width: u32,
    canvas_height: u32,
) -> Vec<CaptionCue> {
    let (window_start, window_end) = window;
    let mut cues: Vec<CaptionCue> = Vec::new();

    for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
        for clip in &track.clips {
            let Some(cue) = caption_cue(track, clip, canvas_width, canvas_height) else {
                continue;
            };
            if cue.paint.is_mitigated() {
                continue;
            }
            if cue.start_sec >= window_end || cue.end_sec <= window_start {
                continue;
            }
            // The midpoint of a cue that only partly overlaps the file would
            // fall outside it, so the sample is taken in the middle of the part
            // the file actually holds.
            let overlap_start = cue.start_sec.max(window_start);
            let overlap_end = cue.end_sec.min(window_end);
            if overlap_end <= overlap_start {
                continue;
            }
            cues.push(CaptionCue {
                midpoint_sec: (overlap_start + overlap_end) / 2.0,
                ..cue
            });
        }
    }

    cues.sort_by(|left, right| {
        left.midpoint_sec
            .partial_cmp(&right.midpoint_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    cues
}

/// Builds a cue from a caption clip, or `None` when there is nothing to read.
fn caption_cue(
    track: &Track,
    clip: &Clip,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<CaptionCue> {
    let text = clip.label.as_ref().map(|label| label.trim())?;
    if text.is_empty() {
        return None;
    }

    let start_sec = clip.place.timeline_in_sec;
    let end_sec = clip.timeline_end();
    if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
        return None;
    }

    Some(CaptionCue {
        clip_id: clip.id.clone(),
        track_id: track.id.clone(),
        start_sec,
        end_sec,
        midpoint_sec: (start_sec + end_sec) / 2.0,
        band_percent: super::rules::caption_band_percent(clip, canvas_width, canvas_height),
        paint: caption_paint(clip.caption_style.as_ref()),
    })
}

/// Last timeline second a decode can honestly be aimed at.
///
/// The declared window, unless the file that was measured is shorter than it:
/// seeking past the end of a file yields its last frame rather than an error,
/// so a cue beyond this point would be graded against a picture from somewhere
/// else entirely.
fn decodable_end_sec(window: (f64, f64), file_duration_sec: Option<f64>) -> f64 {
    match file_duration_sec {
        Some(duration) if duration.is_finite() && duration > 0.0 => {
            (window.0 + duration).min(window.1)
        }
        _ => window.1,
    }
}

/// Picks at most `limit` items, spread evenly across the list.
///
/// Taking the first `limit` would sample the head of the programme and call the
/// tail clean; an even spread keeps the answer about the whole file.
fn spread_evenly<T>(items: Vec<T>, limit: usize) -> Vec<T> {
    if limit == 0 {
        return Vec::new();
    }
    if items.len() <= limit {
        return items;
    }

    let total = items.len();
    let step = total as f64 / limit as f64;
    let mut kept: Vec<T> = Vec::with_capacity(limit);
    let mut last_index: Option<usize> = None;

    for (position, item) in items.into_iter().enumerate() {
        let wanted = ((kept.len() as f64) * step).floor() as usize;
        if kept.len() < limit && position >= wanted && last_index != Some(position) {
            last_index = Some(position);
            kept.push(item);
        }
    }

    kept
}

// =============================================================================
// Measurement
// =============================================================================

/// Measures the caption bands of a rendered file.
///
/// `window` is the timeline span the file holds — `(0.0, output_duration)` for
/// a whole-sequence render — so a cue's timeline midpoint is decoded at
/// `midpoint - window.0` in the file.
///
/// A decode that fails is a note, never an error: one unreadable second must
/// not cost the caller the rest of the report. Everything the pass could not
/// look at is counted in [`CaptionBandSampling::coverage`], so the rule can say
/// so rather than let it read as a clean result.
pub async fn sample_caption_bands(
    runner: &FFmpegRunner,
    file: &Path,
    sequence: &Sequence,
    window: (f64, f64),
    options: &CaptionSampleOptions,
) -> CaptionBandSampling {
    let canvas_width = sequence.format.canvas.width;
    let canvas_height = sequence.format.canvas.height;

    let candidates = sampling_candidates(sequence, window, canvas_width, canvas_height);
    let mut sampling = CaptionBandSampling {
        coverage: CaptionSampleCoverage {
            cues: candidates.len(),
            ..CaptionSampleCoverage::default()
        },
        ..CaptionBandSampling::default()
    };

    // A file shorter than the window it was declared for cannot answer for the
    // cues past its end, and saying so is the only honest answer available.
    let decodable_end = decodable_end_sec(window, options.file_duration_sec);
    let reachable: Vec<CaptionCue> = candidates
        .into_iter()
        .filter(|cue| cue.midpoint_sec <= decodable_end)
        .collect();
    sampling.coverage.beyond_file = sampling.coverage.cues - reachable.len();
    if sampling.coverage.beyond_file > 0 {
        sampling.notes.push(format!(
            "caption.contrast could not decode {} caption cue(s) that lie past the end of the \
             measured file; those cues were not graded",
            sampling.coverage.beyond_file
        ));
    }

    let reachable_count = reachable.len();
    let selected = spread_evenly(reachable, options.max_frames);
    sampling.coverage.over_cap = reachable_count - selected.len();
    if sampling.coverage.over_cap > 0 {
        sampling.notes.push(format!(
            "caption.contrast sampled {} of {} unprotected caption cue(s): the check decodes at \
             most {} frames per run, spread evenly across the file",
            selected.len(),
            reachable_count,
            options.max_frames
        ));
    }

    // One deadline for the pass, so a run cannot cost the caller's whole
    // `--timeout-sec` once per cue.
    let deadline = Instant::now().checked_add(options.run_timeout);
    let mut remaining = selected.into_iter().peekable();
    while let Some(cue) = remaining.next() {
        let budget = match deadline {
            Some(deadline) => deadline.saturating_duration_since(Instant::now()),
            None => options.timeout,
        };
        if budget.is_zero() {
            // This cue and every one after it.
            sampling.coverage.timed_out = 1 + remaining.count();
            break;
        }

        let file_time_sec = (cue.midpoint_sec - window.0).max(0.0);
        match measure_band(
            runner,
            file,
            file_time_sec,
            cue.band_percent,
            options.max_width,
            options.timeout.min(budget),
        )
        .await
        {
            Ok((mean, stddev)) => sampling.samples.push(CaptionBandSample {
                clip_id: cue.clip_id,
                track_id: cue.track_id,
                start_sec: cue.start_sec,
                end_sec: cue.end_sec,
                sampled_at_sec: cue.midpoint_sec,
                band_luminance: mean,
                band_luminance_stddev: stddev,
                text_luminance: cue.paint.text_luminance,
                has_box: cue.paint.has_box,
                has_outline: cue.paint.has_outline,
            }),
            Err(error) => {
                sampling.coverage.decode_failures += 1;
                tracing::debug!(
                    "caption band sample failed at {:.2}s: {}",
                    file_time_sec,
                    error
                );
            }
        }
    }

    sampling.coverage.sampled = sampling.samples.len();

    if sampling.coverage.decode_failures > 0 {
        sampling.notes.push(format!(
            "caption.contrast could not decode {} caption frame(s); those cues were not graded",
            sampling.coverage.decode_failures
        ));
    }
    if sampling.coverage.timed_out > 0 {
        sampling.notes.push(format!(
            "caption.contrast ran out of time after {}s with {} caption cue(s) left to sample",
            options.run_timeout.as_secs(),
            sampling.coverage.timed_out
        ));
    }

    sampling
}

/// Builds the filter chain that isolates a caption band.
///
/// The frame is scaled first and cropped second, so the crop arithmetic runs on
/// a bounded picture and can never ask for a zero-height strip: `max(1,…)` and
/// `min(ih-1,…)` keep the window inside the scaled frame whatever the band
/// percentages say.
fn band_filter(band_percent: (f64, f64), max_width: u32) -> String {
    let (top, bottom) = band_percent;
    let top_fraction = (top / 100.0).clamp(0.0, 1.0);
    let height_fraction = ((bottom - top) / 100.0).clamp(0.0, 1.0);

    format!(
        "scale=w='min({},iw)':h=-2,crop=w=iw:h='max(1,floor(ih*{:.6}))':x=0:y='min(ih-1,floor(ih*{:.6}))',format=rgb24",
        max_width.max(1),
        height_fraction,
        top_fraction
    )
}

/// Decodes one frame and returns `(mean, stddev)` luminance over the band.
///
/// Both pipes are read through bounded readers, so an FFmpeg that writes more
/// than the band can hold is refused while it writes rather than after the
/// whole payload has been buffered.
async fn measure_band(
    runner: &FFmpegRunner,
    file: &Path,
    time_sec: f64,
    band_percent: (f64, f64),
    max_width: u32,
    timeout: Duration,
) -> CoreResult<(f64, f64)> {
    let args = [
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-nostdin".to_string(),
        "-ss".to_string(),
        format!("{:.6}", time_sec.max(0.0)),
        "-i".to_string(),
        file.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        band_filter(band_percent, max_width),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "pipe:1".to_string(),
    ];

    let mut command = tokio::process::Command::new(&runner.info().ffmpeg_path);
    configure_tokio_command(&mut command);
    let mut child = command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CoreError::Internal(format!("Caption band decode failed: {error}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Internal("Caption band decode opened no output".to_string()))?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CoreError::Internal("Caption band decode opened no error pipe".to_string())
    })?;

    // One byte past the cap, so "the decode wrote too much" is detectable
    // without ever holding more than the cap plus that byte.
    let mut bounded_stdout = stdout.take(MAX_RAW_FRAME_BYTES as u64 + 1);
    let mut bounded_stderr = stderr.take(MAX_STDERR_BYTES);
    let collect = async {
        let mut raw = Vec::new();
        let mut diagnostics = Vec::new();
        tokio::try_join!(
            bounded_stdout.read_to_end(&mut raw),
            bounded_stderr.read_to_end(&mut diagnostics),
        )?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((raw, diagnostics, status))
    };

    let collected = tokio::time::timeout(timeout, collect).await;

    let (raw, diagnostics, status) = match collected {
        Ok(Ok(collected)) => collected,
        Ok(Err(error)) => {
            let _ = child.start_kill();
            return Err(CoreError::Internal(format!(
                "Caption band decode failed: {error}"
            )));
        }
        Err(_) => {
            let _ = child.start_kill();
            return Err(CoreError::Internal(format!(
                "Caption band decode timed out after {}s",
                timeout.as_secs()
            )));
        }
    };

    if raw.len() > MAX_RAW_FRAME_BYTES {
        return Err(CoreError::Internal(
            "Caption band decode produced more pixels than the band can hold".to_string(),
        ));
    }

    if !status.success() {
        return Err(CoreError::Internal(format!(
            "Caption band decode failed: {}",
            String::from_utf8_lossy(&diagnostics).trim()
        )));
    }

    luminance_statistics(&raw)
        .ok_or_else(|| CoreError::Internal("Caption band decode produced no pixels".to_string()))
}

/// Returns `(mean, stddev)` luminance over packed RGB24 pixels, 0–1.
///
/// `None` for a buffer with no whole pixel in it, which is how a seek past the
/// end of the file arrives: FFmpeg exits cleanly having written nothing.
fn luminance_statistics(raw_rgb: &[u8]) -> Option<(f64, f64)> {
    let mut count = 0.0_f64;
    let mut sum = 0.0_f64;
    let mut sum_squares = 0.0_f64;

    for pixel in raw_rgb.chunks_exact(3) {
        let luminance = rgb_luminance(
            f64::from(pixel[0]),
            f64::from(pixel[1]),
            f64::from(pixel[2]),
        );
        count += 1.0;
        sum += luminance;
        sum_squares += luminance * luminance;
    }

    if count == 0.0 {
        return None;
    }

    let mean = sum / count;
    // Clamped because floating-point cancellation can drive a constant band's
    // variance a hair below zero, and a NaN spread would poison the metrics.
    let variance = (sum_squares / count - mean * mean).max(0.0);

    Some((mean, variance.sqrt()))
}

// =============================================================================
// Rule
// =============================================================================

/// Rule that reports caption cues the rendered picture swallows.
///
/// Grades the samples [`sample_caption_bands`] produced: a cue with no box and
/// no outline is reported at [`Severity::Warning`], with an executable fix that
/// restyles it, when its text luminance sits within [`DEFAULT_MIN_CONTRAST`] of
/// the band behind it *or* the band's own spread exceeds
/// [`DEFAULT_MAX_BAND_STDDEV`] — see the module docs on grading.
///
/// Without a rendered file there is nothing to compare against, and the rule
/// says exactly that — once, as [`Severity::Info`] — rather than staying silent
/// or guessing. A check that never appears in the report is a check an agent
/// cannot reason about, and one that guesses from the timeline alone would be
/// guessing about pixels it has not seen. The same is true, cue by cue, of
/// everything a sampling pass could not reach.
#[derive(Debug, Default)]
pub struct CaptionContrastRule;

/// Why one sample was reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContrastFault {
    /// The words and the picture behind them are one tone
    LowContrast,
    /// The band is several tones, so the words clear only part of it
    MixedBackground,
}

impl CaptionContrastRule {
    /// Creates a new CaptionContrastRule
    pub fn new() -> Self {
        Self
    }

    /// Builds the restyle fix for one cue.
    fn restyle_fix(sequence_id: &str, sample: &CaptionBandSample) -> serde_json::Value {
        serde_json::json!({
            "type": "UpdateCaption",
            "sequenceId": sequence_id,
            "trackId": sample.track_id,
            "clipId": sample.clip_id,
            "stylePack": CONTRAST_STYLE_PACK,
        })
    }

    /// Whether any caption cue exists at all in the sequence.
    fn has_caption_cues(sequence: &Sequence) -> bool {
        sequence
            .tracks
            .iter()
            .filter(|track| track.is_caption())
            .any(|track| {
                track.clips.iter().any(|clip| {
                    clip.label
                        .as_ref()
                        .is_some_and(|label| !label.trim().is_empty())
                })
            })
    }

    /// Grades one sample, or `None` when the cue reads fine.
    fn fault_for(
        sample: &CaptionBandSample,
        min_contrast: f64,
        max_stddev: f64,
    ) -> Option<ContrastFault> {
        if sample.has_box || sample.has_outline {
            return None;
        }
        let contrast = sample.contrast();
        if contrast.is_finite() && contrast < min_contrast {
            return Some(ContrastFault::LowContrast);
        }
        if sample.band_luminance_stddev.is_finite() && sample.band_luminance_stddev > max_stddev {
            return Some(ContrastFault::MixedBackground);
        }
        None
    }

    /// The informational finding for cues the pass could not measure.
    fn coverage_violation(&self, coverage: CaptionSampleCoverage) -> Option<QCViolation> {
        let unmeasured = coverage.unmeasured();
        if unmeasured == 0 {
            return None;
        }

        let reasons = coverage
            .reasons()
            .unwrap_or_else(|| "no reason recorded".to_string());

        Some(
            QCViolation::new(
                self.name(),
                Severity::Info,
                format!(
                    "Caption contrast: {} of {} cue(s) not measured ({})",
                    unmeasured, coverage.cues, reasons
                ),
            )
            .with_details(
                "Those cues are neither legible nor illegible as far as this report is \
                 concerned. Re-render the window they fall in, or raise the run's timeout, and \
                 verify again."
                    .to_string(),
            )
            .with_metric("measured", coverage.sampled > 0)
            .with_metric("cueCount", coverage.cues)
            .with_metric("sampledCount", coverage.sampled)
            .with_metric("unmeasuredCount", unmeasured)
            .with_metric("decodeFailures", coverage.decode_failures)
            .with_metric("beyondFile", coverage.beyond_file)
            .with_metric("overFrameCap", coverage.over_cap)
            .with_metric("timedOut", coverage.timed_out),
        )
    }
}

#[async_trait]
impl QCRule for CaptionContrastRule {
    fn name(&self) -> &str {
        "CaptionContrastRule"
    }

    fn check_id(&self) -> &str {
        CAPTION_CONTRAST_CHECK_ID
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Reports caption cues whose text has too little contrast against the rendered picture"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        if !Self::has_caption_cues(sequence) {
            return Ok(Vec::new());
        }

        let Some(measurements) = context.measurements.as_ref() else {
            // Not skipped: the finding here is that nothing was measured, and
            // an agent that reads "skipped" learns only that the rule did not
            // run, not that the answer needs a render.
            return Ok(vec![QCViolation::new(
                self.name(),
                Severity::Info,
                "Caption contrast not measured (needs a rendered file)",
            )
            .with_details(
                "Whether a caption can be read depends on the picture behind it, which only a \
                 render carries. Re-run the verification against a rendered file to grade it."
                    .to_string(),
            )
            .with_metric("measured", false)]);
        };

        let min_contrast = config
            .get_param::<f64>("min_contrast")
            .filter(|value| value.is_finite())
            .unwrap_or(DEFAULT_MIN_CONTRAST)
            .abs();
        let max_stddev = config
            .get_param::<f64>("max_band_stddev")
            .filter(|value| value.is_finite())
            .unwrap_or(DEFAULT_MAX_BAND_STDDEV)
            .abs();
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let mut violations = Vec::new();
        for sample in &measurements.caption_band_samples {
            let Some(fault) = Self::fault_for(sample, min_contrast, max_stddev) else {
                continue;
            };

            let message = match fault {
                ContrastFault::LowContrast => format!(
                    "Caption text and the picture behind it differ by only {:.2} luminance \
                     (limit {:.2}), with no box or outline to separate them",
                    sample.contrast(),
                    min_contrast
                ),
                ContrastFault::MixedBackground => format!(
                    "Caption text sits over a mixed background (luminance spread {:.2}, limit \
                     {:.2}), with no box or outline to separate them",
                    sample.band_luminance_stddev, max_stddev
                ),
            };

            let details = match fault {
                ContrastFault::LowContrast => format!(
                    "Measured at {:.2}s: the band the words occupy averages {:.2} luminance \
                     (spread {:.2}) and the text is {:.2}. Give the cue an outline so it reads \
                     over any background.",
                    sample.sampled_at_sec,
                    sample.band_luminance,
                    sample.band_luminance_stddev,
                    sample.text_luminance
                ),
                ContrastFault::MixedBackground => format!(
                    "Measured at {:.2}s: the band the words occupy averages {:.2} luminance but \
                     varies by {:.2} across its width, so text at {:.2} clears part of it and \
                     disappears into the rest. Give the cue an outline so it reads over any \
                     background.",
                    sample.sampled_at_sec,
                    sample.band_luminance,
                    sample.band_luminance_stddev,
                    sample.text_luminance
                ),
            };

            violations.push(
                QCViolation::new(self.name(), severity, message)
                    .with_location(sample.start_sec, sample.end_sec)
                    .with_entities(vec![sample.clip_id.clone()])
                    .with_details(details)
                    .with_metric(
                        "bandLuminance",
                        (sample.band_luminance * 1000.0).round() / 1000.0,
                    )
                    .with_metric(
                        "bandLuminanceStddev",
                        (sample.band_luminance_stddev * 1000.0).round() / 1000.0,
                    )
                    .with_metric(
                        "textLuminance",
                        (sample.text_luminance * 1000.0).round() / 1000.0,
                    )
                    .with_metric("contrast", (sample.contrast() * 1000.0).round() / 1000.0)
                    .with_metric("minContrast", min_contrast)
                    .with_metric("maxBandStddev", max_stddev)
                    .with_metric(
                        "fault",
                        match fault {
                            ContrastFault::LowContrast => "lowContrast",
                            ContrastFault::MixedBackground => "mixedBackground",
                        },
                    )
                    .with_metric("hasBox", sample.has_box)
                    .with_metric("hasOutline", sample.has_outline)
                    .with_metric("trackId", sample.track_id.clone())
                    .with_fix(
                        ViolationFix::new(
                            format!("Restyle the caption with the '{CONTRAST_STYLE_PACK}' pack"),
                            vec![Self::restyle_fix(&sequence.id, sample)],
                        )
                        // The measurement is certain; that an outline is the
                        // style the edit wants is not.
                        .with_confidence(0.8),
                    ),
            );
        }

        if let Some(coverage) = measurements.caption_band_coverage {
            violations.extend(self.coverage_violation(coverage));
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::captions::{CaptionPosition, CaptionStyle, Color, VerticalPosition};
    use crate::core::ffmpeg::{FFmpegInfo, FFmpegSource};
    use crate::core::qc::context::RenderMeasurements;
    use crate::core::render::export::build_caption_drawtext_with_enable;
    use crate::core::timeline::{Sequence, SequenceFormat, Track};
    use std::path::PathBuf;

    fn caption_clip_with_style(
        text: &str,
        start_sec: f64,
        end_sec: f64,
        style: Option<serde_json::Value>,
    ) -> Clip {
        let mut clip = Clip::with_range("caption", 0.0, end_sec - start_sec);
        clip.place.timeline_in_sec = start_sec;
        clip.place.duration_sec = end_sec - start_sec;
        clip.label = Some(text.to_string());
        clip.caption_style = style;
        clip
    }

    fn caption_clip(text: &str, start_sec: f64, end_sec: f64, style: Option<CaptionStyle>) -> Clip {
        caption_clip_with_style(
            text,
            start_sec,
            end_sec,
            style.map(|style| {
                serde_json::to_value(style).expect("a caption style serialises to an object")
            }),
        )
    }

    fn sequence_with_captions(clips: Vec<Clip>) -> Sequence {
        let mut sequence = Sequence::new("Contrast", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("C1");
        for clip in clips {
            track.add_clip(clip);
        }
        sequence.add_track(track);
        sequence
    }

    fn bare_white_style() -> CaptionStyle {
        CaptionStyle {
            outline_color: None,
            outline_width: 0.0,
            background_color: None,
            ..CaptionStyle::default()
        }
    }

    fn sample(band_luminance: f64, text_luminance: f64) -> CaptionBandSample {
        CaptionBandSample {
            clip_id: "clip_1".to_string(),
            track_id: "track_1".to_string(),
            start_sec: 1.0,
            end_sec: 3.0,
            sampled_at_sec: 2.0,
            band_luminance,
            band_luminance_stddev: 0.01,
            text_luminance,
            has_box: false,
            has_outline: false,
        }
    }

    async fn run_rule(
        sequence: &Sequence,
        measurements: Option<RenderMeasurements>,
    ) -> Vec<QCViolation> {
        let state = ProjectState::new("Contrast");
        let mut context = QCContext::from_sequence(sequence);
        context.measurements = measurements;

        CaptionContrastRule::new()
            .check(sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("the rule runs")
    }

    /// Feature: Caption legibility
    /// Scenario: should report a bare caption the picture swallows
    #[tokio::test]
    async fn should_report_white_text_on_a_white_band() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Invisible words",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let measurements = RenderMeasurements {
            caption_band_samples: vec![sample(0.97, 1.0)],
            ..Default::default()
        };

        let violations = run_rule(&sequence, Some(measurements)).await;

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(violations[0].auto_fixable);
        assert_eq!(violations[0].metrics["fault"], "lowContrast");
        let fix = violations[0].suggested_fix.as_ref().expect("a fix");
        assert_eq!(fix.commands[0]["type"], "UpdateCaption");
        assert_eq!(fix.commands[0]["stylePack"], CONTRAST_STYLE_PACK);
    }

    /// Feature: Caption legibility
    /// Scenario: should pass the same caption over a dark picture
    #[tokio::test]
    async fn should_pass_white_text_on_a_dark_band() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Readable words",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let measurements = RenderMeasurements {
            caption_band_samples: vec![sample(0.05, 1.0)],
            ..Default::default()
        };

        assert!(run_rule(&sequence, Some(measurements)).await.is_empty());
    }

    /// Feature: Caption legibility
    /// Scenario: should report a band that is half black and half white
    ///
    /// The mean says 0.5, so white text clears the contrast limit comfortably
    /// while half the line sits on white and cannot be read at all.
    #[tokio::test]
    async fn should_report_white_text_over_a_mixed_background() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Half readable",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let mut mixed = sample(0.5, 1.0);
        mixed.band_luminance_stddev = 0.5;
        let measurements = RenderMeasurements {
            caption_band_samples: vec![mixed],
            ..Default::default()
        };

        let violations = run_rule(&sequence, Some(measurements)).await;

        assert_eq!(violations.len(), 1, "{violations:?}");
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["fault"], "mixedBackground");
        assert!(
            violations[0].message.contains("mixed background"),
            "the message must say which half of the rule fired: {}",
            violations[0].message
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should not grade a cue an outline already protects
    #[tokio::test]
    async fn should_pass_a_low_contrast_cue_that_carries_an_outline() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Outlined words",
            1.0,
            3.0,
            Some(CaptionStyle::default()),
        )]);
        let mut sample = sample(0.97, 1.0);
        sample.has_outline = true;
        let measurements = RenderMeasurements {
            caption_band_samples: vec![sample],
            ..Default::default()
        };

        assert!(run_rule(&sequence, Some(measurements)).await.is_empty());
    }

    /// Feature: Caption legibility
    /// Scenario: should say once that nothing was measured, not once per cue
    #[tokio::test]
    async fn should_report_one_info_finding_without_a_rendered_file() {
        let sequence = sequence_with_captions(vec![
            caption_clip("First", 1.0, 3.0, Some(bare_white_style())),
            caption_clip("Second", 3.0, 5.0, Some(bare_white_style())),
            caption_clip("Third", 5.0, 7.0, Some(bare_white_style())),
        ]);

        let violations = run_rule(&sequence, None).await;

        assert_eq!(violations.len(), 1, "one line for the run, not one per cue");
        assert_eq!(violations[0].severity, Severity::Info);
        assert!(violations[0].message.contains("not measured"));
        assert!(!violations[0].auto_fixable);
    }

    /// Feature: Caption legibility
    /// Scenario: should stay silent on a sequence with no captions at all
    #[tokio::test]
    async fn should_report_nothing_when_the_sequence_has_no_captions() {
        let sequence = Sequence::new("No captions", SequenceFormat::youtube_1080());

        assert!(run_rule(&sequence, None).await.is_empty());
    }

    /// Feature: Coverage
    /// Scenario: should never claim a clean run over cues it could not measure
    #[tokio::test]
    async fn should_report_cues_the_sampling_pass_could_not_measure() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Unreadable frame",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let measurements = RenderMeasurements {
            caption_band_samples: Vec::new(),
            caption_band_coverage: Some(CaptionSampleCoverage {
                cues: 3,
                sampled: 0,
                decode_failures: 2,
                beyond_file: 1,
                ..CaptionSampleCoverage::default()
            }),
            ..Default::default()
        };

        let violations = run_rule(&sequence, Some(measurements)).await;

        assert_eq!(violations.len(), 1, "{violations:?}");
        assert_eq!(violations[0].severity, Severity::Info);
        assert!(
            violations[0].message.contains("3 of 3 cue(s) not measured"),
            "{}",
            violations[0].message
        );
        assert!(
            violations[0].message.contains("2 could not decode")
                && violations[0].message.contains("1 beyond the file"),
            "the finding must say why: {}",
            violations[0].message
        );
        assert_eq!(violations[0].metrics["measured"], false);
    }

    /// Feature: Coverage
    /// Scenario: should stay quiet when every candidate cue was measured
    #[tokio::test]
    async fn should_report_no_coverage_finding_when_everything_was_sampled() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Readable words",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let measurements = RenderMeasurements {
            caption_band_samples: vec![sample(0.05, 1.0)],
            caption_band_coverage: Some(CaptionSampleCoverage {
                cues: 1,
                sampled: 1,
                ..CaptionSampleCoverage::default()
            }),
            ..Default::default()
        };

        assert!(run_rule(&sequence, Some(measurements)).await.is_empty());
    }

    /// Feature: Style reading
    /// Scenario: should read protection only where the renderer draws it
    #[test]
    fn should_read_mitigation_the_way_the_renderer_draws_it() {
        let boxed = serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 180 } });
        assert!(caption_paint(Some(&boxed)).has_box);

        // A box the viewer cannot see is not a box.
        let clear_box =
            serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 0 } });
        assert!(!caption_paint(Some(&clear_box)).is_mitigated());

        // An outline width with no colour renders no outline at all.
        let width_only = serde_json::json!({ "outlineWidth": 4 });
        assert!(
            !caption_paint(Some(&width_only)).is_mitigated(),
            "the renderer keys the stroke off outlineColor"
        );

        // A colour with no width renders the renderer's own default of 2px.
        let colour_only = serde_json::json!({ "outlineColor": "#000000" });
        assert!(caption_paint(Some(&colour_only)).has_outline);

        // An explicit zero width turns it off again.
        let zeroed = serde_json::json!({ "outlineColor": "#000000", "outlineWidth": 0 });
        assert!(!caption_paint(Some(&zeroed)).is_mitigated());

        // A partial blob that says nothing about either decoration renders
        // bare, whatever `CaptionStyle::default` would have carried.
        let partial = serde_json::json!({ "fontSize": 64 });
        assert!(!caption_paint(Some(&partial)).is_mitigated());

        // And no style at all is the barest case of the lot.
        assert!(!caption_paint(None).is_mitigated());
    }

    /// Feature: Style reading
    /// Scenario: should read the text colour a cue is drawn in
    #[test]
    fn should_read_text_luminance_from_the_style_colour() {
        let white = caption_paint(Some(
            &serde_json::to_value(bare_white_style()).expect("style serialises"),
        ));
        assert!((white.text_luminance - 1.0).abs() < 1e-9);

        let black_text = CaptionStyle {
            color: Color::black(),
            ..bare_white_style()
        };
        let black = caption_paint(Some(
            &serde_json::to_value(black_text).expect("style serialises"),
        ));
        assert!(black.text_luminance < 1e-9);

        // Hex strings reach the renderer too, and mean the same thing there.
        let hex = caption_paint(Some(&serde_json::json!({ "color": "#000000FF" })));
        assert!(hex.text_luminance < 1e-9);

        // A blob naming no colour renders white, which is the renderer's
        // fallback and not the caption model's default.
        assert!((caption_paint(None).text_luminance - 1.0).abs() < 1e-9);
    }

    /// Feature: Style reading
    /// Scenario: should agree with the export pipeline about every fixture
    ///
    /// The renderer's own gates are private, so this drives the real `drawtext`
    /// seam — `borderw`/`box=1` appear exactly when a stroke or a box is burned
    /// in — and asserts the check reaches the same verdict from the same blob.
    /// A change on either side that breaks the mirror fails here.
    #[test]
    fn should_agree_with_the_renderer_about_protection() {
        let fixtures = [
            ("no style at all", None),
            ("empty object", Some(serde_json::json!({}))),
            (
                "font size only",
                Some(serde_json::json!({ "fontSize": 64 })),
            ),
            (
                "outline width with no colour",
                Some(serde_json::json!({ "outlineWidth": 4 })),
            ),
            (
                "outline colour with no width",
                Some(serde_json::json!({ "outlineColor": "#000000" })),
            ),
            (
                "outline colour and width",
                Some(serde_json::json!({ "outlineColor": "#000000", "outlineWidth": 4 })),
            ),
            (
                "outline colour with an explicit zero width",
                Some(serde_json::json!({ "outlineColor": "#000000", "outlineWidth": 0 })),
            ),
            (
                "opaque box",
                Some(
                    serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 200 } }),
                ),
            ),
            (
                "fully transparent box",
                Some(serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 0 } })),
            ),
            (
                "fully transparent outline",
                Some(serde_json::json!({ "outlineColor": "#00000000", "outlineWidth": 4 })),
            ),
            (
                "snake_case outline",
                Some(serde_json::json!({ "outline_color": "#101112", "outline_width": 3 })),
            ),
            (
                "the caption model default",
                Some(serde_json::to_value(CaptionStyle::default()).expect("serialises")),
            ),
            (
                "a bare white style",
                Some(serde_json::to_value(bare_white_style()).expect("serialises")),
            ),
        ];

        for (label, style) in fixtures {
            let clip = caption_clip_with_style("Words", 0.0, 2.0, style);
            let filter = build_caption_drawtext_with_enable(&clip)
                .unwrap_or_else(|| panic!("{label}: a caption with text renders"));
            let paint = caption_paint(clip.caption_style.as_ref());

            assert_eq!(
                paint.has_outline,
                drawtext_draws_an_outline(&filter),
                "{label}: the check and the renderer disagree about the outline ({filter})"
            );
            assert_eq!(
                paint.has_box,
                drawtext_draws_a_box(&filter),
                "{label}: the check and the renderer disagree about the box ({filter})"
            );
        }
    }

    /// Reads one `key=value` pair out of a `drawtext` filter body.
    fn drawtext_param<'a>(filter: &'a str, key: &str) -> Option<&'a str> {
        filter
            .split(':')
            .find_map(|part| part.strip_prefix(&format!("{key}=")))
    }

    /// Whether an `0xRRGGBB[@alpha]` colour is visible at all.
    fn ffmpeg_colour_is_visible(colour: &str) -> bool {
        match colour.split_once('@') {
            Some((_, alpha)) => alpha.parse::<f64>().is_ok_and(|alpha| alpha > 0.0),
            None => true,
        }
    }

    /// Whether the `drawtext` filter actually strokes the glyphs.
    ///
    /// `borderw=0` and a fully transparent `bordercolor` are both written out
    /// and both draw nothing, so presence of the parameter is not the question.
    fn drawtext_draws_an_outline(filter: &str) -> bool {
        let width = drawtext_param(filter, "borderw")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let visible = drawtext_param(filter, "bordercolor").is_some_and(ffmpeg_colour_is_visible);
        width > 0.0 && visible
    }

    /// Whether the `drawtext` filter actually paints a box behind the words.
    fn drawtext_draws_a_box(filter: &str) -> bool {
        drawtext_param(filter, "box") == Some("1")
            && drawtext_param(filter, "boxcolor").is_some_and(ffmpeg_colour_is_visible)
    }

    /// Feature: Cue selection
    /// Scenario: should only consider cues the file actually holds
    #[test]
    fn should_select_only_unprotected_cues_inside_the_window() {
        let sequence = sequence_with_captions(vec![
            caption_clip("Before the window", 0.0, 5.0, Some(bare_white_style())),
            caption_clip("Inside", 12.0, 14.0, Some(bare_white_style())),
            caption_clip("Outlined", 15.0, 17.0, Some(CaptionStyle::default())),
            caption_clip("After the window", 40.0, 42.0, Some(bare_white_style())),
        ]);

        let cues = sampling_candidates(&sequence, (10.0, 20.0), 1920, 1080);

        let labels: Vec<f64> = cues.iter().map(|cue| cue.midpoint_sec).collect();
        assert_eq!(labels, vec![13.0], "only the bare cue inside the window");
    }

    /// Feature: Cue selection
    /// Scenario: should sample the part of a straddling cue the file holds
    #[test]
    fn should_sample_inside_the_file_for_a_cue_that_straddles_the_edge() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Straddles the start",
            5.0,
            15.0,
            Some(bare_white_style()),
        )]);

        let cues = sampling_candidates(&sequence, (10.0, 20.0), 1920, 1080);

        assert_eq!(cues.len(), 1);
        assert!(
            (cues[0].midpoint_sec - 12.5).abs() < 1e-9,
            "the midpoint must land inside the file, got {}",
            cues[0].midpoint_sec
        );
    }

    /// Feature: Cue selection
    /// Scenario: should stop at the end of a file shorter than its window
    #[test]
    fn should_bound_candidates_by_the_measured_file_length() {
        // A window declaring ten seconds of timeline over a file holding two.
        assert!((decodable_end_sec((10.0, 20.0), Some(2.0)) - 12.0).abs() < 1e-9);
        // A file longer than the window changes nothing: the window still wins.
        assert!((decodable_end_sec((10.0, 20.0), Some(30.0)) - 20.0).abs() < 1e-9);
        // An unknown or unusable length leaves the window alone.
        assert!((decodable_end_sec((10.0, 20.0), None) - 20.0).abs() < 1e-9);
        assert!((decodable_end_sec((10.0, 20.0), Some(f64::NAN)) - 20.0).abs() < 1e-9);
    }

    /// A runner pointing at a binary that is not there.
    ///
    /// Every decode it is asked for fails to spawn, which is exactly the shape
    /// of a failed decode and needs no FFmpeg on the machine running the test.
    fn broken_runner() -> FFmpegRunner {
        FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("openreelio-no-such-ffmpeg"),
            ffprobe_path: PathBuf::from("openreelio-no-such-ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: FFmpegSource::System,
        })
    }

    /// Feature: Coverage
    /// Scenario: should count every cue it failed to decode
    #[tokio::test]
    async fn should_count_decode_failures_rather_than_reporting_a_clean_pass() {
        let sequence = sequence_with_captions(vec![
            caption_clip("First", 1.0, 3.0, Some(bare_white_style())),
            caption_clip("Second", 4.0, 6.0, Some(bare_white_style())),
        ]);

        let sampling = sample_caption_bands(
            &broken_runner(),
            Path::new("openreelio-no-such-render.mp4"),
            &sequence,
            (0.0, 10.0),
            &CaptionSampleOptions::default(),
        )
        .await;

        assert!(sampling.samples.is_empty());
        assert_eq!(sampling.coverage.cues, 2);
        assert_eq!(sampling.coverage.sampled, 0);
        assert_eq!(sampling.coverage.decode_failures, 2);
        assert_eq!(sampling.coverage.unmeasured(), 2);
        assert!(
            sampling
                .notes
                .iter()
                .any(|note| note.contains("could not decode")),
            "{:?}",
            sampling.notes
        );
    }

    /// Feature: Coverage
    /// Scenario: should stop sampling once the run's budget is gone
    ///
    /// A zero budget spawns nothing at all, so the pass is bounded by the
    /// caller's timeout rather than by the timeout times the cue count.
    #[tokio::test]
    async fn should_stop_sampling_when_the_run_deadline_passes() {
        let sequence = sequence_with_captions(vec![
            caption_clip("First", 1.0, 3.0, Some(bare_white_style())),
            caption_clip("Second", 4.0, 6.0, Some(bare_white_style())),
            caption_clip("Third", 7.0, 9.0, Some(bare_white_style())),
        ]);

        let sampling = sample_caption_bands(
            &broken_runner(),
            Path::new("openreelio-no-such-render.mp4"),
            &sequence,
            (0.0, 10.0),
            &CaptionSampleOptions {
                run_timeout: Duration::ZERO,
                ..CaptionSampleOptions::default()
            },
        )
        .await;

        assert!(sampling.samples.is_empty());
        assert_eq!(sampling.coverage.cues, 3);
        assert_eq!(sampling.coverage.timed_out, 3);
        assert_eq!(
            sampling.coverage.decode_failures, 0,
            "nothing should have been spawned at all"
        );
        assert!(
            sampling
                .notes
                .iter()
                .any(|note| note.contains("ran out of time")),
            "{:?}",
            sampling.notes
        );
    }

    /// Feature: Coverage
    /// Scenario: should refuse to decode a cue past the end of the file
    #[tokio::test]
    async fn should_report_cues_beyond_the_measured_file_as_unmeasurable() {
        let sequence = sequence_with_captions(vec![
            caption_clip("Inside", 0.5, 1.5, Some(bare_white_style())),
            caption_clip("Past the end", 8.0, 9.0, Some(bare_white_style())),
        ]);

        let sampling = sample_caption_bands(
            &broken_runner(),
            Path::new("openreelio-no-such-render.mp4"),
            &sequence,
            (0.0, 10.0),
            &CaptionSampleOptions {
                // The file only holds the first two seconds of the window.
                file_duration_sec: Some(2.0),
                ..CaptionSampleOptions::default()
            },
        )
        .await;

        assert_eq!(sampling.coverage.cues, 2);
        assert_eq!(sampling.coverage.beyond_file, 1);
        assert_eq!(
            sampling.coverage.decode_failures, 1,
            "only the reachable cue was attempted"
        );
        assert!(
            sampling
                .notes
                .iter()
                .any(|note| note.contains("past the end of the measured file")),
            "{:?}",
            sampling.notes
        );
    }

    /// Feature: The decode cap
    /// Scenario: should spread the kept samples across the whole list
    #[test]
    fn should_spread_samples_evenly_when_capped() {
        let kept = spread_evenly((0..10).collect::<Vec<i32>>(), 5);

        assert_eq!(kept, vec![0, 2, 4, 6, 8]);

        let unchanged = spread_evenly(vec![1, 2, 3], 5);
        assert_eq!(unchanged, vec![1, 2, 3]);
        assert!(spread_evenly(vec![1, 2, 3], 0).is_empty());
    }

    /// Feature: Band statistics
    /// Scenario: should measure the mean and the spread of a band
    #[test]
    fn should_compute_luminance_mean_and_spread() {
        let white = vec![255u8, 255, 255, 255, 255, 255];
        let (mean, stddev) = luminance_statistics(&white).expect("pixels");
        assert!((mean - 1.0).abs() < 1e-9);
        assert!(stddev < 1e-9);

        let mixed = vec![0u8, 0, 0, 255, 255, 255];
        let (mean, stddev) = luminance_statistics(&mixed).expect("pixels");
        assert!((mean - 0.5).abs() < 1e-9);
        assert!((stddev - 0.5).abs() < 1e-9);

        assert!(luminance_statistics(&[]).is_none());
        assert!(luminance_statistics(&[1, 2]).is_none());
    }

    /// Feature: Band geometry
    /// Scenario: should crop the strip the words sit in
    #[test]
    fn should_build_a_crop_for_the_caption_band() {
        let clip = caption_clip("Words", 0.0, 2.0, Some(bare_white_style()));
        let (top, bottom) = super::super::rules::caption_band_percent(&clip, 1920, 1080);

        assert!(
            top > 75.0 && bottom <= 100.0,
            "a default caption sits low in the frame, got {top}-{bottom}"
        );

        let filter = band_filter((top, bottom), 320);
        assert!(filter.contains("scale=w='min(320,iw)'"));
        assert!(filter.contains("crop="));
        assert!(filter.ends_with("format=rgb24"));
    }

    /// Feature: Band geometry
    /// Scenario: should follow a caption that was moved to the top
    #[test]
    fn should_follow_the_caption_anchor_up_the_frame() {
        let mut clip = caption_clip("Words", 0.0, 2.0, Some(bare_white_style()));
        clip.caption_position = Some(
            serde_json::to_value(CaptionPosition::Preset {
                vertical: VerticalPosition::Top,
                margin_percent: 10.0,
            })
            .expect("position serialises"),
        );

        let (top, bottom) = super::super::rules::caption_band_percent(&clip, 1920, 1080);

        assert!(
            top >= 9.0 && bottom < 25.0,
            "a top-anchored caption sits high in the frame, got {top}-{bottom}"
        );
    }
}
