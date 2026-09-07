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
//! luminance of the text itself. A cue whose style already carries an outline,
//! or a background box that cannot fail whatever the picture behind it turns
//! out to be (see [`box_guarantees_legibility`]), is never decoded: the
//! mitigation settles the question before a pixel is read, and skipping it
//! keeps the pass cheap on the ordinary project where every caption is
//! outlined. Every other box is measured like any other cue, with the box
//! composited over the band it covers.
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
//!   at all. Whether the stroke that *is* drawn counts as protection is a
//!   second question, answered from its colour and alpha rather than from its
//!   existence — see [`CaptionPaint::outline_protects`] — because a stroke in
//!   the text's own colour, or one washed out by its alpha, separates nothing.
//!   A stroke that is not opaque is graded against the ring the viewer sees,
//!   `alpha * outline + (1 - alpha) * picture`, by the same interval arithmetic
//!   a box's separation is graded by ([`decoration_separation`]), not against
//!   the colour the style authored. Separation is all a stroke is asked for:
//!   the box's second clause, on the spread the band keeps, belongs to the box
//!   because the box is what the band is measured through.
//! * **Box** — same shape for `backgroundColor`/`background_color`. A box the
//!   renderer quantises away — both paths round the alpha before they draw, so
//!   anything under half a step of it paints nothing — selects no box at all,
//!   and the ASS path keeps `BorderStyle: 1` and the outline it would otherwise
//!   have replaced. Where a box *is* painted it takes the stroke's place, so an
//!   outline behind a box is not protection; and only a box whose own colour
//!   and alpha put every possible reading of the band clear of the text lets
//!   the cue go unmeasured, since a wash the footage reads through - or an
//!   opaque box the same tone as the words - decides nothing on its own.
//! * **Layer opacity** — both renderers multiply every decoration's alpha by
//!   the caption layer's own opacity, which is the style's `opacity` (or the
//!   alpha of its text colour) times the clip's. A 90 %-opaque box on a clip
//!   faded to a tenth paints at nine percent, so the same factors are folded
//!   into the box alpha here before anything is decided from it. The *glyphs*
//!   carry the same factor — `drawtext` puts it on `fontcolor`, the ASS path on
//!   `PrimaryColour` — so the words the viewer reads are a blend of the text
//!   colour and the band behind them, and the separation actually drawn is the
//!   layer opacity times the one the two colours imply. Every contrast this
//!   module quotes is scaled by it, on the measured side
//!   ([`CaptionBandSample::contrast`]) and in [`box_guarantees_legibility`]
//!   alike: a box that clears the floor for opaque words does not clear it for
//!   words drawn at six tenths.
//! * **Text colour** — the renderers fall back to `#FFFFFF`, not to
//!   [`CaptionStyle::default`](crate::core::captions::CaptionStyle::default), when the blob names no readable colour.
//!
//! Deriving any of this from [`CaptionStyle::default`](crate::core::captions::CaptionStyle::default) — which *does* carry a
//! two-pixel black outline — made the check skip exactly the bare captions it
//! exists to catch. The ideal fix is one shared predicate both sides call; the
//! renderer's gates are private to a module this check must not reach into, so
//! the mirror is pinned instead by
//! `should_agree_with_the_renderer_about_protection`, which drives both real
//! seams — the `drawtext` filter and the ASS style row libass renders from —
//! over the same fixtures this module grades.
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
//! Both are graded *after* the cue's own background box is composited over the
//! band — `alpha` of a flat colour over `1 - alpha` of the picture, which
//! raises the mean toward the box and scales the spread down. A translucent box
//! is therefore neither waved through nor ignored: it is worth exactly as much
//! as it hides.
//!
//! # Coverage
//!
//! Not every candidate cue can be measured: a decode can fail, the run can hit
//! its deadline, the per-run frame cap can bite, a cue can lie past the end of
//! a file shorter than the window that was declared for it, and a cue faded out
//! of the frame draws no glyphs to measure. Those counts are carried in
//! [`CaptionSampleCoverage`] and reported as an informational finding, because
//! "we measured none of them" must never reach an agent as `passed`.

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
use crate::core::render::export::effective_text_layer_opacity;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::{CoreError, CoreResult};

/// Stable check ID reported to agents.
pub const CAPTION_CONTRAST_CHECK_ID: &str = "caption.contrast";

/// Smallest luminance separation, on 0–1, a bare caption needs to be legible.
///
/// Below this the words and the picture behind them read as one tone. It is a
/// difference on the gamma-encoded scale described in the module docs, not a
/// WCAG contrast ratio.
///
/// # Known limitation
///
/// The two scales disagree about how demanding this is, and this one is the
/// more forgiving. A 0.35 separation is about a 2.4:1 WCAG contrast ratio for
/// white text on the darkest band that still clears it, and about 3.0:1 for
/// black text on the lightest one - both short of the 4.5:1 WCAG asks of body
/// text. So a cue this check passes is legible rather than accessible, and the
/// number is deliberately left where it is: it exists to catch captions the
/// picture swallows, not to grade a project against WCAG.
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
    /// Whether the renderer paints a background box behind the cue at all
    ///
    /// A box is not protection on its own, so this is `true` on plenty of
    /// reported cues: what settles the question is
    /// [`box_guarantees_legibility`], which asks what the box is made of.
    pub has_box: bool,
    /// Whether the renderer strokes the cue's glyphs solidly enough to protect
    /// them
    ///
    /// A stroke whose colour separates it from the text by the run's contrast
    /// floor or better, at the alpha it is actually painted at, *is*
    /// protection, so a sample carrying one is never graded. A stroke that is
    /// too faint or too close to the text colour is not, and such a cue is
    /// measured like any other bare one — see
    /// [`CaptionPaint::outline_protects`].
    pub has_outline: bool,
    /// Alpha of that background box, 0–1; `0.0` where none is painted
    ///
    /// Defaulted on read because reports written before the box was measured
    /// carry no such field. That default is a lie for a cue those reports
    /// recorded as `hasBox`, and a deliberately conservative one: the box is
    /// left out of the blend, so the cue is graded against the undiluted
    /// picture and can only be reported more readily than a fresh measurement
    /// would report it.
    #[serde(default)]
    pub box_alpha: f64,
    /// Luminance of that background box's colour, 0–1
    ///
    /// Defaulted on read the same way, and meaningless where no box is painted.
    #[serde(default)]
    pub box_luminance: f64,
    /// Opacity the cue's glyphs are drawn at, 0–1
    ///
    /// Both renderers put the caption layer's opacity on the text colour
    /// itself, so this is how much of the text colour reaches the picture - see
    /// [`CaptionBandSample::contrast`]. Defaulted to fully opaque on read,
    /// because a report written before the glyphs' own alpha was measured
    /// graded the colours undiluted and must keep reading the way it was
    /// written.
    #[serde(default = "opaque_layer")]
    pub layer_opacity: f64,
}

/// Layer opacity assumed for a report that carries none.
fn opaque_layer() -> f64 {
    1.0
}

impl CaptionBandSample {
    /// Luminance the words are actually read against, 0–1.
    ///
    /// A translucent box does not remove the picture, it dilutes it: the viewer
    /// sees `alpha` of the box over `1 - alpha` of the shot. A box that settles
    /// the question on its own is never measured at all (see
    /// [`box_guarantees_legibility`]), so this is what the rest of them do.
    pub fn effective_band_luminance(&self) -> f64 {
        let alpha = self.box_alpha.clamp(0.0, 1.0);
        alpha * self.box_luminance + (1.0 - alpha) * self.band_luminance
    }

    /// Spread of the picture that survives the box, 0–1.
    ///
    /// The box is one flat colour, so it contributes no variation of its own
    /// and scales down what the picture behind it contributes.
    pub fn effective_band_stddev(&self) -> f64 {
        (1.0 - self.box_alpha.clamp(0.0, 1.0)) * self.band_luminance_stddev
    }

