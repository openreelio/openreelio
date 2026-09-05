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
//! # Luminance
//!
//! Both sides are measured the same way: Rec. 709 weights over *gamma-encoded*
//! sRGB components, scaled to `0.0`–`1.0`. That is a perceptual proxy rather
//! than WCAG relative luminance (which linearises first), and it is used on
//! both sides of the comparison, so [`DEFAULT_MIN_CONTRAST`] is calibrated on
//! this scale and must not be read as a WCAG ratio.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::context::QCContext;
use super::rules::{CheckCategory, QCRule, RuleConfig};
use super::violation::{QCViolation, Severity, ViolationFix};
use crate::core::captions::{CaptionStyle, Color};
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

/// Largest raw frame payload accepted from one decode, in bytes.
///
/// The pipe is bounded by construction (`SAMPLE_MAX_WIDTH` × one band × 3), so
/// this only bites if FFmpeg is asked for something other than what this module
/// asks for. It exists so a wrong filter can never buffer without limit.
const MAX_RAW_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Caption pack suggested for a cue that cannot be read.
///
/// `standard-outline` and not `boxed-contrast`: the box is the stronger fix on
/// paper, but background boxes are not rendered by the export pipeline yet, so
/// suggesting one would hand an agent a fix that changes the project and not
/// the picture. Move this to `boxed-contrast` once boxes render.
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

/// Everything one sampling pass produced, including what it could not do.
#[derive(Debug, Clone, Default)]
pub struct CaptionBandSampling {
    /// Bands that were measured
    pub samples: Vec<CaptionBandSample>,
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
}

