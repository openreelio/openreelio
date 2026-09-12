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
//! # One rectangle per frame, and one cue per rectangle
//!
//! `bbox` reports the bounding box of every inked pixel on the frame, so a
//! frame showing two text events at once returns their union - a rectangle that
//! belongs to neither. The first cut of this module answered that by refusing:
//! a cue whose probe instants were all to itself was *solo* and measured, and a
//! cue sharing an instant with anything else was handed back to the caller's
//! predictor. That is fine for one caption track and useless for the ordinary
//! shape of a finished video - a lower third or a channel bug on screen the
//! whole time - where *every* caption shares a frame with the title and nothing
//! at all gets measured.
//!
//! So the cues are **isolated** instead. They are partitioned into layers by
//! greedy colouring of the conflict graph (see [`plan_layers`]), and each layer
//! is rendered from a script in which only that layer's events draw ink -
//! [`ASS_HIDE_INK_TAGS`](super::export::ASS_HIDE_INK_TAGS) on every other event.
//! Within a layer nothing overlaps, so the one rectangle `bbox` reports for a
//! probe frame is the one live cue's rectangle. A single caption track is one
//! layer and still costs one FFmpeg run; a title over captions is two.
//!
//! ## Hidden, not dropped - and the collisions that turns on
//!
//! The hidden events stay in the script, at their own timings, in their own
//! styles, with their own text. That is not tidiness: libass shifts overlapping
//! events apart so they do not draw on top of each other, and it computes that
//! from the *bitmaps it rendered*. A fully transparent event still renders its
//! bitmaps, so hiding preserves the shift; an event deleted from the script
//! cannot be avoided, so dropping would not.
//!
//! Measured against the bundled binary at 1920x1080, two `\an2` captions live
//! at the same instant:
//!
//! | script | inked box |
//! |--------|-----------|
//! | both drawn | `726..1194 x 903..1021` (their union) |
//! | second alone in the script | `726..1194 x 967..1021` |
//! | second drawn, first **hidden** | `726..1194 x 903..957` |
//!
//! The third row is the second caption's real position - the top half of the
//! union the first row reports. Dropping the neighbour's `Dialogue` line would
//! have measured the second row and reported that caption 5.9% of the canvas
//! below where it burns in. So the vertical a layer measures is the vertical
//! that renders, collisions and all, and there is no band of cues this pass has
//! to hand back for being stacked.
//!
//! # On libass's own clock, not the timeline's
//!
//! That partition is only sound if "live at this instant" means what libass
//! thinks it means. ASS carries times to a hundredth of a second and
//! [`ass_centisecond`](super::export::ass_centisecond) rounds them there, so the
//! span a cue is *drawn* over is not the span the timeline stores. Measured
//! against this binary: a cue whose exact bounds are `[2.004, 2.03)` is written
//! `0:00:02.00,0:00:02.03` and draws on frame 60 of a 30fps render - `t=2.000`,
//! which its exact start is four milliseconds *past*. Classifying on the exact
//! times called that cue absent from the frame, so a neighbour probed there was
//! declared solo and handed the union of both. Every timing question below is
//! therefore asked of the rounded span, which is the one the script writes.
//!
//! # Colour emoji are outside the alpha
//!
//! The burn-in replaces every emoji cluster it has a picture for with an
//! ink-free advance-only spacer and composites the colour PNG *over* the
//! rendered subtitle layer. The probe builds the same script - it has to, or the
//! advances and the line breaks are a different caption - which means the alpha
//! it measures carries the hole and not the picture. So a cue containing a
//! colour-emoji cell is reported as uncovered rather than measured short.
//!
//! # Three samples per cue
//!
//! At 25%, 50% and 75% of the cue, unioned. Not the first frame: a `{\fad}` cue
//! draws literally nothing on it, and a first-frame probe would report every
//! faded caption in the project as drawing no ink at all.
//!
//! # Two boxes per cue, because two questions are being asked
//!
//! "Does anything the viewer can see get cropped?" and "are the *words*
//! legible?" are different questions with different answers, and a safe-area
//! standard grades them against different margins. So every solo cue is measured
//! twice:
//!
//! - **Full ink** - the caption exactly as it burns in, outline, shadow, blur
//!   and background box included. This is the rectangle that must not leave the
//!   frame and must clear the action-safe margin.
//! - **Glyph only** - the same script with every border, shadow and blur zeroed,
//!   so the box is the letterforms themselves. This is what the tighter
//!   title-safe margin is about: a reader's eye needs the glyphs inside it, not
//!   the decoration around them.
//!
//! The second box costs a second FFmpeg run because the decoration is switched
//! off script-wide, not per event - but it is one run for every glyph-only frame
//! in the chunk, on exactly the same 25/50/75 grid and the same layers, so it
//! never doubles the number of *spawns per cue*.
//!
//! The decoration is taken off the layer's *visible* events only. A hidden event
//! keeps its outline, shadow and background box, because those are what libass
//! measured when it decided how far to shift the visible cue away from it: a
//! hidden neighbour rendered two pixels shorter is a visible cue two pixels
//! lower than the one that burns in.
//!
//! How the decoration is switched off is measured rather than assumed, and the
//! answer is **alpha, never geometry**. The visible cue's own outline and
//! background box belong to the same bitmap its glyphs do, so shrinking them -
//! `\bord0\shad0`, or a `force_style='BorderStyle=1,Outline=0'` - moves the cue
//! libass then packs into the collision stack. [`GLYPH_ONLY_OVERRIDE_TAGS`]
//! instead paints the outline and shadow colours fully transparent and leaves
//! every glyph, border and box exactly the size libass drew it, so the pass
//! measures the letterforms *where they burn in*. The measurements are in that
//! constant's own documentation.
//!
//! `force_style` is not used at all. It cannot reach an event that overrides the
//! field inline (an inline tag wins), it reaches the *hidden* neighbours as well
//! - shrinking the very obstacles the visible cue was positioned against - and
//! everything it was there for, the `BorderStyle` column included, the alpha
//! tags cover inline.
//!
//! No tag used here moves a glyph: libass breaks lines on advances, and an alpha
//! has none. The glyph-only render is therefore the same layout with less of it
//! painted, which is what makes the two boxes comparable at all.

use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant},
};

use super::export::{
    ass_centisecond, build_ass_text_overlay_script_in_window_with_emoji,
    build_ass_text_overlay_script_isolated, EmojiSpacerContext, ExportEngine, ExportError,
};
use crate::core::{effects::Effect, text::emoji_assets::EmojiRasterSource, timeline::Sequence};

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

/// Alpha level a pixel has to exceed to count as inked.
///
/// Zero, and the comparison is the reason it can be: `bbox` keeps a pixel when
/// its value is **strictly greater** than `min_val`, so `min_val=0` means "every
/// pixel carrying any alpha at all" and still excludes the transparent canvas,
/// which is alpha `0`. Anything higher silently discards the faintest
/// anti-aliased fringe - at `min_val=1` the alpha-1 rim of the outline is not in
/// the box - and the extent QC reasons about is the outer edge of what was
/// drawn.
///
/// This constant was `1` on the strength of a claim that `0` returns a
/// full-frame box. It does not, and the measurement says so: over
/// `color=c=black@0.0,format=rgba` this binary reports `703..1217 x 968..1011`
/// for the same caption at `min_val` `0`, `1` and `32`, and reports *no box at
/// all* for a whitespace-only cue at `min_val=0`. The full-frame box that
/// claim came from was the separate `format=rgba`-in-`-vf` bug below, which
/// filled alpha with 255 before the filter ever saw it.
const BBOX_MIN_ALPHA: u32 = 0;

/// Override tags that hide a caption's decoration without moving one pixel of
/// it.
///
/// Appended to the *end* of every override block of every event in the
/// glyph-only script, because within one block the last spelling of a tag wins:
/// the burn-in's own `\3a&H80&` or `\4a&H80&` sits earlier in that same block,
/// and anything written before it would simply be overwritten.
///
/// `\3a` is the outline colour's alpha and `\4a` the shadow-and-back colour's;
/// `&HFF&` is fully transparent. The glyph fill (`\1a`) is left alone, so what
/// the pass measures is the letterforms and nothing drawn around them. One tag
/// covers a `BorderStyle: 3` background box too: libass paints that box in the
/// outline colour and its drop shadow in the back colour, so hiding both colours
/// hides the box.
///
/// **Alpha, not geometry, and that is the whole point.** The obvious spelling -
/// `\bord0\shad0\blur0\be0` - takes the decoration away by *shrinking the
/// bitmap*, and libass packs colliding events by the bitmaps it rendered. A cue
/// in a collision stack therefore slides down by however much its own outline
/// was worth, and the glyph pass measures it below where it burns in. Measured
/// on this binary at 1920x1080, the second of a colliding pair with the first
/// hidden:
///
/// | style                 | full ink   | `\bord0...` | alpha    |
/// |-----------------------|------------|-------------|----------|
/// | `BorderStyle: 3` box  | `869..950` | `899..949`  | `889..939` |
/// | `BorderStyle: 1` `\bord6` | `891..953` | `903..953` | `897..947` |
///
/// Ten pixels and six pixels low respectively, on exactly the population this
/// pass exists to measure - and in the boxed case one pixel from escaping the
/// full-ink box it is supposed to refine. Alpha changes no bitmap's extent, so
/// the collision packing, and therefore the measured position, is the burn-in's.
///
/// `\blur`/`\be` are deliberately **not** here, and that is a decision rather
/// than an oversight. They blur the glyph *fill* whenever there is no
/// glyph-hugging border bitmap for the blur to land on instead - `\bord0`, and
/// `BorderStyle: 3`, whose decoration is a box rather than a stroke - so the
/// glyph box this pass reports then includes the fill's own soft edge. Measured:
/// a boxed caption's glyphs ink `970..1009` unblurred and `965..1013` at
/// `\blur2`; a `\bord0\blur6` caption inks `954..1032` and measures the same.
/// With a border present libass blurs the border bitmap and leaves the fill
/// crisp, so the glyph box is the sharp letterforms either way.
///
/// Zeroing them would shrink the bitmap and bring the geometry shift straight
/// back, which is the whole defect above. The soft edge of a blurred letterform
/// is part of that letterform, it is what a viewer actually has to read, and
/// measuring it errs toward a *larger* box - the safe direction for a safe-area
/// verdict.
const GLYPH_ONLY_OVERRIDE_TAGS: &str = r"\3a&HFF&\4a&HFF&";

/// Commas preceding the `Text` field of a `Dialogue` line.
///
/// `Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect` - nine
/// fields, and therefore nine commas, before the text begins. Counted rather
/// than split on so a text field containing commas (which is ordinary) stays in
/// one piece, and so the override blocks of *only* the text are touched: a
/// `Name` or `Effect` column is not a place a brace means anything.
const ASS_DIALOGUE_COMMAS_BEFORE_TEXT: usize = 9;

/// How many distinct libass font-substitution lines reach the coverage record.
///
/// A project in a script no bundled face covers logs one pair of lines per
/// missing codepoint, which on a feature-length transcript is thousands of
/// lines saying the same two things. The first few name the families and the
/// codepoints, which is the whole diagnostic value; the rest are noise in a
/// report a human reads.
const MAX_FONT_SUBSTITUTION_NOTES: usize = 6;

/// Ceiling on `select` terms in one probe, so a long project cannot build a
/// filtergraph argument the platform refuses to pass to a child process.
///
/// Each term is about fifteen characters, so this caps the expression near four
/// kilobytes - comfortably inside every `argv` limit this ships against, while
/// still measuring eighty cues in a single FFmpeg run.
const MAX_PROBE_FRAMES_PER_RUN: usize = 240;

/// Ceiling on how many overlap-free layers one measurement pass will render.
///
/// Every layer is at least one FFmpeg spawn, and two when the glyph box is
/// wanted, so the number of layers multiplies the number of processes this pass
/// can start. The colouring in [`plan_layers`] needs one layer per event that is
/// simultaneously on screen, which is one for an ordinary caption track, two
/// for the title-over-captions project this exists for, and - for a motion
/// graphic built from thirty text clips that all animate together - thirty.
/// That project must not spawn sixty FFmpeg runs inside a QC pass.
///
/// Eight is well past anything a human edit produces (a lower third, a bug, a
/// caption and a chapter card at once is four) and small enough to keep the
/// spawn count bounded rather than proportional to the timeline's text clips.
///
/// Bounded, not fixed: each layer is itself chunked by
/// [`chunk_by_frame_budget`], so the real ceiling is
/// `MAX_MEASURED_LAYERS × ceil(probed frames / MAX_PROBE_FRAMES_PER_RUN) ×
/// (1 + glyph pass)`. A feature-length project's chunk count is what dominates
/// that product; what this cap removes is the *other* factor growing with it.
/// The whole pass is still held inside `probe_budget` regardless, which is what
/// actually stops a QC run from running long. Cues in a layer past the cap are
/// named in
/// [`CaptionExtentCoverage::shared_frame_cue_ids`] and graded by the caller's
/// predictor, exactly as every uncovered cue is.
const MAX_MEASURED_LAYERS: usize = 8;

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
    /// Everything the cue drew: glyphs, outline, shadow, blur, background box.
    ///
    /// The rectangle a frame boundary and an action-safe margin are about,
    /// because all of it is ink a viewer sees and a crop would take away.
    ///
    /// `None` with `no_ink` set is a cue that rendered nothing at all. `None`
    /// without it is a cue the probe could not run for; the coverage record
    /// says which.
    pub full_ink: Option<BoxPercent>,
    /// The letterforms alone, measured with the decoration switched off.
    ///
    /// The rectangle a *legibility* bound is about: the title-safe margin asks
    /// where a reader's eye has to find the words, and an outline drawn around
    /// them is not one of the words.
    ///
    /// Always contained in [`Self::full_ink`] when both were measured, and
    /// independently optional: the two come from two FFmpeg runs, and a run that
    /// failed leaves its own box `None` without taking the other one with it.
    pub glyph: Option<BoxPercent>,
    /// Whether the ink ran off the frame by an amount nothing can recover.
    ///
    /// libass clips at the frame, so an overflowing caption measures as a box
    /// flush against the edge and the overshoot is simply not in the picture.
    /// This flag says "overflow of unknown magnitude"; there is deliberately no
    /// estimate of how far, because re-rendering on a larger canvas would change
    /// the wrapping and measure a different caption.
    ///
    /// It is **not** set by a box that merely reaches an edge. A caption with
    /// `marginPercent: 0` measures `y2 == height - 1`, and a `\blur` or a
    /// `\shad` reaches an edge the glyphs do not; all of those are ordinary
    /// output that the caller's own edge comparison passes. See
    /// [`FlushEdges::overflows_frame`] for the signature that separates them.
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
    /// Cues sharing their frames with more events than the pass would isolate.
    ///
    /// Sharing a frame is no longer a refusal on its own: the cues are split
    /// into overlap-free layers and each layer is rendered with every other
    /// event hidden, so a caption under a persistent title is measured like any
    /// other. What is left here is the overflow past [`MAX_MEASURED_LAYERS`] -
    /// a project with more text events simultaneously on screen than this pass
    /// will spawn processes for. The caller falls back to its predictor for
    /// them.
    pub shared_frame_cue_ids: Vec<String>,
    /// Cues shorter than a frame interval, which no frame of this render shows.
    pub sub_frame_cue_ids: Vec<String>,
    /// Cues carrying at least one colour-emoji cell.
    ///
    /// The burn-in draws the emoji's picture *outside* the subtitle layer and
    /// leaves an ink-free spacer in the text, so the alpha box for such a cue is
    /// the caption minus its emoji - narrower than what the viewer sees, and
    /// narrower in the direction that turns a real overflow into a pass. Left to
    /// the caller's predictor until the overlay cells can be unioned in.
    pub emoji_cue_ids: Vec<String>,
    /// Whether at least one probe run could not be completed.
    pub probe_failed: bool,
    /// Cues measured for their full ink but not for their glyphs alone.
    ///
    /// The glyph-only box comes from a second FFmpeg run, and a run that failed
    /// leaves these cues with a full-ink rectangle and no legibility box. The
    /// caller grades what it has - a frame or action-safe verdict is still a
    /// measurement - and must not read a missing glyph box as "the glyphs are
    /// fine".
    pub glyph_unmeasured_cue_ids: Vec<String>,
    /// Font substitutions libass reported while laying these cues out.
    ///
    /// Only collected when [`Self::uses_host_fonts`] is set, which is the only
    /// case where they can differ between machines - and the case where a CI
    /// report and a laptop report disagreeing about a caption's width needs an
    /// explanation more specific than "host fonts were involved". Each line
    /// names the family that was asked for, the family that answered, and, for a
    /// fallback, the codepoint that forced it.
    pub font_substitutions: Vec<String>,
    /// Whether the layout depended on fonts installed on this machine.
    ///
    /// True when at least one run fell through to the host font provider rather
    /// than a face the script embeds. The boxes are then only as reproducible as
    /// the machine's font set: the same project measured on CI and on a
    /// developer's laptop can legitimately disagree, and a reader comparing two
    /// reports needs to know that before calling it a regression.
    pub uses_host_fonts: bool,
    /// Human-readable detail, for the report the caller prints.
    pub notes: Vec<String>,
}

