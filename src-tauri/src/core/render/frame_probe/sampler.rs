//! Event-driven frame sampling — "where to look" turned into timecodes.
//!
//! Uniform sampling (`--between`) is blind to the edit: evenly spaced midpoints
//! never land on a cut, never land on a caption, and never land on the seconds a
//! command just changed. An agent that wants to *see what it did* therefore had
//! to read `timeline info`, reconstruct cut times, subtract a frame and a half
//! by hand, and assemble a `--times` list — arithmetic that is easy to get
//! wrong and impossible to check from the picture that comes back.
//!
//! This module turns those questions into samplers. Each one reads the sequence
//! (plus its effect table, plus the last apply's affected ranges) and returns
//! the times worth looking at, each tagged with *why* it was chosen, so the
//! reason travels all the way out to `frames[].reason` and `sheet.cells[].reason`.
//!
//! # Why a frame and a half before a cut
//!
//! FFmpeg seeks resolve **forward**: a seek to `t` decodes the first frame at or
//! after `t`. A fixed backoff smaller than one frame therefore resolves forward
//! across the cut and puts *both* cells on the incoming shot — which happens at
//! **coarser** timebases, where a frame is long: at 24fps a frame is 0.0417s, so
//! `cut - 0.04` never reaches the outgoing shot. Backing the first sample off by
//! 1.5 frames *of the sequence's own rate* lands it in the middle of the
//! outgoing shot's last frame, which is the frame a continuity judgement is
//! about, at every timebase.

use std::collections::HashMap;

use serde::Serialize;

use super::{
    sequence_duration_sec, FrameProbeArgumentNames, FrameProbeError, FrameProbeResult,
    MAX_GRID_CELLS,
};
use crate::core::effects::Effect;
use crate::core::render::{is_text_clip, track_included_in_export};
use crate::core::timeline::{
    collect_caption_spans, collect_text_spans, collect_transition_spans, collect_video_cuts,
    Sequence, TrackKind,
};
use crate::core::{EffectId, TimeRange};

/// Tolerance for treating two sample times as the same instant (1 microsecond).
///
/// The same epsilon the timeline uses for edit-point deduplication, so a cut and
/// an affected-range boundary that the rest of the engine calls coincident
/// collapse to one sample here too.
const TIME_EPSILON: f64 = 1e-6;

/// Frames subtracted from a cut to land on the outgoing shot.
///
/// See the module docs: seeks resolve forward, so a whole frame is not enough to
/// guarantee the earlier picture once rounding is involved.
pub(super) const CUT_LEAD_FRAMES: f64 = 1.5;

/// Frame rate assumed when the sequence states an unusable one.
///
/// Only reached for a malformed sequence format; a wrong lead is still better
/// than a division by zero, and 25fps errs on the side of a larger backoff.
const FALLBACK_FPS: f64 = 25.0;

/// Default half-width of an `around` window, in seconds.
pub const DEFAULT_AROUND_SPAN_SEC: f64 = 0.5;

/// Default number of samples an `around` window produces.
pub const DEFAULT_AROUND_COUNT: usize = 5;

/// Why a sample was chosen.
///
/// Carried on every extracted still and every contact-sheet cell so the picture
/// can be read without re-deriving the timeline event that produced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SampleReason {
    /// The last frame of the outgoing shot at a cut.
    CutBefore,
    /// The first frame of the incoming shot at a cut.
    CutAfter,
    /// The instant a two-input transition starts blending.
    TransitionStart,
    /// The cut a two-input transition is centred on.
    TransitionCut,
    /// The instant a two-input transition finishes blending.
    TransitionEnd,
    /// The middle of a caption's span.
    CaptionMid,
    /// The middle of a text clip's span.
    TextMid,
    /// A sequence marker's time.
    Marker,
    /// The middle of one shot.
    ShotMid,
    /// The start of a changed range — the last apply's, or a named one.
    AffectedStart,
    /// The middle of a changed range — the last apply's, or a named one.
    AffectedMid,
    /// The last frame of a changed range — the last apply's, or a named one.
    AffectedEnd,
    /// A sample from an explicit `--around` window.
    Around,
}

/// One time the probe will extract, and why.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    /// Timeline position in seconds.
    pub time_sec: f64,
    /// The event that put this time on the list.
    pub reason: SampleReason,
    /// The timeline event this sample belongs to, when it shares one.
    ///
    /// Both samples of a cut, all three of a transition and every sample of one
    /// affected range carry the same id, because they are only worth anything
    /// together: half a cut is a still with nothing to compare it to. `None`
    /// means the sample stands alone — a marker, a shot midpoint. Ids are
    /// assigned per run (see [`run`]) and mean nothing outside it.
    pub group: Option<u32>,
}

impl Sample {
    /// A sample that stands on its own.
    fn new(time_sec: f64, reason: SampleReason) -> Self {
        Self {
            time_sec,
            reason,
            group: None,
        }
    }

    /// A sample that only means something alongside the rest of its event.
    fn grouped(time_sec: f64, reason: SampleReason, group: u32) -> Self {
        Self {
            time_sec,
            reason,
            group: Some(group),
        }
    }

    /// The same sample re-keyed into another event's group.
    fn in_group(mut self, group: u32) -> Self {
        self.group = Some(group);
        self
    }
}

/// Which samplers a request asked for, exactly as the caller expressed it.
///
/// Field names mirror the CLI flags they came from. Samplers combine as a union;
/// what they cannot combine with — a time, a time list, a swept range, a count,
/// an asset, a rendered file — is enforced where the selection is resolved,
/// because every surface has to be told the same thing in the same words.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SamplerSpec {
    /// How the calling surface spells these arguments in a refusal.
    pub names: &'static FrameProbeArgumentNames,
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
    /// Sample a window centred on this time.
    pub around: Option<f64>,
    /// Half-width of the `around` window in seconds.
    pub span: Option<f64>,
    /// Number of samples the `around` window produces.
    pub around_count: Option<usize>,
    /// Sample the ranges the last successful apply changed.
    pub affected: bool,
    /// Sample the ranges the caller named outright.
    ///
    /// The same sampler `affected` runs, over ranges that arrive with the
    /// request instead of being read from the project's hand-off file. A caller
    /// that already holds the ranges its own apply reported — the in-app bridge
    /// does, from `plan_apply` — states them here and never has to trust a slot
    /// another surface can overwrite between the edit and the look.
    pub ranges: Option<Vec<TimeRange>>,
    /// Largest number of samples to keep; the rest are thinned out evenly.
    pub limit: Option<usize>,
}

impl SamplerSpec {
    /// Whether any sampler was asked for.
    ///
    /// `span`, `around_count` and `limit` deliberately do not count: they shape a
    /// sampler rather than being one, and a request carrying only those has
    /// nothing to sample.
    pub fn is_active(&self) -> bool {
        self.at_cuts
            || self.at_transitions
            || self.at_captions
            || self.at_markers
            || self.per_shot
            || self.around.is_some()
            || self.affected
            || self.ranges.is_some()
    }

    /// The samplers asked for, in the order they are applied.
    ///
    /// The order is what decides the reason a shared time keeps: the first
    /// sampler to name a time wins the dedupe.
    pub fn kinds(&self) -> Vec<String> {
        let mut kinds = Vec::new();
        for (active, name) in [
            (self.at_cuts, "atCuts"),
            (self.at_transitions, "atTransitions"),
            (self.at_captions, "atCaptions"),
            (self.at_markers, "atMarkers"),
            (self.per_shot, "perShot"),
            (self.around.is_some(), "around"),
            (self.affected, "affected"),
            (self.ranges.is_some(), "ranges"),
        ] {
            if active {
                kinds.push(name.to_string());
            }
        }
        kinds
    }

    /// Names the shaping flags that were passed without any sampler to shape.
    ///
    /// Empty when the request is coherent. Reported rather than ignored: a
    /// budget nothing reads looks to the caller like one that was honoured.
    pub fn orphaned_modifiers(&self) -> Vec<&'static str> {
        if self.is_active() {
            return Vec::new();
        }
        [
            (self.span.is_some(), self.names.span),
            (self.around_count.is_some(), self.names.around_count),
            (self.limit.is_some(), self.names.limit),
        ]
        .into_iter()
        .filter_map(|(used, flag)| used.then_some(flag))
        .collect()
    }
}