impl Default for CaptionSampleOptions {
    fn default() -> Self {
        Self {
            max_frames: DEFAULT_MAX_SAMPLED_FRAMES,
            max_width: SAMPLE_MAX_WIDTH,
            timeout: SAMPLE_TIMEOUT,
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

/// Rec. 709 luminance of a colour, on gamma-encoded components, 0–1.
fn colour_luminance(colour: &Color) -> f64 {
    (0.2126 * f64::from(colour.r) + 0.7152 * f64::from(colour.g) + 0.0722 * f64::from(colour.b))
        / 255.0
}

/// Whether a background colour is opaque enough to count as a box.
///
/// A fully transparent box is not a box; anything the viewer can see is, and
/// judging *how* much it helps is beyond a deterministic check.
fn is_visible_box(colour: Option<&Color>) -> bool {
    colour.is_some_and(|colour| colour.a > 0)
}

/// Reads the paint from a caption clip's stored style JSON.
///
/// Stored styles are untyped and frequently partial — only the edited fields
/// are written — so a blob that will not parse as a whole [`CaptionStyle`] is
/// read field by field, with the caption defaults standing in for whatever is
/// absent. That mirrors what the renderer does, which is what makes the answer
/// about the picture rather than about the blob.
fn caption_paint(style: Option<&serde_json::Value>) -> CaptionPaint {
    let defaults = CaptionStyle::default();

    let Some(value) = style else {
        return CaptionPaint {
            text_luminance: colour_luminance(&defaults.color),
            has_box: is_visible_box(defaults.background_color.as_ref()),
            has_outline: defaults.outline_width > 0.0,
        };
    };

    if let Ok(parsed) = serde_json::from_value::<CaptionStyle>(value.clone()) {
        return CaptionPaint {
            text_luminance: colour_luminance(&parsed.color),
            has_box: is_visible_box(parsed.background_color.as_ref()),
            has_outline: parsed.outline_width > 0.0,
        };
    }

    let colour = value
        .get("color")
        .and_then(|raw| serde_json::from_value::<Color>(raw.clone()).ok())
        .unwrap_or(defaults.color);

    let background = ["backgroundColor", "background_color"]
        .iter()
        .find_map(|key| value.get(*key))
        .map(|raw| serde_json::from_value::<Color>(raw.clone()).ok())
        .unwrap_or(defaults.background_color);

    let outline_width = ["outlineWidth", "outline_width"]
        .iter()
        .find_map(|key| value.get(*key))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(f64::from(defaults.outline_width));

    CaptionPaint {
        text_luminance: colour_luminance(&colour),
        has_box: is_visible_box(background.as_ref()),
        has_outline: outline_width > 0.0,
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
/// not cost the caller the rest of the report.
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
    let candidate_count = candidates.len();
    let mut sampling = CaptionBandSampling::default();

    if candidate_count > options.max_frames {
        sampling.notes.push(format!(
            "caption.contrast sampled {} of {} unprotected caption cue(s): the check decodes at \
             most {} frames per run, spread evenly across the file",
            options.max_frames, candidate_count, options.max_frames
        ));
    }

    let mut failures = 0usize;
    for cue in spread_evenly(candidates, options.max_frames) {
        let file_time_sec = (cue.midpoint_sec - window.0).max(0.0);
        match measure_band(runner, file, file_time_sec, cue.band_percent, options).await {
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
                failures += 1;
                tracing::debug!(
                    "caption band sample failed at {:.2}s: {}",
                    file_time_sec,
                    error
                );
            }
        }
    }

    if failures > 0 {
        sampling.notes.push(format!(
            "caption.contrast could not decode {failures} caption frame(s); those cues were not \
             graded"
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
async fn measure_band(
    runner: &FFmpegRunner,
    file: &Path,
    time_sec: f64,
    band_percent: (f64, f64),
    options: &CaptionSampleOptions,
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
        band_filter(band_percent, options.max_width),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "pipe:1".to_string(),
    ];

    let mut command = tokio::process::Command::new(&runner.info().ffmpeg_path);
    configure_tokio_command(&mut command);
    let child = command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let output = tokio::time::timeout(options.timeout, child)
        .await
        .map_err(|_| {
            CoreError::Internal(format!(
                "Caption band decode timed out after {}s",
                options.timeout.as_secs()
            ))
        })?
        .map_err(|error| CoreError::Internal(format!("Caption band decode failed: {error}")))?;

    if !output.status.success() {
        return Err(CoreError::Internal(format!(
            "Caption band decode failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    if output.stdout.len() > MAX_RAW_FRAME_BYTES {
        return Err(CoreError::Internal(
            "Caption band decode produced more pixels than the band can hold".to_string(),
        ));
    }

    luminance_statistics(&output.stdout)
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
        let luminance = (0.2126 * f64::from(pixel[0])
            + 0.7152 * f64::from(pixel[1])
            + 0.0722 * f64::from(pixel[2]))
            / 255.0;
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
/// no outline whose text luminance sits within [`DEFAULT_MIN_CONTRAST`] of the
/// band behind it is reported at [`Severity::Warning`], with an executable fix
/// that restyles it.
///
/// Without a rendered file there is nothing to compare against, and the rule
/// says exactly that — once, as [`Severity::Info`] — rather than staying silent
/// or guessing. A check that never appears in the report is a check an agent
/// cannot reason about, and one that guesses from the timeline alone would be
/// guessing about pixels it has not seen.
#[derive(Debug, Default)]
pub struct CaptionContrastRule;

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
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let mut violations = Vec::new();
        for sample in &measurements.caption_band_samples {
            if sample.has_box || sample.has_outline {
                continue;
            }
            let contrast = sample.contrast();
            if !contrast.is_finite() || contrast >= min_contrast {
                continue;
            }

            violations.push(
                QCViolation::new(
                    self.name(),
                    severity,
                    format!(
                        "Caption text and the picture behind it differ by only {:.2} luminance \
                         (limit {:.2}), with no box or outline to separate them",
                        contrast, min_contrast
                    ),
                )
                .with_location(sample.start_sec, sample.end_sec)
                .with_entities(vec![sample.clip_id.clone()])
                .with_details(format!(
                    "Measured at {:.2}s: the band the words occupy averages {:.2} luminance \
                     (spread {:.2}) and the text is {:.2}. Give the cue an outline so it reads \
                     over any background.",
                    sample.sampled_at_sec,
                    sample.band_luminance,
                    sample.band_luminance_stddev,
                    sample.text_luminance
                ))
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
                .with_metric("contrast", (contrast * 1000.0).round() / 1000.0)
                .with_metric("minContrast", min_contrast)
                .with_metric("hasBox", sample.has_box)
                .with_metric("hasOutline", sample.has_outline)
                .with_metric("trackId", sample.track_id.clone())
                .with_fix(
                    ViolationFix::new(
                        format!("Restyle the caption with the '{CONTRAST_STYLE_PACK}' pack"),
                        vec![Self::restyle_fix(&sequence.id, sample)],
                    )
                    // The measurement is certain; that an outline is the style
                    // the edit wants is not.
                    .with_confidence(0.8),
                ),
            );
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
    use crate::core::captions::{CaptionPosition, VerticalPosition};
    use crate::core::qc::context::RenderMeasurements;
    use crate::core::timeline::{Sequence, SequenceFormat, Track};

    fn caption_clip(text: &str, start_sec: f64, end_sec: f64, style: Option<CaptionStyle>) -> Clip {
        let mut clip = Clip::with_range("caption", 0.0, end_sec - start_sec);
        clip.place.timeline_in_sec = start_sec;
        clip.place.duration_sec = end_sec - start_sec;
        clip.label = Some(text.to_string());
        clip.caption_style = style.map(|style| {
            serde_json::to_value(style).expect("a caption style serialises to an object")
        });
        clip
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

    /// Feature: Style reading
    /// Scenario: should treat a box or an outline as protection
    #[test]
    fn should_read_mitigation_from_full_and_partial_styles() {
        let boxed = serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 180 } });
        assert!(caption_paint(Some(&boxed)).has_box);

        let bare = serde_json::json!({ "outlineWidth": 0.0, "backgroundColor": null });
        let paint = caption_paint(Some(&bare));
        assert!(!paint.is_mitigated(), "{paint:?}");

        // A partial blob that says nothing about the outline renders with the
        // caption default, which has one.
        let partial = serde_json::json!({ "fontSize": 64 });
        assert!(caption_paint(Some(&partial)).has_outline);

        // No style at all is the caption default too.
        assert!(caption_paint(None).has_outline);
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