/// Every cue's extent, plus what the pass could not reach.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CaptionExtentMeasurement {
    /// One entry per measured cue, in the order the script wrote its events.
    ///
    /// Event order, which is track order and then clip order within a track -
    /// *not* timeline order, which two caption tracks would interleave. Nothing
    /// reads these positionally (the caller looks a cue up by `clip_id`), so the
    /// order is a description rather than a contract.
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
    ///
    // TODO(caption-extent-window-end): a declared range bounds the start of the
    // measured set and not its end, so a cue after the window is still probed
    // and reported. Harmless to the boxes - each is measured on its own frames -
    // and wrong for a caller grading only the range under review. Closing it
    // means carrying the end through the script builder too, so an event past
    // the window stops being written at all rather than being filtered out of
    // the cue list after the fact.
    pub window_start_sec: f64,
    /// Whether the second, glyph-only render is wanted at all.
    ///
    /// It doubles the FFmpeg runs this pass makes and produces exactly one
    /// thing: [`CaptionExtent::glyph`], which only the safe-area rule's
    /// title-safe tier reads. A caller that does not grade that tier says so
    /// here and pays for one pass instead of two.
    pub needs_glyph_box: bool,
    /// How long every probe run may take between them.
    ///
    /// Spent in order and never split: the full-ink pass over every layer has
    /// first call on it, because its boxes are what every consumer of this pass
    /// needs, and the glyph pass runs only over the layers it completed and only
    /// if enough is left to be worth starting.
    ///
    /// Enforced per *layer*, which is what makes running out survivable. A
    /// deadline around the whole call would cancel the future holding every
    /// rectangle measured so far; a per-layer slice leaves the layers that
    /// finished standing and sends only the ones that were never reached back to
    /// the caller's predictor.
    pub probe_budget: Duration,
}

/// One cue, as both the script builder and the probe see it.
#[derive(Clone, Debug, PartialEq)]
struct CaptionCue {
    /// The clip that carries it.
    clip_id: String,
    /// Cue bounds on the timeline.
    timeline_in_sec: f64,
    timeline_end_sec: f64,
    /// Cue start as the `Dialogue` line writes it: on the render's clock,
    /// floored at zero exactly as `ass_timecode` floors it, and rounded to the
    /// centisecond grid that is the only precision ASS has.
    drawn_start_sec: f64,
    /// Cue end on the same clock and the same grid.
    drawn_end_sec: f64,
}

impl CaptionCue {
    /// Whether this cue is drawn at `instant`, on the render's clock.
    ///
    /// Half-open, and measured to be so: a cue written `0:00:02.00,0:00:03.00`
    /// draws on the 30fps frames at `t=2.000` and `t=2.9667` and not on the one
    /// at `t=3.000`. Two cues that merely touch are therefore never both live,
    /// which is what keeps a back-to-back caption track measurable.
    ///
    /// Asked of the *rounded* span, because that is the span libass is handed.
    /// A cue starting at an exact `2.004` is written `0:00:02.00` and really is
    /// on the frame at `t=2.000`; answering `false` there declares a neighbour
    /// solo that is about to be measured together with this one.
    fn is_live_at(&self, instant: f64) -> bool {
        self.drawn_start_sec <= instant && instant < self.drawn_end_sec
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
    /// there is nothing to measure. A cue whose whole span rounds onto a single
    /// centisecond lands here too, and correctly: the `Dialogue` line it
    /// produces has `Start == End` and draws on nothing.
    ///
    /// The span is the rounded one for the same reason [`Self::is_live_at`]
    /// uses it - a frame is probed because libass draws the cue on it, and what
    /// libass draws is decided by the timecodes in the script.
    fn probe_frames(&self, fps: f64) -> Vec<u64> {
        if !fps.is_finite() || fps <= 0.0 {
            return Vec::new();
        }

        let start = self.drawn_start_sec;
        let end = self.drawn_end_sec;
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

/// Which of the four frame edges a measured box is flush against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FlushEdges {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

impl FlushEdges {
    /// Whether the ink ran off the frame by an amount the picture cannot show.
    ///
    /// libass clips its own rendering at the frame, so a caption wider than the
    /// picture measures as one the width of the picture - to within the few
    /// pixels of [`FLUSH_EDGE_TOLERANCE_PX`] - and the overshoot is simply not
    /// in the image. That is worth reporting, and it is
    /// the only thing here that is: "flush against an edge" on its own is
    /// ordinary output, and treating it as an overflow makes this measurement
    /// stricter than the estimate it replaced, on cues nobody cropped.
    ///
    /// Measured against this binary, over a 1920x1080 canvas:
    ///
    /// - a bottom caption with `marginPercent: 0` - a value the preset schema
    ///   allows - inks `718..1201 x 1027..1079`: flush on the bottom, and not a
    ///   pixel of it lost,
    /// - the same caption with `\blur8\bord6` inks `778..1142 x 1003..1079`:
    ///   flush on the bottom because the blur reaches there, still nothing cut,
    /// - a 200-character unspaced run inks `0..1919 x 968..1010`: flush on the
    ///   left *and* the right at once.
    ///
    /// The third is the signature, and it is the one a legitimate caption cannot
    /// produce: filling an axis edge to edge means the line was longer than the
    /// axis. A single flush edge is left to the caller's ordinary edge
    /// comparison, which passes a box at `0..100` exactly as it does for an
    /// estimate.
    ///
    /// The cost is stated rather than hidden: a caption pushed *partly* off one
    /// side measures flush on that side alone and is now graded as reaching the
    /// edge rather than leaving the frame. Separating that from a margin-0
    /// caption needs a second measurement - the ink density in the boundary
    /// column, or a probe on an over-sized canvas - and a probe on a larger
    /// canvas re-wraps the text and measures a different caption.
    // TODO(caption-extent-one-sided-crop): measure the boundary column's ink run
    // so a caption cropped on one side can be told from one merely flush
    // against that side.
    fn overflows_frame(self) -> bool {
        (self.left && self.right) || (self.top && self.bottom)
    }
}

/// How far short of a frame edge the ink may stop and still saturate it.
///
/// A caption libass cut off at the frame does *not* reliably ink the boundary
/// column. The line is laid out in the script's `PlayRes` space and rasterised
/// into the output frame, and where the boundary falls inside the run is a
/// matter of arithmetic: land it in the side bearing of the glyph that straddles
/// the edge and the outermost column stays transparent, even though the rest of
/// the sentence was thrown away. Asking for pixel `0` and pixel `width - 1`
/// exactly therefore reads half of all cropped captions as "fits".
///
/// Not a theory - measured on this binary, over a single centred line whose
/// length was grown one character at a time well past the point where the ink
/// stops widening (so every sample below really is cropped). The gap alternates
/// with the parity of the character count, which is what makes it half:
///
/// | canvas | `PlayResX` | 48px | 72px | 96px |
/// |---|---|---|---|---|
/// | 1080x1920 | 608 | 8 | 4 | 12 |
/// | 720x1280 | 608 | 5 | 3 | 8 |
/// | 1088x1920 | 612 | 4 | 8 | 16 |
/// | 1920x1080 | 1920 | 4 | 6 | 9 |
/// | 1280x720 | 1920 | 2 | 4 | 6 |
/// | 1080x1080 | 1080 | 4 | 7 | 6 |
///
/// (worst glyph of `l . i I 1 j t f r` at each size; `PlayResY` is always 1080,
/// so a vertical canvas is a 608-wide script blown up to 1080 columns and pays
/// the largest gaps - which is exactly where this check was reported passing a
/// caption cropped on both sides.)
///
/// `16` is the largest of those. It bounds the measurements above and not the
/// mechanism: the gap is a fraction of the em rather than a fixed count of
/// pixels, so a caption set far larger than 96px can still stop further short
/// than this. Closing that for good needs the boundary column's ink run rather
/// than an ever-wider tolerance - see the TODO on
/// [`FlushEdges::overflows_frame`].
///
/// What it costs is bounded and was measured too. A false positive needs a
/// caption that lost nothing and yet inks within 16 pixels of *both* opposing
/// edges - on a 1080-wide frame, one filling 97% of the picture, which is
/// already far outside the 93% action-safe box `caption.safe_area` grades. The
/// alternative is the defect this replaces, where a cropped caption's own box is
/// indistinguishable from that one and the Error simply does not fire.
const FLUSH_EDGE_TOLERANCE_PX: i64 = 16;

/// The tolerance one axis can carry without its two thresholds meeting.
///
/// On a canvas narrower than twice the tolerance, "near the left edge" and "near
/// the right edge" would overlap and a single inked pixel would read as flush
/// against both at once - an overflow invented out of one dot. The canvas floor
/// elsewhere is far above that, so this only ever binds on a degenerate frame.
fn flush_tolerance(extent: u32) -> i64 {
    let midpoint = (i64::from(extent) - 1) / 2 - 1;
    midpoint.clamp(0, FLUSH_EDGE_TOLERANCE_PX)
}

/// Which frame edges the measured ink reaches.
fn flush_edges(measured: MeasuredBox, width: u32, height: u32) -> FlushEdges {
    let horizontal = flush_tolerance(width);
    let vertical = flush_tolerance(height);
    let right_edge = i64::from(width) - 1 - horizontal;
    let bottom_edge = i64::from(height) - 1 - vertical;

    FlushEdges {
        left: i64::from(measured.x1) <= horizontal,
        right: i64::from(measured.x2) >= right_edge,
        top: i64::from(measured.y1) <= vertical,
        bottom: i64::from(measured.y2) >= bottom_edge,
    }
}

/// Turns the script builder's own event list into the cues the probe measures.
///
/// The builder writes one `Dialogue` line per clip it accepts and reports the
/// clip behind each line in
/// [`AssTextOverlayScript::event_clip_ids`](super::export::AssTextOverlayScript::event_clip_ids),
/// so the set of cues and their order come from the code that emits them rather
/// than from a second walk of the sequence re-implementing its selection
/// clauses. That mirrored walk is what this replaced: it agreed with the builder
/// on the day it was written, and the first clause to drift - one more reason to
/// drop a clip, one fewer - would have shifted every attribution past the
/// divergence onto the wrong caption.
///
/// Only the *timing* is read back off the clip here, and it is the same timing
/// the builder wrote into the event.
///
/// `None` means the events cannot be attributed at all: an id the sequence does
/// not hold, or two clips sharing one id. Neither is reachable from a builder
/// that took its ids from this same sequence, and both would silently measure
/// the wrong caption, so the answer is to measure nothing and say so.
fn cues_for_events(
    sequence: &Sequence,
    window_start_sec: f64,
    event_clip_ids: &[String],
) -> Option<Vec<CaptionCue>> {
    let wanted: std::collections::HashSet<&str> =
        event_clip_ids.iter().map(String::as_str).collect();

    let mut spans: HashMap<&str, (f64, f64)> = HashMap::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            if !wanted.contains(clip.id.as_str()) {
                continue;
            }
            let span = (clip.place.timeline_in_sec, clip.place.timeline_out_sec());
            if spans.insert(clip.id.as_str(), span).is_some() {
                // Two clips answering to one id: whichever box is measured, it
                // cannot be said which of them drew it.
                return None;
            }
        }
    }

    event_clip_ids
        .iter()
        .map(|clip_id| {
            let (start, end) = *spans.get(clip_id.as_str())?;
            if !start.is_finite() || !end.is_finite() || end <= start {
                return None;
            }

            let render_end = end - window_start_sec;
            if render_end < 0.0 {
                return None;
            }

            Some(CaptionCue {
                clip_id: clip_id.clone(),
                timeline_in_sec: start,
                timeline_end_sec: end,
                // Exactly what the `Dialogue` line will say. `ass_timecode`
                // floors a negative start at zero, so a cue already on screen
                // when the window opens is drawn from the window's first frame;
                // `ass_centisecond` is that same function's rounding, which is
                // the grid libass is given and therefore the grid every timing
                // question here has to be asked on.
                drawn_start_sec: ass_centisecond((start - window_start_sec).max(0.0)),
                drawn_end_sec: ass_centisecond(render_end),
            })
        })
        .collect()
}

/// The same script with the *visible* events' decoration hidden.
///
/// Only the `Dialogue` lines are touched, and only their text field: the styles
/// keep their `Outline`, `Shadow` and `BorderStyle` columns exactly as the
/// burn-in wrote them, because those columns are what libass sizes the bitmaps
/// from and a smaller bitmap is a differently positioned cue. The inline
/// [`GLYPH_ONLY_OVERRIDE_TAGS`] make the decoration invisible without making it
/// smaller, which is the only way to have both.
///
/// Line endings, the `[Script Info]` header, the `[Fonts]` section and the
/// timecodes all survive byte for byte, which is what keeps this the *same*
/// layout: libass wraps on glyph advances, and no tag added here has one.
///
/// `hidden_events` names the events this layer's script drew no ink for, by
/// their position among the `Dialogue` lines - which is the event index
/// everything else in this module counts by, because the builder writes exactly
/// one line per event in order. Those lines are copied through untouched.
///
/// With [`GLYPH_ONLY_OVERRIDE_TAGS`] as it stands, skipping them changes no
/// pixel: a hidden event already carries
/// [`ASS_HIDE_INK_TAGS`](super::export::ASS_HIDE_INK_TAGS), so appending the
/// same transparency to it a second time is idempotent. The boundary is kept
/// anyway, and deliberately, because it is the structural guarantee that this
/// pass never rewrites an event it is not measuring. A hidden neighbour is the
/// *obstacle* libass shifted the visible cue away from, and libass sized that
/// obstacle with its outline and its background box on; the day someone widens
/// this tag set to something that changes a bitmap's extent, the neighbours have
/// to be out of its reach. Measured on this binary at 1920x1080, a `\bord6` cue
/// stacked above a hidden neighbour, with the geometry-zeroing tag set this
/// module used to write: correct box `897..947`, that tag set on the visible cue
/// alone `903..953`, and on the neighbour as well `909..959` - outside the
/// full-ink rectangle it is supposed to be a subset of.
fn glyph_only_script(script: &str, hidden_events: &std::collections::HashSet<usize>) -> String {
    let mut out = String::with_capacity(script.len() + script.len() / 8);
    let mut event_index = 0usize;

    for line in script.split_inclusive('\n') {
        let (body, ending) = match line.find(['\r', '\n']) {
            Some(index) => line.split_at(index),
            None => (line, ""),
        };

        let is_event = body.starts_with("Dialogue:");
        let hidden = is_event && hidden_events.contains(&event_index);
        if is_event {
            event_index += 1;
        }

        match (!hidden)
            .then(|| is_event.then(|| dialogue_text_offset(body)).flatten())
            .flatten()
        {
            Some(offset) => {
                out.push_str(&body[..offset]);
                out.push_str(&hide_decoration_tags(&body[offset..]));
            }
            None => out.push_str(body),
        }
        out.push_str(ending);
    }

    out
}

/// Byte offset of a `Dialogue` line's text field, or `None` when the line is
/// too short to have one.
///
/// A line missing its ninth comma is malformed and is copied through untouched
/// rather than guessed at: appending override tags at a guessed offset would
/// corrupt an event the burn-in still has to be able to draw.
fn dialogue_text_offset(line: &str) -> Option<usize> {
    let mut commas = 0usize;

    for (index, byte) in line.bytes().enumerate() {
        if byte == b',' {
            commas += 1;
            if commas == ASS_DIALOGUE_COMMAS_BEFORE_TEXT {
                return Some(index + 1);
            }
        }
    }

    None
}

/// Appends the decoration-hiding tags to the end of every override block.
///
/// Every block, not only the first: the burn-in opens a second block per font
/// run and per emoji spacer, and a block later in the line could otherwise make
/// an outline opaque again. Appending rather than prepending is the whole trick:
/// inside one block the last spelling of a tag wins, so these have to come after
/// any `\3a` the burn-in wrote.
///
/// Text carrying no block at all gets one in front, so an event written by hand
/// (or by a future builder that drops the inherited tags) is still measured
/// without its style's decoration painted. That is also what retires the
/// `force_style` option this pass used to splice into the filter: the one case
/// it covered - an event with no override block, whose `BorderStyle` column no
/// inline tag could otherwise reach - is covered here, inline, and without
/// touching the hidden neighbours a style-level option would also have reached.
fn hide_decoration_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + GLYPH_ONLY_OVERRIDE_TAGS.len() + 2);
    let mut rest = text;
    let mut blocks = 0usize;

    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|offset| open + offset) else {
            // An unterminated brace is not an override block; libass draws it as
            // text and so does this.
            break;
        };

        out.push_str(&rest[..close]);
        out.push_str(GLYPH_ONLY_OVERRIDE_TAGS);
        out.push('}');
        rest = &rest[close + 1..];
        blocks += 1;
    }

    out.push_str(rest);

    if blocks == 0 {
        return format!("{{{GLYPH_ONLY_OVERRIDE_TAGS}}}{out}");
    }

    out
}