/// Everything a sampler run reads beyond the spec itself.
pub struct SamplerInputs<'a> {
    /// Sequence the samples are taken from.
    pub sequence: &'a Sequence,
    /// The project's whole effect table; only referenced ids are read.
    pub effects: &'a HashMap<EffectId, Effect>,
    /// Ranges the last successful apply changed, empty unless `affected` is set.
    ///
    /// Read from the project's hand-off file by the caller. Ignored when the
    /// spec names its own [`ranges`](SamplerSpec::ranges), which the two are
    /// never allowed to do at once.
    pub affected_ranges: &'a [TimeRange],
    /// Stretch of timeline every sampler is confined to, when there is one.
    ///
    /// Set when the samples are destined for a rendered file that covers only
    /// part of the edit: a sample outside the file cannot be pictured, and
    /// choosing one anyway would spend the budget on a frame that gets dropped.
    /// `None` samples the whole sequence, which is every other caller.
    ///
    /// The bound is on the *events* a sampler looks at, not on the samples it
    /// produces from them: a cut at the very start of the range legitimately
    /// puts its `cutBefore` frame a frame and a half earlier, and that frame is
    /// half of what the cut is being judged on.
    pub restrict: Option<TimeRange>,
}

/// What a sampler run produced, alongside the arithmetic behind it.
///
/// `candidates` and `selected` differ exactly when `limit` thinned the list, so
/// a caller can tell "there were only three cuts" from "there were sixty and you
/// are seeing twelve of them".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerReport {
    /// Samplers that ran, in application order.
    pub kinds: Vec<String>,
    /// Times the samplers produced, after clamping and deduplication.
    pub candidates: usize,
    /// Times actually extracted.
    pub selected: usize,
    /// Whether `limit` dropped anything.
    pub limited: bool,
    /// The ranges that were sampled, when `affected` or `ranges` ran.
    ///
    /// Echoed back whichever way they arrived — read from the hand-off record,
    /// or named by the caller — so the picture can be checked against the
    /// seconds it claims to be of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_ranges: Option<Vec<TimeRange>>,
    /// Samples the rendered file turned out not to hold, and so were dropped.
    ///
    /// Only set when the samples were translated into a rendered file's
    /// timebase. Non-zero means the declared range and the file disagree — a
    /// render that stopped early, or a range wider than what was encoded — and
    /// the caller is looking at fewer moments than the sampler chose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_outside_file: Option<usize>,
}

/// A sampler run's times and the report describing them.
#[derive(Debug)]
pub struct SamplerOutcome {
    /// The times to extract, ascending.
    pub samples: Vec<Sample>,
    /// What the run did, for the JSON payload.
    pub report: SamplerReport,
}

/// Runs every sampler the spec asks for and returns their normalized union.
///
/// Fails when the union is empty: an extraction that writes no pictures is a
/// silent no-op, and the caller cannot tell it from a sequence with nothing to
/// look at unless it is said out loud.
pub fn run(spec: &SamplerSpec, inputs: &SamplerInputs<'_>) -> FrameProbeResult<SamplerOutcome> {
    let sequence = inputs.sequence;
    let fps = sequence.format.fps.as_f64();

    // Each sampler numbers its own events from zero, so they are rebased onto a
    // run-wide sequence as they are folded in; without that, the first cut and
    // the first transition would look like one event to the thinning below.
    let restrict = inputs.restrict.as_ref();
    let mut raw = Vec::new();
    let mut next_group = 0_u32;
    if spec.at_cuts {
        extend_rebased(&mut raw, &mut next_group, at_cuts(sequence, restrict, fps));
    }
    if spec.at_transitions {
        extend_rebased(
            &mut raw,
            &mut next_group,
            at_transitions(sequence, inputs.effects, restrict),
        );
    }
    if spec.at_captions {
        extend_rebased(
            &mut raw,
            &mut next_group,
            at_captions(sequence, inputs.effects, restrict),
        );
    }
    if spec.at_markers {
        extend_rebased(&mut raw, &mut next_group, at_markers(sequence, restrict));
    }
    if spec.per_shot {
        extend_rebased(&mut raw, &mut next_group, per_shot(sequence, restrict));
    }
    if let Some(time) = spec.around {
        // The window clamps itself into the *sequence*, so a centre near the
        // restriction's edge still reaches past it; the samples that do are
        // dropped rather than the window being re-centred, which would show a
        // moment the caller did not ask about.
        let window = around(
            sequence,
            time,
            spec.span.unwrap_or(DEFAULT_AROUND_SPAN_SEC),
            spec.around_count.unwrap_or(DEFAULT_AROUND_COUNT),
            spec.names,
        )?
        .into_iter()
        .filter(|sample| within(restrict, sample.time_sec))
        .collect();
        extend_rebased(&mut raw, &mut next_group, window);
    }
    // `affected` and `ranges` are the same sampler over ranges that arrived by
    // different routes, and the request layer refuses both at once — so at most
    // one of these is ever a non-empty list.
    let named_ranges: &[TimeRange] = match spec.ranges.as_deref() {
        Some(ranges) => ranges,
        None => inputs.affected_ranges,
    };
    // Clipped rather than filtered: a change that starts inside the restriction
    // and runs past it is still worth looking at, over the part that can be
    // pictured. A range with no overlap at all contributes nothing.
    let sampled_ranges = clip_ranges(named_ranges, restrict);
    if spec.affected || spec.ranges.is_some() {
        extend_rebased(
            &mut raw,
            &mut next_group,
            affected(&sampled_ranges, sequence, fps),
        );
    }

    // The samplers gate their own events with `within`, which includes both
    // boundaries. The END boundary cannot survive translation into a rendered
    // file's timebase, so it is trimmed here, once, over the whole union —
    // including the cuts `affected` collects, whose ranges were already clipped
    // to this one. The START boundary is left alone: a cut at the head of the
    // range still owes the caller the outgoing frame that sits a frame and a
    // half in front of it.
    if let Some(restrict) = restrict {
        raw.retain(|sample| before_restriction_end(restrict, sample.time_sec));
    }

    let candidates = normalize(sequence, raw);
    if candidates.is_empty() {
        // "Nothing to look at" is a confusing answer to `--at-transitions` on a
        // timeline that visibly has transitions on it. Say which ones the
        // renderer refuses, so the caller fixes the edit rather than the flag.
        let refused = if spec.at_transitions {
            refused_transition_reasons(sequence, inputs.effects)
        } else {
            Vec::new()
        };
        let refusals = if refused.is_empty() {
            String::new()
        } else {
            format!(
                " Every stored transition renders as a hard cut, so there is no blend to sample: {}. Sample those boundaries with {}, or fix the transitions.",
                refused.join("; "),
                spec.names.at_cuts
            )
        };

        // A restricted run has one extra way to come back empty — the events
        // are all outside the stretch being looked at — and the caller cannot
        // tell that from "this sequence has no cuts" unless it is said.
        let where_looked = match restrict {
            Some(restrict) => format!(
                " between {:.3}s and {:.3}s, the timeline range the rendered file covers",
                restrict.start_sec, restrict.end_sec
            ),
            None => String::new(),
        };

        return Err(FrameProbeError::new(format!(
            "{} found nothing to look at on sequence '{}'{where_looked}.{refusals} Try another sampler, or {} for an even sweep.",
            spec.kinds().join(" + "),
            sequence.name,
            spec.names.between_range()
        )));
    }

    let candidate_count = candidates.len();
    let (samples, limited) = match spec.limit {
        Some(limit) => limit_samples(candidates, limit, spec.names)?,
        None => (candidates, false),
    };

    Ok(SamplerOutcome {
        report: SamplerReport {
            kinds: spec.kinds(),
            candidates: candidate_count,
            selected: samples.len(),
            limited,
            affected_ranges: (spec.affected || spec.ranges.is_some()).then_some(sampled_ranges),
            // Set by the file path once the samples have been translated; a
            // timeline run drops nothing to a file it never reads.
            dropped_outside_file: None,
        },
        samples,
    })
}

/// Intersects named ranges with the stretch the run is confined to.
///
/// Ranges that do not overlap it are dropped outright. Without a restriction
/// the list is returned as it arrived, which is what every timeline run gets.
///
/// A range that merely *touches* the restriction — one ending exactly where the
/// restriction begins, or beginning exactly where it ends — is dropped rather
/// than collapsed to a zero-width range, because a zero-width clip is reported
/// as a single-instant change and would put a picture of an unrelated frame in
/// front of the caller. A range that arrived zero-width is a real single
/// instant, so that one is kept when the restriction holds it.
fn clip_ranges(ranges: &[TimeRange], restrict: Option<&TimeRange>) -> Vec<TimeRange> {
    let Some(restrict) = restrict else {
        return ranges.to_vec();
    };

    ranges
        .iter()
        .filter_map(|range| {
            let start_sec = range.start_sec.max(restrict.start_sec);
            let end_sec = range.end_sec.min(restrict.end_sec);
            let width_sec = end_sec - start_sec;
            let kept = if range.end_sec - range.start_sec <= TIME_EPSILON {
                width_sec >= -TIME_EPSILON
            } else {
                width_sec > TIME_EPSILON
            };
            kept.then_some(TimeRange { start_sec, end_sec })
        })
        .collect()
}