    /// Separation between the text and what sits behind it, 0–1.
    ///
    /// The glyphs are painted at [`layer_opacity`](Self::layer_opacity) over
    /// the band, so what the viewer reads is that much of the text colour over
    /// the rest of the picture and the separation on the screen is that
    /// fraction of the one the two colours imply. A caption faded to a third is
    /// a third as readable as its palette suggests, and grading it on the
    /// palette alone reported white-on-white cues as comfortable.
    pub fn contrast(&self) -> f64 {
        self.layer_opacity.clamp(0.0, 1.0)
            * (self.text_luminance - self.effective_band_luminance()).abs()
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
    ///
    /// Includes the cues faded out of the frame: they are cues the report has
    /// to account for, and dropping them from the total made a run that graded
    /// none of them look like a run that graded all of them.
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
    /// Cues whose layer is faded out, so no glyphs reach the picture
    pub faded_out: usize,
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
            (self.faded_out, "faded out"),
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

/// The numbers a caption band is graded against.
///
/// The rule reads them from its [`RuleConfig`], and the sampling pass has to
/// grade against the same pair: a box is waved through without a decode only
/// when it cannot fail *this run's* thresholds, so a caller who raised
/// `min_contrast` would otherwise have cues skipped against the default and
/// never see the finding they asked for.
///
/// No shipped surface sets either parameter yet: `verify` builds its rule
/// configuration without them, so every run on that path grades against
/// [`ContrastThresholds::default`]. [`ContrastThresholds::from_config`] is what
/// a surface that starts offering them would come through, and the pass is
/// already written to follow whatever it returns.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContrastThresholds {
    /// Smallest separation, 0–1, a cue may show and still read
    pub min_contrast: f64,
    /// Largest band spread, 0–1, a cue may sit over and still read
    pub max_band_stddev: f64,
}

impl Default for ContrastThresholds {
    fn default() -> Self {
        Self {
            min_contrast: DEFAULT_MIN_CONTRAST,
            max_band_stddev: DEFAULT_MAX_BAND_STDDEV,
        }
    }
}

impl ContrastThresholds {
    /// Resolves the thresholds one rule configuration asks for.
    ///
    /// A missing or non-finite parameter falls back to the default and a
    /// negative one is read as its magnitude, which is how the rule has always
    /// read them.
    pub fn from_config(config: &RuleConfig) -> Self {
        let resolve = |key: &str, fallback: f64| {
            config
                .get_param::<f64>(key)
                .filter(|value| value.is_finite())
                .unwrap_or(fallback)
                .abs()
        };

        Self {
            min_contrast: resolve("min_contrast", DEFAULT_MIN_CONTRAST),
            max_band_stddev: resolve("max_band_stddev", DEFAULT_MAX_BAND_STDDEV),
        }
    }
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
    /// Thresholds the run grades against
    ///
    /// The pass decides which cues never need a decode, and that decision is
    /// only sound against the thresholds the rule will grade the rest with, so
    /// the caller resolves them once and hands them to both.
    pub thresholds: ContrastThresholds,
}

impl Default for CaptionSampleOptions {
    fn default() -> Self {
        Self {
            max_frames: DEFAULT_MAX_SAMPLED_FRAMES,
            max_width: SAMPLE_MAX_WIDTH,
            timeout: SAMPLE_TIMEOUT,
            run_timeout: SAMPLE_RUN_TIMEOUT,
            file_duration_sec: None,
            thresholds: ContrastThresholds::default(),
        }
    }
}

// =============================================================================
// Style reading
// =============================================================================

/// Largest luminance spread a band of values on 0–1 can possibly have.
///
/// Half the picture at black and half at white; nothing in an eight-bit frame
/// beats it. It is the worst case a box has to survive to be waved through
/// without a decode.
const MAX_POSSIBLE_BAND_STDDEV: f64 = 0.5;

/// Whether a box settles the cue's legibility whatever the picture behind it is.
///
/// Skipping a cue is a claim that the shot cannot matter, and only the box's own
/// arithmetic can earn it. The viewer reads the words against
/// `alpha * box + (1 - alpha) * picture`, and the picture is somewhere on 0–1,
/// so the band the box leaves lies in `[alpha * box, alpha * box + (1 - alpha)]`
/// and its surviving spread is at most `(1 - alpha) * `
/// [`MAX_POSSIBLE_BAND_STDDEV`]. A box is protection only when the *whole* of
/// that interval clears [`ContrastThresholds::min_contrast`] and that spread
/// clears [`ContrastThresholds::max_band_stddev`] — which is why an opaque box
/// is not enough by itself: white text on a ninety-percent *white* box is
/// inside the interval, reads as nothing over a dark shot, and is measured like
/// any other cue.
///
/// `layer_opacity` is what the glyphs themselves are drawn at, and it scales
/// the separation the same way it scales the measured one: the words only ever
/// reach the picture at that fraction of their colour, so a box that would
/// guarantee an opaque caption guarantees six tenths of that for a caption
/// drawn at six tenths. At an opacity of zero nothing is guaranteed and nothing
/// needs to be - [`CaptionPaint::draws_text`] takes those cues out of the pass
/// before this is asked.
///
/// A stroke measures its separation the same way — see
/// [`decoration_separation`], which both decorations share — but it is held to
/// that clause alone. The spread clause belongs to the box because the box is
/// what the band is *measured through*: a cue carrying one is graded on
/// [`CaptionBandSample::effective_band_stddev`], so waving a translucent box
/// through unmeasured would skip a reading the pass would otherwise have taken.
/// A stroke is never composited into the measurement at all, so holding it to a
/// clause the measurement path cannot answer only turns strokes that do protect
/// the words into reports - see [`CaptionPaint::outline_protects`].
fn box_guarantees_legibility(
    text_luminance: f64,
    box_alpha: f64,
    box_luminance: f64,
    layer_opacity: f64,
    thresholds: ContrastThresholds,
) -> bool {
    let alpha = box_alpha.clamp(0.0, 1.0);
    let separation = decoration_separation(text_luminance, alpha, box_luminance);

    separation * layer_opacity.clamp(0.0, 1.0) >= thresholds.min_contrast
        && (1.0 - alpha) * MAX_POSSIBLE_BAND_STDDEV <= thresholds.max_band_stddev
}

/// Distance from the text to the nearest tone a decoration can leave behind it.
///
/// A decoration painted at `alpha` in `decoration_luminance` is only its own
/// colour where it is opaque; below that the viewer reads
/// `alpha * decoration + (1 - alpha) * picture`, and the picture is somewhere
/// on 0–1, so the band the decoration leaves lies on
/// `[alpha * decoration, alpha * decoration + (1 - alpha)]`. What the
/// decoration is worth is the distance from the text to the *nearest* tone that
/// interval can take, which is zero whenever some picture makes the two the
/// same tone.
///
/// Both decorations are graded on this one number - the box in
/// [`box_guarantees_legibility`] and the stroke in
/// [`CaptionPaint::outline_protects`] - so a box and a stroke of the same
/// colour and alpha are worth the same separation, and only what each of them
/// has to clear differs. The result is on 0–1 and is not yet scaled by the
/// layer opacity; the callers do that, because the glyphs are faded by the
/// layer as well as the decoration is.
fn decoration_separation(text_luminance: f64, alpha: f64, decoration_luminance: f64) -> f64 {
    let alpha = alpha.clamp(0.0, 1.0);
    let lowest = alpha * decoration_luminance.clamp(0.0, 1.0);
    let highest = lowest + (1.0 - alpha);

    if text_luminance < lowest {
        lowest - text_luminance
    } else if text_luminance > highest {
        text_luminance - highest
    } else {
        0.0
    }
}

/// The most separation any stroke could reach at a given layer opacity, 0–1.
///
/// The layer fades the stroke as well as the glyphs. At opacity `L` even an
/// authored-opaque stroke reaches the picture at alpha `L`, so by
/// [`decoration_separation`] the band it leaves is `(1 - L)` wide and the
/// furthest the text can possibly sit from that band is `L` — whatever colours
/// the style picks, and whichever side of the band the text is on. The glyphs
/// are drawn at `L` too, so what the viewer reads is at most `L * L`.
///
/// Below `sqrt(min_contrast)` that ceiling is under the floor, which means no
/// restyling can rescue the cue and the `standard-outline` fix would be advice
/// that cannot work. The rule offers the opacity instead.
fn best_outline_separation(layer_opacity: f64) -> f64 {
    let opacity = layer_opacity.clamp(0.0, 1.0);
    opacity * opacity
}

/// What a cue's style says about the words themselves.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CaptionPaint {
    /// Luminance of the text colour, 0–1
    text_luminance: f64,
    /// Alpha the background box actually paints at, `0.0` for none
    ///
    /// The style's own box alpha times [`CaptionPaint::layer_opacity`], because
    /// that is the product both renderers hand to the box colour.
    box_alpha: f64,
    /// Luminance of that box's colour, 0–1; meaningless where none is painted
    box_luminance: f64,
    /// Whether the renderer draws a stroke around the glyphs that reaches the
    /// picture, layer opacity included
    strokes_glyphs: bool,
    /// Luminance of that stroke's colour, 0–1; meaningless where none is drawn
    outline_luminance: f64,
    /// Alpha the style names for that stroke, 0–1; `0.0` where none is drawn
    ///
    /// The style's own alpha *before* [`CaptionPaint::layer_opacity`], unlike
    /// [`CaptionPaint::box_alpha`], because the stroke is only ever asked about
    /// through [`CaptionPaint::outline_protects`], which folds the layer in
    /// itself.
    outline_alpha: f64,
    /// Opacity the whole caption layer is drawn at, 0–1
    ///
    /// `effective_text_layer_opacity` of the style's opacity and the clip's, so
    /// a caption faded out of the frame is known to draw nothing at all.
    layer_opacity: f64,
}

impl CaptionPaint {
    /// Whether the renderer paints a background box at all, however faint.
    ///
    /// The gate the ASS path keys `BorderStyle: 3` off, and the one `drawtext`
    /// keys `box=1` off, so it is what both renderers can be asserted against.
    /// See [`paints_at`] for the rounding.
    fn paints_box(&self) -> bool {
        paints_at(self.box_alpha)
    }

    /// Whether a box that settles the question on its own is painted.
    ///
    /// Alpha alone never answers this: see [`box_guarantees_legibility`].
    fn protects_with_box(&self, thresholds: ContrastThresholds) -> bool {
        self.paints_box()
            && box_guarantees_legibility(
                self.text_luminance,
                self.box_alpha,
                self.box_luminance,
                self.layer_opacity,
                thresholds,
            )
    }

    /// Whether the glyphs reach the picture at all.
    ///
    /// A caption layer faded to nothing draws nothing, and a cue nobody can see
    /// is not a legibility defect - it is a different one, and reporting it here
    /// would be reporting the contrast of pixels that were never drawn. Graded
    /// at the same quantisation as the box (see [`paints_at`]), because the
    /// glyphs' alpha is written through the same rounding.
    fn draws_text(&self) -> bool {
        paints_at(self.layer_opacity)
    }

    /// Whether the outline the style asks for actually reaches the picture.
    ///
    /// `BorderStyle: 3` replaces the outline with the box, so on the ASS path -
    /// the one that renders wherever libass is present - a painted box takes
    /// the stroke away with it. A stroke therefore only exists where no box is
    /// painted at all; whether the stroke that does exist is *protection* is a
    /// second question, asked by [`CaptionPaint::outline_protects`].
    fn draws_outline(&self) -> bool {
        self.strokes_glyphs && !self.paints_box()
    }

    /// Whether the stroke that is drawn also settles the question.
    ///
    /// A stroke separates the glyphs from the picture by standing between the
    /// two, so what it is worth is the separation between the *text* and the
    /// *ring the viewer actually sees*. A stroke that is not opaque is not its
    /// own colour: it is `a * outline + (1 - a) * picture` at the alpha `a` it
    /// is painted at, and the picture is somewhere on 0–1, so the ring lies on
    /// the same interval a box leaves — `[a * outline, a * outline + (1 - a)]`.
    /// Measuring the stroke against its *authored* colour instead
    /// (`a * |text - outline|`) is not conservative: it credits a translucent
    /// stroke with a separation no picture behind it allows. A half-alpha black
    /// stroke around `#CCCCCC` words reads that way as 0.4, while over a white
    /// shot the ring is 0.498 and the words clear it by 0.302 — under the
    /// default floor, and waved through unmeasured.
    ///
    /// So the ring's separation is measured by exactly the arithmetic a box's
    /// is - [`decoration_separation`], with the stroke's painted alpha and
    /// colour in the box's place - and that separation, scaled by the layer
    /// opacity, is the whole of the test. The box's second clause, on
    /// [`ContrastThresholds::max_band_stddev`], is deliberately not applied
    /// here. A box is what the band is *measured through*
    /// ([`CaptionBandSample::effective_band_stddev`]), so a translucent one
    /// waved through unmeasured would skip a reading the pass would otherwise
    /// have taken; a stroke is composited into no measurement at all, so the
    /// alternative to trusting it is not a better reading but a report on a
    /// cue nothing was measured about. Holding the ring to the spread clause
    /// too reported strokes that plainly do protect the words: a `#00000080`
    /// outline around white words leaves a ring no lighter than 0.498, which
    /// the glyphs clear by 0.502, and it was still called `lowContrast` over a
    /// white shot because half an alpha cannot flatten a hypothetical worst-case
    /// picture.
    ///
    /// Both halves matter and neither is enough on its own: a white stroke
    /// around white words at full opacity separates nothing, and a black stroke
    /// drawn at a fifth of an alpha carries a fifth of its blackness. Gating on
    /// the layer opacity alone waved both through — the cue was never decoded
    /// and never reported: not graded clean, not counted as faded out, simply
    /// absent from the report.
    ///
    /// Graded against the run's own `min_contrast`, the same floor
    /// [`box_guarantees_legibility`] and the measured grading use, so a stroke
    /// is protection exactly where the separation it draws would have cleared
    /// the check had it been measured.
    fn outline_protects(&self, thresholds: ContrastThresholds) -> bool {
        let painted_alpha = (self.outline_alpha * self.layer_opacity).clamp(0.0, 1.0);
        let separation =
            decoration_separation(self.text_luminance, painted_alpha, self.outline_luminance);

        self.draws_outline()
            && separation * self.layer_opacity.clamp(0.0, 1.0) >= thresholds.min_contrast
    }

    /// Whether the style already protects the words from their background.
    fn is_mitigated(&self, thresholds: ContrastThresholds) -> bool {
        self.protects_with_box(thresholds) || self.outline_protects(thresholds)
    }
}