/// A cue with the frames the probe will read it back on.
#[derive(Clone, Debug, PartialEq)]
struct PlannedCue {
    cue: CaptionCue,
    /// Frames to probe. Empty for a sub-frame cue.
    frames: Vec<u64>,
}

impl PlannedCue {
    /// Whether these two cues can be measured on the same probe run.
    ///
    /// They cannot when either one is drawn on a frame the other is probed on,
    /// because `bbox` reports one rectangle for the frame and it would then be
    /// the union of the two. Asked in both directions, which is not the same
    /// question asked twice: a long cue can be live across a short one's every
    /// sample while the short one is live at none of the long one's.
    ///
    /// Asked of *frames* rather than of the spans, because a frame is what
    /// libass is actually handed to draw. Two cues whose drawn spans overlap for
    /// less than a frame interval may share no rendered frame at all, and
    /// putting them in separate layers on the strength of the span alone would
    /// spawn a second FFmpeg run to measure something one already could.
    fn conflicts_with(&self, other: &Self, fps: f64) -> bool {
        self.frames
            .iter()
            .any(|frame| other.cue.is_live_at(*frame as f64 / fps))
            || other
                .frames
                .iter()
                .any(|frame| self.cue.is_live_at(*frame as f64 / fps))
    }
}

/// Pairs every cue with the frames it will be probed on.
///
/// Purely a question of timing, answered before anything is rendered.
fn plan_cues(cues: Vec<CaptionCue>, fps: f64) -> Vec<PlannedCue> {
    cues.into_iter()
        .map(|cue| {
            let frames = cue.probe_frames(fps);
            PlannedCue { cue, frames }
        })
        .collect()
}