// ── Samplers ────────────────────────────────────────────────────────────

/// Samples both sides of every cut inside the sequence.
///
/// A cut is a boundary the *picture* changes at — see
/// [`collect_video_cuts`], the one definition all three surfaces read, so a
/// caption's in point or an audio boundary never spends a cell. `range`
/// restricts which cuts are sampled, not which samples survive: the `cutBefore`
/// frame of a cut at the very start of the range legitimately sits a frame and a
/// half before it.
pub fn at_cuts(sequence: &Sequence, range: Option<&TimeRange>, fps: f64) -> Vec<Sample> {
    let lead_sec = cut_lead_sec(fps);

    let mut samples = Vec::new();
    for (group, cut_sec) in collect_video_cuts(sequence).into_iter().enumerate() {
        if !within(range, cut_sec) {
            continue;
        }
        let group = group as u32;
        let before_sec = cut_sec - lead_sec;
        if before_sec >= 0.0 {
            samples.push(Sample::grouped(before_sec, SampleReason::CutBefore, group));
        }
        samples.push(Sample::grouped(cut_sec, SampleReason::CutAfter, group));
    }

    samples
}

/// Samples the start, cut and end of every two-input transition.
///
/// A transition is stored on the outgoing clip and blends *across* the cut, so
/// none of these three times is a clip boundary — which is exactly why they
/// cannot be derived from a clip list.
///
/// A stored transition the renderer refuses is skipped: its three times all land
/// on the same hard cut, so they would spend three cells showing what `--at-cuts`
/// shows in two, and would read as a blend that is not there. `timeline info`
/// still lists it, with `rendersAsCut` and the reason.
pub fn at_transitions(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
    range: Option<&TimeRange>,
) -> Vec<Sample> {
    let mut samples = Vec::new();
    for (group, span) in collect_transition_spans(sequence, effects)
        .into_iter()
        .enumerate()
    {
        if span.renders_as_cut {
            continue;
        }
        // Overlap, not the cut alone: a blend that begins before the range and
        // resolves inside it is visible in the range, and gating on `cut_sec`
        // dropped the whole transition rather than the landmarks the range does
        // not hold. Each landmark is then kept on its own.
        if clip_span(range, span.start_sec, span.end_sec).is_none() {
            continue;
        }
        let group = group as u32;
        for (time_sec, reason) in [
            (span.start_sec, SampleReason::TransitionStart),
            (span.cut_sec, SampleReason::TransitionCut),
            (span.end_sec, SampleReason::TransitionEnd),
        ] {
            if within(range, time_sec) {
                samples.push(Sample::grouped(time_sec, reason, group));
            }
        }
    }

    samples
}

/// Samples the middle of every caption and every text clip.
///
/// The midpoint rather than the in point: a caption that fades or animates in is
/// not fully drawn at its own start, and readability is judged on the settled
/// frame.
pub fn at_captions(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
    range: Option<&TimeRange>,
) -> Vec<Sample> {
    let mut samples = Vec::new();
    for (spans, reason) in [
        (collect_caption_spans(sequence), SampleReason::CaptionMid),
        (collect_text_spans(sequence, effects), SampleReason::TextMid),
    ] {
        for span in spans {
            // The midpoint of the part that is *inside* the range, not of the
            // whole span: a caption that starts before the range and runs into
            // it is on screen for seconds the caller is looking at, and judging
            // it by a midpoint that lands outside dropped it entirely.
            let Some((start_sec, end_sec)) = clip_span(range, span.start_sec, span.end_sec) else {
                continue;
            };
            samples.push(Sample::new(midpoint(start_sec, end_sec), reason));
        }
    }

    samples
}

/// Samples every sequence marker.
pub fn at_markers(sequence: &Sequence, range: Option<&TimeRange>) -> Vec<Sample> {
    sequence
        .collect_marker_times()
        .into_iter()
        .filter(|time_sec| within(range, *time_sec))
        .map(|time_sec| Sample::new(time_sec, SampleReason::Marker))
        .collect()
}

/// Samples the middle of every shot.
///
/// A shot is an enabled, non-text clip on a picture track the export includes,
/// so a hidden or muted track contributes nothing: a still of a track that will
/// not be in the render is not a picture of the edit. Text clips are excluded
/// because they are titles rather than shots — `at_captions` covers those.
///
/// Overlay tracks count as picture tracks here, because the export composites
/// them: a picture-in-picture inset or a B-roll cutaway placed on an overlay
/// track is a shot, and a coverage sweep that skipped it reported full coverage
/// of an edit it had not looked at.
pub fn per_shot(sequence: &Sequence, range: Option<&TimeRange>) -> Vec<Sample> {
    let mut samples = Vec::new();
    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Video | TrackKind::Overlay)
            || !track_included_in_export(track)
        {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled || is_text_clip(clip) {
                continue;
            }
            // The midpoint of the part inside the range: a shot that straddles
            // the range being looked at is one of the shots in it, and judging
            // it by the whole clip's midpoint dropped exactly the long takes a
            // coverage sweep most needs to see.
            let Some((start_sec, end_sec)) = clip_span(
                range,
                clip.place.timeline_in_sec,
                clip.place.timeline_out_sec(),
            ) else {
                continue;
            };
            samples.push(Sample::new(
                midpoint(start_sec, end_sec),
                SampleReason::ShotMid,
            ));
        }
    }

    samples
}

/// Samples a window centred on one time.
///
/// The window is clamped into the sequence *before* it is divided, so a request
/// near either edge is shifted inward rather than losing the samples that fell
/// outside — a window at the head becomes `[0, end]` and is divided over that.
/// It is not a guarantee of `count` distinct times: a window clamped down to
/// nothing, at a sequence one frame long, collapses to repeats that
/// [`normalize`] then dedupes. What the clamp buys is that the samples that do
/// come back are all inside the render.
///
/// The upper clamp is the last *decodable* frame, a frame and a half back from
/// the end rather than a microsecond: seeks resolve forward, so a time inside
/// the final frame's interval has no frame at or after it to return.
pub fn around(
    sequence: &Sequence,
    time_sec: f64,
    span_sec: f64,
    count: usize,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<Vec<Sample>> {
    if !time_sec.is_finite() || time_sec < 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be a finite, non-negative time (got {time_sec})",
            names.around
        )));
    }
    if !span_sec.is_finite() || span_sec <= 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be a positive number of seconds (got {span_sec})",
            names.span
        )));
    }
    if count == 0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be >= 1",
            names.around_count
        )));
    }

    let duration_sec = sequence_duration_sec(sequence);
    if duration_sec <= 0.0 {
        return Err(FrameProbeError::new(format!(
            "Sequence '{}' is empty, so there is no frame to extract",
            sequence.name
        )));
    }
    // A centre past the end used to be clamped silently, and the caller got one
    // still of the last frame back as though it were the moment they asked
    // about. Refused in the same words `ensure_times_inside_sequence` uses, so
    // a mistyped time reads the same however it reached the probe.
    if time_sec >= duration_sec {
        return Err(FrameProbeError::new(format!(
            "Requested time {:.3}s is at or past the end of sequence '{}' ({:.3}s). Ask for a time inside the sequence, or narrow {} to the edited range.",
            time_sec, sequence.name, duration_sec, names.between
        )));
    }

    let last_sec = (duration_sec - cut_lead_sec(sequence.format.fps.as_f64())).max(0.0);
    let start_sec = (time_sec - span_sec).max(0.0).min(last_sec);
    let end_sec = (time_sec + span_sec).max(0.0).min(last_sec);

    if count == 1 {
        return Ok(vec![Sample::new(
            midpoint(start_sec, end_sec),
            SampleReason::Around,
        )]);
    }

    let step = (end_sec - start_sec) / (count - 1) as f64;
    Ok((0..count)
        .map(|index| Sample::new(start_sec + step * index as f64, SampleReason::Around))
        .collect())
}