/// Whether an alpha survives the rounding both renderers write it through.
///
/// `AssColor` quantises to an inverted byte and `drawtext` to two decimals, so
/// anything under half a step of alpha is written out and paints nothing. The
/// byte is the finer of the two and is the one every decoration is asked
/// against here, so the box, the stroke and the glyphs all answer the same
/// question rather than three different ones.
fn paints_at(alpha: f64) -> bool {
    ((1.0 - alpha) * 255.0).round() < 255.0
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
///
/// Stored style blobs carry numbers as strings often enough that the renderer
/// reads both, so every check that has to predict the renderer reads both too -
/// which is why this is shared with the safe-area rule rather than each rule
/// reaching for `as_f64` and disagreeing with the burn-in over `"48"`.
pub(crate) fn json_number(value: &serde_json::Value) -> Option<f64> {
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
/// box too faint to hide anything all come back bare. A fully transparent box
/// is bare *and* leaves the outline standing, which is what the ASS path does
/// with it.
///
/// `clip_opacity` is the caption clip's own opacity, which both renderers fold
/// into every alpha the layer paints with, so it decides the box and the stroke
/// here too.
fn caption_paint(style: Option<&serde_json::Value>, clip_opacity: f32) -> CaptionPaint {
    // `build_caption_text_effect` reads `clip.caption_style.as_object()`; a
    // missing or non-object blob sets no style param at all, and the renderers
    // then draw white text with no decoration whatsoever - at the clip's own
    // opacity, which applies whether or not there is a style blob to read.
    let Some(style) = style.and_then(serde_json::Value::as_object) else {
        return CaptionPaint {
            text_luminance: DEFAULT_TEXT_LUMINANCE,
            box_alpha: 0.0,
            box_luminance: 0.0,
            strokes_glyphs: false,
            outline_luminance: 0.0,
            outline_alpha: 0.0,
            layer_opacity: effective_text_layer_opacity(1.0, clip_opacity),
        };
    };

    let text_colour = style_field(style, &["color"]).and_then(parse_paint_colour);
    let text_luminance = text_colour
        .map(|colour| colour.luminance)
        .unwrap_or(DEFAULT_TEXT_LUMINANCE);

    // `build_caption_text_effect` takes the layer's opacity from the style's
    // own `opacity`, falling back to the alpha of the text colour, and then
    // folds the clip's opacity into it. Every decoration's alpha is multiplied
    // by the result on both render paths.
    let text_opacity = style_field(style, &["opacity"])
        .and_then(json_number)
        .map(|opacity| opacity.clamp(0.0, 1.0))
        .or_else(|| text_colour.map(|colour| colour.alpha))
        .unwrap_or(1.0);
    let layer_opacity = effective_text_layer_opacity(text_opacity, clip_opacity);

    // A box the renderer cannot paint is not a box: the ASS path leaves
    // `BorderStyle: 1` and the outline in place for a fully transparent
    // `backgroundColor`, and `drawtext` writes `box=1` with a colour that draws
    // nothing. Both the alpha and the colour are carried rather than collapsed
    // to a flag, because a box below the protection floor is not waved through:
    // it is composited over the measured band, which needs both.
    let background =
        style_field(style, &["backgroundColor", "background_color"]).and_then(parse_paint_colour);
    let box_alpha = background
        .map(|colour| colour.alpha * layer_opacity)
        .unwrap_or(0.0);
    let box_luminance = background.map(|colour| colour.luminance).unwrap_or(0.0);

    // The outline is keyed off the colour, exactly as both renderers key it:
    // no `outlineColor`, no stroke, whatever `outlineWidth` says. The width
    // then defaults to the renderer's own 2 and is rounded the same way, so a
    // sub-half-pixel width reads as the nothing it renders as, and the stroke's
    // own alpha is scaled by the layer opacity and quantised the same way the
    // box's is. Colour and alpha are carried rather than collapsed to a flag,
    // for the same reason the box's are: a stroke is protection only where it
    // separates the words from itself, which needs both.
    let outline =
        style_field(style, &["outlineColor", "outline_color"]).and_then(parse_paint_colour);
    let strokes_glyphs = outline.is_some_and(|colour| {
        let width = style_field(style, &["outlineWidth", "outline_width"])
            .and_then(json_number)
            .unwrap_or(2.0)
            .clamp(0.0, 100.0)
            .round();
        colour.is_visible() && paints_at(colour.alpha * layer_opacity) && width > 0.0
    });

    CaptionPaint {
        text_luminance,
        box_alpha,
        box_luminance,
        strokes_glyphs,
        outline_luminance: outline.map(|colour| colour.luminance).unwrap_or(0.0),
        outline_alpha: outline.map(|colour| colour.alpha).unwrap_or(0.0),
        layer_opacity,
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
    /// Column the words occupy, as `(left, right)` percentages of canvas width
    span_percent: (f64, f64),
    paint: CaptionPaint,
}

/// The cues one window offers a sampling pass, sorted and counted.
#[derive(Debug, Default)]
struct CandidateCues {
    /// Cues whose bands are worth decoding, earliest first
    cues: Vec<CaptionCue>,
    /// Cues inside the window whose layer is faded out entirely
    ///
    /// Nothing of them reaches the picture, so there is nothing to measure -
    /// but they are still cues the report has to account for, which is why they
    /// are counted here instead of dropped.
    faded_out: usize,
}

/// Returns the caption cues a file covering `window` could be asked about.
///
/// Cues with no text are not cues, and cues the style already protects are
/// excluded here rather than after decoding: the style is the answer, and
/// paying for a frame to confirm it would make the check cost scale with the
/// captions that are already fine. A cue faded out of the frame is not measured
/// either, for the same reason - the style answers it - but it is counted in
/// [`CandidateCues::faded_out`] and reaches the report as coverage, because a
/// caption nobody can see is a cue this pass did not grade rather than one it
/// graded clean.
fn sampling_candidates(
    sequence: &Sequence,
    window: (f64, f64),
    canvas_width: u32,
    canvas_height: u32,
    thresholds: ContrastThresholds,
) -> CandidateCues {
    let (window_start, window_end) = window;
    let mut candidates = CandidateCues::default();
    let cues = &mut candidates.cues;

    for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
        for clip in &track.clips {
            let Some(cue) = caption_cue(track, clip, canvas_width, canvas_height) else {
                continue;
            };
            // A cue the renderer already protects is answered without a decode.
            // A faded one is answered too, but it is counted rather than
            // dropped, so the mitigation test is asked only of cues that draw.
            if cue.paint.draws_text() && cue.paint.is_mitigated(thresholds) {
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
            if !cue.paint.draws_text() {
                candidates.faded_out += 1;
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
    candidates
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
        span_percent: super::rules::caption_span_percent(clip, canvas_width, canvas_height),
        paint: caption_paint(clip.caption_style.as_ref(), clip.opacity),
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

    for (position, item) in items.into_iter().enumerate() {
        let wanted = ((kept.len() as f64) * step).floor() as usize;
        if kept.len() < limit && position >= wanted {
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

    let CandidateCues { cues, faded_out } = sampling_candidates(
        sequence,
        window,
        canvas_width,
        canvas_height,
        options.thresholds,
    );
    let mut sampling = CaptionBandSampling {
        coverage: CaptionSampleCoverage {
            // Faded cues are cues the pass did not grade, so they count toward
            // the total and toward what went unmeasured.
            cues: cues.len() + faded_out,
            faded_out,
            ..CaptionSampleCoverage::default()
        },
        ..CaptionBandSampling::default()
    };

    // A file shorter than the window it was declared for cannot answer for the
    // cues past its end, and saying so is the only honest answer available.
    let decodable_end = decodable_end_sec(window, options.file_duration_sec);
    let drawn_count = cues.len();
    let reachable: Vec<CaptionCue> = cues
        .into_iter()
        .filter(|cue| cue.midpoint_sec <= decodable_end)
        .collect();
    sampling.coverage.beyond_file = drawn_count - reachable.len();
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
            cue.span_percent,
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
                has_box: cue.paint.paints_box(),
                has_outline: cue.paint.outline_protects(options.thresholds),
                box_alpha: if cue.paint.paints_box() {
                    cue.paint.box_alpha
                } else {
                    0.0
                },
                box_luminance: cue.paint.box_luminance,
                layer_opacity: cue.paint.layer_opacity,
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

/// Builds the filter chain that isolates the rectangle a caption occupies.
///
/// Both axes are cropped. Measuring the full frame width let a bright strip in
/// a corner the words never reach dominate the spread and report a centred
/// caption as sitting over a mixed background, so the crop is the column the
/// line is drawn in as well as the band it sits on.
///
/// The frame is scaled first and cropped second, so the crop arithmetic runs on
/// a bounded picture and can never ask for an empty rectangle: `max(1,…)` keeps
/// each side positive and `min(iw-ow,…)`/`min(ih-oh,…)` keep the window inside
/// the scaled frame whatever the percentages say.
fn band_filter(band_percent: (f64, f64), span_percent: (f64, f64), max_width: u32) -> String {
    let (top, bottom) = band_percent;
    let (left, right) = span_percent;
    let top_fraction = (top / 100.0).clamp(0.0, 1.0);
    let height_fraction = ((bottom - top) / 100.0).clamp(0.0, 1.0);
    let left_fraction = (left / 100.0).clamp(0.0, 1.0);
    let width_fraction = ((right - left) / 100.0).clamp(0.0, 1.0);

    format!(
        "scale=w='min({},iw)':h=-2,crop=w='max(1,floor(iw*{:.6}))':h='max(1,floor(ih*{:.6}))':x='min(iw-ow,max(0,floor(iw*{:.6})))':y='min(ih-oh,max(0,floor(ih*{:.6})))',format=rgb24",
        max_width.max(1),
        width_fraction,
        height_fraction,
        left_fraction,
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
    span_percent: (f64, f64),
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
        band_filter(band_percent, span_percent, max_width),
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
/// Without a rendered file there is nothing to compare against, so the rule is
/// reported as skipped rather than passed — see [`skip_reason`](CaptionContrastRule::skip_reason).
/// A check that guessed from the timeline alone would be guessing about pixels
/// it has not seen. The same is true, cue by cue, of everything a sampling pass
/// could not reach, which is why partial coverage is an [`Severity::Info`]
/// finding rather than a silent pass.
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

    /// The command that puts the caption clip back to full opacity.
    ///
    /// Offered in place of [`Self::restyle_fix`] on a cue whose layer opacity
    /// is already too low for any stroke to lift it over the floor - see
    /// [`best_outline_separation`]. The layer opacity is the style's opacity
    /// times the clip's, and this is the clip's half of it, which is why the
    /// fix carries a lower confidence than the restyle does and the details say
    /// what to do when the style is the faded one.
    fn opacity_fix(sequence_id: &str, sample: &CaptionBandSample) -> serde_json::Value {
        serde_json::json!({
            "type": "SetClipOpacity",
            "sequenceId": sequence_id,
            "trackId": sample.track_id,
            "clipId": sample.clip_id,
            "opacity": 1.0,
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
    ///
    /// An outline the viewer can see, in a colour the words stand out against,
    /// settles the question, because it separates the glyphs from anything -
    /// which is why the flag on the sample is written by
    /// [`CaptionPaint::outline_protects`] rather than by the presence of a
    /// stroke, so a stroke drawn too faintly or in the text's own colour does
    /// not short-circuit the grading here. A box does not settle it
    /// by being a box: it is composited over the measured band, and the diluted
    /// picture is what the words are graded against, so a wash that genuinely
    /// rescues a white-on-white cue clears the check and one that only looks
    /// like a box does not. Nothing is short-circuited on the box here, because
    /// a box that *could* have been short-circuited - see
    /// [`box_guarantees_legibility`], which is what keeps those cues from being
    /// decoded at all - clears the measured grading too, by construction: the
    /// measured band lies inside the interval that rule quantified over.
    fn fault_for(
        sample: &CaptionBandSample,
        min_contrast: f64,
        max_stddev: f64,
    ) -> Option<ContrastFault> {
        if sample.has_outline {
            return None;
        }
        let contrast = sample.contrast();
        if contrast.is_finite() && contrast < min_contrast {
            return Some(ContrastFault::LowContrast);
        }
        let stddev = sample.effective_band_stddev();
        if stddev.is_finite() && stddev > max_stddev {
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
            .with_details(format!(
                "Those cues are neither legible nor illegible as far as this report is \
                 concerned. Re-render the window they fall in, or raise the run's timeout, and \
                 verify again.{}",
                if coverage.faded_out > 0 {
                    format!(
                        " {} of them are faded out of the frame entirely, which no re-render \
                         changes: raise the caption's opacity if the words are meant to be seen.",
                        coverage.faded_out
                    )
                } else {
                    String::new()
                }
            ))
            .with_metric("measured", coverage.sampled > 0)
            .with_metric("cueCount", coverage.cues)
            .with_metric("sampledCount", coverage.sampled)
            .with_metric("unmeasuredCount", unmeasured)
            .with_metric("decodeFailures", coverage.decode_failures)
            .with_metric("beyondFile", coverage.beyond_file)
            .with_metric("overFrameCap", coverage.over_cap)
            .with_metric("timedOut", coverage.timed_out)
            .with_metric("fadedOut", coverage.faded_out),
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
            // The engine reports this rule as skipped (see `skip_reason`); an
            // empty result here only guards direct single-rule invocations.
            return Ok(Vec::new());
        };

        // The same resolution the sampling pass ran before it decided which
        // cues never needed a decode, so both halves grade one pair of numbers.
        let ContrastThresholds {
            min_contrast,
            max_band_stddev: max_stddev,
        } = ContrastThresholds::from_config(config);
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let mut violations = Vec::new();
        for sample in &measurements.caption_band_samples {
            let Some(fault) = Self::fault_for(sample, min_contrast, max_stddev) else {
                continue;
            };

            // A cue with a faint box was graded with that box blended over the
            // picture, so saying it has nothing behind the words would be
            // wrong; a bare one has exactly nothing, which is the point.
            let separation = if sample.box_alpha > 0.0 {
                format!(
                    "even with the {:.0}%-opaque box behind them",
                    sample.box_alpha * 100.0
                )
            } else {
                "with no box or outline to separate them".to_string()
            };

            let message = match fault {
                ContrastFault::LowContrast => format!(
                    "Caption text and the picture behind it differ by only {:.2} luminance \
                     (limit {:.2}), {separation}",
                    sample.contrast(),
                    min_contrast
                ),
                ContrastFault::MixedBackground => format!(
                    "Caption text sits over a mixed background (luminance spread {:.2}, limit \
                     {:.2}), {separation}",
                    sample.effective_band_stddev(),
                    max_stddev
                ),
            };

            // What the box did to the numbers, for a cue that carries one: the
            // metrics report the picture as measured, and the verdict was
            // reached on the picture the box left behind.
            let blended = if sample.box_alpha > 0.0 {
                format!(
                    " The cue's {:.0}%-opaque box leaves that reading {:.2} (spread {:.2}) where \
                     the words sit.",
                    sample.box_alpha * 100.0,
                    sample.effective_band_luminance(),
                    sample.effective_band_stddev()
                )
            } else {
                String::new()
            };

            // And what the layer's own opacity did to them: the glyphs are
            // painted at it, so the separation that reached the picture is that
            // fraction of the one the two colours below imply.
            let faded = if sample.layer_opacity < 1.0 {
                format!(
                    " The caption layer is drawn at {:.0}% opacity, so the words reach the \
                     picture at that fraction of their colour.",
                    sample.layer_opacity * 100.0
                )
            } else {
                String::new()
            };

            // An outline is only worth suggesting where the layer leaves room
            // for one. The stroke is faded with the glyphs, so the most any
            // stroke can separate them by is the layer opacity squared; under
            // the floor, the `standard-outline` pack is advice that cannot
            // work, and the opacity is the thing to raise instead.
            let outline_can_rescue = best_outline_separation(sample.layer_opacity) >= min_contrast;
            let remedy = if outline_can_rescue {
                "Give the cue an outline so it reads over any background.".to_string()
            } else {
                format!(
                    "At {:.0}% layer opacity no outline can reach {min_contrast:.2} separation - \
                     the stroke fades with the glyphs - so raise the caption's opacity first. The \
                     layer opacity is the style's opacity times the clip's, so raise the style's \
                     too if the clip is already opaque.",
                    sample.layer_opacity * 100.0
                )
            };

            let details = match fault {
                ContrastFault::LowContrast => format!(
                    "Measured at {:.2}s: the band the words occupy averages {:.2} luminance \
                     (spread {:.2}) and the text is {:.2}.{blended}{faded} {remedy}",
                    sample.sampled_at_sec,
                    sample.band_luminance,
                    sample.band_luminance_stddev,
                    sample.text_luminance
                ),
                ContrastFault::MixedBackground => format!(
                    "Measured at {:.2}s: the band the words occupy averages {:.2} luminance but \
                     varies by {:.2} across its width, so text at {:.2} clears part of it and \
                     disappears into the rest.{blended}{faded} {remedy}",
                    sample.sampled_at_sec,
                    sample.band_luminance,
                    sample.band_luminance_stddev,
                    sample.text_luminance
                ),
            };

            let mut violation = QCViolation::new(self.name(), severity, message)
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
                .with_metric("hasOutline", sample.has_outline);

            // `boxAlpha` is the alpha of a box that exists; on a cue with no box
            // the number would be a measurement of nothing, and a reader would
            // have to know that `0.0` and "absent" mean the same thing here.
            if sample.has_box {
                violation =
                    violation.with_metric("boxAlpha", (sample.box_alpha * 1000.0).round() / 1000.0);
            }

            // `layerOpacity` is the fraction of their colour the glyphs were
            // drawn at, and `contrast` is already scaled by it. It is reported
            // only where it is not 1.0, so a reader who sees it knows the
            // reported contrast is smaller than `textLuminance` and
            // `bandLuminance` alone would suggest.
            if sample.layer_opacity < 1.0 {
                violation = violation.with_metric(
                    "layerOpacity",
                    (sample.layer_opacity * 1000.0).round() / 1000.0,
                );
            }

            let fix = if outline_can_rescue {
                ViolationFix::new(
                    format!("Restyle the caption with the '{CONTRAST_STYLE_PACK}' pack"),
                    vec![Self::restyle_fix(&sequence.id, sample)],
                )
                // The measurement is certain; that an outline is the style the
                // edit wants is not.
                .with_confidence(0.8)
            } else {
                ViolationFix::new(
                    "Raise the caption clip back to full opacity",
                    vec![Self::opacity_fix(&sequence.id, sample)],
                )
                // Lower still: the clip is only one of the two opacities that
                // multiply into the layer's, so this can be the wrong half.
                .with_confidence(0.5)
            };

            violations.push(
                violation
                    .with_metric("trackId", sample.track_id.clone())
                    .with_fix(fix),
            );
        }

        if let Some(coverage) = measurements.caption_band_coverage {
            violations.extend(self.coverage_violation(coverage));
        }

        Ok(violations)
    }

    /// Reports the check as skipped when there is no render to read.
    ///
    /// Whether a caption can be read depends on the picture behind it, so
    /// without a rendered file this check has nothing to look at - exactly the
    /// position every other rendered check is in, and it now says so the same
    /// way. Reporting `passed: false, skipped: false` plus an `info` finding
    /// asking for a file instead made a deliberate `--structural-only` run look
    /// like it had failed something, and asked the caller for a render the run
    /// had just declared it did not want. A run that *could* have measured is
    /// still told: the report's own "N rendered check(s) were skipped" warning
    /// covers it, and only where a file was actually an option.
    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        if context.measurements.is_none() {
            return Some("no rendered measurements available".to_string());
        }
        None
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
    use crate::core::render::export::{
        build_ass_text_overlay_script, build_caption_drawtext_with_enable,
    };
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

    /// The paint a style renders as on a clip at full opacity.
    fn paint_of(style: Option<&serde_json::Value>) -> CaptionPaint {
        caption_paint(style, 1.0)
    }

    /// The thresholds a run grades against when the caller configures none.
    fn thresholds_default() -> ContrastThresholds {
        ContrastThresholds::default()
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
            box_alpha: 0.0,
            box_luminance: 0.0,
            layer_opacity: 1.0,
        }
    }

    /// A sample of `text_luminance` text over a `band_luminance` picture, with
    /// a black background box painted at `box_alpha`.
    fn boxed_sample(band_luminance: f64, text_luminance: f64, box_alpha: f64) -> CaptionBandSample {
        CaptionBandSample {
            has_box: box_alpha > 0.0,
            box_alpha,
            box_luminance: 0.0,
            ..sample(band_luminance, text_luminance)
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
    /// Scenario: should offer the opacity, not an outline, on a faded cue
    ///
    /// The `standard-outline` pack was suggested whatever the cue's opacity
    /// was, and on a caption drawn at three tenths it is advice that cannot
    /// work: the stroke fades with the glyphs, so the most any restyle can
    /// separate them by is 0.09 and the floor is 0.35. The report now names
    /// the thing that would actually help.
    #[tokio::test]
    async fn should_offer_the_opacity_when_no_outline_could_rescue_the_cue() {
        let mut clip = caption_clip("Barely there", 1.0, 3.0, Some(bare_white_style()));
        clip.opacity = 0.3;
        let sequence = sequence_with_captions(vec![clip]);
        let faded = CaptionBandSample {
            layer_opacity: 0.3,
            ..sample(0.97, 1.0)
        };
        let measurements = RenderMeasurements {
            caption_band_samples: vec![faded],
            ..Default::default()
        };

        let violations = run_rule(&sequence, Some(measurements)).await;

        assert_eq!(violations.len(), 1);
        let fix = violations[0].suggested_fix.as_ref().expect("a fix");
        assert_eq!(fix.commands.len(), 1);
        assert_eq!(fix.commands[0]["type"], "SetClipOpacity");
        assert_eq!(fix.commands[0]["opacity"], 1.0);
        assert!(
            violations[0]
                .details
                .as_ref()
                .expect("details")
                .contains("no outline can reach"),
            "the report says why the outline it usually suggests is not offered"
        );

        // The outline is still the fix wherever one could clear the floor: at
        // eight tenths a stroke is worth up to 0.64.
        let workable = CaptionBandSample {
            layer_opacity: 0.8,
            ..sample(0.97, 1.0)
        };
        let violations = run_rule(
            &sequence,
            Some(RenderMeasurements {
                caption_band_samples: vec![workable],
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0]
                .suggested_fix
                .as_ref()
                .expect("a fix")
                .commands[0]["type"],
            "UpdateCaption"
        );
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
    /// Scenario: should be skipped, not reported, without a rendered file
    ///
    /// Reporting a finding here made a `--structural-only` run - a run that had
    /// just said it wanted no render - come back with `passed: false` and a
    /// line asking for one. Every other rendered check answers this by being
    /// skipped, and the report's own "N rendered check(s) were skipped" warning
    /// nudges the callers for whom a file was actually an option.
    #[tokio::test]
    async fn should_be_skipped_rather_than_reported_without_a_rendered_file() {
        let sequence = sequence_with_captions(vec![
            caption_clip("First", 1.0, 3.0, Some(bare_white_style())),
            caption_clip("Second", 3.0, 5.0, Some(bare_white_style())),
            caption_clip("Third", 5.0, 7.0, Some(bare_white_style())),
        ]);

        let context = QCContext::from_sequence(&sequence);
        assert!(
            CaptionContrastRule::new().skip_reason(&context).is_some(),
            "a rendered check with nothing to read has to report as skipped"
        );
        assert!(
            run_rule(&sequence, None).await.is_empty(),
            "and it must not also invent a finding on the way past"
        );
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
        let boxed = serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 230 } });
        assert!(paint_of(Some(&boxed)).protects_with_box(ContrastThresholds::default()));

        // A box the picture shows too much of is measured, not waved past: at
        // half alpha the spread that survives can still be a mixed background.
        let translucent =
            serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 128 } });
        assert!(paint_of(Some(&translucent)).paints_box());
        assert!(!paint_of(Some(&translucent)).is_mitigated(ContrastThresholds::default()));

        // A box the viewer cannot see is not a box, and it does not take the
        // outline with it either: the ASS path keeps `BorderStyle: 1`.
        let clear_box =
            serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 0 } });
        assert!(!paint_of(Some(&clear_box)).is_mitigated(ContrastThresholds::default()));
        let clear_box_outlined = serde_json::json!({
            "backgroundColor": "#00000000",
            "outlineColor": "#000000",
            "outlineWidth": 4,
        });
        assert!(
            paint_of(Some(&clear_box_outlined)).draws_outline(),
            "an unpaintable box leaves the outline standing"
        );

        // A box faint enough for the footage to read straight through is not
        // protection, and because a painted box replaces the outline on the
        // ASS path, an outline behind one is not protection either.
        let wash = serde_json::json!({
            "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 12 },
            "outlineColor": "#000000",
            "outlineWidth": 4,
        });
        assert!(
            !paint_of(Some(&wash)).is_mitigated(ContrastThresholds::default()),
            "a box below the protection floor hides nothing and hides the stroke"
        );

        // An outline width with no colour renders no outline at all.
        let width_only = serde_json::json!({ "outlineWidth": 4 });
        assert!(
            !paint_of(Some(&width_only)).is_mitigated(ContrastThresholds::default()),
            "the renderer keys the stroke off outlineColor"
        );

        // A colour with no width renders the renderer's own default of 2px.
        let colour_only = serde_json::json!({ "outlineColor": "#000000" });
        assert!(paint_of(Some(&colour_only)).draws_outline());

        // An explicit zero width turns it off again.
        let zeroed = serde_json::json!({ "outlineColor": "#000000", "outlineWidth": 0 });
        assert!(!paint_of(Some(&zeroed)).is_mitigated(ContrastThresholds::default()));

        // A partial blob that says nothing about either decoration renders
        // bare, whatever `CaptionStyle::default` would have carried.
        let partial = serde_json::json!({ "fontSize": 64 });
        assert!(!paint_of(Some(&partial)).is_mitigated(ContrastThresholds::default()));

        // And no style at all is the barest case of the lot.
        assert!(!paint_of(None).is_mitigated(ContrastThresholds::default()));
    }

    /// Feature: Caption legibility
    /// Scenario: should grade a translucent box by what it actually hides
    ///
    /// A ten-percent wash used to buy a cue a free pass: the check saw a box,
    /// declined to decode the frame and reported nothing, while the footage
    /// read straight through it. Now only a box that settles the question on
    /// its own goes unmeasured, and everything below it is composited over the
    /// band and graded on what is left.
    #[test]
    fn should_blend_a_translucent_box_into_the_band_it_covers() {
        let black_box_at = |alpha: f64| {
            serde_json::json!({
                "color": "#FFFFFF",
                "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": (alpha * 255.0).round() },
            })
        };

        // A tenth of a black box over white leaves the band at 0.9, which white
        // text cannot be read against.
        assert!(
            !paint_of(Some(&black_box_at(0.1))).is_mitigated(ContrastThresholds::default()),
            "a box this faint must still be measured"
        );
        assert_eq!(
            CaptionContrastRule::fault_for(
                &boxed_sample(1.0, 1.0, 0.1),
                DEFAULT_MIN_CONTRAST,
                DEFAULT_MAX_BAND_STDDEV
            ),
            Some(ContrastFault::LowContrast)
        );

        // Once the black box is opaque enough that no picture can reach either
        // limit, it decides the question by itself and the cue is never decoded.
        assert!(
            paint_of(Some(&black_box_at(0.8))).is_mitigated(ContrastThresholds::default()),
            "a box this opaque protects white words whatever is behind it"
        );
        assert_eq!(
            CaptionContrastRule::fault_for(
                &boxed_sample(1.0, 1.0, 0.8),
                DEFAULT_MIN_CONTRAST,
                DEFAULT_MAX_BAND_STDDEV
            ),
            None
        );

        // Half a black box brings a white band to 0.5, which white text clears.
        assert!(
            !paint_of(Some(&black_box_at(0.5))).is_mitigated(ContrastThresholds::default()),
            "a half-opaque box is measured, not waved through"
        );
        assert_eq!(
            CaptionContrastRule::fault_for(
                &boxed_sample(1.0, 1.0, 0.5),
                DEFAULT_MIN_CONTRAST,
                DEFAULT_MAX_BAND_STDDEV
            ),
            None,
            "a box that genuinely rescues the cue must clear the check"
        );

        // And the spread it hides counts for as much as the mean it lifts.
        let mut mixed = boxed_sample(0.5, 1.0, 0.5);
        mixed.band_luminance_stddev = 0.3;
        assert_eq!(
            CaptionContrastRule::fault_for(&mixed, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            None,
            "half the picture is half the spread"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should decide a box on its colour, not only on its alpha
    ///
    /// A ninety-percent box used to buy any cue a free pass, whatever the box
    /// was made of. White words on a nearly-white box are exactly as unreadable
    /// as white words on a white wall, and the check declined to decode the
    /// frame that would have said so.
    #[test]
    fn should_measure_a_box_the_text_disappears_into() {
        let boxed = |red: u8, green: u8, blue: u8, alpha: f64| {
            serde_json::json!({
                "color": "#FFFFFF",
                "backgroundColor": {
                    "r": red, "g": green, "b": blue, "a": (alpha * 255.0).round(),
                },
            })
        };

        // White text on a ninety-percent *white* box: the band it leaves is
        // 0.9 at the darkest, and white words cannot be read against that.
        let white_box = boxed(255, 255, 255, 0.9);
        assert!(paint_of(Some(&white_box)).paints_box());
        assert!(
            !paint_of(Some(&white_box)).is_mitigated(ContrastThresholds::default()),
            "a box the same tone as the words protects nothing"
        );

        // And over a dark shot the decode it now earns reports the cue.
        let mut sample = boxed_sample(0.0, 1.0, 0.9);
        sample.box_luminance = 1.0;
        assert_eq!(
            CaptionContrastRule::fault_for(&sample, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            Some(ContrastFault::LowContrast),
            "white on a white box over black is the case this exists to catch"
        );

        // The same alpha in black is protection, because no picture can lift
        // the band it leaves anywhere near white.
        assert!(
            paint_of(Some(&boxed(0, 0, 0, 0.9))).is_mitigated(ContrastThresholds::default()),
            "a black box this opaque settles the question by itself"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should grade the glyphs at the opacity they are drawn at
    ///
    /// The box and the stroke already carried the layer's opacity; the words
    /// did not. So a grey box that guarantees an opaque caption its separation
    /// bought a *faded* one the same free pass, and the cue it waved through
    /// was drawn at a fraction of the contrast the colours promised.
    #[test]
    fn should_fold_the_layer_opacity_into_the_glyphs() {
        let faded_box = serde_json::json!({
            "color": "#FFFFFF",
            "opacity": 0.6,
            "backgroundColor": "#696969",
        });
        let paint = paint_of(Some(&faded_box));
        assert!(paint.paints_box());
        assert!(
            !paint.is_mitigated(thresholds_default()),
            "a box is worth only what the glyphs drawn over it can show"
        );

        // Over a white shot the box leaves the band at 0.65, and white words
        // drawn at six tenths separate from it by 0.21 - not the 0.35 the two
        // colours on their own would suggest.
        let mut boxed = boxed_sample(1.0, 1.0, paint.box_alpha);
        boxed.box_luminance = paint.box_luminance;
        boxed.layer_opacity = paint.layer_opacity;
        assert!(
            (boxed.contrast() - 0.212).abs() < 0.01,
            "the drawn separation is the layer opacity times the colours', got {}",
            boxed.contrast()
        );
        assert_eq!(
            CaptionContrastRule::fault_for(&boxed, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            Some(ContrastFault::LowContrast)
        );

        // And a bare caption faded to a third over a dark band is graded on the
        // third that reaches the picture, not on the whole palette.
        let mut bare = sample(0.1, 1.0);
        bare.layer_opacity = 0.3;
        assert!(
            (bare.contrast() - 0.27).abs() < 1e-9,
            "0.3 of a 0.9 separation is 0.27, got {}",
            bare.contrast()
        );
        assert_eq!(
            CaptionContrastRule::fault_for(&bare, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            Some(ContrastFault::LowContrast),
            "a caption this faint is unreadable however bold its colours are"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should grade a stroke the viewer cannot see
    ///
    /// The stroke was treated as protection whatever opacity it was painted at,
    /// so a caption faded to a twentieth carried one that reached the picture
    /// with a twentieth of its colour and was never decoded at all - not graded
    /// clean, not counted as faded out, simply missing from the report.
    #[test]
    fn should_grade_an_outline_drawn_below_the_contrast_floor() {
        let outlined = serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#000000",
            "outlineWidth": 4,
        });

        // At full opacity the stroke separates the glyphs from anything, so the
        // cue is never decoded and the flag says so.
        let opaque = caption_paint(Some(&outlined), 1.0);
        assert!(opaque.draws_outline());
        assert!(
            opaque.is_mitigated(thresholds_default()),
            "a stroke the viewer can see settles the question"
        );
        assert!(opaque.outline_protects(thresholds_default()));

        // Faded to a twentieth it is still a stroke, and still no protection:
        // the picture only ever receives a twentieth of its colour.
        let faded = caption_paint(Some(&outlined), 0.05);
        assert!(
            faded.draws_outline(),
            "the renderer still writes the stroke; what changed is what it shows"
        );
        assert!(
            !faded.is_mitigated(thresholds_default()),
            "a stroke drawn below the run's floor cannot carry that much separation"
        );
        assert!(
            faded.draws_text(),
            "and the words do reach the picture, so this is a cue to measure              rather than one to count as faded out"
        );

        // The flag the sample carries is written by the same gate, so the
        // grading is not short-circuited a second time on the way out.
        let mut graded = sample(0.0, 1.0);
        graded.layer_opacity = faded.layer_opacity;
        graded.has_outline = faded.outline_protects(thresholds_default());
        assert!(!graded.has_outline);
        assert_eq!(
            CaptionContrastRule::fault_for(&graded, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            Some(ContrastFault::LowContrast),
            "white words at a twentieth over black separate by 0.05, not by 1.0"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should grade a stroke that separates the words from nothing
    ///
    /// Protection was decided from the layer opacity alone, so a white stroke
    /// around white words - and a stroke washed out by its own alpha - counted
    /// as protection at full opacity and the cue disappeared from the report
    /// entirely: not graded clean, not counted as faded out, absent.
    #[test]
    fn should_grade_an_outline_that_cannot_separate_the_words() {
        // A stroke the same tone as the glyphs draws an edge nobody can see.
        let same_colour = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#FFFFFF",
            "outlineWidth": 4,
        })));
        assert!(
            same_colour.draws_outline(),
            "the renderer still writes the stroke; what changed is what it separates"
        );
        assert!(
            !same_colour.is_mitigated(thresholds_default()),
            "a white stroke around white words separates nothing"
        );

        // And the cue is graded, over a white wall, like any other bare one.
        let mut graded = sample(1.0, 1.0);
        graded.has_outline = same_colour.outline_protects(thresholds_default());
        assert!(!graded.has_outline);
        assert_eq!(
            CaptionContrastRule::fault_for(&graded, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV),
            Some(ContrastFault::LowContrast),
            "white words on a white wall are unreadable however they are stroked"
        );

        // A black stroke at a fifth of an alpha carries a fifth of its
        // blackness to the picture, which is under the run's floor.
        let washed_out = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#00000033",
            "outlineWidth": 4,
        })));
        assert!(washed_out.draws_outline());
        assert!(
            !washed_out.is_mitigated(thresholds_default()),
            "0.2 of a full separation does not clear a floor of {DEFAULT_MIN_CONTRAST}"
        );

        // The same stroke opaque is exactly what the check exists to wave
        // through, so the gate must not have become one that never passes.
        let opaque = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#000000",
            "outlineWidth": 4,
        })));
        assert!(
            opaque.outline_protects(thresholds_default()),
            "an opaque black stroke around white words reads over anything"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should grade a stroke against the ring the viewer sees
    ///
    /// A translucent stroke is not its own colour: the viewer reads
    /// `a * outline + (1 - a) * picture`, so the ring lies on the interval a
    /// box leaves and the stroke is worth the distance from the text to the
    /// *nearest* tone that interval can take. Grading it as
    /// `alpha * |text - outline|` credited it with a separation no picture
    /// behind it allows, and the cue was waved through unmeasured.
    #[test]
    fn should_grade_a_translucent_stroke_against_the_band_it_leaves() {
        // Light-grey words behind a half-alpha black stroke. The authored
        // arithmetic called this 0.502 * 0.8 = 0.4 and skipped the cue; over a
        // white shot the ring is 0.498 and the words clear it by 0.302, which
        // is under the default floor of 0.35.
        let half_alpha_stroke = paint_of(Some(&serde_json::json!({
            "color": "#CCCCCC",
            "outlineColor": "#00000080",
            "outlineWidth": 4,
        })));
        assert!(half_alpha_stroke.draws_outline());
        assert!(
            !half_alpha_stroke.outline_protects(thresholds_default()),
            "a stroke the shot shows through cannot promise more than the band it leaves"
        );

        // The same reasoning through the layer: an opaque black stroke on a
        // caption drawn at half opacity reaches the picture at half an alpha,
        // so the ring runs to 0.5 and the words - themselves at half opacity -
        // clear it by 0.25.
        let faded_layer = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#000000",
            "outlineWidth": 4,
            "opacity": 0.5,
        })));
        assert!(faded_layer.draws_outline());
        assert!(
            !faded_layer.outline_protects(thresholds_default()),
            "half of a full separation does not clear a floor of {DEFAULT_MIN_CONTRAST}"
        );
        assert!(
            faded_layer.draws_text(),
            "and the glyphs do reach the picture, so this is a cue to measure"
        );

        // The gate still waves through the stroke it exists for: opaque, and
        // so the only tone the ring can take is the stroke's own.
        let opaque = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#000000",
            "outlineWidth": 4,
        })));
        assert!(
            opaque.outline_protects(thresholds_default()),
            "an opaque stroke leaves the shot no way through to the glyph edge"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should trust a translucent stroke the words clear the ring of
    ///
    /// The separation the ring leaves is the whole of the stroke's test. Held
    /// to the box's spread clause as well, a `#00000080` outline around white
    /// words was refused: the ring can never be lighter than 0.498 and the
    /// glyphs clear it by 0.502, but half an alpha cannot flatten a worst-case
    /// picture, so the cue was decoded and reported `lowContrast` over a white
    /// shot. Nothing on the stroke path ever measures that spread, so the
    /// clause could only ever cost real strokes their credit.
    #[test]
    fn should_trust_a_translucent_stroke_the_ring_separates() {
        let half_alpha_stroke = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "outlineColor": "#00000080",
            "outlineWidth": 4,
        })));
        assert!(half_alpha_stroke.draws_outline());
        assert!(
            half_alpha_stroke.outline_protects(thresholds_default()),
            "white words clear the lightest tone a half-alpha black ring can take by 0.502"
        );

        // The separation itself was not loosened: the same stroke around
        // light-grey words is worth 0.302 and is still measured.
        let grey_words = paint_of(Some(&serde_json::json!({
            "color": "#CCCCCC",
            "outlineColor": "#00000080",
            "outlineWidth": 4,
        })));
        assert!(
            !grey_words.outline_protects(thresholds_default()),
            "0.302 of separation does not clear a floor of {DEFAULT_MIN_CONTRAST}"
        );

        // And the box keeps both clauses, because the band is measured
        // *through* a box: a wash at the same alpha is decoded, not skipped.
        let washed_box = paint_of(Some(&serde_json::json!({
            "color": "#FFFFFF",
            "backgroundColor": "#00000080",
        })));
        assert!(washed_box.paints_box());
        assert!(
            !washed_box.protects_with_box(thresholds_default()),
            "a box the shot shows through is graded on the band it leaves"
        );
    }

    /// Feature: Caption legibility
    /// Scenario: should skip a box only against the thresholds this run grades
    ///
    /// The skip is a claim that the cue cannot fail, and it is only true of the
    /// numbers the rule is about to grade with. Deciding it against the
    /// defaults let a run that asked for a stricter floor never decode the very
    /// cues that floor exists to catch.
    #[test]
    fn should_honour_the_configured_thresholds_when_skipping_a_box() {
        // White words on a mid-grey box at 80%: the darkest band it can leave
        // is 0.6, so the separation it guarantees is 0.4.
        let style = serde_json::json!({
            "color": "#FFFFFF",
            "backgroundColor": { "r": 128, "g": 128, "b": 128, "a": 204 },
        });
        let paint = paint_of(Some(&style));
        assert!(
            paint.is_mitigated(ContrastThresholds::default()),
            "0.4 clears the default floor of {DEFAULT_MIN_CONTRAST}"
        );

        let strict = ContrastThresholds {
            min_contrast: 0.6,
            ..ContrastThresholds::default()
        };
        assert!(
            !paint.is_mitigated(strict),
            "0.4 does not clear a floor of 0.6, so the cue has to be measured"
        );

        // And the sampling pass honours the same pair, so the cue reaches the
        // decode queue rather than being dropped before it.
        let sequence = sequence_with_captions(vec![caption_clip_with_style(
            "Boxed",
            1.0,
            3.0,
            Some(style),
        )]);
        assert!(
            sampling_candidates(&sequence, (0.0, 10.0), 1920, 1080, thresholds_default())
                .cues
                .is_empty(),
            "the default run skips it"
        );
        assert_eq!(
            sampling_candidates(&sequence, (0.0, 10.0), 1920, 1080, strict)
                .cues
                .len(),
            1,
            "the stricter run measures it"
        );
    }

    /// Feature: Coverage
    /// Scenario: should account for cues that are faded out of the frame
    #[test]
    fn should_count_a_faded_cue_as_unmeasured_rather_than_dropping_it() {
        let faded = caption_clip_with_style(
            "Invisible",
            1.0,
            3.0,
            Some(serde_json::json!({ "color": "#FFFFFF", "opacity": 0.0 })),
        );
        let sequence = sequence_with_captions(vec![
            faded,
            caption_clip("Visible", 4.0, 6.0, Some(bare_white_style())),
        ]);

        let candidates =
            sampling_candidates(&sequence, (0.0, 10.0), 1920, 1080, thresholds_default());

        assert_eq!(candidates.cues.len(), 1, "only the visible cue is decoded");
        assert_eq!(candidates.faded_out, 1, "the faded one is still counted");

        let coverage = CaptionSampleCoverage {
            cues: 2,
            sampled: 1,
            faded_out: 1,
            ..CaptionSampleCoverage::default()
        };
        assert_eq!(coverage.unmeasured(), 1);
        assert_eq!(coverage.reasons().as_deref(), Some("1 faded out"));

        let violation = CaptionContrastRule::new()
            .coverage_violation(coverage)
            .expect("a cue nobody measured is reported");
        assert_eq!(violation.metrics["cueCount"], 2);
        assert_eq!(violation.metrics["fadedOut"], 1);
    }

    /// Feature: Caption legibility
    /// Scenario: should never decode a cue a curated boxed pack already settles
    ///
    /// Both boxed packs put white text on a black box opaque enough that no
    /// picture can reach the contrast or the spread limit, so a project styled
    /// with them costs this check no decodes at all.
    #[test]
    fn should_skip_the_curated_boxed_packs_without_decoding() {
        for pack_id in ["boxed-contrast", "broadcast-lower"] {
            let style = crate::core::style::resolve_caption_pack(pack_id)
                .unwrap_or_else(|error| panic!("{pack_id} resolves: {error}"))
                .style();
            let style = serde_json::to_value(style).expect("a caption style serialises");
            let paint = paint_of(Some(&style));

            assert!(paint.paints_box(), "{pack_id} paints a box");
            assert!(
                paint.is_mitigated(ContrastThresholds::default()),
                "{pack_id} cannot fail whatever is behind it, so it must not be decoded"
            );
        }
    }

    /// Feature: Caption legibility
    /// Scenario: should say what a measured box did to the numbers
    #[tokio::test]
    async fn should_report_the_box_a_measured_cue_carries() {
        let sequence = sequence_with_captions(vec![caption_clip(
            "Barely boxed",
            1.0,
            3.0,
            Some(bare_white_style()),
        )]);
        let measurements = RenderMeasurements {
            caption_band_samples: vec![boxed_sample(1.0, 1.0, 0.1)],
            ..Default::default()
        };

        let violations = run_rule(&sequence, Some(measurements)).await;

        assert_eq!(violations.len(), 1, "{violations:?}");
        assert_eq!(violations[0].metrics["hasBox"], true);
        assert_eq!(violations[0].metrics["boxAlpha"], 0.1);
        assert!(
            violations[0].message.contains("10%-opaque box"),
            "the finding must not claim the cue has no box: {}",
            violations[0].message
        );
    }

    /// Feature: Style reading
    /// Scenario: should read the text colour a cue is drawn in
    #[test]
    fn should_read_text_luminance_from_the_style_colour() {
        let white = paint_of(Some(
            &serde_json::to_value(bare_white_style()).expect("style serialises"),
        ));
        assert!((white.text_luminance - 1.0).abs() < 1e-9);

        let black_text = CaptionStyle {
            color: Color::black(),
            ..bare_white_style()
        };
        let black = paint_of(Some(
            &serde_json::to_value(black_text).expect("style serialises"),
        ));
        assert!(black.text_luminance < 1e-9);

        // Hex strings reach the renderer too, and mean the same thing there.
        let hex = paint_of(Some(&serde_json::json!({ "color": "#000000FF" })));
        assert!(hex.text_luminance < 1e-9);

        // A blob naming no colour renders white, which is the renderer's
        // fallback and not the caption model's default.
        assert!((paint_of(None).text_luminance - 1.0).abs() < 1e-9);
    }

    /// Feature: Style reading
    /// Scenario: should agree with both export seams about every fixture
    ///
    /// The renderer's own gates are private, so this drives the real seams and
    /// asserts the check reaches the same verdict from the same blob. Two of
    /// them, because the burn-in has two: the `drawtext` fallback, where
    /// `borderw`/`box=1` appear exactly when a stroke or a box is drawn, and
    /// the ASS style row libass renders from wherever it is present, where a
    /// box is `BorderStyle: 3` with a visible `OutlineColour` and a stroke is
    /// `BorderStyle: 1` with one. Grading only the fallback is how a fully
    /// transparent box came to erase the outline on the path that actually
    /// renders while the check went on counting the outline as protection.
    /// A change on any side that breaks the mirror fails here.
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
            // Under half a step of alpha: both paths round it away and paint
            // nothing, so a check that only asked whether the alpha was
            // non-zero saw a box the renderer never draws.
            (
                "a box rounded away to nothing",
                Some(
                    serde_json::json!({ "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 0.4 } }),
                ),
            ),
            (
                "fully transparent box over an outline",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "outlineColor": "#000000",
                    "outlineWidth": 4,
                    "backgroundColor": "#00000000",
                })),
            ),
            (
                "opaque box over an outline",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "outlineColor": "#000000",
                    "outlineWidth": 4,
                    "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 200 },
                })),
            ),
            (
                "fully transparent outline",
                Some(serde_json::json!({ "outlineColor": "#00000000", "outlineWidth": 4 })),
            ),
            // Both renderers draw these; neither of them protects anything, so
            // the mirror has to keep saying "drawn" while the grading says
            // "measure it".
            (
                "an outline in the text's own colour",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "outlineColor": "#FFFFFF",
                    "outlineWidth": 4,
                })),
            ),
            (
                "a translucent outline",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "outlineColor": "#00000033",
                    "outlineWidth": 4,
                })),
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

        // Both renderers scale every decoration's alpha by the layer opacity,
        // which is the style's own opacity folded together with the clip's, so
        // these fixtures carry a clip opacity of their own.
        let faded_fixtures = [
            (
                "an opaque box under a style opacity of 0.3",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "opacity": 0.3,
                    "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 255 },
                })),
                1.0_f32,
            ),
            (
                "an opaque box on a clip faded to 0.4",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 255 },
                })),
                0.4_f32,
            ),
            (
                "an outline at a style opacity of 0.3 on a clip faded to 0.4",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "opacity": 0.3,
                    "outlineColor": "#000000",
                    "outlineWidth": 4,
                })),
                0.4_f32,
            ),
            // Equal opacities are one setting expressed twice, not a fade
            // applied twice; the renderer says so and so must the check.
            (
                "a box whose style and clip opacities match",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "opacity": 0.4,
                    "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 255 },
                })),
                0.4_f32,
            ),
            (
                "a boxed and outlined caption faded out entirely",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "opacity": 0.0,
                    "outlineColor": "#000000",
                    "outlineWidth": 4,
                    "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 255 },
                })),
                1.0_f32,
            ),
            (
                "an outlined caption on a clip faded out entirely",
                Some(serde_json::json!({
                    "color": "#FFFFFF",
                    "outlineColor": "#000000",
                    "outlineWidth": 4,
                })),
                0.0_f32,
            ),
        ];

        for (label, style, clip_opacity) in fixtures
            .into_iter()
            .map(|(label, style)| (label, style, 1.0_f32))
            .chain(faded_fixtures)
        {
            let mut clip = caption_clip_with_style("Words", 0.0, 2.0, style);
            clip.opacity = clip_opacity;
            let filter = build_caption_drawtext_with_enable(&clip)
                .unwrap_or_else(|| panic!("{label}: a caption with text renders"));
            let paint = caption_paint(clip.caption_style.as_ref(), clip.opacity);

            // `drawtext` draws the stroke and the box independently, so the
            // question there is what the style asks for.
            assert_eq!(
                paint.strokes_glyphs,
                drawtext_draws_an_outline(&filter),
                "{label}: the check and the drawtext path disagree about the outline ({filter})"
            );
            assert_eq!(
                paint.paints_box(),
                drawtext_draws_a_box(&filter),
                "{label}: the check and the drawtext path disagree about the box ({filter})"
            );
            assert_eq!(
                paint.draws_text(),
                drawtext_param(&filter, "fontcolor").is_some_and(ffmpeg_colour_is_visible),
                "{label}: the check and the drawtext path disagree about whether the glyphs \
                 reach the picture ({filter})"
            );

            // Not only *that* a box is painted but at what alpha: the grading
            // blends the box over the band, so a box measured at the wrong
            // opacity is a verdict reached about the wrong picture.
            if paint.paints_box() {
                let painted = drawtext_box_alpha(&filter)
                    .unwrap_or_else(|| panic!("{label}: a painted box has a boxcolor ({filter})"));
                assert!(
                    (paint.box_alpha - painted).abs() < 0.01,
                    "{label}: the check says the box paints at {:.4} and drawtext at {painted} \
                     ({filter})",
                    paint.box_alpha
                );
            }

            // libass draws one or the other, so the question there is what
            // survives - which is the question the grading actually asks.
            let style_row = ass_style_row_for(&clip);
            assert_eq!(
                paint.draws_outline(),
                ass_row_draws_an_outline(&style_row),
                "{label}: the check and the ASS path disagree about the outline ({style_row})"
            );
            assert_eq!(
                paint.paints_box(),
                ass_row_draws_a_box(&style_row),
                "{label}: the check and the ASS path disagree about the box ({style_row})"
            );

            // And at what alpha, on this path too: libass composites the box
            // over the picture exactly as the grading does, so a byte's worth
            // of drift here is a verdict about a band nobody rendered.
            if paint.paints_box() {
                let painted = ass_box_alpha(&style_row).unwrap_or_else(|| {
                    panic!("{label}: a painted box has a border colour ({style_row})")
                });
                assert!(
                    (paint.box_alpha - painted).abs() < 1.0 / 255.0,
                    "{label}: the check says the box paints at {:.4} and libass at {painted:.4} \
                     ({style_row})",
                    paint.box_alpha
                );
            }

            // And the glyphs' own opacity, which is not an incidental
            // number: the measured contrast is scaled by it and the
            // outline mitigation is gated on it, so a byte's drift here is
            // a verdict reached about words nobody rendered.
            let glyph_alpha = ass_alpha(ass_style_column(&style_row, ASS_PRIMARY_COLOUR_COLUMN))
                .unwrap_or_else(|| {
                    panic!("{label}: the style row carries a primary colour ({style_row})")
                });
            assert!(
                (paint.layer_opacity - glyph_alpha).abs() < 1.0 / 255.0,
                "{label}: the check says the glyphs paint at {:.4} and libass at \n                 {glyph_alpha:.4} ({style_row})",
                paint.layer_opacity
            );
        }
    }

    /// Builds the ASS `Style:` row the export writes for one caption clip.
    fn ass_style_row_for(clip: &Clip) -> String {
        let mut sequence = Sequence::new("Contrast", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        track.add_clip(clip.clone());
        sequence.add_track(track);

        build_ass_text_overlay_script(&sequence, &std::collections::HashMap::new())
            .expect("the script builds")
            .expect("a caption with text produces a script")
            .lines()
            .find(|line| line.starts_with("Style: "))
            .expect("the script carries a style row")
            .to_string()
    }

    /// Reads one column out of an ASS `Style:` row, by its `Format:` index.
    fn ass_style_column(row: &str, index: usize) -> &str {
        row.split(',')
            .nth(index)
            .unwrap_or_else(|| panic!("the style row has a column {index}: {row}"))
            .trim()
    }

    /// Whether an `&HAABBGGRR` colour paints anything; `0xFF` alpha is invisible.
    fn ass_colour_is_visible(raw: &str) -> bool {
        ass_alpha(raw).is_some_and(|alpha| alpha > 0.0)
    }

    /// Opacity an `&HAABBGGRR` colour paints at, 0–1.
    ///
    /// ASS states transparency rather than opacity, so `AA` is inverted: `00`
    /// is opaque and `FF` draws nothing.
    fn ass_alpha(raw: &str) -> Option<f64> {
        let hex = raw.trim().trim_start_matches("&H");
        let transparency = u8::from_str_radix(hex.get(0..2)?, 16).ok()?;
        Some(1.0 - f64::from(transparency) / 255.0)
    }

    /// Alpha libass paints the style row's background box at.
    ///
    /// `BorderStyle: 3` draws the box in `OutlineColour`, so that is the column
    /// the alpha comes out of - the same one the stroke uses when no box
    /// replaces it.
    fn ass_box_alpha(row: &str) -> Option<f64> {
        ass_alpha(ass_style_column(row, ASS_BORDER_COLOUR_COLUMN))
    }

    /// `PrimaryColour`, the column libass draws the glyphs themselves in.
    const ASS_PRIMARY_COLOUR_COLUMN: usize = 3;
    /// `OutlineColour`, the column libass draws both the stroke and the box in.
    const ASS_BORDER_COLOUR_COLUMN: usize = 5;
    /// `BorderStyle`: 1 strokes the glyphs, 3 replaces the stroke with a box.
    const ASS_BORDER_STYLE_COLUMN: usize = 15;
    /// `Outline`, the stroke width or the box padding depending on the style.
    const ASS_OUTLINE_WIDTH_COLUMN: usize = 16;

    /// Whether libass would stroke the glyphs from this style row.
    fn ass_row_draws_an_outline(row: &str) -> bool {
        let width = ass_style_column(row, ASS_OUTLINE_WIDTH_COLUMN)
            .parse::<f64>()
            .unwrap_or(0.0);
        ass_style_column(row, ASS_BORDER_STYLE_COLUMN) == "1"
            && width > 0.0
            && ass_colour_is_visible(ass_style_column(row, ASS_BORDER_COLOUR_COLUMN))
    }

    /// Whether libass would paint a background box from this style row.
    fn ass_row_draws_a_box(row: &str) -> bool {
        ass_style_column(row, ASS_BORDER_STYLE_COLUMN) == "3"
            && ass_colour_is_visible(ass_style_column(row, ASS_BORDER_COLOUR_COLUMN))
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

    /// Alpha the `drawtext` filter's box paints at, or `None` where it has none.
    ///
    /// `hex_to_ffmpeg_color` drops the `@alpha` suffix at full opacity, so a
    /// bare colour is an opaque box rather than a missing one.
    fn drawtext_box_alpha(filter: &str) -> Option<f64> {
        let colour = drawtext_param(filter, "boxcolor")?;
        match colour.split_once('@') {
            Some((_, alpha)) => alpha.parse::<f64>().ok(),
            None => Some(1.0),
        }
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

        let candidates =
            sampling_candidates(&sequence, (10.0, 20.0), 1920, 1080, thresholds_default());

        let labels: Vec<f64> = candidates.cues.iter().map(|cue| cue.midpoint_sec).collect();
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

        let cues =
            sampling_candidates(&sequence, (10.0, 20.0), 1920, 1080, thresholds_default()).cues;

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
    /// A runner around a real FFmpeg, or `None` after recording a skip.
    ///
    /// The band geometry is the one part of this module that cannot be asserted
    /// from the filter string alone: whether the crop lands on the picture the
    /// caption is drawn over is a question only pixels answer.
    fn ffmpeg_runner_for_tests() -> Option<FFmpegRunner> {
        let ffmpeg = crate::core::test_ffmpeg::require_or_skip_ffmpeg()?;
        let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });

        Some(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: ffmpeg,
            ffprobe_path: ffprobe,
            version: "test".to_string(),
            is_bundled: false,
            source: FFmpegSource::System,
        }))
    }

    /// Renders a short fixture clip from a `lavfi` description.
    async fn render_fixture(runner: &FFmpegRunner, file: &Path, source: &str) {
        let mut command = tokio::process::Command::new(&runner.info().ffmpeg_path);
        configure_tokio_command(&mut command);
        let output = command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                source,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(file)
            .output()
            .await
            .expect("the fixture render launches");
        assert!(
            output.status.success(),
            "the fixture render failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

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

        let (left, right) = super::super::rules::caption_span_percent(&clip, 1920, 1080);
        let filter = band_filter((top, bottom), (left, right), 320);
        assert!(filter.contains("scale=w='min(320,iw)'"));
        assert!(filter.contains("crop="));
        assert!(filter.ends_with("format=rgb24"));
    }

    /// Feature: Band geometry
    /// Scenario: should measure only the column the words are drawn in
    ///
    /// Cropping the full frame width let a bright strip at the far edge - a
    /// window, a lit sign - decide that a centred caption sat over a mixed
    /// background. The strip is outside the words entirely.
    ///
    /// It is a whole sixth of the frame, which is wide enough to fail this test
    /// if the column ever collapses back to the wrap box: the part of it inside
    /// a 10-90 crop is enough white to push the spread past the limit.
    #[tokio::test]
    #[ignore = "needs a real FFmpeg binary"]
    async fn should_ignore_a_bright_strip_the_caption_never_reaches() {
        let Some(runner) = ffmpeg_runner_for_tests() else {
            return;
        };
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("strip.mp4");

        // A dark 1920x1080 frame with a white strip down its rightmost sixth,
        // which no centred caption's text block reaches.
        render_fixture(
            &runner,
            &file,
            "color=c=#202020:s=1920x1080:d=2,drawbox=x=1600:y=0:w=320:h=1080:color=white:t=fill",
        )
        .await;

        let clip = caption_clip("Readable words", 0.0, 2.0, Some(bare_white_style()));
        let sequence = sequence_with_captions(vec![clip]);
        let sampling = sample_caption_bands(
            &runner,
            &file,
            &sequence,
            (0.0, 2.0),
            &CaptionSampleOptions {
                file_duration_sec: Some(2.0),
                ..CaptionSampleOptions::default()
            },
        )
        .await;

        let sample = sampling
            .samples
            .first()
            .unwrap_or_else(|| panic!("the cue must be measured: {:?}", sampling.notes));
        assert!(
            sample.band_luminance_stddev <= DEFAULT_MAX_BAND_STDDEV,
            "a strip outside the text block must not read as a mixed background, got spread {}",
            sample.band_luminance_stddev
        );
    }

    /// Feature: Band geometry
    /// Scenario: should follow a `verticalAlign` the renderer honours
    ///
    /// `resolve_caption_anchor` lets the style's `verticalAlign` move the block,
    /// so a band read from `caption_position` alone sampled the bottom of the
    /// frame for a caption drawn along the top - and graded it against the
    /// wrong half of the picture.
    #[tokio::test]
    #[ignore = "needs a real FFmpeg binary"]
    async fn should_measure_a_top_aligned_caption_against_the_top_of_the_frame() {
        let Some(runner) = ffmpeg_runner_for_tests() else {
            return;
        };
        let temp = tempfile::TempDir::new().expect("temp dir");

        let top_aligned = serde_json::json!({
            "color": "#FFFFFF",
            "verticalAlign": "top",
        });

        // Black top half, white bottom half: white text sampled against the
        // top reads clearly, and against the bottom disappears.
        let black_top = temp.path().join("black-top.mp4");
        render_fixture(
            &runner,
            &black_top,
            "color=c=black:s=1920x1080:d=2,drawbox=x=0:y=540:w=1920:h=540:color=white:t=fill",
        )
        .await;

        let sequence = sequence_with_captions(vec![caption_clip_with_style(
            "Readable words",
            0.0,
            2.0,
            Some(top_aligned.clone()),
        )]);
        let sampling = sample_caption_bands(
            &runner,
            &black_top,
            &sequence,
            (0.0, 2.0),
            &CaptionSampleOptions {
                file_duration_sec: Some(2.0),
                ..CaptionSampleOptions::default()
            },
        )
        .await;
        let sample = sampling
            .samples
            .first()
            .unwrap_or_else(|| panic!("the cue must be measured: {:?}", sampling.notes));
        assert!(
            sample.band_luminance < 0.2,
            "a top-aligned caption must be measured against the top band, got {}",
            sample.band_luminance
        );

        // The same style over the inverse frame is the failing case, which is
        // what proves the band moved rather than merely widened.
        let white_top = temp.path().join("white-top.mp4");
        render_fixture(
            &runner,
            &white_top,
            "color=c=white:s=1920x1080:d=2,drawbox=x=0:y=540:w=1920:h=540:color=black:t=fill",
        )
        .await;

        let sequence = sequence_with_captions(vec![caption_clip_with_style(
            "Readable words",
            0.0,
            2.0,
            Some(top_aligned),
        )]);
        let sampling = sample_caption_bands(
            &runner,
            &white_top,
            &sequence,
            (0.0, 2.0),
            &CaptionSampleOptions {
                file_duration_sec: Some(2.0),
                ..CaptionSampleOptions::default()
            },
        )
        .await;
        let sample = sampling
            .samples
            .first()
            .unwrap_or_else(|| panic!("the cue must be measured: {:?}", sampling.notes));
        assert!(
            sample.band_luminance > 0.8,
            "white text over a white top band is the failing case, got {}",
            sample.band_luminance
        );
        assert!(
            CaptionContrastRule::fault_for(sample, DEFAULT_MIN_CONTRAST, DEFAULT_MAX_BAND_STDDEV)
                .is_some(),
            "an unreadable top-aligned caption must be reported"
        );
    }

    /// Measures the band of the one caption a position and style describe.
    async fn measure_one_band(
        runner: &FFmpegRunner,
        file: &Path,
        position: serde_json::Value,
        style: serde_json::Value,
    ) -> CaptionBandSample {
        let mut clip = caption_clip_with_style("Readable words", 0.0, 2.0, Some(style));
        clip.caption_position = Some(position);
        let sequence = sequence_with_captions(vec![clip]);

        let sampling = sample_caption_bands(
            runner,
            file,
            &sequence,
            (0.0, 2.0),
            &CaptionSampleOptions {
                file_duration_sec: Some(2.0),
                ..CaptionSampleOptions::default()
            },
        )
        .await;

        sampling
            .samples
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the cue must be measured: {:?}", sampling.notes))
    }

    /// Feature: Band geometry
    /// Scenario: should measure the position shapes the CLI writes where the
    /// renderer draws them
    ///
    /// The band was mirrored through `serde`, which refuses all three of these
    /// and the burn-in accepts all three. Over a frame that is black on top and
    /// white underneath, the difference is the whole verdict: measured where
    /// the renderer draws, white text on the top band reads; measured against
    /// the default bottom band, the same cue is graded over white.
    #[tokio::test]
    #[ignore = "needs a real FFmpeg binary"]
    async fn should_measure_lenient_position_shapes_where_the_renderer_draws_them() {
        let Some(runner) = ffmpeg_runner_for_tests() else {
            return;
        };
        let temp = tempfile::TempDir::new().expect("temp dir");
        let white = serde_json::json!({ "color": "#FFFFFF" });

        let black_top = temp.path().join("black-top.mp4");
        render_fixture(
            &runner,
            &black_top,
            "color=c=black:s=1920x1080:d=2,drawbox=x=0:y=540:w=1920:h=540:color=white:t=fill",
        )
        .await;

        for (label, position) in [
            ("a bare string", serde_json::json!("top")),
            (
                "a preset with no margin",
                serde_json::json!({ "type": "preset", "vertical": "top" }),
            ),
            (
                "a preset in the wrong case",
                serde_json::json!({ "type": "Preset", "vertical": "top", "marginPercent": 5.0 }),
            ),
        ] {
            let sample = measure_one_band(&runner, &black_top, position, white.clone()).await;
            assert!(
                sample.band_luminance < 0.2,
                "{label} draws along the top, so the dark top band is what must be \
                 measured, got {}",
                sample.band_luminance
            );
            assert!(
                CaptionContrastRule::fault_for(
                    &sample,
                    DEFAULT_MIN_CONTRAST,
                    DEFAULT_MAX_BAND_STDDEV
                )
                .is_none(),
                "{label}: white words on the black band read fine"
            );
        }

        // The same shapes over the inverse frame are the failing case, which is
        // what proves the band moved rather than merely widened.
        let white_top = temp.path().join("white-top.mp4");
        render_fixture(
            &runner,
            &white_top,
            "color=c=white:s=1920x1080:d=2,drawbox=x=0:y=540:w=1920:h=540:color=black:t=fill",
        )
        .await;

        let sample = measure_one_band(
            &runner,
            &white_top,
            serde_json::json!({ "type": "preset", "vertical": "top" }),
            white.clone(),
        )
        .await;
        assert!(
            sample.band_luminance > 0.8,
            "white text over a white top band is the failing case, got {}",
            sample.band_luminance
        );

        // A bare string names a preset outright, and the renderer returns
        // before it reads `verticalAlign`, so this cue is drawn - and has to be
        // measured - along the bottom whatever the style says.
        let sample = measure_one_band(
            &runner,
            &white_top,
            serde_json::json!("bottom"),
            serde_json::json!({ "color": "#FFFFFF", "verticalAlign": "top" }),
        )
        .await;
        assert!(
            sample.band_luminance < 0.2,
            "a bare string outranks verticalAlign in the renderer, so the dark bottom band \
             is what must be measured, got {}",
            sample.band_luminance
        );
    }

    /// Feature: Band geometry
    /// Scenario: should follow every position shape the renderer accepts
    ///
    /// The band used to be read back through `serde`, which refuses a bare
    /// string, a preset with no `marginPercent` - the shape `caption add
    /// --position-json` writes - and a `"Preset"` in the wrong case. All three
    /// fell back to the default bottom band while the renderer drew the words
    /// along the top, so the check measured the wrong half of the picture for
    /// exactly the captions an agent creates from the command line.
    #[test]
    fn should_follow_the_lenient_position_shapes_the_renderer_reads() {
        let band_for = |position: serde_json::Value, style: serde_json::Value| {
            let mut clip = caption_clip_with_style("Words", 0.0, 2.0, Some(style));
            clip.caption_position = Some(position);
            super::super::rules::caption_band_percent(&clip, 1920, 1080)
        };
        let white = serde_json::json!({ "color": "#FFFFFF" });

        for (label, position) in [
            ("a bare string", serde_json::json!("top")),
            (
                "a preset with no margin",
                serde_json::json!({ "type": "preset", "vertical": "top" }),
            ),
            (
                "a preset in the wrong case",
                serde_json::json!({ "type": "Preset", "vertical": "top", "marginPercent": 5.0 }),
            ),
        ] {
            let (top, bottom) = band_for(position, white.clone());
            assert!(
                top < 10.0 && bottom < 25.0,
                "{label} anchors the caption to the top of the frame, got {top}-{bottom}"
            );
        }

        // A bare string names a preset outright, and the renderer returns
        // before it reads `verticalAlign`, so the string wins.
        let (top, bottom) = band_for(
            serde_json::json!("bottom"),
            serde_json::json!({ "color": "#FFFFFF", "verticalAlign": "top" }),
        );
        assert!(
            top > 75.0 && bottom <= 100.0,
            "a bare string outranks verticalAlign in the renderer, got {top}-{bottom}"
        );
    }

    /// Feature: Band geometry
    /// Scenario: should crop around the point a custom caption is pinned to
    ///
    /// `xPercent: 0.5` is the middle of the frame to the renderer, which reads
    /// an axis under 1 as a fraction. Read as a raw percentage it was the left
    /// edge, and the crop went looking for the words in a corner.
    #[test]
    fn should_crop_around_the_centre_for_a_fractional_custom_anchor() {
        let mut clip = caption_clip_with_style(
            "Words",
            0.0,
            2.0,
            Some(serde_json::json!({ "color": "#FFFFFF" })),
        );
        clip.caption_position =
            Some(serde_json::json!({ "type": "custom", "xPercent": 0.5, "yPercent": 0.5 }));

        let (left, right) = super::super::rules::caption_span_percent(&clip, 1920, 1080);
        let centre = (left + right) / 2.0;

        assert!(
            (centre - 50.0).abs() < 1.0,
            "a fractional x is the middle of the frame, got {left}-{right}"
        );
    }

    /// Feature: Band geometry
    /// Scenario: should crop a preset caption to the column it can occupy
    ///
    /// The wrap box is the ceiling, not the floor. Flooring at it gave every
    /// preset cue the same 10–90 column whatever it said, which is the crop
    /// this pass exists to avoid: a short cue was graded across four fifths of
    /// the frame, bright corners and all. A long one still gets the whole box.
    #[test]
    fn should_crop_a_preset_caption_to_the_column_it_can_reach() {
        let wrap_box = crate::core::captions::CAPTION_WRAP_BOX_WIDTH_PERCENT;

        let short = caption_clip("Hi", 0.0, 2.0, Some(bare_white_style()));
        let (left, right) = super::super::rules::caption_span_percent(&short, 1920, 1080);
        assert!(
            right - left < wrap_box,
            "a two-character cue must not be measured across the whole wrap box, got \
             {left}-{right}"
        );
        assert!(
            ((left + right) / 2.0 - 50.0).abs() < 1e-9,
            "a centred preset caption's column stays centred, got {left}-{right}"
        );
        assert!(
            right - left >= super::super::rules::MIN_CAPTION_SPAN_WIDTH_PERCENT - 1e-9,
            "the column is never narrower than the floor, got {left}-{right}"
        );

        // A caption long enough to fill the box is still measured across it and
        // no wider, because that is as far as the renderer can draw it.
        let long = caption_clip(
            "A caption long enough to run the full width of the wrap box it is drawn inside",
            0.0,
            2.0,
            Some(bare_white_style()),
        );
        let (left, right) = super::super::rules::caption_span_percent(&long, 1920, 1080);
        assert!(
            (right - left - wrap_box).abs() < 1e-9,
            "a full-width preset caption is measured across its wrap box, got {left}-{right}"
        );
    }

    /// Feature: Band geometry
    /// Scenario: should cover a line the estimator has no shaping for
    ///
    /// The crop is only an answer about the words if the words are inside it.
    /// A half-em advance is the Latin figure: Hangul is drawn on a full-em
    /// square and tracking adds its pixels to every glyph, so both lines came
    /// out at half the width the renderer draws and the pass graded a column
    /// the ends of the line ran clean out of.
    #[test]
    fn should_crop_wide_enough_for_text_the_estimator_underestimates() {
        const FONT_SIZE: f64 = 48.0;
        const CANVAS_WIDTH: f64 = 1920.0;

        /// Percentage of the canvas a line covers at a given advance per glyph.
        fn line_width_percent(label: &str, spacing_px: f64) -> f64 {
            let drawn: f64 = label
                .chars()
                .map(|character| {
                    let advance = if character.is_ascii() {
                        FONT_SIZE / 2.0
                    } else {
                        FONT_SIZE
                    };
                    advance + spacing_px
                })
                .sum();
            drawn / CANVAS_WIDTH * 100.0
        }

        /// Asserts the measured column contains the centred line it is for.
        fn assert_column_covers(clip: &Clip, line_percent: f64, what: &str) {
            let (left, right) = super::super::rules::caption_span_percent(clip, 1920, 1080);
            assert!(
                left <= 50.0 - line_percent / 2.0 + 1e-9
                    && right >= 50.0 + line_percent / 2.0 - 1e-9,
                "{what}: the {line_percent:.1}% line runs outside the {left:.1}-{right:.1} column"
            );
        }

        // Twenty-five characters of Korean: the spaces are half an em and the
        // syllables a whole one, so the line is well past half the frame.
        let korean_label = "자막 대비 검사를 위한 한국어 자막 문장입니다";
        assert_eq!(korean_label.chars().count(), 25);
        let korean = caption_clip_with_style(
            korean_label,
            0.0,
            2.0,
            Some(serde_json::json!({ "color": "#FFFFFF", "fontSize": FONT_SIZE })),
        );
        assert_column_covers(
            &korean,
            line_width_percent(korean_label, 0.0),
            "a Hangul caption",
        );

        // And Latin tracked out by 30px a glyph, which more than doubles it.
        let tracked_label = "Tracked out caption";
        let tracked = caption_clip_with_style(
            tracked_label,
            0.0,
            2.0,
            Some(serde_json::json!({
                "color": "#FFFFFF",
                "fontSize": FONT_SIZE,
                "letterSpacing": 30,
            })),
        );
        assert_column_covers(
            &tracked,
            line_width_percent(tracked_label, 30.0),
            "a letter-spaced caption",
        );
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