/// Splits the measurable cues into groups no two members of which share a frame.
///
/// Greedy colouring of the conflict graph, mirroring the colour-emoji pass's
/// [`plan_measurement_batches`](super::emoji_measure::plan_measurement_batches):
/// each cue takes the first layer none of whose members it conflicts with, and a
/// cue that fits nowhere opens a new one. The order is the script's own event
/// order, so the partition is deterministic; the result is a proper colouring by
/// construction, which is the only property the measurement needs (an optimal
/// one would only ever save a process).
///
/// The guarantee a layer carries is exactly the one the probe rests on: on any
/// frame a member is probed at, no other member of that layer is drawn. Cues
/// *outside* the layer draw nothing at all, because the script that renders it
/// hides them - so the rectangle `bbox` reports for that frame is one cue's.
///
/// `measurable` is the cues worth colouring: a sub-frame cue has no frame to
/// probe, and a colour-emoji cue is refused for its own reason. Including them
/// would spend layers - and therefore FFmpeg runs - on cues that are going back
/// to the caller's predictor either way.
fn plan_layers(planned: &[PlannedCue], measurable: &[usize], fps: f64) -> Vec<Vec<usize>> {
    let mut layers: Vec<Vec<usize>> = Vec::new();

    for index in measurable {
        let slot = layers.iter().position(|layer| {
            layer
                .iter()
                .all(|member| !planned[*member].conflicts_with(&planned[*index], fps))
        });

        match slot {
            Some(slot) => layers[slot].push(*index),
            None => layers.push(vec![*index]),
        }
    }

    layers
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

    // Built once, and built *first*: it is the script that decides which clips
    // become events, so the cue list is derived from it rather than guessed
    // alongside it. Every probe run then reads the same script the burn-in
    // would, so the fonts, the `PlayRes`, the margins and the wrapping are the
    // export's and not a reconstruction of them.
    //
    // Including the emoji pack, which is the part that is easy to get wrong:
    // with a pack installed the burn-in turns every emoji cluster into a
    // 1.2 em advance-only spacer, and a probe built without one lays the raw
    // glyph out instead - different advances, a different line break, and a
    // rectangle for a caption the export never draws. The price is that the
    // spacer is ink-free, so an emoji cue's own box is incomplete; those cues
    // are refused below rather than reported short.
    let emoji_pack = crate::core::text::emoji_assets::discover();
    let Some(script) = build_ass_text_overlay_script_in_window_with_emoji(
        request.sequence,
        request.effects,
        request.window_start_sec,
        Some(EmojiSpacerContext {
            pack: emoji_pack.map(|pack| pack as &dyn EmojiRasterSource),
            markers: None,
            refused: None,
        }),
    )?
    else {
        return Ok(CaptionExtentMeasurement::default());
    };

    let Some(cues) = cues_for_events(
        request.sequence,
        request.window_start_sec,
        &script.event_clip_ids,
    ) else {
        // Measuring on an identity this module cannot vouch for would report
        // one caption's rectangle under another caption's name, which is worse
        // than the predictor the caller falls back to.
        return Ok(CaptionExtentMeasurement {
            extents: Vec::new(),
            coverage: CaptionExtentCoverage {
                notes: vec![
                    "The burn-in script's events could not be matched to clips, so no cue was \
                     measured"
                        .to_string(),
                ],
                ..CaptionExtentCoverage::default()
            },
        });
    };
    if cues.is_empty() {
        return Ok(CaptionExtentMeasurement::default());
    }

    let planned = plan_cues(cues, fps);
    // `event_index` is a position in the script's own event list, which is the
    // same list `event_clip_ids` - and therefore `planned` - is indexed by.
    let emoji_events: std::collections::HashSet<usize> = script
        .emoji_occurrences
        .iter()
        .map(|occurrence| occurrence.event_index)
        .collect();

    let mut coverage = CaptionExtentCoverage {
        uses_host_fonts: script.uses_host_fonts,
        ..CaptionExtentCoverage::default()
    };
    let mut measurable: Vec<usize> = Vec::new();

    for (index, entry) in planned.iter().enumerate() {
        // Asked first, and before `no_ink` can ever be reached: a cue that is
        // nothing but an emoji renders an ink-free spacer and would otherwise be
        // reported as a caption that drew nothing at all.
        if emoji_events.contains(&index) {
            coverage.emoji_cue_ids.push(entry.cue.clip_id.clone());
        } else if entry.frames.is_empty() {
            coverage.sub_frame_cue_ids.push(entry.cue.clip_id.clone());
        } else {
            measurable.push(index);
        }
    }

    // One layer per set of cues that never share a probe frame. A caption track
    // collapses to one; a persistent title over that track makes two.
    let mut layers = plan_layers(&planned, &measurable, fps);
    let kept_layers = MAX_MEASURED_LAYERS.min(layers.len());
    let capped: std::collections::HashSet<usize> = layers.drain(kept_layers..).flatten().collect();
    // Walked in event order rather than in layer order, so both the measured set
    // and the report name the cues in the order the script wrote them however
    // the colouring happened to fall out.
    let mut layered: Vec<usize> = Vec::with_capacity(measurable.len());
    for index in &measurable {
        if capped.contains(index) {
            coverage
                .shared_frame_cue_ids
                .push(planned[*index].cue.clip_id.clone());
        } else {
            layered.push(*index);
        }
    }

    // TODO(caption-extent-emoji-union): measure the full extent of an emoji cue
    // by unioning the overlay cells `EmojiColourPass` places - their positions
    // and sizes are already computed for the burn-in - with the alpha box of the
    // text around them, and drop this bucket.
    if !coverage.emoji_cue_ids.is_empty() {
        coverage.notes.push(format!(
            "{} caption cue(s) contain a colour emoji, whose picture is composited outside the \
             subtitle layer and so is not in the measured alpha; their boxes are estimated",
            coverage.emoji_cue_ids.len()
        ));
    }
    // Only worth saying when there is a measurement for it to qualify. The flag
    // itself stays on the record either way, because that is what a reader
    // comparing two machines' reports looks at.
    if coverage.uses_host_fonts && !layered.is_empty() {
        coverage.notes.push(
            "At least one caption run was laid out with fonts installed on this machine rather \
             than a face the script embeds, so the measured boxes are machine-specific and two \
             machines can legitimately disagree about them"
                .to_string(),
        );
    }
    if !coverage.shared_frame_cue_ids.is_empty() {
        coverage.notes.push(format!(
            "{} cue(s) are on screen alongside more text or caption events than this pass will \
             isolate ({MAX_MEASURED_LAYERS} at once), so their boxes are estimated",
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

    let frames_per_cue: Vec<usize> = planned.iter().map(|entry| entry.frames.len()).collect();
    let event_count = script.event_clip_ids.len();
    let mut plans: Vec<LayerPlan> = Vec::with_capacity(layers.len());
    let mut unbuildable: Vec<usize> = Vec::new();

    for (layer_index, layer) in layers.iter().enumerate() {
        let visible: std::collections::HashSet<usize> = layer.iter().copied().collect();
        // One layer holding *every* event in the script: there is nothing to
        // hide, so the render's own script is reused rather than rebuilt.
        //
        // Narrower than "an ordinary one-track project", and worth being exact
        // about: the layers only ever hold the `measurable` cues, so a single
        // emoji cue, a single sub-frame cue, or any cue past
        // `MAX_MEASURED_LAYERS` is enough to take a one-caption-track project
        // down the rebuild path. That is correctness-neutral - the isolated
        // build with every measured event visible produces the same script the
        // builder wrote, and `build_ass_text_overlay_script_isolated` is tested
        // for exactly that - so this stays a shortcut, not a guarantee. It is
        // load-bearing only in that the common shape does not pay for a second
        // build.
        let text = if visible.len() == event_count {
            script.script.clone()
        } else {
            let Some(isolated) = build_ass_text_overlay_script_isolated(
                request.sequence,
                request.effects,
                request.window_start_sec,
                Some(EmojiSpacerContext {
                    pack: emoji_pack.map(|pack| pack as &dyn EmojiRasterSource),
                    markers: None,
                    refused: None,
                }),
                Some(&visible),
            )?
            else {
                // Unreachable: the isolated build runs exactly the selection the
                // build above it ran, and that one produced events. Recorded
                // rather than skipped, because a layer quietly dropped here
                // would leave its cues in the measured set with no box - and a
                // cue with no box is reported as one that drew no ink, which is
                // a defect invented out of a build that never happened.
                debug_assert!(
                    false,
                    "an isolated build of a script that has events produced none"
                );
                unbuildable.extend(layer.iter().copied());
                continue;
            };
            isolated.script
        };

        let script_path = temp_dir
            .path()
            .join(format!("caption-extent-layer-{layer_index}.ass"));
        crate::core::fs::validate_filter_safe_path(&script_path, "Caption extent script path")
            .map_err(ExportError::InvalidSettings)?;
        tokio::fs::write(&script_path, &text)
            .await
            .map_err(ExportError::IoError)?;

        plans.push(LayerPlan {
            cues: layer.clone(),
            chunks: chunk_by_frame_budget(layer, &frames_per_cue),
            script_path,
            hidden_events: (0..event_count)
                .filter(|index| !visible.contains(index))
                .collect::<std::collections::HashSet<usize>>(),
        });
    }

    if !unbuildable.is_empty() {
        coverage.probe_failed = true;
        coverage.notes.push(format!(
            "{} cue(s) had no isolated script built for them, so their boxes are estimated",
            unbuildable.len()
        ));
    }

    // The budget starts here, at the first thing that spawns FFmpeg. What came
    // before it is script building and one file write per layer.
    let probe_started = Instant::now();
    let mut full_ink = ProbeOutcome::default();
    let mut completed: Vec<usize> = Vec::new();
    let mut unreached: Vec<usize> = Vec::new();

    for (plan_index, plan) in plans.iter().enumerate() {
        let Some(remaining) = remaining_pass_budget(request.probe_budget, probe_started.elapsed())
        else {
            unreached.extend(cues_of(&plans[plan_index..]));
            break;
        };

        match tokio::time::timeout(
            remaining,
            run_probe_pass(
                engine,
                request,
                &script,
                ProbePass {
                    script_path: &plan.script_path,
                    collect_font_notes: script.uses_host_fonts,
                },
                &plan.chunks,
                &planned,
                fps,
            ),
        )
        .await
        {
            Ok(outcome) => {
                full_ink.absorb(outcome);
                completed.push(plan_index);
            }
            // The layers already measured keep their rectangles. Only this one
            // and the ones behind it go back to the caller's predictor, which is
            // the whole reason the deadline is taken per layer rather than once
            // around the loop.
            Err(_) => {
                unreached.extend(cues_of(&plans[plan_index..]));
                break;
            }
        }
    }

    if !unreached.is_empty() {
        coverage.notes.push(format!(
            "Caption extent measurement ran out of the {:.1}s left in the run's budget after {} of \
             {} layer(s), so {} cue(s) keep their estimated boxes",
            request.probe_budget.as_secs_f64(),
            completed.len(),
            plans.len(),
            unreached.len()
        ));
        full_ink.failed.extend(unreached);
    }

    // The second run, over the same cues and the same frames, with the
    // decoration switched off. Skipped outright when nobody asked for the glyph
    // box, and when the first run reached no cue at all: a binary that cannot
    // spawn will not spawn twice either, and every cue is already going to be
    // reported unmeasured.
    let layered_total: usize = plans.iter().map(|plan| plan.cues.len()).sum();
    let mut glyph = ProbeOutcome::default();
    if request.needs_glyph_box && !completed.is_empty() && full_ink.failed.len() < layered_total {
        let mut ran_short = false;

        for plan_index in &completed {
            let plan = &plans[*plan_index];
            let Some(remaining) =
                remaining_pass_budget(request.probe_budget, probe_started.elapsed())
            else {
                ran_short = true;
                break;
            };

            let glyph_path = temp_dir
                .path()
                .join(format!("caption-extent-glyph-{plan_index}.ass"));
            crate::core::fs::validate_filter_safe_path(&glyph_path, "Caption extent script path")
                .map_err(ExportError::InvalidSettings)?;
            let layer_script = tokio::fs::read_to_string(&plan.script_path)
                .await
                .map_err(ExportError::IoError)?;
            tokio::fs::write(
                &glyph_path,
                glyph_only_script(&layer_script, &plan.hidden_events),
            )
            .await
            .map_err(ExportError::IoError)?;

            match tokio::time::timeout(
                remaining,
                run_probe_pass(
                    engine,
                    request,
                    &script,
                    ProbePass {
                        script_path: &glyph_path,
                        // Already collected from the full-ink run over the same
                        // script, and libass resolves the same faces for both:
                        // saying it twice would only pad the report.
                        collect_font_notes: false,
                    },
                    &plan.chunks,
                    &planned,
                    fps,
                ),
            )
            .await
            {
                Ok(outcome) => glyph.absorb(outcome),
                // The full-ink boxes survive this. They are already measured,
                // every other consumer grades them, and the cues left without a
                // glyph box are named below exactly as a failed second render
                // names them.
                Err(_) => {
                    ran_short = true;
                    break;
                }
            }
        }

        if ran_short {
            coverage.notes.push(
                "The glyph-only measurement ran out of the run's budget; the full-ink boxes stand \
                 and the tighter title-safe bound was not graded for every cue"
                    .to_string(),
            );
        }
    }

    if !full_ink.failed.is_empty() {
        coverage.probe_failed = true;
        coverage.notes.push(format!(
            "{} cue(s) could not be probed; FFmpeg did not complete the measurement run",
            full_ink.failed.len()
        ));
    }
    coverage.font_substitutions = full_ink.font_notes;
    if !coverage.font_substitutions.is_empty() {
        coverage.notes.push(format!(
            "libass substituted a font while laying these captions out, so the boxes are only as \
             reproducible as this machine's font set: {}",
            coverage.font_substitutions.join("; ")
        ));
    }

    // Only cues a probe was actually run for. `layered` is the set the pass
    // *intended* to measure, and `no_ink` below is asked of a missing box - so a
    // cue that never reached a run at all would come back reported as a caption
    // that drew nothing, which is a defect this pass would have invented.
    let probed: std::collections::HashSet<usize> = cues_of(&plans).collect();
    let extents: Vec<CaptionExtent> = layered
        .iter()
        .filter(|index| probed.contains(index) && !full_ink.failed.contains(index))
        .map(|index| {
            let cue = &planned[*index].cue;
            let measured = full_ink.boxes.get(index).copied().flatten();
            let glyph_measured = glyph.boxes.get(index).copied().flatten();

            CaptionExtent {
                clip_id: cue.clip_id.clone(),
                timeline_in_sec: cue.timeline_in_sec,
                timeline_end_sec: cue.timeline_end_sec,
                full_ink: measured.and_then(|measured| {
                    box_to_percent(measured, request.canvas_width, request.canvas_height)
                }),
                glyph: glyph_measured.and_then(|measured| {
                    box_to_percent(measured, request.canvas_width, request.canvas_height)
                }),
                clipped: measured.is_some_and(|measured| {
                    flush_edges(measured, request.canvas_width, request.canvas_height)
                        .overflows_frame()
                }),
                // Every sampled frame came back with no ink. Not a probe
                // failure - the run completed and libass drew nothing. Asked of
                // the full-ink render alone: a cue with ink but no glyph box is
                // a cue whose *second* run failed, not one that drew nothing.
                no_ink: measured.is_none(),
            }
        })
        .collect();

    // A cue with ink the glyph pass could not put a rectangle on. Named rather
    // than counted, because the caller grades cues one at a time and needs to
    // know which of them has no legibility box rather than that some do not.
    //
    // Only when the glyph box was asked for: a caller that did not want one is
    // not missing anything, and naming every cue as "unmeasured" would report a
    // gap in a measurement nobody ordered.
    if request.needs_glyph_box {
        coverage.glyph_unmeasured_cue_ids = extents
            .iter()
            .filter(|extent| extent.full_ink.is_some() && extent.glyph.is_none())
            .map(|extent| extent.clip_id.clone())
            .collect();
        if !coverage.glyph_unmeasured_cue_ids.is_empty() {
            coverage.notes.push(format!(
                "{} cue(s) were measured for their full ink but not for their glyphs alone; the \
                 tighter title-safe bound was not graded for them",
                coverage.glyph_unmeasured_cue_ids.len()
            ));
        }
    }

    Ok(CaptionExtentMeasurement { extents, coverage })
}

/// Least of the budget worth starting another probe pass with.
///
/// One FFmpeg spawn costs more than this on every machine this ships to, so a
/// pass started with less can only end in a timeout - having written a script
/// and spawned a process for nothing. The cue list is identical either way; what
/// changes is whether the run wastes its last quarter-second finding that out.
const MINIMUM_PASS_BUDGET: Duration = Duration::from_millis(250);

/// What is left of the budget, or `None` when it is not worth another pass.
///
/// The passes run in order and each takes whatever the ones before it did not
/// spend: the full-ink layers first, because their boxes are what every consumer
/// of this module reads, and then the glyph layers, which refine exactly one
/// verdict.
fn remaining_pass_budget(probe_budget: Duration, spent: Duration) -> Option<Duration> {
    let remaining = probe_budget.saturating_sub(spent);

    (remaining >= MINIMUM_PASS_BUDGET).then_some(remaining)
}

/// One overlap-free layer, ready to render.
struct LayerPlan {
    /// The cues it holds, as indices into the planned-cue list.
    cues: Vec<usize>,
    /// Those cues grouped into runs small enough for one FFmpeg invocation.
    chunks: Vec<Vec<usize>>,
    /// The script in which only this layer's events draw ink.
    script_path: std::path::PathBuf,
    /// The events that script hid, by their position in the event list.
    ///
    /// Carried for the glyph pass, which must leave them exactly as they are:
    /// they are the obstacles libass shifted this layer's cues away from, and it
    /// measured them with their decoration on.
    hidden_events: std::collections::HashSet<usize>,
}

/// Every cue these layers hold, in layer order.
fn cues_of(plans: &[LayerPlan]) -> impl Iterator<Item = usize> + '_ {
    plans.iter().flat_map(|plan| plan.cues.iter().copied())
}

/// What one probe pass produced.
#[derive(Debug, Default)]
struct ProbeOutcome {
    /// Per planned-cue index, the union of the boxes its frames measured.
    boxes: HashMap<usize, Option<MeasuredBox>>,
    /// Cue indices whose chunk did not complete.
    failed: Vec<usize>,
    /// Font substitutions libass reported, deduplicated and capped.
    font_notes: Vec<String>,
}

impl ProbeOutcome {
    /// Folds another layer's outcome into this one.
    ///
    /// The three fields merge three different ways, and each is the only one
    /// that is right. Boxes are disjoint - a cue belongs to exactly one layer -
    /// so they are moved across rather than unioned. Failures accumulate.
    /// Substitution notes are deduplicated and capped again, because two layers
    /// of the same project draw the same families and would otherwise report the
    /// same fallback once per layer.
    fn absorb(&mut self, other: Self) {
        self.boxes.extend(other.boxes);
        self.failed.extend(other.failed);
        for note in other.font_notes {
            if self.font_notes.len() >= MAX_FONT_SUBSTITUTION_NOTES {
                break;
            }
            if !self.font_notes.contains(&note) {
                self.font_notes.push(note);
            }
        }
    }
}

/// How one pass differs from the other. Everything else about them is identical,
/// which is the point: two boxes of the same caption, not two measurements of
/// two different layouts.
///
/// The filter graph is identical too, down to the option string. The two passes
/// differ by their *script* and by nothing else, which is what lets the glyph
/// box be compared with the full-ink box at all - a `subtitles` option that
/// applied to one and not the other would be a second layout in disguise.
struct ProbePass<'a> {
    /// Script to render - the burn-in's own, or its decoration-hiding twin.
    script_path: &'a Path,
    /// Whether to run verbosely enough to hear libass pick a fallback face.
    collect_font_notes: bool,
}

/// Runs one pass of the probe over every chunk and unions each cue's frames.
async fn run_probe_pass(
    engine: &ExportEngine,
    request: &CaptionExtentRequest<'_>,
    script: &super::export::AssTextOverlayScript,
    pass: ProbePass<'_>,
    chunks: &[Vec<usize>],
    planned: &[PlannedCue],
    fps: f64,
) -> ProbeOutcome {
    let mut outcome = ProbeOutcome::default();

    for chunk in chunks {
        let instants: Vec<(usize, u64, f64)> = chunk
            .iter()
            .flat_map(|index| {
                planned[*index]
                    .frames
                    .iter()
                    .map(move |frame| (*index, *frame, *frame as f64 / fps))
            })
            .collect();

        match run_probe(engine, request, script, &pass, &instants, fps).await {
            Ok(report) => {
                let printed = parse_bbox_frames(&report.printed);
                for (index, _, instant) in &instants {
                    let measured = match_box_to_instant(&printed, *instant, fps);
                    let slot = outcome.boxes.entry(*index).or_default();
                    *slot = match (*slot, measured) {
                        (Some(existing), Some(found)) => Some(existing.union(found)),
                        (Some(existing), None) => Some(existing),
                        (None, found) => found,
                    };
                }
                for note in report.font_notes {
                    if outcome.font_notes.len() >= MAX_FONT_SUBSTITUTION_NOTES {
                        break;
                    }
                    if !outcome.font_notes.contains(&note) {
                        outcome.font_notes.push(note);
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Caption extent measurement failed for {} cue(s); they keep the predicted \
                     extent: {error}",
                    chunk.len()
                );
                outcome.failed.extend(chunk.iter().copied());
            }
        }
    }

    outcome
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

/// Everything about a probe's filtergraph that is not the cue list.
///
/// Grouped rather than passed one by one because three of the four are strings
/// spliced into the same `subtitles` option list, and a call site that mixed two
/// of them up would build a graph that runs and measures the wrong thing.
///
/// There is deliberately no `force_style` here. Both passes want the styles the
/// burn-in wrote, because a style-level override reaches every event in the
/// script - the alpha-hidden neighbours included - and shrinking one of those is
/// what moves the cue being measured. See [`GLYPH_ONLY_OVERRIDE_TAGS`].
struct ProbeGraph<'a> {
    /// The script libass is handed.
    script_path: &'a Path,
    /// `:fontsdir='...'`, or empty when the script embeds every face it needs.
    fonts_dir_option: &'a str,
    /// `:wrap_unicode=1`, or empty for a binary whose filter has no such option.
    wrap_unicode_option: &'a str,
    /// `-loglevel` value.
    log_level: &'a str,
}

/// Builds the probe command for one run.
///
/// Split out from the spawn so a test can assert on the exact graph without
/// needing FFmpeg - the graph is the load-bearing part of this module, and every
/// option in it is there to make the probe lay the script out the way the
/// burn-in does.
fn build_probe_args(
    request: &CaptionExtentRequest<'_>,
    instants: &[(usize, u64, f64)],
    fps: f64,
    graph: &ProbeGraph<'_>,
) -> Vec<String> {
    use crate::core::effects::escape_ffmpeg_filter_value;

    let ProbeGraph {
        script_path,
        fonts_dir_option,
        wrap_unicode_option,
        log_level,
    } = graph;

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
        log_level.to_string(),
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

/// The default log level for a probe run.
///
/// Quiet enough that the `metadata` filter's own info-level chatter stays out of
/// the way; everything this module reads is on stdout.
const PROBE_LOG_LEVEL: &str = "error";

/// The log level libass names its font substitutions at.
///
/// Measured against this binary: `Glyph 0x12000 not found, selecting one more
/// font for (Family, 400, 0)` and the `fontselect:` line that answers it are
/// `MSGL_INFO`, which `vf_subtitles` maps to `AV_LOG_VERBOSE` - so `warning`
/// hears nothing at all, not even for a family that is installed nowhere. The
/// price of `verbose` is that libass also echoes the whole script to stderr,
/// which is why it is asked for only when the layout depended on host fonts and
/// the answer is therefore worth something.
const PROBE_FONT_LOG_LEVEL: &str = "verbose";

/// What one probe run returned.
struct ProbeReport {
    /// The `metadata` filter's report, off stdout.
    printed: String,
    /// Font substitutions libass named on stderr, when it was asked loudly
    /// enough to name them.
    font_notes: Vec<String>,
}

/// Runs one probe and returns the metadata text it printed.
async fn run_probe(
    engine: &ExportEngine,
    request: &CaptionExtentRequest<'_>,
    script: &super::export::AssTextOverlayScript,
    pass: &ProbePass<'_>,
    instants: &[(usize, u64, f64)],
    fps: f64,
) -> Result<ProbeReport, ExportError> {
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

    let log_level = if pass.collect_font_notes {
        PROBE_FONT_LOG_LEVEL
    } else {
        PROBE_LOG_LEVEL
    };
    let args = build_probe_args(
        request,
        instants,
        fps,
        &ProbeGraph {
            script_path: pass.script_path,
            fonts_dir_option: &fonts_dir_option,
            wrap_unicode_option,
            log_level,
        },
    );
    let output = super::executor::execute_ffmpeg_output(engine.ffmpeg_path(), &args).await?;

    Ok(ProbeReport {
        printed: String::from_utf8_lossy(&output.stdout).into_owned(),
        font_notes: if pass.collect_font_notes {
            parse_font_substitutions(&String::from_utf8_lossy(&output.stderr))
        } else {
            Vec::new()
        },
    })
}

/// Pulls libass's font-selection lines out of a verbose run's stderr.
///
/// Two shapes, both worth keeping and for different reasons:
///
/// - `fontselect: (Family, 400, 0) -> ArialMT, 0, ArialMT` - the family that was
///   asked for and the face that answered. A report saying those differ is the
///   difference between "this machine has the font" and "this machine picked
///   something else", which is exactly what makes two machines' boxes disagree.
/// - `Glyph 0x12000 not found, selecting one more font for (Family, 400, 0)` -
///   the codepoint that forced a fallback, which names the character a reader
///   should look at.
///
/// Everything else on a verbose run's stderr - and at that level libass echoes
/// the whole script - is dropped. The `[Parsed_subtitles_1 @ 0x...]` prefix goes
/// with it: it carries a heap address, so keeping it would make two runs of the
/// same project produce different report text.
fn parse_font_substitutions(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = match line.rfind("] ") {
                Some(index) if line.starts_with('[') => &line[index + 2..],
                _ => line,
            };

            (line.starts_with("fontselect:")
                || (line.starts_with("Glyph 0x") && line.contains("not found")))
            .then(|| line.to_string())
        })
        .collect()
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

    /// A cue placed on the render's clock, rounded the way the script writes it.
    fn cue(clip_id: &str, start: f64, end: f64) -> CaptionCue {
        CaptionCue {
            clip_id: clip_id.to_string(),
            timeline_in_sec: start,
            timeline_end_sec: end,
            drawn_start_sec: ass_centisecond(start),
            drawn_end_sec: ass_centisecond(end),
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

    /// A probe graph with the ordinary log level, for a test that cares only
    /// about the filter options.
    fn probe_graph<'a>(
        script_path: &'a Path,
        fonts_dir_option: &'a str,
        wrap_unicode_option: &'a str,
    ) -> ProbeGraph<'a> {
        ProbeGraph {
            script_path,
            fonts_dir_option,
            wrap_unicode_option,
            log_level: PROBE_LOG_LEVEL,
        }
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
    /// Scenario: a box filling an entire axis is an overflow of unknown size
    ///
    /// libass clips at the frame, so a caption wider than the picture measures
    /// as one the width of the picture. Reporting that as a clean "fits inside
    /// the frame" is the failure this flag exists to prevent - and the signature
    /// is both *opposing* edges at once, because that is what a line longer than
    /// the axis produces and what a legitimate caption cannot.
    #[test]
    fn a_box_filling_a_whole_axis_is_flagged_as_clipped() {
        let inside = MeasuredBox {
            x1: 60,
            y1: 60,
            x2: 1859,
            y2: 1019,
        };
        assert!(!flush_edges(inside, 1920, 1080).overflows_frame());

        // The measured 200-character unspaced run: left and right at once.
        let horizontal = MeasuredBox {
            x1: 0,
            y1: 968,
            x2: 1919,
            y2: 1010,
        };
        assert!(flush_edges(horizontal, 1920, 1080).overflows_frame());

        let vertical = MeasuredBox {
            x1: 700,
            y1: 0,
            x2: 1200,
            y2: 1079,
        };
        assert!(flush_edges(vertical, 1920, 1080).overflows_frame());
    }

    /// Feature: caption extent measurement
    /// Scenario: a box that stops a pixel short of both edges is still clipped
    ///
    /// The regression this tolerance exists for, in arithmetic. Asking for pixel
    /// `0` and pixel `width - 1` *exactly* let a caption cropped on both sides
    /// through whenever the frame boundary happened to fall in the side bearing
    /// of the glyph straddling it - which alternates with the character count,
    /// so it was half of them. Measured on a 1080x1920 sequence the ink stopped
    /// six columns short at each end (`6..1073`) while the estimate that
    /// measurement replaced reported the same caption, which is the shape of
    /// "worse than the model it replaced" this whole flag exists to avoid.
    ///
    /// The far side of the tolerance is asserted in the same breath: a box tens
    /// of pixels clear of the edges is an ordinary caption and must stay one, or
    /// the fix trades a false negative for a false positive.
    #[test]
    fn a_box_stopping_just_short_of_both_edges_is_still_clipped() {
        // 1080x1920, `clean-minimal`, an unspaced run of ninety-six `l`s.
        let measured_shorts = MeasuredBox {
            x1: 6,
            y1: 1668,
            x2: 1073,
            y2: 1712,
        };
        assert!(
            flush_edges(measured_shorts, 1080, 1920).overflows_frame(),
            "a caption cropped at both ends does not have to ink the boundary column"
        );

        // One pixel in from each edge, the smallest gap there is.
        let one_pixel_short = MeasuredBox {
            x1: 1,
            y1: 900,
            x2: 1078,
            y2: 1000,
        };
        assert!(flush_edges(one_pixel_short, 1080, 1920).overflows_frame());

        // The largest gap the tolerance covers, and the first one past it.
        let at_the_limit = MeasuredBox {
            x1: FLUSH_EDGE_TOLERANCE_PX as i32,
            y1: 900,
            x2: 1079 - FLUSH_EDGE_TOLERANCE_PX as i32,
            y2: 1000,
        };
        assert!(flush_edges(at_the_limit, 1080, 1920).overflows_frame());
        let past_the_limit = MeasuredBox {
            x1: FLUSH_EDGE_TOLERANCE_PX as i32 + 1,
            ..at_the_limit
        };
        assert!(
            !flush_edges(past_the_limit, 1080, 1920).overflows_frame(),
            "the tolerance is a few pixels, not a licence to call any wide caption cropped"
        );

        // An ordinary margined caption on the same canvas: measured `281..796`.
        let margined = MeasuredBox {
            x1: 281,
            y1: 1175,
            x2: 796,
            y2: 1435,
        };
        assert!(
            !flush_edges(margined, 1080, 1920).overflows_frame(),
            "a caption with margins is nowhere near an edge"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a frame too small to hold the tolerance cannot invent an
    /// overflow
    ///
    /// The tolerance is a band at each end of an axis, and on a frame narrower
    /// than two of them the bands would overlap: one inked pixel would read as
    /// flush against the left *and* the right, and every caption on such a
    /// canvas would be reported cropped. Nothing in the product makes a canvas
    /// that small - the CLI floor is sixteen pixels - which is exactly why it
    /// would never be noticed.
    #[test]
    fn a_canvas_smaller_than_the_tolerance_does_not_invent_an_overflow() {
        let single_pixel = MeasuredBox {
            x1: 4,
            y1: 4,
            x2: 4,
            y2: 4,
        };
        assert!(
            !flush_edges(single_pixel, 16, 16).overflows_frame(),
            "one dot in the middle of a tiny frame fills no axis"
        );
        assert!(
            flush_edges(
                MeasuredBox {
                    x1: 0,
                    y1: 4,
                    x2: 15,
                    y2: 4,
                },
                16,
                16
            )
            .overflows_frame(),
            "and a run that really does span the axis is still reported"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a caption merely reaching one frame edge is not an overflow
    ///
    /// Measured against the real binary at 1920x1080: a bottom caption with
    /// `marginPercent: 0` - a value the preset schema allows - inks
    /// `718..1201 x 1027..1079`, and the same caption with `\blur8\bord6` inks
    /// `778..1142 x 1003..1079`. Neither lost a pixel. Escalating those to an
    /// Error made this measurement stricter than the estimate it replaced, on
    /// captions nobody cropped; the ordinary edge comparison, which passes a box
    /// at `0..100`, governs them instead.
    #[test]
    fn a_caption_flush_against_one_edge_is_not_an_overflow() {
        for (name, flush) in [
            (
                "a margin-0 bottom caption",
                MeasuredBox {
                    x1: 718,
                    y1: 1027,
                    x2: 1201,
                    y2: 1079,
                },
            ),
            (
                "the same caption with a blur",
                MeasuredBox {
                    x1: 778,
                    y1: 1003,
                    x2: 1142,
                    y2: 1079,
                },
            ),
            (
                "a caption flush against the left",
                MeasuredBox {
                    x1: 0,
                    y1: 500,
                    x2: 900,
                    y2: 560,
                },
            ),
            (
                "a caption flush against the top",
                MeasuredBox {
                    x1: 700,
                    y1: 0,
                    x2: 1200,
                    y2: 60,
                },
            ),
        ] {
            let edges = flush_edges(flush, 1920, 1080);
            assert!(
                !edges.overflows_frame(),
                "{name} reaches an edge without being cut: {flush:?} -> {edges:?}"
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
        // `1.0` to `1.0666…` is written `0:00:01.00,0:00:01.07`, and measured
        // against the real binary that script draws on frames 30, 31 and 32 -
        // not on 29, not on 33. All three fractions must land inside that span
        // and nowhere else.
        let frames = cue("a", 1.0, 1.0 + 2.0 / 30.0).probe_frames(30.0);

        assert!(!frames.is_empty());
        for frame in &frames {
            assert!((30..=32).contains(frame), "frame {frame} is not on the cue");
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
    // Layering
    // =========================================================================

    /// Every cue of `planned`, coloured.
    fn layers_of(planned: &[PlannedCue], fps: f64) -> Vec<Vec<usize>> {
        let measurable: Vec<usize> = (0..planned.len()).collect();
        plan_layers(planned, &measurable, fps)
    }

    /// Feature: caption extent measurement
    /// Scenario: a single caption track is one layer, and therefore one run
    ///
    /// Back-to-back cues touch at their boundary, and a touch is not an overlap:
    /// nothing is drawn at the instant a cue ends. Treating it as one would put
    /// the ordinary project - one caption track, cues end to end - into a layer
    /// per cue and spawn an FFmpeg run for each of them.
    #[test]
    fn back_to_back_cues_on_one_track_are_one_layer() {
        let planned = plan_cues(
            vec![cue("a", 0.0, 2.0), cue("b", 2.0, 4.0), cue("c", 4.0, 6.0)],
            30.0,
        );

        let layers = layers_of(&planned, 30.0);

        assert_eq!(layers, vec![vec![0, 1, 2]], "{planned:#?}");
        // And that one layer is one FFmpeg invocation, which is the cost claim
        // the common path rests on.
        let frames: Vec<usize> = planned.iter().map(|entry| entry.frames.len()).collect();
        assert_eq!(chunk_by_frame_budget(&layers[0], &frames).len(), 1);
    }

    /// Feature: caption extent measurement
    /// Scenario: a title over a caption track is two layers, not two refusals
    ///
    /// The project this change exists for: one text clip on screen for the whole
    /// timeline, captions running underneath it. Every caption shares a frame
    /// with the title, so the solo/shared partition measured *nothing* here. Two
    /// layers measure all of it - the title alone in one, every caption in the
    /// other, because the captions do not overlap each other.
    #[test]
    fn a_persistent_title_over_captions_is_two_layers() {
        let planned = plan_cues(
            vec![
                cue("title", 0.0, 6.0),
                cue("a", 0.0, 2.0),
                cue("b", 2.0, 4.0),
                cue("c", 4.0, 6.0),
            ],
            30.0,
        );

        assert_eq!(layers_of(&planned, 30.0), vec![vec![0], vec![1, 2, 3]]);
    }

    /// Feature: caption extent measurement
    /// Scenario: two events live at once go into different layers
    ///
    /// `bbox` reports one rectangle per frame: the union of every inked pixel on
    /// it. A caption drawn at the same instant as a text overlay gives a box
    /// that belongs to neither, so the two are never rendered together.
    #[test]
    fn cues_that_share_a_frame_are_split_across_layers() {
        let planned = plan_cues(vec![cue("a", 0.0, 4.0), cue("b", 1.0, 3.0)], 30.0);

        assert_eq!(layers_of(&planned, 30.0), vec![vec![0], vec![1]]);
    }

    /// Feature: caption extent measurement
    /// Scenario: an overlap that misses every sample instant stays in one layer
    ///
    /// The conflict is about the frames actually probed, not about whether the
    /// spans intersect at all: a cue overlapping another only near its very end
    /// can still have all three of its own samples to itself, and a second
    /// FFmpeg run to establish that would buy nothing.
    #[test]
    fn an_overlap_that_misses_every_sample_leaves_both_cues_in_one_layer() {
        // `a` samples at 1s, 2s and 3s; `b` samples at 4.25s, 4.5s and 4.75s.
        // They overlap on [3.9, 4.0) and share no sample instant.
        let planned = plan_cues(vec![cue("a", 0.0, 4.0), cue("b", 3.9, 5.0)], 30.0);

        assert_eq!(layers_of(&planned, 30.0), vec![vec![0, 1]]);
    }

    /// Feature: caption extent measurement
    /// Scenario: a sub-frame cue has nothing to probe
    #[test]
    fn a_sub_frame_cue_is_planned_with_no_frames_at_all() {
        let planned = plan_cues(vec![cue("a", 0.98, 1.0)], 30.0);

        assert!(planned[0].frames.is_empty());
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue the script rounds onto a neighbour's probe frame
    /// conflicts with it
    ///
    /// The whole partition rests on "no other event is drawn here", and the
    /// script decides that on a hundredth-of-a-second grid the timeline knows
    /// nothing about. A cue whose exact bounds are `[2.004, 2.03)` is written
    /// `0:00:02.00,0:00:02.03`, and measured against the real binary that line
    /// draws on exactly one frame of a 30fps render: frame 60, at `t=2.000` -
    /// four milliseconds *before* the cue's own exact start.
    ///
    /// Asked on the exact times, both halves of that were wrong at once. The
    /// spanning cue probed frame 60 with nobody apparently live there, so it
    /// would share a layer with the short one and be handed a rectangle
    /// containing both captions; and the short cue's own frame span came out
    /// empty, so it was filed as a cue no frame shows while libass was drawing
    /// it.
    ///
    /// Note which direction carries the answer: the short cue is live on the
    /// spanning cue's frame 60, but the spanning cue is live on the short one's
    /// frame 60 as well - and a fixture where only one direction fires is what
    /// [`PlannedCue::conflicts_with`] asks both for.
    #[test]
    fn a_cue_the_script_rounds_onto_a_neighbours_probe_frame_conflicts_with_it() {
        let short = cue("short", 2.004, 2.03);

        assert!(
            short.timeline_in_sec > 60.0 / 30.0,
            "the fixture only proves anything if the exact start is past the probe instant"
        );
        assert_eq!(
            short.probe_frames(30.0),
            vec![60],
            "the frame the binary was measured drawing this line on"
        );

        // Probes 1.5s, 2.0s and 2.5s: frames 45, 60 and 90.
        let planned = plan_cues(vec![cue("spanning", 1.0, 3.0), short], 30.0);

        assert_eq!(layers_of(&planned, 30.0), vec![vec![0], vec![1]]);
    }

    /// Feature: caption extent measurement
    /// Scenario: a conflict is a conflict in either direction
    ///
    /// A long cue can be drawn across a short one's every probe frame while the
    /// short one is live on none of the long one's - so asking the question once
    /// answers it for half the pairs and silently measures the union for the
    /// other half. Here the short cue sits between the spanning cue's 25% and
    /// 50% samples, so nothing of it is on frames 45, 60 or 90.
    #[test]
    fn a_conflict_only_one_cue_can_see_still_splits_the_layer() {
        let spanning = cue("spanning", 1.0, 3.0);
        let short = cue("short", 1.6, 1.7);
        assert_eq!(spanning.probe_frames(30.0), vec![45, 60, 75]);
        assert_eq!(short.probe_frames(30.0), vec![49, 50]);
        assert!(
            spanning
                .probe_frames(30.0)
                .iter()
                .all(|frame| !short.is_live_at(*frame as f64 / 30.0)),
            "the spanning cue's own samples never see the short one"
        );

        let planned = plan_cues(vec![spanning, short], 30.0);

        assert_eq!(
            layers_of(&planned, 30.0),
            vec![vec![0], vec![1]],
            "the short cue's samples all carry the spanning cue's ink"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: three simultaneous cues need three layers
    ///
    /// Greedy colouring, in the shape the cap is about: every cue conflicts with
    /// every other, so no two can share a run.
    #[test]
    fn simultaneous_cues_each_take_their_own_layer() {
        let planned = plan_cues(
            vec![cue("a", 0.0, 4.0), cue("b", 0.0, 4.0), cue("c", 0.0, 4.0)],
            30.0,
        );

        assert_eq!(layers_of(&planned, 30.0), vec![vec![0], vec![1], vec![2]]);
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

    /// The script's own event list, turned into cues exactly as the pass does.
    fn cues_from_script(sequence: &Sequence, window_start_sec: f64) -> Vec<CaptionCue> {
        let script = build_ass_text_overlay_script_in_window_with_emoji(
            sequence,
            &HashMap::new(),
            window_start_sec,
            None,
        )
        .expect("the script builds");

        let Some(script) = script else {
            return Vec::new();
        };

        cues_for_events(sequence, window_start_sec, &script.event_clip_ids)
            .expect("every event names a clip of this sequence")
    }

    /// Feature: caption extent measurement
    /// Scenario: the Nth cue is the clip that drew the Nth `Dialogue` line
    ///
    /// The load-bearing identity claim, and the reason the builder reports its
    /// event list at all. A count-only check passed happily while the mapping
    /// was off by one; this pins *which* clip each event belongs to, over a
    /// sequence whose clips are deliberately not all accepted: a blank label and
    /// a disabled clip draw nothing, a text overlay on a video track draws
    /// through the same script, and the caption track is emitted after it.
    #[test]
    fn each_event_is_matched_to_the_clip_that_drew_it() {
        use crate::core::effects::{EffectType, ParamValue};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video = Track::new_video("Video");
        let mut title = Clip::new(&format!(
            "{}title",
            crate::core::commands::TEXT_ASSET_PREFIX
        ))
        .with_source_range(0.0, 2.0)
        .place_at(0.0);
        title.id = "clip-title".to_string();
        title.effects.push("text-effect".to_string());
        video.add_clip(title);
        sequence.add_track(video);

        let mut title_effect = Effect::with_id("text-effect", EffectType::TextOverlay);
        title_effect.set_param("text", ParamValue::String("A title card".to_string()));
        let effects: HashMap<String, Effect> =
            HashMap::from([("text-effect".to_string(), title_effect)]);

        let mut captions = Track::new_caption("Captions");
        for (id, label, start, enabled) in [
            ("clip-blank", "   ", 2.0, true),
            ("clip-first", "First cue", 4.0, true),
            ("clip-hidden", "Hidden cue", 6.0, false),
            ("clip-second", "Second cue", 8.0, true),
        ] {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(start);
            clip.id = id.to_string();
            clip.label = Some(label.to_string());
            clip.caption_style = Some(caption_style(64.0));
            clip.enabled = enabled;
            captions.add_clip(clip);
        }
        sequence.add_track(captions);

        let script =
            build_ass_text_overlay_script_in_window_with_emoji(&sequence, &effects, 0.0, None)
                .expect("the script builds")
                .expect("the script has events");

        let dialogue_lines: Vec<&str> = script
            .script
            .lines()
            .filter(|line| line.starts_with("Dialogue:"))
            .collect();

        assert_eq!(
            script.event_clip_ids,
            vec!["clip-title", "clip-first", "clip-second"],
            "the blank label and the disabled clip draw nothing"
        );
        assert_eq!(script.event_clip_ids.len(), dialogue_lines.len());

        // The Nth event is styled `OpenReelioText<n>`, so the position the id
        // list records really is the position the script writes.
        for (index, line) in dialogue_lines.iter().enumerate() {
            assert!(
                line.contains(&format!("OpenReelioText{index}")),
                "event {index} is not the {index}th style: {line}"
            );
        }

        let cues = cues_for_events(&sequence, 0.0, &script.event_clip_ids).expect("cues resolve");
        let identified: Vec<(&str, f64)> = cues
            .iter()
            .map(|cue| (cue.clip_id.as_str(), cue.timeline_in_sec))
            .collect();
        assert_eq!(
            identified,
            vec![
                ("clip-title", 0.0),
                ("clip-first", 4.0),
                ("clip-second", 8.0)
            ],
            "each cue carries the timing of the clip its event came from"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: an id the sequence cannot resolve measures nothing at all
    ///
    /// Unreachable from a builder fed this same sequence, and the one failure
    /// mode that would report a caption's rectangle under another caption's
    /// name - so it refuses rather than guesses.
    #[test]
    fn an_event_naming_an_unknown_clip_refuses_the_whole_pass() {
        let sequence = sequence_with_captions(&[("First cue", 0.0, 2.0)]);

        assert!(cues_for_events(&sequence, 0.0, &["clip-that-is-not-here".to_string()]).is_none());
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

        let cues = cues_from_script(&sequence, 0.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 2.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a disabled clip draws nothing and is not enumerated
    #[test]
    fn a_disabled_caption_is_not_enumerated() {
        let mut sequence = sequence_with_captions(&[("Hidden", 0.0, 2.0), ("Shown", 2.0, 4.0)]);
        sequence.tracks[0].clips[0].enabled = false;

        let cues = cues_from_script(&sequence, 0.0);

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

        let cues = cues_from_script(&sequence, 10.0);

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].timeline_in_sec, 8.0);
        assert_eq!(cues[0].timeline_end_sec, 14.0);
        assert_eq!(cues[0].drawn_start_sec, 0.0, "floored at the window");
        assert_eq!(cues[0].drawn_end_sec, 4.0);
    }

    /// Feature: caption extent measurement
    /// Scenario: a cue entirely in front of the window is dropped
    #[test]
    fn a_cue_that_ended_before_the_window_opened_is_not_enumerated() {
        let sequence = sequence_with_captions(&[("Gone", 0.0, 2.0), ("Here", 10.0, 12.0)]);

        let cues = cues_from_script(&sequence, 10.0);

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
    /// - `min_val=0`. The filter keeps pixels *strictly greater* than
    ///   `min_val`, so 0 is "any alpha at all" and still excludes the
    ///   transparent canvas; anything higher drops the anti-aliased fringe.
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let args = build_probe_args(
            &request,
            &[(0, 30, 1.0), (0, 60, 2.0), (0, 90, 3.0)],
            30.0,
            &probe_graph(Path::new("script.ass"), "", ""),
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
             alphaextract,bbox=min_val=0,metadata=mode=print:file=-"
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let args = build_probe_args(
            &request,
            &[(0, 30, 1.0)],
            30.0,
            &probe_graph(
                Path::new("script.ass"),
                ":fontsdir='/usr/share/fonts'",
                super::super::export::SUBTITLES_WRAP_UNICODE_OPTION,
            ),
        );
        let filter = args
            .iter()
            .position(|arg| arg == "-vf")
            .expect("a filter chain");

        assert_eq!(
            args[filter + 1],
            "select='eq(n\\,30)',subtitles=filename='script.ass':alpha=1:\
             fontsdir='/usr/share/fonts':wrap_unicode=1,alphaextract,bbox=min_val=0,\
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let args = build_probe_args(
            &request,
            &[(0, 25, 1.0)],
            25.0,
            &probe_graph(Path::new("s.ass"), "", ""),
        );
        let input = args.iter().position(|arg| arg == "-i").expect("an input");

        assert!(
            args[input + 1].contains("s=1080x1920"),
            "{}",
            args[input + 1]
        );
        assert!(args[input + 1].contains(":r=25:"), "{}", args[input + 1]);
    }

    // =========================================================================
    // The budget the two passes share
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: each pass takes only what the passes before it left
    ///
    /// Every layer's full-ink run, then every layer's glyph run, under one
    /// budget spent in order rather than split: the full-ink boxes are what
    /// every consumer of this module reads, and the glyph box refines exactly
    /// one verdict. When what is left is less than an FFmpeg spawn costs, the
    /// next pass is not started at all — writing a script and spawning a process
    /// only to time out would spend the run's last moments proving it had none
    /// left.
    #[test]
    fn each_pass_takes_only_what_the_passes_before_it_left() {
        assert_eq!(
            remaining_pass_budget(Duration::from_secs(30), Duration::from_secs(2)),
            Some(Duration::from_secs(28)),
            "whatever the earlier passes did not spend"
        );
        assert_eq!(
            remaining_pass_budget(Duration::from_secs(30), Duration::from_millis(29_900)),
            None,
            "100ms cannot spawn FFmpeg, so the pass is skipped rather than started"
        );
        assert_eq!(
            remaining_pass_budget(Duration::from_secs(30), Duration::from_secs(45)),
            None,
            "a pass that overran leaves nothing, and must not underflow"
        );
        assert_eq!(
            remaining_pass_budget(Duration::from_secs(30), Duration::from_secs(30))
                .or(Some(Duration::ZERO)),
            Some(Duration::ZERO),
            "an exactly spent budget is a skip, not a zero-second timeout"
        );
    }

    // =========================================================================
    // The glyph-only script
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: the glyph-only script zeroes the decoration the burn-in wrote
    ///
    /// Appended to the *end* of the block, which is the whole mechanism: within
    /// one override block the last spelling of a tag wins, so tags written
    /// before the burn-in's own `\bord6.00` would simply be overwritten and the
    /// "glyph-only" render would be the full-ink one measured twice.
    #[test]
    fn the_glyph_only_script_zeroes_the_decoration_the_burn_in_wrote() {
        let script = "[Events]\n\
                      Dialogue: 0,0:00:01.00,0:00:03.00,S,,60,60,60,,\
                      {\\an2\\bord6.00\\xshad3\\yshad3\\blur2}Hello\n";

        let glyph = glyph_only_script(script, &std::collections::HashSet::new());
        let event = glyph
            .lines()
            .find(|line| line.starts_with("Dialogue:"))
            .expect("the event survives");

        assert!(
            event.ends_with(&format!("{GLYPH_ONLY_OVERRIDE_TAGS}}}Hello")),
            "the zeroing tags have to be the last thing in the block: {event}"
        );
        assert!(
            event.contains("\\bord6.00"),
            "the burn-in's own tags stay, so only the winner changed: {event}"
        );
        assert!(
            event.contains("0:00:01.00,0:00:03.00"),
            "the timing is untouched, or the two passes measure different frames: {event}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: every override block of an event is zeroed, not only the first
    ///
    /// The burn-in opens a fresh block per font run and per emoji spacer. A
    /// later one carrying a border would put the decoration back for the rest of
    /// the line, and the box would be neither the full ink nor the glyphs.
    #[test]
    fn every_override_block_of_an_event_is_zeroed() {
        let script = "[Events]\n\
                      Dialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,\
                      {\\an2\\bord6.00}Hello {\\fnNoto Sans}world\n";

        let glyph = glyph_only_script(script, &std::collections::HashSet::new());

        assert_eq!(
            glyph.matches(GLYPH_ONLY_OVERRIDE_TAGS).count(),
            2,
            "both blocks carry the zeroing: {glyph}"
        );
        assert!(glyph.contains(&format!("{{\\fnNoto Sans{GLYPH_ONLY_OVERRIDE_TAGS}}}world")));
    }

    /// Feature: caption extent measurement
    /// Scenario: an event with no override block still loses its decoration
    ///
    /// Its style's `Outline` and `Shadow` are answered by the forced style, but
    /// only if a block exists to lose to nothing; giving the event one costs
    /// nothing and makes the two mechanisms agree.
    #[test]
    fn an_event_with_no_override_block_is_given_one() {
        let script = "[Events]\nDialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,Plain text\n";

        assert!(
            glyph_only_script(script, &std::collections::HashSet::new()).contains(&format!(
                "0,0:00:00.00,0:00:02.00,S,,0,0,0,,{{{GLYPH_ONLY_OVERRIDE_TAGS}}}Plain text"
            ))
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: everything that is not an event is copied byte for byte
    ///
    /// The `[Script Info]` header carries `PlayResX`, `WrapStyle` and
    /// `ScaledBorderAndShadow`, and the `[Fonts]` section carries the embedded
    /// faces. Touching any of them would measure a different layout rather than
    /// the same one with less ink on it.
    #[test]
    fn only_the_events_of_the_script_are_rewritten() {
        let script = "[Script Info]\nPlayResX: 1920\nPlayResY: 1080\n\n\
                      [V4+ Styles]\nStyle: S,Arial,60.00,&H00FFFFFF,&H00FFFFFF,&H00000000,\
                      &H00000000,0,0,0,0,100.00,100.00,0,0,1,2.00,0.00,2,60,60,60,1\n\n\
                      [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, \
                      MarginV, Effect, Text\n\
                      Dialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,{\\an2}Hi\n";

        let glyph = glyph_only_script(script, &std::collections::HashSet::new());

        for line in script.lines().filter(|line| !line.starts_with("Dialogue:")) {
            assert!(
                glyph.contains(line),
                "a non-event line was rewritten: {line}"
            );
        }
        assert_eq!(
            glyph.lines().count(),
            script.lines().count(),
            "no line was added or dropped"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a `Dialogue` line with no text field is left alone
    ///
    /// Appending tags at a guessed offset would corrupt an event that still has
    /// to draw; a malformed line is libass's problem to report, not this
    /// module's to rewrite.
    #[test]
    fn a_dialogue_line_with_no_text_field_is_copied_through() {
        let script = "[Events]\nDialogue: 0,0:00:00.00,0:00:02.00,S\n";

        assert_eq!(
            glyph_only_script(script, &std::collections::HashSet::new()),
            script
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: the glyph-only probe overrides no style field
    ///
    /// The decoration is hidden inline, per event, by
    /// [`GLYPH_ONLY_OVERRIDE_TAGS`]. A `force_style` option would reach the
    /// alpha-hidden neighbours too, and a neighbour rendered smaller is a
    /// measured cue libass packs lower - the geometry shift this pass exists to
    /// avoid. Asserted on the graph so a "belt and braces" option cannot come
    /// back without this failing.
    #[test]
    fn the_glyph_probe_graph_overrides_no_style_field() {
        let sequence = sequence_with_captions(&[("Hello", 0.0, 4.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let args = build_probe_args(
            &request,
            &[(0, 30, 1.0)],
            30.0,
            &probe_graph(Path::new("glyph.ass"), "", ""),
        );
        let filter = args
            .iter()
            .position(|arg| arg == "-vf")
            .expect("a filter chain");

        assert_eq!(
            args[filter + 1],
            "select='eq(n\\,30)',subtitles=filename='glyph.ass':alpha=1,alphaextract,\
             bbox=min_val=0,metadata=mode=print:file=-"
        );
    }

    // =========================================================================
    // Font substitution
    // =========================================================================

    /// Feature: caption extent measurement
    /// Scenario: libass's fallback choices are read off a verbose run
    ///
    /// The lines are real output from this binary for a script naming a family
    /// that is installed nowhere. The filter has to keep both shapes - the
    /// family that answered, and the codepoint that forced a fallback - and drop
    /// the heap address in the prefix, which would otherwise make two runs of
    /// the same project produce different report text.
    #[test]
    fn a_verbose_runs_font_substitutions_are_read_back_without_their_addresses() {
        let stderr = "[Parsed_subtitles_1 @ 0000020e23590380] Initialized\n\
                      [Parsed_subtitles_1 @ 0000020e23590380] fontselect: (NoSuchFamily, 400, 0) \
                      -> ArialMT, 0, ArialMT\n\
                      [Parsed_subtitles_1 @ 0000020e23590380] Glyph 0x12000 not found, selecting \
                      one more font for (NoSuchFamily, 400, 0)\n\
                      [Parsed_subtitles_1 @ 0000020e23590380] Event: [Script Info]\n\
                      PlayResX: 1920\n";

        let notes = parse_font_substitutions(stderr);

        assert_eq!(
            notes,
            vec![
                "fontselect: (NoSuchFamily, 400, 0) -> ArialMT, 0, ArialMT".to_string(),
                "Glyph 0x12000 not found, selecting one more font for (NoSuchFamily, 400, 0)"
                    .to_string(),
            ],
            "the echoed script and the address prefix are not diagnostics"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a run laid out entirely by embedded faces says nothing
    #[test]
    fn a_quiet_run_reports_no_substitutions() {
        assert!(parse_font_substitutions("frame:0 pts_time:1\n").is_empty());
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
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
    /// Scenario: a cue containing a colour emoji is refused, not measured short
    ///
    /// The probe has to build the script the burn-in builds, emoji pack and all,
    /// or the advances and the line breaks belong to a caption the export never
    /// draws. Doing that puts an ink-free spacer where the emoji is and leaves
    /// the colour picture outside the alpha, so the cue's own box comes back
    /// narrower than what a viewer sees - narrower in the direction that turns a
    /// real overflow into a pass. So it is refused.
    ///
    /// That the emoji cue is named here at all is itself the proof the probe
    /// built the script with the pack: an occurrence only exists when a cluster
    /// was given a cell.
    #[tokio::test]
    async fn a_cue_carrying_a_colour_emoji_is_recorded_as_uncovered() {
        if crate::core::text::emoji_assets::discover().is_none() {
            eprintln!("Skipping test: no colour emoji pack is installed");
            return;
        }

        let mut sequence =
            sequence_with_captions(&[("Plain cue", 0.0, 2.0), ("Fire \u{1F525}", 2.0, 4.0)]);
        sequence.tracks[0].clips[0].id = "clip-plain".to_string();
        sequence.tracks[0].clips[1].id = "clip-emoji".to_string();

        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("an emoji is not an error");

        assert_eq!(
            measurement.coverage.emoji_cue_ids,
            vec!["clip-emoji".to_string()],
            "the emoji cue is named as uncovered: {:?}",
            measurement.coverage
        );
        assert!(
            measurement
                .coverage
                .notes
                .iter()
                .any(|note| note.contains("colour emoji")),
            "the report has to say why: {:?}",
            measurement.coverage.notes
        );
        // The plain cue was the only one the probe was asked to run for, which
        // is what makes the emoji cue's exclusion a refusal rather than a
        // failure shared by both.
        assert!(
            !measurement
                .coverage
                .shared_frame_cue_ids
                .contains(&"clip-emoji".to_string()),
            "an emoji cue is refused for its own reason, not filed under overlap"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a layout that fell through to the host's fonts says so
    ///
    /// A measured box is a statement about glyph metrics, so a run that libass
    /// drew with a face off this machine rather than one the script embeds is
    /// only as reproducible as the machine. Without the flag, a CI report and a
    /// developer's report disagreeing about a caption's width reads as a
    /// regression in the project rather than as two different font sets.
    #[tokio::test]
    async fn a_layout_drawn_with_host_fonts_is_marked_machine_specific() {
        // Hangul: no bundled face covers it, so libass consults the host's font
        // provider and `fontsdir` goes onto the graph.
        let sequence = sequence_with_captions(&[("한글 자막", 0.0, 2.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("host fonts are not an error");

        assert!(
            measurement.coverage.uses_host_fonts,
            "a Hangul caption is drawn by a face off this machine: {:?}",
            measurement.coverage
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: overlapping cues are probed rather than refused
    ///
    /// The behaviour change this module was rewritten for. Two cues live at the
    /// same instant used to be named in `shared_frame_cue_ids` and handed to the
    /// caller's predictor without a single FFmpeg run being attempted; now each
    /// takes a layer of its own and both are probed. The engine here cannot
    /// spawn, so what comes back is a *failure* - which is exactly the point:
    /// the pass tried.
    #[tokio::test]
    async fn overlapping_cues_are_probed_in_separate_layers() {
        let sequence = sequence_with_captions(&[("Under", 0.0, 4.0), ("Over", 1.0, 3.0)]);
        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("overlap is not an error");

        assert!(
            measurement.coverage.shared_frame_cue_ids.is_empty(),
            "two events on one frame is a second layer now, not a refusal: {:?}",
            measurement.coverage
        );
        assert!(
            measurement.coverage.probe_failed,
            "both cues were handed to a binary that cannot run: {:?}",
            measurement.coverage
        );
        assert!(measurement.extents.is_empty());
    }

    /// Feature: caption extent measurement
    /// Scenario: a project with more simultaneous events than the cap is
    /// partly refused rather than given unbounded processes
    ///
    /// Every layer is at least one FFmpeg spawn. A motion graphic built from a
    /// dozen text clips that all animate together needs one layer each, and a QC
    /// pass must not answer that by starting a dozen processes. The layers up to
    /// the cap are measured; the rest are named in the coverage and graded by
    /// the caller's predictor, exactly as any other uncovered cue is.
    #[tokio::test]
    async fn simultaneous_events_past_the_layer_cap_are_recorded_as_uncovered() {
        let overlapping: Vec<(&str, f64, f64)> = (0..MAX_MEASURED_LAYERS + 3)
            .map(|_| ("All at once", 0.0, 4.0))
            .collect();
        let mut sequence = sequence_with_captions(&overlapping);
        for (index, clip) in sequence.tracks[0].clips.iter_mut().enumerate() {
            clip.id = format!("clip-{index}");
        }

        let request = CaptionExtentRequest {
            sequence: &sequence,
            effects: &HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: false,
            probe_budget: Duration::from_secs(30),
        };

        let measurement = measure_caption_extents(&engine_that_cannot_run(), &request)
            .await
            .expect("a crowded frame is not an error");

        assert_eq!(
            measurement.coverage.shared_frame_cue_ids,
            vec![
                "clip-8".to_string(),
                "clip-9".to_string(),
                "clip-10".to_string()
            ],
            "the overflow past the cap is named, in event order: {:?}",
            measurement.coverage
        );
        assert!(
            measurement
                .coverage
                .notes
                .iter()
                .any(|note| note.contains("isolate")),
            "and the report says why: {:?}",
            measurement.coverage.notes
        );
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
    ///
    /// One helper for both passes, because the passes differ only by the script
    /// they are handed: a test that measured the glyph box through a different
    /// graph would not be measuring what this module runs.
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
            needs_glyph_box: true,
            probe_budget: Duration::from_secs(30),
        };
        let args = build_probe_args(
            &request,
            &[(0, frame, frame as f64 / fps)],
            fps,
            &probe_graph(&path, &fonts, wrap),
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
        fixture_script_with_margin(tags, text, 60)
    }

    /// The same, with the vertical margin under the caller's control.
    ///
    /// `0` is the margin a `marginPercent: 0` preset resolves to, and the case
    /// this module used to report as an overflow.
    fn fixture_script_with_margin(tags: &str, text: &str, margin_v: u32) -> String {
        fixture_script_with_events(&[(tags, text)], margin_v)
    }

    /// The same shape, with one `Dialogue` line per `(tags, text)` pair.
    ///
    /// Every event runs over the same span, which is what a fixture about two
    /// captions on one frame needs.
    fn fixture_script_with_events(events: &[(&str, &str)], margin_v: u32) -> String {
        let lines: String = events
            .iter()
            .map(|(tags, text)| {
                format!("Dialogue: 0,0:00:00.00,0:00:04.00,T,,60,60,{margin_v},,{{{tags}}}{text}\n")
            })
            .collect();

        format!(
            "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\
             PlayResX: 1920\nPlayResY: 1080\n\n\
             [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
             OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, \
             Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, \
             Encoding\n\
             Style: T,Arial,60.00,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100.00,\
             100.00,0,0,1,2.00,0.00,2,60,60,{margin_v},1\n\n\
             [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, \
             Text\n\
             {lines}"
        )
    }

    /// The same shape, with the style's `BorderStyle` column set to `3` - the
    /// opaque background box - and a 10px box with a 3px drop shadow.
    ///
    /// The box is ink no `\bord` of the *events* put there, which is exactly why
    /// it is the case the alpha method has to answer for: it is painted in the
    /// outline colour and its shadow in the back colour, so `\3a`/`\4a` hide it
    /// without changing the size of a single bitmap.
    fn fixture_script_boxed(events: &[(&str, &str)], margin_v: u32) -> String {
        fixture_script_with_events(events, margin_v)
            .replace(",0,0,1,2.00,0.00,2,", ",0,0,3,10.00,3.00,2,")
    }

    /// Feature: caption extent measurement
    /// Scenario: an isolated cue is measured where collision avoidance put it
    ///
    /// The claim the whole isolation design rests on, asked of the renderer.
    /// libass moves overlapping events apart so they do not draw on top of each
    /// other, and it decides that from the bitmaps it rendered - so an event
    /// hidden by [`ASS_HIDE_INK_TAGS`](super::export::ASS_HIDE_INK_TAGS), which
    /// still renders its bitmaps, is still avoided. Measured on this binary at
    /// 1920x1080: the pair inks `903..1021`, the second cue alone in its own
    /// script inks `967..1021`, and the second cue with the first *hidden* inks
    /// `903..957` - the shifted position, which is the one that burns in.
    ///
    /// The alternative implementation - dropping the other `Dialogue` lines -
    /// would measure the `967..1021` row and report that caption 5.9% of the
    /// canvas below where the viewer sees it. If a future libass stops
    /// accounting for transparent events, this fails rather than quietly
    /// shifting every stacked caption's verdict.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn an_isolated_cue_is_measured_where_collision_avoidance_put_it() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let hide = crate::core::render::export::ASS_HIDE_INK_TAGS;
        let first = ("\\an2", "First caption line");
        let second = ("\\an2", "Second caption line");

        let both = probe_script(
            &ffmpeg,
            &fixture_script_with_events(&[first, second], 60),
            30,
            30.0,
        )
        .expect("two captions draw ink");
        let isolated = probe_script(
            &ffmpeg,
            &fixture_script_with_events(&[(&format!("\\an2{hide}"), first.1), second], 60),
            30,
            30.0,
        )
        .expect("the visible caption draws ink");
        let alone = probe_script(
            &ffmpeg,
            &fixture_script_with_events(&[second], 60),
            30,
            30.0,
        )
        .expect("one caption draws ink");

        assert!(
            both.y1 < alone.y1,
            "the fixture only means anything if libass really stacked the two: {both:?} against \
             {alone:?}"
        );
        assert!(
            isolated.y1 == both.y1 && isolated.y2 < alone.y1,
            "isolating by alpha has to leave the cue where the full render draws it - the top half \
             of the pair's union - not where it would sit with nobody to avoid: {isolated:?}, pair \
             {both:?}, alone {alone:?}"
        );
        assert!(
            isolated.x1 == alone.x1 && isolated.x2 == alone.x2,
            "and the horizontal extent is the cue's own either way: {isolated:?} against {alone:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a collided cue's glyph box is measured where the cue burns in
    ///
    /// The load-bearing property of [`GLYPH_ONLY_OVERRIDE_TAGS`], and the one
    /// the geometry-zeroing tag set this module used to write got wrong.
    ///
    /// libass packs colliding events apart by the *bitmaps it rendered*. Take a
    /// cue's outline or background box away by shrinking it - `\bord0\shad0`, or
    /// a `force_style` - and libass lets that cue sit lower in the stack than
    /// the render does, so the glyph pass reports a caption below where a viewer
    /// sees it. Hiding the same decoration with `\3a&HFF&\4a&HFF&` changes no
    /// bitmap's extent, so the packing, and the measured position, is the
    /// burn-in's.
    ///
    /// The control is the same fixture with those alpha tags written straight
    /// into the visible event and its geometry untouched - which is, by
    /// construction, the cue's true glyph extent where it really renders. The
    /// assertion is *equality* with that control, not containment inside the
    /// full ink: containment is exactly what the old tag set went on satisfying
    /// while reading six and ten pixels low.
    ///
    /// Measured on this binary at 1920x1080, second of a colliding pair with the
    /// first alpha-hidden:
    ///
    /// | style | full ink | `\bord0...` | alpha (and control) |
    /// |---|---|---|---|
    /// | `\bord6` | `891..953` | `903..953` | `897..947` |
    /// | `BorderStyle: 3` box | `869..950` | `899..949` | `889..939` |
    ///
    /// Note how nearly the boxed case broke the glyph-inside-ink invariant
    /// outright: `949` against `950`.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_collided_cues_glyph_box_is_measured_where_the_cue_burns_in() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        // The tag set this module wrote before the fix, kept here so the defect
        // it caused is asserted rather than remembered.
        const GEOMETRY_TAGS: &str = r"\bord0\shad0\xshad0\yshad0\blur0\be0";

        let hide = crate::core::render::export::ASS_HIDE_INK_TAGS;
        let hidden: std::collections::HashSet<usize> = [0usize].into_iter().collect();

        for (label, tags, build) in [
            (
                "BorderStyle: 1 with a 6px outline",
                r"\bord6",
                fixture_script_with_events as fn(&[(&str, &str)], u32) -> String,
            ),
            ("BorderStyle: 3 opaque box", "", fixture_script_boxed),
            (
                "a blurred outline",
                r"\bord4\blur3",
                fixture_script_with_events,
            ),
        ] {
            let first = format!("\\an2{hide}{tags}");
            let second = format!("\\an2{tags}");
            let isolated = build(
                &[
                    (&first, "First caption line"),
                    (&second, "Second caption line"),
                ],
                60,
            );
            // Geometry untouched, the visible cue's outline and shadow simply
            // not painted. Where the cue's letterforms really are.
            let control_second = format!("{second}{GLYPH_ONLY_OVERRIDE_TAGS}");
            let control_script = build(
                &[
                    (&first, "First caption line"),
                    (&control_second, "Second caption line"),
                ],
                60,
            );
            // The same fixture with the decoration taken away by shrinking it.
            let geometry_second = format!("{second}{GEOMETRY_TAGS}");
            let geometry_script = build(
                &[
                    (&first, "First caption line"),
                    (&geometry_second, "Second caption line"),
                ],
                60,
            );

            let full_ink = probe_script(&ffmpeg, &isolated, 30, 30.0)
                .unwrap_or_else(|| panic!("{label}: the visible caption draws ink"));
            let glyph = probe_script(&ffmpeg, &glyph_only_script(&isolated, &hidden), 30, 30.0)
                .unwrap_or_else(|| panic!("{label}: the glyphs draw ink"));
            let control = probe_script(&ffmpeg, &control_script, 30, 30.0)
                .unwrap_or_else(|| panic!("{label}: the control's glyphs draw ink"));
            let geometry = probe_script(&ffmpeg, &geometry_script, 30, 30.0)
                .unwrap_or_else(|| panic!("{label}: the shrunken cue draws ink"));

            assert_eq!(
                glyph, control,
                "{label}: the glyph pass has to measure the cue exactly where hiding its \
                 decoration by alpha leaves it - equality, because the wrong method is also \
                 inside the ink: {glyph:?} against {control:?}"
            );
            assert!(
                glyph.x1 > full_ink.x1
                    && glyph.x2 < full_ink.x2
                    && glyph.y1 > full_ink.y1
                    && glyph.y2 < full_ink.y2,
                "{label}: and it still has to sit strictly inside the ink drawn around it: \
                 {glyph:?} against {full_ink:?}"
            );
            assert!(
                geometry.y1 > glyph.y1 && geometry.y2 > glyph.y2,
                "{label}: the fixture only means anything if taking the decoration away by \
                 geometry really does drop the cue down the collision stack: {geometry:?} \
                 against {glyph:?}"
            );
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: the glyph pass rewrites no event it is not measuring
    ///
    /// With [`GLYPH_ONLY_OVERRIDE_TAGS`] as it stands this changes no pixel - a
    /// hidden event is already fully transparent, so hiding it again is
    /// idempotent - and that is the assertion: the two scripts measure the same.
    /// The `hidden_events` boundary exists for the tag set that is *not*
    /// idempotent, and this pins that the current one is.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn the_glyph_pass_leaves_a_hidden_neighbours_decoration_alone() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let hide = crate::core::render::export::ASS_HIDE_INK_TAGS;
        let isolated = fixture_script_boxed(
            &[
                (&format!("\\an2{hide}\\bord6"), "First caption line"),
                ("\\an2\\bord6", "Second caption line"),
            ],
            60,
        );
        let hidden: std::collections::HashSet<usize> = [0usize].into_iter().collect();

        let skipped = probe_script(&ffmpeg, &glyph_only_script(&isolated, &hidden), 30, 30.0)
            .expect("the glyphs draw ink");
        let rewritten = probe_script(
            &ffmpeg,
            &glyph_only_script(&isolated, &std::collections::HashSet::new()),
            30,
            30.0,
        )
        .expect("the glyphs draw ink");

        assert_eq!(
            skipped, rewritten,
            "hiding an already-hidden neighbour a second time has to be a no-op; if it is not, \
             the tag set has started changing bitmap extents and the neighbours are no longer \
             where libass packed the measured cue against them: {skipped:?} against {rewritten:?}"
        );
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

        assert!(
            !flush_edges(measured, 1920, 1080).overflows_frame(),
            "{measured:?}"
        );

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
        assert!(
            !flush_edges(measured, 1920, 1080).overflows_frame(),
            "{measured:?}"
        );
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
            flush_edges(measured, 1920, 1080).overflows_frame(),
            "a 200-character unspaced run cannot fit in 1920px: {measured:?}"
        );
        let edges = flush_edges(measured, 1920, 1080);
        assert!(
            edges.left && edges.right,
            "the signature is an axis filled edge to edge, not a single edge: {edges:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a caption flush against the bottom of the frame is not cropped
    ///
    /// `marginPercent: 0` is a value the preset schema accepts, and a `\blur`
    /// or a `\shad` reaches an edge the glyphs do not. Both measure with the box
    /// touching the last row of the picture and neither loses a pixel. Flagging
    /// them made the measured path stricter than the estimate it replaced, on
    /// output nobody would call broken - so they have to come back with the
    /// overflow flag clear and be left to the ordinary edge comparison.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_margin_zero_caption_reaches_the_edge_without_being_cropped() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        for (name, script) in [
            (
                "a margin-0 bottom caption",
                fixture_script_with_margin(r"\an2", "Bottom flush caption", 0),
            ),
            (
                "the same caption with a blur and a wide border",
                fixture_script_with_margin(r"\an2\blur8\bord6", "Blurry bottom", 0),
            ),
        ] {
            let measured = probe_script(&ffmpeg, &script, 30, 30.0).expect("the caption draws ink");
            let edges = flush_edges(measured, 1920, 1080);

            assert!(
                edges.bottom,
                "{name} has to actually reach the frame edge, or this proves nothing: {measured:?}"
            );
            assert!(
                !edges.overflows_frame(),
                "{name} reaches the edge without being cropped: {measured:?} -> {edges:?}"
            );

            let percent = box_to_percent(measured, 1920, 1080).expect("a sized canvas");
            assert!(
                percent.left > 0.0 && percent.right < 100.0 && percent.bottom <= 100.0,
                "and its edges are the ones an edge comparison passes: {percent:?}"
            );
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: the drawn span of a cue is the one the script rounds it onto
    ///
    /// The measurement the centisecond reasoning rests on. A cue whose exact
    /// bounds are `[2.004, 2.03)` is written `0:00:02.00,0:00:02.03` and is
    /// drawn on exactly one frame of a 30fps render - frame 60, at `t=2.000`,
    /// which its exact start is four milliseconds past. If this ever stops being
    /// true, [`CaptionCue::is_live_at`] is classifying on the wrong clock again
    /// and solo cues are being measured with a neighbour's ink in the box.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_cue_is_drawn_on_the_frames_its_rounded_timecodes_cover() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        let script = fixture_script(r"\an2", "Rounded")
            .replace("0:00:00.00,0:00:04.00", "0:00:02.00,0:00:02.03");

        assert!(
            probe_script(&ffmpeg, &script, 59, 30.0).is_none(),
            "t=1.9667 is before the rounded start"
        );
        assert!(
            probe_script(&ffmpeg, &script, 60, 30.0).is_some(),
            "t=2.000 is the rounded start, and libass draws there"
        );
        assert!(
            probe_script(&ffmpeg, &script, 61, 30.0).is_none(),
            "t=2.0333 is past the rounded end"
        );

        // And the module agrees with the binary about which frame that is.
        assert_eq!(cue("a", 2.004, 2.03).probe_frames(30.0), vec![60]);
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
    /// Scenario: the glyph-only render is strictly smaller than the full ink
    ///
    /// The claim the whole two-tier design rests on, and one no unit test can
    /// make: a caption with no neighbour to collide with still measures a glyph
    /// box strictly inside its own ink, because `\3a`/`\4a` stop the outline and
    /// the shadow being painted.
    ///
    /// The `\blur2` in the fixture is deliberate. libass blurs the *border*
    /// bitmap when a border is drawn and leaves the fill crisp, so hiding the
    /// border by alpha measures the sharp letterforms - the same box zeroing the
    /// geometry would have reported, and one no `\blur0` of ours had to produce.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn the_glyph_only_render_is_strictly_inside_the_full_ink_render() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        // The decoration the burn-in writes inline, in the shape it writes it.
        let full = fixture_script(r"\an2\bord6.00\xshad3\yshad3\blur2", "Hello measured world");
        let glyph = glyph_only_script(&full, &std::collections::HashSet::new());

        let full_box = probe_script(&ffmpeg, &full, 30, 30.0).expect("the caption draws ink");
        let glyph_box = probe_script(&ffmpeg, &glyph, 30, 30.0).expect("the glyphs draw ink");

        assert!(
            glyph_box.x1 > full_box.x1
                && glyph_box.y1 > full_box.y1
                && glyph_box.x2 < full_box.x2
                && glyph_box.y2 < full_box.y2,
            "the glyph box has to sit strictly inside the full ink on every side: {glyph_box:?} \
             against {full_box:?}"
        );
    }

    /// Feature: caption extent measurement
    /// Scenario: a background-box caption collapses to its glyphs too
    ///
    /// `BorderStyle: 3` paints an opaque rectangle in the `OutlineColour`
    /// column, and its drop shadow in the `BackColour` one - ink the glyphs do
    /// not have. `\3a&HFF&\4a&HFF&` reaches both, which is why the alpha method
    /// needs no separate answer for the box and no `force_style` for the
    /// `BorderStyle` column. Measured against this binary, a boxed caption inks
    /// `690..1232 x 949..1033` and its glyph-only twin inks
    /// `704..1215 x 970..1009` - the *identical* box the outlined caption's
    /// glyphs measure.
    ///
    /// The second half of this test is where the blur decision is pinned. A
    /// boxed caption has no glyph-hugging border bitmap for `\blur` to land on,
    /// so libass blurs the *fill*, and the alpha method reports the fill it
    /// finds: the same words at `\blur2` measure `700..1219 x 965..1013`, a few
    /// pixels wider on every side. That is deliberate, and the reason
    /// [`GLYPH_ONLY_OVERRIDE_TAGS`] carries no `\blur0`. Zeroing the blur would
    /// shrink the bitmap, and a shrunken bitmap is a cue libass packs somewhere
    /// else - the exact defect the alpha method exists to remove. The soft edge
    /// of a blurred letterform is part of that letterform, and measuring it
    /// errs toward a larger box, which is the safe direction for a safe-area
    /// verdict.
    #[test]
    #[ignore = "requires FFmpeg with libass"]
    fn a_background_box_caption_collapses_to_the_same_glyphs() {
        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };

        // `BorderStyle: 3` with a 10px box, in the columns the export writes.
        let boxed_style =
            |script: String| script.replace(",0,0,1,2.00,0.00,2,", ",0,0,3,10.00,3.00,2,");
        let glyphs_of = |script: &str| {
            probe_script(
                &ffmpeg,
                &glyph_only_script(script, &std::collections::HashSet::new()),
                30,
                30.0,
            )
            .expect("the glyphs draw ink")
        };

        let outlined = fixture_script(r"\an2\bord6.00\xshad3\yshad3", "Hello measured world");
        let boxed = boxed_style(fixture_script(
            r"\an2\bord10.00\xshad3\yshad3",
            "Hello measured world",
        ));
        let boxed_blurred = boxed_style(fixture_script(
            r"\an2\bord10.00\xshad3\yshad3\blur2",
            "Hello measured world",
        ));

        let boxed_ink = probe_script(&ffmpeg, &boxed, 30, 30.0).expect("a boxed caption draws ink");
        let boxed_glyphs = glyphs_of(&boxed);
        let outlined_glyphs = glyphs_of(&outlined);
        let blurred_glyphs = glyphs_of(&boxed_blurred);

        assert!(
            boxed_glyphs.x1 > boxed_ink.x1 && boxed_glyphs.y1 > boxed_ink.y1,
            "the box is ink the glyphs are not: {boxed_glyphs:?} against {boxed_ink:?}"
        );
        assert_eq!(
            boxed_glyphs, outlined_glyphs,
            "the same words in the same face measure the same glyph box whichever decoration was \
             hidden on them"
        );
        assert!(
            blurred_glyphs.x1 < boxed_glyphs.x1
                && blurred_glyphs.x2 > boxed_glyphs.x2
                && blurred_glyphs.y1 < boxed_glyphs.y1
                && blurred_glyphs.y2 > boxed_glyphs.y2,
            "a boxed caption's `\\blur` lands on the fill, and this pass measures the soft \
             letterform rather than shrinking the bitmap to sharpen it: {blurred_glyphs:?} \
             against {boxed_glyphs:?}"
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

    // =========================================================================
    // Whole passes, against a real libass
    // =========================================================================

    /// An engine pointed at the FFmpeg this machine has, or `None` to skip.
    fn real_engine() -> Option<ExportEngine> {
        let ffmpeg = crate::core::test_ffmpeg::require_or_skip_ffmpeg()?;
        Some(ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
            crate::core::ffmpeg::FFmpegInfo {
                ffprobe_path: ffmpeg.with_file_name(if cfg!(windows) {
                    "ffprobe.exe"
                } else {
                    "ffprobe"
                }),
                ffmpeg_path: ffmpeg,
                version: "test".to_string(),
                is_bundled: false,
                source: crate::core::ffmpeg::FFmpegSource::System,
            },
        )))
    }

    /// A top-anchored title running the whole timeline, over a caption track.
    ///
    /// The shape of nearly every finished video, and the one the solo/shared
    /// partition measured nothing at all for.
    fn sequence_with_a_title_over_captions() -> Sequence {
        let mut sequence = Sequence::new("Title", SequenceFormat::youtube_1080());

        let mut titles = Track::new_caption("Title");
        let mut title = Clip::new("caption-asset")
            .with_source_range(0.0, 6.0)
            .place_at(0.0);
        title.id = "clip-title".to_string();
        title.label = Some("A persistent title".to_string());
        title.caption_style = Some(caption_style(64.0));
        title.caption_position = Some(serde_json::json!({
            "type": "preset",
            "vertical": "top",
        }));
        titles.add_clip(title);
        sequence.add_track(titles);

        let mut captions = Track::new_caption("Captions");
        for (index, (text, start, end)) in [
            ("The first caption", 0.0, 2.0),
            ("The second caption", 2.0, 4.0),
            ("The third caption", 4.0, 6.0),
        ]
        .iter()
        .enumerate()
        {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, end - start)
                .place_at(*start);
            clip.id = format!("clip-{index}");
            clip.label = Some((*text).to_string());
            clip.caption_style = Some(caption_style(64.0));
            captions.add_clip(clip);
        }
        sequence.add_track(captions);

        sequence
    }

    fn request_for<'a>(
        sequence: &'a Sequence,
        effects: &'a HashMap<String, Effect>,
        probe_budget: Duration,
    ) -> CaptionExtentRequest<'a> {
        CaptionExtentRequest {
            sequence,
            effects,
            canvas_width: 1920,
            canvas_height: 1080,
            fps: 30.0,
            window_start_sec: 0.0,
            needs_glyph_box: true,
            probe_budget,
        }
    }

    /// The same request over the sequence's own canvas rather than 1920x1080.
    ///
    /// The probe renders at exactly the canvas it is told about, and the whole
    /// point of the vertical fixtures below is that the canvas decides how the
    /// script is scaled - so measuring a 1080x1920 sequence at 1920x1080 would
    /// measure a different caption.
    fn request_for_canvas<'a>(
        sequence: &'a Sequence,
        effects: &'a HashMap<String, Effect>,
        probe_budget: Duration,
    ) -> CaptionExtentRequest<'a> {
        CaptionExtentRequest {
            canvas_width: sequence.format.canvas.width,
            canvas_height: sequence.format.canvas.height,
            ..request_for(sequence, effects, probe_budget)
        }
    }

    /// A caption in the family the product actually ships and embeds.
    ///
    /// `caption_style` names `"Inter"`, which nothing here ships: libass
    /// substitutes whatever the host ranks first and the metrics - and therefore
    /// the pixel column a line is cut at - become a property of the machine. The
    /// fixtures that assert on a *cropped* box have to be laid out by the face
    /// the burn-in uses, so they name the bundled one and the script embeds it.
    fn bundled_caption_style(font_size: f64) -> serde_json::Value {
        serde_json::json!({
            "fontFamily": crate::core::text::bundled_fonts::DEFAULT_TEXT_FONT_FAMILY,
            "fontSize": font_size,
            "color": "#FFFFFF",
        })
    }

    /// One caption track, two cues: an over-long unspaced run, then a short one.
    fn sequence_with_an_overflowing_caption(format: SequenceFormat) -> Sequence {
        let mut sequence = Sequence::new("Overflow", format);
        let mut track = Track::new_caption("Captions");

        for (index, (label, start, end, margin_percent)) in [
            // Ninety-six `l`s: unbreakable, far wider than any of these frames,
            // and narrow enough that the frame boundary lands in a side bearing
            // rather than on ink - which is the case that used to pass.
            ("l".repeat(96), 0.0, 2.0, 10.0),
            ("A short caption".to_string(), 2.0, 4.0, 10.0),
            // `marginPercent: 0` draws against the last row of the picture. One
            // edge, nothing cropped, and it must stay out of the Error.
            ("Against the bottom".to_string(), 4.0, 6.0, 0.0),
        ]
        .into_iter()
        .enumerate()
        {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, end - start)
                .place_at(start);
            clip.id = format!("clip-{index}");
            clip.label = Some(label);
            clip.caption_style = Some(bundled_caption_style(48.0));
            clip.caption_position = Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": margin_percent,
            }));
            track.add_clip(clip);
        }

        sequence.add_track(track);
        sequence
    }

    /// Feature: measured caption bounds
    /// Scenario: a caption cropped on a vertical canvas is reported as clipped
    ///
    /// The regression test the direct-`MeasuredBox` unit tests could not be.
    /// Those construct a rectangle and ask what the helper makes of it, so an
    /// off-by-one between what libass *draws* and what the helper *expects* is
    /// invisible to them - and that is precisely what shipped: `flush_edges`
    /// wanted pixel `0` and pixel `width - 1` exactly, and on a 1080x1920
    /// sequence the cropped run inked `6..1073`. `caption.out_of_bounds` is an
    /// Error, so the worst caption in the project passed the one check that
    /// exists to fail it, while the estimate the measurement replaced reported
    /// it. The landscape canvases every other fixture here uses all happened to
    /// ink the boundary column, which is why nothing caught it.
    ///
    /// Both canvases the product offers vertically are covered, because the
    /// script is laid out at `PlayResY: 1080` and scaled to the frame: 1080x1920
    /// and 720x1280 share a 608-wide script and two different scale factors, and
    /// the gap is a property of the scale.
    ///
    /// The short caption on the same track, in the same run, is the control. If
    /// the tolerance ever grows into something that calls an ordinary caption
    /// cropped, this fails on that cue rather than silently over-reporting.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn a_caption_cropped_on_a_vertical_canvas_is_measured_as_clipped() {
        let Some(engine) = real_engine() else {
            return;
        };

        for format in [
            SequenceFormat::shorts_1080(),
            SequenceFormat::new(720, 1280, 30, 1, 48_000),
        ] {
            let canvas = format.canvas.clone();
            let sequence = sequence_with_an_overflowing_caption(format);
            let effects = HashMap::new();
            let measurement = measure_caption_extents(
                &engine,
                &request_for_canvas(&sequence, &effects, Duration::from_secs(60)),
            )
            .await
            .unwrap_or_else(|error| panic!("{canvas:?}: the pass runs: {error}"));

            assert!(
                !measurement.coverage.probe_failed,
                "{canvas:?}: a real binary completes the pass: {:?}",
                measurement.coverage
            );

            let extent_of = |clip_id: &str| {
                measurement
                    .extents
                    .iter()
                    .find(|extent| extent.clip_id == clip_id)
                    .unwrap_or_else(|| panic!("{canvas:?}: {clip_id} was measured"))
                    .clone()
            };

            let cropped = extent_of("clip-0");
            let inked = cropped
                .full_ink
                .unwrap_or_else(|| panic!("{canvas:?}: the long caption draws ink"));
            assert!(
                inked.width() > 95.0,
                "{canvas:?}: the fixture only means anything if the run really did fill the \
                 frame: {inked:?}"
            );
            assert!(
                cropped.clipped,
                "{canvas:?}: a caption libass cut off at both ends is clipped even when the \
                 outermost columns carry no ink: {inked:?}"
            );

            let ordinary = extent_of("clip-1");
            let inked = ordinary
                .full_ink
                .unwrap_or_else(|| panic!("{canvas:?}: the short caption draws ink"));
            assert!(
                !ordinary.clipped,
                "{canvas:?}: and a caption that fits is left alone: {inked:?}"
            );
            assert!(
                inked.left > 1.0 && inked.right < 99.0,
                "{canvas:?}: which is a claim about this box, not just about the flag: {inked:?}"
            );

            let against_the_bottom = extent_of("clip-2");
            let inked = against_the_bottom
                .full_ink
                .unwrap_or_else(|| panic!("{canvas:?}: the margin-0 caption draws ink"));
            assert!(
                inked.bottom > 99.0,
                "{canvas:?}: the fixture only means anything if the cue really does reach the \
                 last row: {inked:?}"
            );
            assert!(
                !against_the_bottom.clipped,
                "{canvas:?}: one saturated edge is an ordinary caption drawn against the frame, \
                 not a cropped one - widening the tolerance must not change that: {inked:?}"
            );
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: a caption under a persistent title is measured, and so is the
    /// title
    ///
    /// The end-to-end claim this change exists for. Every caption here shares
    /// every one of its frames with the title, so the previous partition
    /// declared all four cues unmeasurable and handed the lot to the caller's
    /// predictor. Two layers measure all four, each with a rectangle that is its
    /// own rather than the union - which is what the vertical assertion checks:
    /// the title's box is in the top of the frame and every caption's is in the
    /// bottom, so neither swallowed the other.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn a_caption_under_a_persistent_title_is_measured_and_so_is_the_title() {
        let Some(engine) = real_engine() else {
            return;
        };

        let sequence = sequence_with_a_title_over_captions();
        let effects = HashMap::new();
        let measurement = measure_caption_extents(
            &engine,
            &request_for(&sequence, &effects, Duration::from_secs(60)),
        )
        .await
        .expect("a title over captions is not an error");

        assert!(
            !measurement.coverage.probe_failed,
            "a real binary completes both layers: {:?}",
            measurement.coverage
        );
        assert!(
            measurement.coverage.shared_frame_cue_ids.is_empty(),
            "nothing is refused for sharing a frame any more: {:?}",
            measurement.coverage
        );

        let mut measured: Vec<&str> = measurement
            .extents
            .iter()
            .map(|extent| extent.clip_id.as_str())
            .collect();
        measured.sort_unstable();
        assert_eq!(
            measured,
            vec!["clip-0", "clip-1", "clip-2", "clip-title"],
            "every cue in the project has a rectangle: {:?}",
            measurement.coverage
        );

        for extent in &measurement.extents {
            let inked = extent
                .full_ink
                .unwrap_or_else(|| panic!("{} drew ink", extent.clip_id));
            assert!(
                inked.left > 0.0
                    && inked.right < 100.0
                    && inked.top >= 0.0
                    && inked.bottom <= 100.0,
                "{} lands inside the frame: {inked:?}",
                extent.clip_id
            );
            assert!(
                inked.height() < 25.0,
                "{} is one line tall, not the union of a title and a caption: {inked:?}",
                extent.clip_id
            );
            assert!(
                !extent.clipped,
                "{} is not cropped: {inked:?}",
                extent.clip_id
            );

            if extent.clip_id == "clip-title" {
                assert!(inked.bottom < 40.0, "the title sits high: {inked:?}");
            } else {
                assert!(inked.top > 60.0, "a caption sits low: {inked:?}");
            }
        }
    }

    /// Feature: caption extent measurement
    /// Scenario: a budget that runs out mid-layering leaves the measured layers
    /// standing
    ///
    /// The deadline is taken per layer for exactly this: one timeout around the
    /// whole loop would cancel the future holding every rectangle already
    /// measured and send a two-layer project back to the estimator entirely. The
    /// budget here is measured from a generous run and then halved, which is
    /// enough for the first layer and rarely enough for all four passes.
    ///
    /// Both outcomes are asserted, because which one a machine lands on is a
    /// property of that machine: what must never happen is coming back with
    /// nothing, and a run that measured fewer cues than it could has to say so.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn a_budget_that_runs_out_between_layers_keeps_the_layers_it_measured() {
        let Some(engine) = real_engine() else {
            return;
        };

        let sequence = sequence_with_a_title_over_captions();
        let effects = HashMap::new();
        let started = std::time::Instant::now();
        let generous = measure_caption_extents(
            &engine,
            &request_for(&sequence, &effects, Duration::from_secs(60)),
        )
        .await
        .expect("the generous run succeeds");
        let everything = started.elapsed();
        assert_eq!(generous.extents.len(), 4, "the fixture measures at all");

        let tight = measure_caption_extents(
            &engine,
            &request_for(&sequence, &effects, everything / 2 + MINIMUM_PASS_BUDGET),
        )
        .await
        .expect("a tight budget is not an error");

        assert!(
            !tight.extents.is_empty(),
            "a layer that finished keeps its rectangles: {:?}",
            tight.coverage.notes
        );
        for extent in &tight.extents {
            let inked = extent
                .full_ink
                .unwrap_or_else(|| panic!("{} drew ink", extent.clip_id));
            assert!(
                inked.right > inked.left && inked.bottom > inked.top,
                "and they are the rectangles the pass measured: {inked:?}"
            );
        }
        if tight.extents.len() < generous.extents.len() {
            assert!(
                tight
                    .coverage
                    .notes
                    .iter()
                    .any(|note| note.contains("budget")),
                "a run that measured fewer cues has to say why: {:?}",
                tight.coverage.notes
            );
        }
    }
}