/// Samples the ranges an edit changed, however the caller named them.
///
/// Serves both `affected` — ranges read from the project's hand-off record —
/// and `ranges`, which the caller states outright; the two produce the same
/// samples and the same reasons, because they are the same question asked with
/// more or less certainty about whose edit it is.
///
/// Each range gets its edges, its middle and every cut inside it: the edges show
/// how the change joins what surrounds it, the middle shows the change itself,
/// and the cuts are where a ripple most often goes wrong. A zero-length range —
/// how a created or deleted marker is recorded — has only a middle.
pub fn affected(ranges: &[TimeRange], sequence: &Sequence, fps: f64) -> Vec<Sample> {
    let lead_sec = cut_lead_sec(fps);

    let mut samples = Vec::new();
    for (group, range) in ranges.iter().enumerate() {
        let group = group as u32;
        let start_sec = range.start_sec;
        let end_sec = range.end_sec;
        if end_sec - start_sec <= TIME_EPSILON {
            samples.push(Sample::grouped(start_sec, SampleReason::AffectedMid, group));
            continue;
        }

        samples.push(Sample::grouped(
            start_sec,
            SampleReason::AffectedStart,
            group,
        ));
        // The cuts inside the range join the range's group rather than keeping
        // their own: a budget that dropped half of one range's samples would
        // describe a change nobody can check.
        samples.extend(
            at_cuts(sequence, Some(range), fps)
                .into_iter()
                .map(|sample| sample.in_group(group)),
        );
        samples.push(Sample::grouped(
            midpoint(start_sec, end_sec),
            SampleReason::AffectedMid,
            group,
        ));

        // The range's own end is the first instant *after* the change, and it is
        // frequently the timeline's end, which holds no frame at all. Back off
        // by the same frame and a half a cut uses.
        let last_sec = end_sec - lead_sec;
        if last_sec > start_sec {
            samples.push(Sample::grouped(last_sec, SampleReason::AffectedEnd, group));
        }
    }

    samples
}

// ── Post-processing ─────────────────────────────────────────────────────

/// Clamps a raw union into the sequence, orders it and collapses duplicates.
///
/// Sorting is stable, so among times within a microsecond of each other the one
/// the earliest sampler produced is the one that keeps its reason.
pub fn normalize(sequence: &Sequence, samples: Vec<Sample>) -> Vec<Sample> {
    let duration_sec = sequence_duration_sec(sequence);

    let mut kept: Vec<Sample> = samples
        .into_iter()
        .filter(|sample| {
            sample.time_sec.is_finite() && sample.time_sec >= 0.0 && sample.time_sec < duration_sec
        })
        .collect();

    kept.sort_by(|left, right| {
        left.time_sec
            .partial_cmp(&right.time_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    kept.dedup_by(|later, earlier| (later.time_sec - earlier.time_sec).abs() < TIME_EPSILON);

    kept
}

/// Thins a sample list down to `limit`, keeping its first and last events.
///
/// Evenly spaced rather than truncated: a caller that asks for twelve frames of
/// a sixty-cut sequence wants twelve frames spread over the whole sequence, not
/// the first twelve cuts and nothing after them.
///
/// Thinned by **event**, never by index. Thinning by index kept whichever
/// samples happened to land on the stride, which for `--at-cuts` meant the
/// `cutBefore` of one cut next to the `cutAfter` of another: two stills of
/// unrelated boundaries, presented as a before/after pair. Both samples of a
/// cut, all three of a transition and every sample of one affected range
/// therefore travel together or not at all, and the budget is rounded down to
/// whole events — twelve frames of a ten-cut sequence is six complete pairs,
/// not six pairs and an orphan.
///
/// The one case that still truncates is a single event larger than the whole
/// budget, where there is no whole-event answer to round down to.
pub fn limit_samples(
    samples: Vec<Sample>,
    limit: usize,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<(Vec<Sample>, bool)> {
    if limit == 0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for {}: must be >= 1",
            names.limit
        )));
    }
    if samples.len() <= limit {
        return Ok((samples, false));
    }

    let events = group_samples(samples);
    // The largest number of evenly spaced events whose samples fit the budget.
    let kept = (1..=events.len())
        .rev()
        .find(|count| selected_event_size(&events, *count) <= limit);

    let Some(kept) = kept else {
        // One event alone overruns the budget, so there is nothing to round
        // down to; truncate rather than return an empty batch.
        let mut thinned: Vec<Sample> = events.into_iter().flatten().collect();
        thinned.truncate(limit);
        return Ok((thinned, true));
    };

    let thinned: Vec<Sample> = select_events(&events, kept)
        .flat_map(|event| event.iter().copied())
        .collect();

    Ok((thinned, true))
}

/// Splits a sample list into the timeline events its samples belong to.
///
/// Order is the order the samples arrived in, so an event sits where its
/// earliest sample sits. A sample carrying no group is its own event.
fn group_samples(samples: Vec<Sample>) -> Vec<Vec<Sample>> {
    let mut events: Vec<Vec<Sample>> = Vec::new();
    let mut index_of: HashMap<u32, usize> = HashMap::new();

    for sample in samples {
        match sample.group {
            Some(group) => match index_of.get(&group) {
                Some(&index) => events[index].push(sample),
                None => {
                    index_of.insert(group, events.len());
                    events.push(vec![sample]);
                }
            },
            None => events.push(vec![sample]),
        }
    }

    events
}

/// The evenly spaced `count` events, first and last always included.
fn select_events(events: &[Vec<Sample>], count: usize) -> impl Iterator<Item = &Vec<Sample>> {
    let last_index = events.len().saturating_sub(1);
    (0..count).map(move |index| {
        let position = if count <= 1 {
            0
        } else {
            index * last_index / (count - 1)
        };
        &events[position]
    })
}

/// How many samples selecting `count` events would keep.
fn selected_event_size(events: &[Vec<Sample>], count: usize) -> usize {
    select_events(events, count).map(Vec::len).sum()
}

/// Chooses a contact-sheet layout for `count` samples.
///
/// Columns widen with the sample count so a sheet stays roughly square and its
/// cells stay large enough to judge: two samples read best side by side, a
/// handful as a 3-wide block, and only a long sweep is worth 6 columns of
/// smaller pictures. A single sample gets a 1x1 sheet — a second column with
/// nothing in it is half a sheet of blank.
pub fn auto_grid(
    count: usize,
    names: &FrameProbeArgumentNames,
) -> FrameProbeResult<(usize, usize)> {
    if count == 0 {
        return Err(FrameProbeError::new(
            "A contact sheet needs at least one sample".to_string(),
        ));
    }
    if count > MAX_GRID_CELLS {
        return Err(FrameProbeError::new(format!(
            "The samplers selected {} times, more than the {} cells a contact sheet holds. Add {}, narrow the sampler, or use {} with an explicit {}.",
            count,
            MAX_GRID_CELLS,
            names.limit_value(MAX_GRID_CELLS),
            names.between_range(),
            names.grid_layout()
        )));
    }

    let mut columns = match count {
        1 => 1,
        2 => 2,
        3..=9 => 3,
        10..=16 => 4,
        _ => 6,
    };

    // A layout holds columns * ceil(count / columns) cells, which for an awkward
    // count rounds *up* past the cap: 100 samples in 6 columns is 17 rows and
    // 102 cells, more than a sheet can hold. Widening squares the layout off,
    // and terminates because at `count` columns the sheet is exactly `count`
    // cells, which the check above has already accepted.
    while columns < count && columns * count.div_ceil(columns) > MAX_GRID_CELLS {
        columns += 1;
    }

    Ok((columns, count.div_ceil(columns)))
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Names every stored transition the renderer refuses, with its reason.
fn refused_transition_reasons(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> Vec<String> {
    collect_transition_spans(sequence, effects)
        .into_iter()
        .filter_map(|span| {
            let reason = span.refusal_reason?;
            Some(format!(
                "the transition on clip '{}' at {:.3}s {reason}",
                span.clip_id, span.cut_sec
            ))
        })
        .collect()
}

/// Folds one sampler's output in, renumbering its events onto the run's ids.
///
/// Each sampler numbers its events from zero. Concatenating two samplers without
/// renumbering makes their first events share an id, and the thinning in
/// [`limit_samples`] would then keep or drop them as one.
fn extend_rebased(into: &mut Vec<Sample>, next_group: &mut u32, produced: Vec<Sample>) {
    let base = *next_group;
    let mut highest: Option<u32> = None;

    for mut sample in produced {
        if let Some(local) = sample.group {
            sample.group = Some(base.saturating_add(local));
            highest = Some(highest.map_or(local, |seen: u32| seen.max(local)));
        }
        into.push(sample);
    }

    if let Some(highest) = highest {
        *next_group = base.saturating_add(highest).saturating_add(1);
    }
}

/// Seconds subtracted from a cut so the sample lands on the outgoing shot.
fn cut_lead_sec(fps: f64) -> f64 {
    let fps = if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        FALLBACK_FPS
    };
    CUT_LEAD_FRAMES / fps
}

/// Whether a time falls inside an optional range, boundaries included.
fn within(range: Option<&TimeRange>, time_sec: f64) -> bool {
    match range {
        Some(range) => {
            time_sec >= range.start_sec - TIME_EPSILON && time_sec <= range.end_sec + TIME_EPSILON
        }
        None => true,
    }
}

/// Whether a sample lies before the END of the stretch a restricted run is
/// confined to.
///
/// Only the END edge, and exclusive there — unlike [`within`], which includes
/// both. The restriction is the timeline range a rendered file covers, and
/// translating a time into that file's timebase is exclusive at the end: the
/// last frame of a range running to `END` sits before `END`, not at it. Keeping
/// an event exactly at `END` only to have the translation drop it produced the
/// worst possible answer — a run whose only event sat on the boundary came back
/// as "all sampled times fall outside the file, declare the range it was really
/// rendered from", which sends the caller to re-render a file that was correct.
///
/// The START edge is deliberately not enforced here: the restriction bounds
/// which *events* are sampled, not which samples they produce, and a cut at the
/// head of the range legitimately puts its outgoing frame a frame and a half
/// earlier. A zero-width restriction is a declared instant rather than a
/// stretch, so nothing is dropped for it.
fn before_restriction_end(restrict: &TimeRange, time_sec: f64) -> bool {
    if restrict.end_sec - restrict.start_sec <= TIME_EPSILON {
        return true;
    }
    time_sec < restrict.end_sec - TIME_EPSILON
}

/// Intersects one span with an optional restriction.
///
/// `None` when the restriction leaves nothing of the span. A span that merely
/// *touches* the restriction leaves nothing: the overlap has no width, and
/// sampling its single instant would put a picture of an unrelated moment in
/// front of the caller. A span that was itself an instant is kept when the
/// restriction holds it, which is how a zero-length event survives.
fn clip_span(restrict: Option<&TimeRange>, start_sec: f64, end_sec: f64) -> Option<(f64, f64)> {
    let Some(restrict) = restrict else {
        return Some((start_sec, end_sec));
    };

    let clipped_start = start_sec.max(restrict.start_sec);
    let clipped_end = end_sec.min(restrict.end_sec);
    let width_sec = clipped_end - clipped_start;
    let kept = if end_sec - start_sec <= TIME_EPSILON {
        width_sec >= -TIME_EPSILON
    } else {
        width_sec > TIME_EPSILON
    };

    kept.then_some((clipped_start, clipped_end))
}

/// Midpoint of a span.
fn midpoint(start_sec: f64, end_sec: f64) -> f64 {
    start_sec + (end_sec - start_sec) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::render::frame_probe::CLI_ARGUMENT_NAMES;

    /// The CLI vocabulary, which these tests read their refusals in.
    fn names() -> &'static FrameProbeArgumentNames {
        CLI_ARGUMENT_NAMES
    }

    /// An empty spec that refuses in long flags.
    fn cli_spec() -> SamplerSpec {
        SamplerSpec {
            names: names(),
            ..SamplerSpec::default()
        }
    }
    use crate::core::commands::TEXT_ASSET_PREFIX;
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::timeline::{Clip, ClipPlace, Marker, SequenceFormat, Track};

    /// 25fps keeps the 1.5-frame lead an exact 0.06s.
    const FPS: f64 = 25.0;
    const LEAD_SEC: f64 = 0.06;

    fn sequence() -> Sequence {
        Sequence::new("Sampler", SequenceFormat::new(1920, 1080, 25, 1, 48_000))
    }

    fn clip_at(asset_id: &str, start_sec: f64, duration_sec: f64) -> Clip {
        let mut clip = Clip::new(asset_id);
        clip.place = ClipPlace::new(start_sec, duration_sec);
        clip
    }

    /// Two four-second shots, so the only cut sits at 4.0s and the timeline ends
    /// at 8.0s.
    fn two_shot_sequence() -> Sequence {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 4.0));
        track.clips.push(clip_at("asset-b", 4.0, 4.0));
        seq.tracks.push(track);
        seq
    }

    fn times(samples: &[Sample]) -> Vec<f64> {
        samples.iter().map(|sample| sample.time_sec).collect()
    }

    fn sample_reasons(samples: &[Sample]) -> Vec<SampleReason> {
        samples.iter().map(|sample| sample.reason).collect()
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn at_cuts_should_sample_a_frame_and_a_half_before_the_cut_and_the_cut_itself() {
        let samples = at_cuts(&two_shot_sequence(), None, FPS);

        assert_eq!(
            sample_reasons(&samples),
            vec![SampleReason::CutBefore, SampleReason::CutAfter]
        );
        assert_close(samples[0].time_sec, 4.0 - LEAD_SEC);
        assert_close(samples[1].time_sec, 4.0);
    }

    #[test]
    fn at_cuts_should_ignore_the_timeline_start_and_end() {
        let samples = at_cuts(&two_shot_sequence(), None, FPS);

        assert!(
            samples
                .iter()
                .all(|sample| sample.time_sec > 0.0 && sample.time_sec < 8.0),
            "the head and tail are edit points but not cuts, got {:?}",
            times(&samples)
        );
    }

    #[test]
    fn at_cuts_should_keep_the_leading_sample_off_the_timeline_start() {
        // A one-frame first shot would put `cut - 1.5/fps` before zero.
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 0.02));
        track.clips.push(clip_at("asset-b", 0.02, 4.0));
        seq.tracks.push(track);

        assert_eq!(
            sample_reasons(&at_cuts(&seq, None, FPS)),
            vec![SampleReason::CutAfter]
        );
    }

    #[test]
    fn at_cuts_should_honour_a_range_filter() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 2.0));
        track.clips.push(clip_at("asset-b", 2.0, 2.0));
        track.clips.push(clip_at("asset-c", 4.0, 2.0));
        seq.tracks.push(track);

        let inside = at_cuts(&seq, Some(&TimeRange::new(3.5, 4.5)), FPS);

        assert_eq!(inside.len(), 2, "only the 4.0s cut is inside the range");
        assert_close(inside[1].time_sec, 4.0);
    }

    #[test]
    fn at_cuts_should_ignore_caption_and_audio_boundaries() {
        let mut seq = two_shot_sequence();

        let mut caption_track = Track::new_caption("C1");
        caption_track.clips.push(clip_at("__caption__", 1.0, 1.0));
        seq.tracks.push(caption_track);

        let mut audio = Track::new("A1", TrackKind::Audio);
        audio.clips.push(clip_at("asset-music", 5.0, 1.0));
        seq.tracks.push(audio);

        // Only the 4.0s picture cut, not the caption at 1.0/2.0 or the music
        // at 5.0/6.0: a still of a caption boundary is what --at-captions is
        // for, and an audio boundary shows nothing at all.
        assert_eq!(times(&at_cuts(&seq, None, FPS)), vec![4.0 - LEAD_SEC, 4.0]);
    }

    #[test]
    fn at_transitions_should_skip_a_blend_the_renderer_refuses() {
        let mut seq = two_shot_sequence();
        // A gap after the outgoing clip leaves nothing to blend into, so the
        // render writes a hard cut and the three blend times name one instant.
        seq.tracks[0].clips[1].place = ClipPlace::new(4.5, 4.0);

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));
        seq.tracks[0].clips[0].effects.push(effect.id.clone());
        let mut effects = HashMap::new();
        effects.insert(effect.id.clone(), effect);

        assert!(
            at_transitions(&seq, &effects, None).is_empty(),
            "a refused transition is a cut, and --at-cuts already covers cuts"
        );
    }

    #[test]
    fn at_cuts_should_ignore_a_disabled_clip_and_a_track_the_export_drops() {
        let mut seq = two_shot_sequence();
        // A third shot butted onto the second, then disabled: its boundary at
        // 8.0 is an edit point but nothing the render cuts at.
        seq.tracks[0].clips.push({
            let mut clip = clip_at("asset-c", 8.0, 4.0);
            clip.enabled = false;
            clip
        });

        let mut hidden = Track::new_video("V2");
        hidden.visible = false;
        hidden.clips.push(clip_at("asset-d", 1.0, 1.0));
        seq.tracks.push(hidden);

        assert_eq!(
            times(&at_cuts(&seq, None, FPS)),
            vec![4.0 - LEAD_SEC, 4.0],
            "only the boundary between two rendered shots is a cut"
        );
    }

    #[test]
    fn at_cuts_should_not_collapse_both_sides_of_a_cut_onto_one_frame() {
        // A muted audio bed five times longer than the picture used to stretch
        // the probe's idea of the sequence length, and both cut samples then
        // snapped to the same frame: two identical stills sold as a before and
        // an after.
        let mut seq = two_shot_sequence();
        let mut music = Track::new("A1", TrackKind::Audio);
        music.muted = true;
        music.clips.push(clip_at("asset-music", 0.0, 40.0));
        seq.tracks.push(music);

        assert_eq!(
            sequence_duration_sec(&seq),
            8.0,
            "a muted track is not in the render, so it is not the length"
        );
        assert_eq!(times(&at_cuts(&seq, None, FPS)), vec![4.0 - LEAD_SEC, 4.0]);
    }

    #[test]
    fn at_captions_should_ignore_a_disabled_caption_and_a_hidden_track() {
        let mut seq = two_shot_sequence();

        let mut captions = Track::new_caption("C1");
        captions.clips.push({
            let mut clip = clip_at("__caption__", 1.0, 2.0);
            clip.enabled = false;
            clip
        });
        seq.tracks.push(captions);

        let mut hidden_titles = Track::new_video("V2");
        hidden_titles.visible = false;
        hidden_titles
            .clips
            .push(clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 5.0, 2.0));
        seq.tracks.push(hidden_titles);

        assert!(
            at_captions(&seq, &HashMap::new(), None).is_empty(),
            "words the render will not draw are not somewhere to look for words"
        );
    }

    #[test]
    fn per_shot_should_sweep_an_overlay_track_the_export_composites() {
        let mut seq = two_shot_sequence();
        let mut overlay = Track::new("V2", TrackKind::Overlay);
        overlay.clips.push(clip_at("asset-inset", 2.0, 2.0));
        seq.tracks.push(overlay);

        assert_eq!(
            times(&per_shot(&seq, None)),
            vec![2.0, 6.0, 3.0],
            "a picture-in-picture inset is a shot the sweep has to look at"
        );
    }

    #[test]
    fn at_markers_should_sample_every_marker() {
        let mut seq = two_shot_sequence();
        seq.markers.push(Marker::new(6.0, "two"));
        seq.markers.push(Marker::new(1.0, "one"));

        let samples = at_markers(&seq, None);

        assert_eq!(times(&samples), vec![1.0, 6.0]);
        assert_eq!(
            sample_reasons(&samples),
            vec![SampleReason::Marker, SampleReason::Marker]
        );
    }

    #[test]
    fn per_shot_should_sample_the_middle_of_every_enabled_shot() {
        let mut seq = two_shot_sequence();
        seq.tracks[0].clips[1].enabled = false;

        let samples = per_shot(&seq, None);

        assert_eq!(times(&samples), vec![2.0]);
        assert_eq!(sample_reasons(&samples), vec![SampleReason::ShotMid]);
    }

    #[test]
    fn per_shot_should_sample_the_part_of_a_straddling_shot_the_range_holds() {
        // The second shot runs 4.0-8.0s and its own midpoint, 6.0s, is outside
        // the restriction. Judging the clip by that midpoint dropped it — which
        // is exactly backwards: a shot that fills the range being looked at is
        // the most important shot in it.
        let samples = per_shot(&two_shot_sequence(), Some(&TimeRange::new(3.0, 5.0)));

        assert_eq!(
            times(&samples),
            vec![3.5, 4.5],
            "each shot is sampled at the middle of its overlap with the range"
        );
    }

    #[test]
    fn per_shot_should_skip_a_track_the_export_leaves_out() {
        let mut seq = two_shot_sequence();
        seq.tracks[0].visible = false;

        assert!(
            per_shot(&seq, None).is_empty(),
            "a hidden track is not in the render, so it is not the edit"
        );
    }

    #[test]
    fn per_shot_should_skip_a_text_clip() {
        let mut seq = two_shot_sequence();
        let mut track = Track::new_video("V2");
        track
            .clips
            .push(clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 1.0, 2.0));
        seq.tracks.push(track);

        assert_eq!(
            times(&per_shot(&seq, None)),
            vec![2.0, 6.0],
            "a title card is not a shot"
        );
    }

    #[test]
    fn at_captions_should_sample_the_middle_of_caption_and_text_spans() {
        let mut seq = two_shot_sequence();

        let mut caption_track = Track::new_caption("C1");
        let mut caption = clip_at("__caption__", 1.0, 2.0);
        caption.label = Some("Hello there".to_string());
        caption_track.clips.push(caption);
        seq.tracks.push(caption_track);

        let mut overlay_track = Track::new_video("V2");
        overlay_track
            .clips
            .push(clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 4.0, 2.0));
        seq.tracks.push(overlay_track);

        let samples = at_captions(&seq, &HashMap::new(), None);

        assert_eq!(times(&samples), vec![2.0, 5.0]);
        assert_eq!(
            sample_reasons(&samples),
            vec![SampleReason::CaptionMid, SampleReason::TextMid]
        );
    }

    #[test]
    fn at_transitions_should_sample_the_start_cut_and_end_of_a_blend() {
        let mut seq = two_shot_sequence();

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));
        seq.tracks[0].clips[0].effects.push(effect.id.clone());
        let mut effects = HashMap::new();
        effects.insert(effect.id.clone(), effect);

        let samples = at_transitions(&seq, &effects, None);

        assert_eq!(
            sample_reasons(&samples),
            vec![
                SampleReason::TransitionStart,
                SampleReason::TransitionCut,
                SampleReason::TransitionEnd
            ]
        );
        // 1.0s at 25fps is 25 frames, which cannot be split evenly: the
        // stitcher gives 12 to the incoming side and 13 to the outgoing one,
        // so the blend really runs 4.0 - 12/25 .. 4.0 + 13/25.
        assert_eq!(times(&samples), vec![3.52, 4.0, 4.52]);
    }

    #[test]
    fn around_should_spread_samples_across_the_window_including_its_edges() {
        let samples = around(&two_shot_sequence(), 4.0, 0.5, 5, names()).expect("window resolves");

        assert_eq!(times(&samples), vec![3.5, 3.75, 4.0, 4.25, 4.5]);
        assert!(samples
            .iter()
            .all(|sample| sample.reason == SampleReason::Around));
    }

    #[test]
    fn around_should_clamp_the_window_into_the_sequence() {
        let samples = around(&two_shot_sequence(), 0.1, 0.5, 3, names()).expect("window resolves");

        assert_close(samples[0].time_sec, 0.0);
        assert_close(samples[2].time_sec, 0.6);
    }

    #[test]
    fn around_should_refuse_a_centre_at_or_past_the_end() {
        // Clamping it silently handed back one still of the last frame as
        // though it were the moment the caller asked about.
        let message = around(&two_shot_sequence(), 8.0, 0.5, 5, names())
            .expect_err("a time outside the sequence is not a window")
            .to_string();

        assert!(
            message.contains("at or past the end") && message.contains("8.000"),
            "the refusal must name the sequence length, got: {message}"
        );
    }

    #[test]
    fn around_should_stop_a_window_at_the_last_decodable_frame() {
        // Seeks resolve forward, so a time inside the final frame's interval
        // has no frame at or after it to return.
        let samples = around(&two_shot_sequence(), 7.9, 0.5, 3, names()).expect("window resolves");

        for sample in &samples {
            assert!(
                sample.time_sec <= 8.0 - LEAD_SEC + 1e-9,
                "a sample at {} would seek past the last frame",
                sample.time_sec
            );
        }
    }

    #[test]
    fn around_should_reject_a_window_with_no_width_or_no_samples() {
        let seq = two_shot_sequence();

        assert!(around(&seq, 1.0, 0.0, 3, names()).is_err());
        assert!(around(&seq, 1.0, 0.5, 0, names()).is_err());
        assert!(around(&seq, -1.0, 0.5, 3, names()).is_err());
    }

    #[test]
    fn affected_should_sample_the_edges_middle_and_cuts_of_a_range() {
        let samples = affected(&[TimeRange::new(2.0, 6.0)], &two_shot_sequence(), FPS);

        assert_eq!(
            sample_reasons(&samples),
            vec![
                SampleReason::AffectedStart,
                SampleReason::CutBefore,
                SampleReason::CutAfter,
                SampleReason::AffectedMid,
                SampleReason::AffectedEnd
            ]
        );
        assert_close(samples[0].time_sec, 2.0);
        assert_close(samples[3].time_sec, 4.0);
        assert_close(samples[4].time_sec, 6.0 - LEAD_SEC);
    }

    #[test]
    fn affected_should_report_a_zero_length_range_as_a_single_midpoint() {
        let samples = affected(&[TimeRange::new(3.0, 3.0)], &two_shot_sequence(), FPS);

        assert_eq!(times(&samples), vec![3.0]);
        assert_eq!(sample_reasons(&samples), vec![SampleReason::AffectedMid]);
    }

    #[test]
    fn normalize_should_keep_the_first_reason_when_a_cut_is_also_a_range_start() {
        let seq = two_shot_sequence();

        // A range starting exactly on the cut: `affectedStart` and `cutAfter`
        // name the same instant, and the range boundary was asked for first.
        let normalized = normalize(&seq, affected(&[TimeRange::new(4.0, 6.0)], &seq, FPS));

        let at_cut: Vec<SampleReason> = normalized
            .iter()
            .filter(|sample| (sample.time_sec - 4.0).abs() < TIME_EPSILON)
            .map(|sample| sample.reason)
            .collect();
        assert_eq!(
            at_cut,
            vec![SampleReason::AffectedStart],
            "the coincident cut must collapse into the range boundary"
        );
    }

    #[test]
    fn normalize_should_drop_times_the_sequence_has_no_content_at() {
        let normalized = normalize(
            &two_shot_sequence(),
            vec![
                Sample::new(-1.0, SampleReason::Around),
                Sample::new(8.0, SampleReason::Around),
                Sample::new(f64::NAN, SampleReason::Around),
                Sample::new(7.9, SampleReason::Around),
            ],
        );

        assert_eq!(times(&normalized), vec![7.9]);
    }

    #[test]
    fn normalize_should_sort_ascending() {
        let normalized = normalize(
            &two_shot_sequence(),
            vec![
                Sample::new(5.0, SampleReason::ShotMid),
                Sample::new(1.0, SampleReason::ShotMid),
                Sample::new(3.0, SampleReason::ShotMid),
            ],
        );

        assert_eq!(times(&normalized), vec![1.0, 3.0, 5.0]);
    }

    #[test]
    fn limit_samples_should_keep_the_first_and_last_and_space_the_rest() {
        let samples: Vec<Sample> = (0..10)
            .map(|index| Sample::new(index as f64, SampleReason::ShotMid))
            .collect();

        let (thinned, limited) = limit_samples(samples, 4, names()).expect("thinning succeeds");

        assert!(limited);
        assert_eq!(times(&thinned), vec![0.0, 3.0, 6.0, 9.0]);
    }

    #[test]
    fn limit_samples_should_never_orphan_half_of_a_cut() {
        // Ten cuts is twenty samples; a budget of twelve is six whole pairs.
        // Thinning by index kept twelve samples that straddled the pairs, so
        // most cells were the `cutBefore` of one cut beside the `cutAfter` of
        // another — a before/after of two unrelated boundaries.
        let samples: Vec<Sample> = (0..10)
            .flat_map(|cut| {
                let cut_sec = 1.0 + cut as f64;
                [
                    Sample::grouped(cut_sec - 0.06, SampleReason::CutBefore, cut),
                    Sample::grouped(cut_sec, SampleReason::CutAfter, cut),
                ]
            })
            .collect();

        let (thinned, limited) = limit_samples(samples, 12, names()).expect("thinning succeeds");

        assert!(limited);
        assert_eq!(thinned.len(), 12, "six whole pairs, not twelve strays");
        for pair in thinned.chunks(2) {
            assert_eq!(
                sample_reasons(pair),
                vec![SampleReason::CutBefore, SampleReason::CutAfter],
                "every kept cell must have its partner: {:?}",
                times(&thinned)
            );
            assert_eq!(
                pair[0].group,
                pair[1].group,
                "the pair has to come from one cut: {:?}",
                times(&thinned)
            );
        }
    }

    #[test]
    fn limit_samples_should_round_a_budget_down_to_whole_transitions() {
        // Three-sample events and a budget of five: two events would need six,
        // so one whole transition is what fits.
        let samples: Vec<Sample> = (0..4)
            .flat_map(|blend| {
                let cut_sec = 2.0 + blend as f64;
                [
                    Sample::grouped(cut_sec - 0.5, SampleReason::TransitionStart, blend),
                    Sample::grouped(cut_sec, SampleReason::TransitionCut, blend),
                    Sample::grouped(cut_sec + 0.5, SampleReason::TransitionEnd, blend),
                ]
            })
            .collect();

        let (thinned, limited) = limit_samples(samples, 5, names()).expect("thinning succeeds");

        assert!(limited);
        assert_eq!(thinned.len(), 3);
        assert_eq!(
            sample_reasons(&thinned),
            vec![
                SampleReason::TransitionStart,
                SampleReason::TransitionCut,
                SampleReason::TransitionEnd
            ]
        );
    }

    #[test]
    fn limit_samples_should_leave_a_short_list_alone() {
        let samples: Vec<Sample> = (0..3)
            .map(|index| Sample::new(index as f64, SampleReason::ShotMid))
            .collect();

        let (kept, limited) = limit_samples(samples, 8, names()).expect("thinning succeeds");

        assert!(!limited);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn limit_samples_should_reject_a_budget_of_nothing() {
        assert!(limit_samples(vec![Sample::new(1.0, SampleReason::Marker)], 0, names()).is_err());
    }

    #[test]
    fn auto_grid_should_widen_the_layout_with_the_sample_count() {
        assert_eq!(auto_grid(1, names()).unwrap(), (1, 1));
        assert_eq!(auto_grid(2, names()).unwrap(), (2, 1));
        assert_eq!(auto_grid(3, names()).unwrap(), (3, 1));
        assert_eq!(auto_grid(9, names()).unwrap(), (3, 3));
        assert_eq!(auto_grid(10, names()).unwrap(), (4, 3));
        assert_eq!(auto_grid(16, names()).unwrap(), (4, 4));
        assert_eq!(auto_grid(17, names()).unwrap(), (6, 3));
    }

    #[test]
    fn auto_grid_should_never_lay_out_more_cells_than_a_sheet_holds() {
        // 100 samples in 6 columns is 17 rows and 102 cells — a layout the very
        // cap that let the count through would then refuse.
        for count in 1..=MAX_GRID_CELLS {
            let (columns, rows) = auto_grid(count, names()).expect("a layout exists");
            assert!(
                columns * rows <= MAX_GRID_CELLS,
                "auto_grid({count}) laid out {columns}x{rows} cells"
            );
            assert!(
                columns * rows >= count,
                "auto_grid({count}) laid out {columns}x{rows}, too few cells"
            );
        }
    }

    #[test]
    fn auto_grid_should_reject_more_samples_than_a_sheet_holds() {
        let message = auto_grid(MAX_GRID_CELLS + 1, names())
            .expect_err("a sheet cannot hold an unbounded sampler")
            .to_string();

        assert!(
            message.contains(&(MAX_GRID_CELLS + 1).to_string())
                && message.contains("--limit")
                && message.contains("--between"),
            "Error should name the count and the ways out, got: {message}"
        );
        assert!(auto_grid(0, names()).is_err());
    }

    #[test]
    fn spec_should_report_which_samplers_ran_and_which_modifiers_are_orphaned() {
        let spec = SamplerSpec {
            at_cuts: true,
            affected: true,
            ..cli_spec()
        };
        assert_eq!(
            spec.kinds(),
            vec!["atCuts".to_string(), "affected".to_string()]
        );
        assert!(spec.orphaned_modifiers().is_empty());

        let orphaned = SamplerSpec {
            limit: Some(4),
            span: Some(0.5),
            ..cli_spec()
        };
        assert!(!orphaned.is_active());
        assert_eq!(orphaned.orphaned_modifiers(), vec!["--span", "--limit"]);
    }

    #[test]
    fn run_should_union_samplers_and_report_the_thinning() {
        let mut seq = two_shot_sequence();
        seq.markers.push(Marker::new(1.0, "one"));
        let effects = HashMap::new();

        let outcome = run(
            &SamplerSpec {
                at_cuts: true,
                at_markers: true,
                per_shot: true,
                limit: Some(3),
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: None,
            },
        )
        .expect("samplers produce times");

        assert_eq!(outcome.report.candidates, 5, "1.0, 2.0, 3.94, 4.0, 6.0");
        assert_eq!(outcome.report.selected, 3);
        assert!(outcome.report.limited);
        // Four events: the marker, two shot midpoints, and the cut — which is
        // two samples that only mean anything together. A budget of three has
        // no room for the pair, so the pair is what goes; keeping half of it
        // would have spent a cell on a still with nothing to compare it to.
        assert_eq!(times(&outcome.samples), vec![1.0, 2.0, 6.0]);
        assert!(outcome.report.affected_ranges.is_none());
        assert_eq!(
            outcome.report.kinds,
            vec![
                "atCuts".to_string(),
                "atMarkers".to_string(),
                "perShot".to_string()
            ]
        );
    }

    #[test]
    fn run_should_refuse_a_sampler_that_found_nothing() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        let message = run(
            &SamplerSpec {
                at_markers: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: None,
            },
        )
        .expect_err("a batch of no pictures is not a success")
        .to_string();

        assert!(
            message.contains("atMarkers") && message.contains("--between"),
            "Error should name the sampler and the fallback, got: {message}"
        );
    }

    #[test]
    fn run_should_say_why_a_timeline_full_of_transitions_has_no_blend_to_sample() {
        let mut seq = two_shot_sequence();
        // A gap after the outgoing clip: the renderer writes a hard cut.
        seq.tracks[0].clips[1].place = ClipPlace::new(4.5, 4.0);

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));
        seq.tracks[0].clips[0].effects.push(effect.id.clone());
        let mut effects = HashMap::new();
        effects.insert(effect.id.clone(), effect);

        let message = run(
            &SamplerSpec {
                at_transitions: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: None,
            },
        )
        .expect_err("a refused transition is no blend")
        .to_string();

        assert!(
            message.contains("renders as a hard cut") && message.contains("--at-cuts"),
            "the refusal must say why there is no blend, got: {message}"
        );
    }

    #[test]
    fn run_should_echo_the_affected_ranges_it_read() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();
        let ranges = vec![TimeRange::new(2.0, 6.0)];

        let outcome = run(
            &SamplerSpec {
                affected: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &ranges,
                restrict: None,
            },
        )
        .expect("the recorded range produces times");

        assert_eq!(outcome.report.affected_ranges, Some(ranges));
    }

    #[test]
    fn run_should_sample_named_ranges_exactly_as_recorded_ones() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();
        let ranges = vec![TimeRange::new(2.0, 6.0)];

        let named = run(
            &SamplerSpec {
                ranges: Some(ranges.clone()),
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                // Deliberately empty: named ranges must not fall back to the
                // record, which is the whole point of naming them.
                affected_ranges: &[],
                restrict: None,
            },
        )
        .expect("named ranges produce times");

        let recorded = run(
            &SamplerSpec {
                affected: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &ranges,
                restrict: None,
            },
        )
        .expect("the recorded range produces times");

        assert_eq!(
            named.samples, recorded.samples,
            "the two range sources must produce the same pictures"
        );
        assert_eq!(named.report.kinds, vec!["ranges".to_string()]);
        assert_eq!(named.report.affected_ranges, Some(ranges));
    }

    /// The restriction a rendered file's declared range becomes: the second
    /// shot only, so the cut at 4.0s is inside it and the first shot is not.
    fn second_shot_only() -> TimeRange {
        TimeRange::new(4.0, 8.0)
    }

    #[test]
    fn run_should_confine_every_sampler_to_the_declared_range() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        let outcome = run(
            &SamplerSpec {
                per_shot: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: Some(second_shot_only()),
            },
        )
        .expect("the second shot is inside the range");

        assert_eq!(
            times(&outcome.samples),
            vec![6.0],
            "the first shot's midpoint at 2.0s is outside the declared range"
        );
    }

    #[test]
    fn run_should_keep_a_cut_lead_that_sits_just_before_the_declared_range() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        let outcome = run(
            &SamplerSpec {
                at_cuts: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: Some(second_shot_only()),
            },
        )
        .expect("the cut at 4.0s is inside the range");

        // The restriction bounds the cuts that are looked at, not the samples
        // they produce: half a cut is a still with nothing to compare it to.
        assert_eq!(
            sample_reasons(&outcome.samples),
            vec![SampleReason::CutBefore, SampleReason::CutAfter]
        );
        assert_close(outcome.samples[0].time_sec, 4.0 - LEAD_SEC);
    }

    #[test]
    fn run_should_clip_named_ranges_to_the_declared_range() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        let outcome = run(
            &SamplerSpec {
                // One range straddling the restriction's start, one wholly
                // outside it.
                ranges: Some(vec![TimeRange::new(2.0, 6.0), TimeRange::new(0.0, 1.0)]),
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: Some(second_shot_only()),
            },
        )
        .expect("the overlapping range still has something to look at");

        assert_eq!(
            outcome.report.affected_ranges,
            Some(vec![TimeRange::new(4.0, 6.0)]),
            "the echoed ranges must be the ones actually sampled"
        );
        for sample in &outcome.samples {
            assert!(
                sample.time_sec >= 4.0 - LEAD_SEC - 1e-9,
                "sample at {} escaped the declared range",
                sample.time_sec
            );
        }
    }

    #[test]
    fn run_should_say_where_it_looked_when_a_restricted_run_finds_nothing() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        let error = run(
            &SamplerSpec {
                at_cuts: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                // The only cut sits at 4.0s, well outside this.
                restrict: Some(TimeRange::new(0.0, 1.0)),
            },
        )
        .expect_err("no cut falls inside the declared range");

        let message = error.to_string();
        assert!(
            message.contains("0.000s") && message.contains("1.000s"),
            "the caller cannot tell an empty sequence from an empty window unless the window is named: {message}"
        );
    }

    #[test]
    fn before_restriction_end_should_exclude_the_end_and_leave_the_start_alone() {
        let restrict = TimeRange::new(2.0, 6.0);

        assert!(before_restriction_end(&restrict, 5.9));
        assert!(
            !before_restriction_end(&restrict, 6.0),
            "translation into the file is exclusive at END, so sampling there only produces a time the file cannot show"
        );
        assert!(
            before_restriction_end(&restrict, 1.9),
            "the START edge belongs to each sampler's own event gate: a cut at the head of the range still owes its outgoing frame"
        );
    }

    #[test]
    fn before_restriction_end_should_keep_a_declared_instant() {
        // A zero-width restriction is a declared instant rather than a stretch,
        // so an exclusive END would empty it.
        let instant = TimeRange::new(3.0, 3.0);

        assert!(before_restriction_end(&instant, 3.0));
    }

    #[test]
    fn run_should_drop_an_event_sitting_exactly_on_the_restrictions_end() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();

        // The only cut is at 4.0s, which is this restriction's END. Its
        // `cutBefore` sample sits inside, so the run still has something to
        // show; the cut itself does not, because the file stops before it.
        let outcome = run(
            &SamplerSpec {
                at_cuts: true,
                ..cli_spec()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
                restrict: Some(TimeRange::new(0.0, 4.0)),
            },
        )
        .expect("the outgoing frame is inside the declared range");

        assert_eq!(
            sample_reasons(&outcome.samples),
            vec![SampleReason::CutBefore],
            "the cut time itself is at END, which the file does not hold"
        );
    }

    #[test]
    fn clip_ranges_should_drop_a_range_that_only_touches_the_restriction() {
        let restrict = TimeRange::new(4.0, 8.0);

        assert!(
            clip_ranges(&[TimeRange::new(1.0, 4.0)], Some(&restrict)).is_empty(),
            "a range ending where the restriction begins has no width inside it,              and a zero-width clip reads as a single-instant change that never happened"
        );
        assert_eq!(
            clip_ranges(&[TimeRange::new(4.0, 4.0)], Some(&restrict)),
            vec![TimeRange::new(4.0, 4.0)],
            "a range that ARRIVED zero-width is a real instant, so it survives"
        );
    }

    #[test]
    fn clip_ranges_should_pass_everything_through_without_a_restriction() {
        let ranges = vec![TimeRange::new(0.0, 1.0), TimeRange::new(5.0, 9.0)];

        assert_eq!(clip_ranges(&ranges, None), ranges);
    }

    #[test]
    fn clip_ranges_should_drop_ranges_that_do_not_overlap() {
        let restrict = TimeRange::new(4.0, 8.0);
        let ranges = vec![
            TimeRange::new(0.0, 1.0),
            TimeRange::new(3.0, 5.0),
            TimeRange::new(9.0, 10.0),
        ];

        assert_eq!(
            clip_ranges(&ranges, Some(&restrict)),
            vec![TimeRange::new(4.0, 5.0)]
        );
    }
}
