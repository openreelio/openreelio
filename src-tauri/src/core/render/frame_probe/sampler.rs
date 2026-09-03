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
//! after `t`. Sampling a cut at `cut - 0.04` and `cut + 0.04` therefore puts
//! *both* cells on the incoming shot on any timebase finer than 25fps. Backing
//! the first sample off by 1.5 frames lands it in the middle of the outgoing
//! shot's last frame, which is the frame a continuity judgement is about.

use std::collections::HashMap;

use serde::Serialize;

use super::{sequence_duration_sec, FrameProbeError, FrameProbeResult, MAX_GRID_CELLS};
use crate::core::effects::Effect;
use crate::core::render::{is_text_clip, track_included_in_export};
use crate::core::timeline::{
    collect_caption_spans, collect_text_spans, collect_transition_spans, Sequence, TrackKind,
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
const CUT_LEAD_FRAMES: f64 = 1.5;

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
    /// The start of a range the last apply changed.
    AffectedStart,
    /// The middle of a range the last apply changed.
    AffectedMid,
    /// The last frame of a range the last apply changed.
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
}

impl Sample {
    fn new(time_sec: f64, reason: SampleReason) -> Self {
        Self { time_sec, reason }
    }
}

/// Which samplers a request asked for, exactly as the caller expressed it.
///
/// Field names mirror the CLI flags they came from. Samplers combine as a union;
/// what they cannot combine with — `--time`, `--times`, `--between`, `--count`,
/// `--asset`, `--file` — is enforced where the selection is resolved, because
/// every surface has to be told the same thing in the same words.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SamplerSpec {
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
    /// `--limit` nothing reads looks to the caller like a budget that was
    /// honoured.
    pub fn orphaned_modifiers(&self) -> Vec<&'static str> {
        if self.is_active() {
            return Vec::new();
        }
        [
            (self.span.is_some(), "--span"),
            (self.around_count.is_some(), "--around-count"),
            (self.limit.is_some(), "--limit"),
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
    pub affected_ranges: &'a [TimeRange],
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
    /// The affected ranges that were read, when `affected` ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_ranges: Option<Vec<TimeRange>>,
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

    let mut raw = Vec::new();
    if spec.at_cuts {
        raw.extend(at_cuts(sequence, None, fps));
    }
    if spec.at_transitions {
        raw.extend(at_transitions(sequence, inputs.effects, None));
    }
    if spec.at_captions {
        raw.extend(at_captions(sequence, inputs.effects, None));
    }
    if spec.at_markers {
        raw.extend(at_markers(sequence, None));
    }
    if spec.per_shot {
        raw.extend(per_shot(sequence, None));
    }
    if let Some(time) = spec.around {
        raw.extend(around(
            sequence,
            time,
            spec.span.unwrap_or(DEFAULT_AROUND_SPAN_SEC),
            spec.around_count.unwrap_or(DEFAULT_AROUND_COUNT),
        )?);
    }
    if spec.affected {
        raw.extend(affected(inputs.affected_ranges, sequence, fps));
    }

    let candidates = normalize(sequence, raw);
    if candidates.is_empty() {
        return Err(FrameProbeError::new(format!(
            "{} found nothing to look at on sequence '{}'. Try another sampler, or --between <START> <END> for an even sweep.",
            spec.kinds().join(" + "),
            sequence.name
        )));
    }

    let candidate_count = candidates.len();
    let (samples, limited) = match spec.limit {
        Some(limit) => limit_samples(candidates, limit)?,
        None => (candidates, false),
    };

    Ok(SamplerOutcome {
        report: SamplerReport {
            kinds: spec.kinds(),
            candidates: candidate_count,
            selected: samples.len(),
            limited,
            affected_ranges: spec.affected.then(|| inputs.affected_ranges.to_vec()),
        },
        samples,
    })
}

// ── Samplers ────────────────────────────────────────────────────────────

/// Samples both sides of every cut inside the sequence.
///
/// A cut is an edit point strictly between the timeline's start and its end;
/// the outer boundaries are not cuts and have no outgoing or incoming shot to
/// compare. `range` restricts which cuts are sampled, not which samples survive:
/// the `cutBefore` frame of a cut at the very start of the range legitimately
/// sits a frame and a half before it.
pub fn at_cuts(sequence: &Sequence, range: Option<&TimeRange>, fps: f64) -> Vec<Sample> {
    let duration_sec = sequence_duration_sec(sequence);
    let lead_sec = cut_lead_sec(fps);

    let mut samples = Vec::new();
    for cut_sec in sequence.collect_edit_points() {
        if cut_sec <= TIME_EPSILON || cut_sec >= duration_sec - TIME_EPSILON {
            continue;
        }
        if !within(range, cut_sec) {
            continue;
        }
        let before_sec = cut_sec - lead_sec;
        if before_sec >= 0.0 {
            samples.push(Sample::new(before_sec, SampleReason::CutBefore));
        }
        samples.push(Sample::new(cut_sec, SampleReason::CutAfter));
    }

    samples
}

/// Samples the start, cut and end of every two-input transition.
///
/// A transition is stored on the outgoing clip and blends *across* the cut, so
/// none of these three times is a clip boundary — which is exactly why they
/// cannot be derived from a clip list.
pub fn at_transitions(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
    range: Option<&TimeRange>,
) -> Vec<Sample> {
    let mut samples = Vec::new();
    for span in collect_transition_spans(sequence, effects) {
        if !within(range, span.cut_sec) {
            continue;
        }
        samples.push(Sample::new(span.start_sec, SampleReason::TransitionStart));
        samples.push(Sample::new(span.cut_sec, SampleReason::TransitionCut));
        samples.push(Sample::new(span.end_sec, SampleReason::TransitionEnd));
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
            let mid_sec = midpoint(span.start_sec, span.end_sec);
            if within(range, mid_sec) {
                samples.push(Sample::new(mid_sec, reason));
            }
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
/// A shot is an enabled, non-text clip on a video track the export includes, so
/// a hidden or muted track contributes nothing: a still of a track that will not
/// be in the render is not a picture of the edit. Text clips are excluded
/// because they are titles rather than shots — `at_captions` covers those.
pub fn per_shot(sequence: &Sequence, range: Option<&TimeRange>) -> Vec<Sample> {
    let mut samples = Vec::new();
    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Video) || !track_included_in_export(track) {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled || is_text_clip(clip) {
                continue;
            }
            let mid_sec = midpoint(clip.place.timeline_in_sec, clip.place.timeline_out_sec());
            if within(range, mid_sec) {
                samples.push(Sample::new(mid_sec, SampleReason::ShotMid));
            }
        }
    }

    samples
}

/// Samples a window centred on one time.
///
/// The window is clamped into the sequence before it is divided, so a request
/// near either edge still returns `count` distinct samples rather than `count`
/// minus however many fell outside.
pub fn around(
    sequence: &Sequence,
    time_sec: f64,
    span_sec: f64,
    count: usize,
) -> FrameProbeResult<Vec<Sample>> {
    if !time_sec.is_finite() || time_sec < 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --around: must be a finite, non-negative time (got {time_sec})"
        )));
    }
    if !span_sec.is_finite() || span_sec <= 0.0 {
        return Err(FrameProbeError::new(format!(
            "Invalid value for --span: must be a positive number of seconds (got {span_sec})"
        )));
    }
    if count == 0 {
        return Err(FrameProbeError::new(
            "Invalid value for --around-count: must be >= 1".to_string(),
        ));
    }

    let duration_sec = sequence_duration_sec(sequence);
    let last_sec = (duration_sec - TIME_EPSILON).max(0.0);
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

/// Samples the ranges the last successful apply changed.
///
/// Each range gets its edges, its middle and every cut inside it: the edges show
/// how the change joins what surrounds it, the middle shows the change itself,
/// and the cuts are where a ripple most often goes wrong. A zero-length range —
/// how a created or deleted marker is recorded — has only a middle.
pub fn affected(ranges: &[TimeRange], sequence: &Sequence, fps: f64) -> Vec<Sample> {
    let lead_sec = cut_lead_sec(fps);

    let mut samples = Vec::new();
    for range in ranges {
        let start_sec = range.start_sec;
        let end_sec = range.end_sec;
        if end_sec - start_sec <= TIME_EPSILON {
            samples.push(Sample::new(start_sec, SampleReason::AffectedMid));
            continue;
        }

        samples.push(Sample::new(start_sec, SampleReason::AffectedStart));
        samples.extend(at_cuts(sequence, Some(range), fps));
        samples.push(Sample::new(
            midpoint(start_sec, end_sec),
            SampleReason::AffectedMid,
        ));

        // The range's own end is the first instant *after* the change, and it is
        // frequently the timeline's end, which holds no frame at all. Back off
        // by the same frame and a half a cut uses.
        let last_sec = end_sec - lead_sec;
        if last_sec > start_sec {
            samples.push(Sample::new(last_sec, SampleReason::AffectedEnd));
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

/// Thins a sample list down to `limit`, keeping its first and last entries.
///
/// Evenly spaced rather than truncated: a caller that asks for twelve frames of
/// a sixty-cut sequence wants twelve frames spread over the whole sequence, not
/// the first twelve cuts and nothing after them.
pub fn limit_samples(samples: Vec<Sample>, limit: usize) -> FrameProbeResult<(Vec<Sample>, bool)> {
    if limit == 0 {
        return Err(FrameProbeError::new(
            "Invalid value for --limit: must be >= 1".to_string(),
        ));
    }
    if samples.len() <= limit {
        return Ok((samples, false));
    }
    if limit == 1 {
        return Ok((vec![samples[0]], true));
    }

    let last_index = samples.len() - 1;
    let thinned = (0..limit)
        .map(|index| samples[index * last_index / (limit - 1)])
        .collect();

    Ok((thinned, true))
}

/// Chooses a contact-sheet layout for `count` samples.
///
/// Columns widen with the sample count so a sheet stays roughly square and its
/// cells stay large enough to judge: two samples read best side by side, a
/// handful as a 3-wide block, and only a long sweep is worth 6 columns of
/// smaller pictures.
pub fn auto_grid(count: usize) -> FrameProbeResult<(usize, usize)> {
    if count == 0 {
        return Err(FrameProbeError::new(
            "A contact sheet needs at least one sample".to_string(),
        ));
    }
    if count > MAX_GRID_CELLS {
        return Err(FrameProbeError::new(format!(
            "The samplers selected {} times, more than the {} cells a contact sheet holds. Add --limit <N>, narrow the sampler, or use --between <START> <END> with an explicit --grid.",
            count, MAX_GRID_CELLS
        )));
    }

    let columns = match count {
        0..=2 => 2,
        3..=9 => 3,
        10..=16 => 4,
        _ => 6,
    };

    Ok((columns, count.div_ceil(columns)))
}

// ── Helpers ─────────────────────────────────────────────────────────────

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

/// Midpoint of a span.
fn midpoint(start_sec: f64, end_sec: f64) -> f64 {
    start_sec + (end_sec - start_sec) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(times(&samples), vec![3.5, 4.0, 4.5]);
    }

    #[test]
    fn around_should_spread_samples_across_the_window_including_its_edges() {
        let samples = around(&two_shot_sequence(), 4.0, 0.5, 5).expect("window resolves");

        assert_eq!(times(&samples), vec![3.5, 3.75, 4.0, 4.25, 4.5]);
        assert!(samples
            .iter()
            .all(|sample| sample.reason == SampleReason::Around));
    }

    #[test]
    fn around_should_clamp_the_window_into_the_sequence() {
        let samples = around(&two_shot_sequence(), 0.1, 0.5, 3).expect("window resolves");

        assert_close(samples[0].time_sec, 0.0);
        assert_close(samples[2].time_sec, 0.6);
    }

    #[test]
    fn around_should_reject_a_window_with_no_width_or_no_samples() {
        let seq = two_shot_sequence();

        assert!(around(&seq, 1.0, 0.0, 3).is_err());
        assert!(around(&seq, 1.0, 0.5, 0).is_err());
        assert!(around(&seq, -1.0, 0.5, 3).is_err());
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

        let (thinned, limited) = limit_samples(samples, 4).expect("thinning succeeds");

        assert!(limited);
        assert_eq!(times(&thinned), vec![0.0, 3.0, 6.0, 9.0]);
    }

    #[test]
    fn limit_samples_should_leave_a_short_list_alone() {
        let samples: Vec<Sample> = (0..3)
            .map(|index| Sample::new(index as f64, SampleReason::ShotMid))
            .collect();

        let (kept, limited) = limit_samples(samples, 8).expect("thinning succeeds");

        assert!(!limited);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn limit_samples_should_reject_a_budget_of_nothing() {
        assert!(limit_samples(vec![Sample::new(1.0, SampleReason::Marker)], 0).is_err());
    }

    #[test]
    fn auto_grid_should_widen_the_layout_with_the_sample_count() {
        assert_eq!(auto_grid(1).unwrap(), (2, 1));
        assert_eq!(auto_grid(2).unwrap(), (2, 1));
        assert_eq!(auto_grid(3).unwrap(), (3, 1));
        assert_eq!(auto_grid(9).unwrap(), (3, 3));
        assert_eq!(auto_grid(10).unwrap(), (4, 3));
        assert_eq!(auto_grid(16).unwrap(), (4, 4));
        assert_eq!(auto_grid(17).unwrap(), (6, 3));
        assert_eq!(auto_grid(MAX_GRID_CELLS).unwrap(), (6, 17));
    }

    #[test]
    fn auto_grid_should_reject_more_samples_than_a_sheet_holds() {
        let message = auto_grid(MAX_GRID_CELLS + 1)
            .expect_err("a sheet cannot hold an unbounded sampler")
            .to_string();

        assert!(
            message.contains(&(MAX_GRID_CELLS + 1).to_string())
                && message.contains("--limit")
                && message.contains("--between"),
            "Error should name the count and the ways out, got: {message}"
        );
        assert!(auto_grid(0).is_err());
    }

    #[test]
    fn spec_should_report_which_samplers_ran_and_which_modifiers_are_orphaned() {
        let spec = SamplerSpec {
            at_cuts: true,
            affected: true,
            ..SamplerSpec::default()
        };
        assert_eq!(
            spec.kinds(),
            vec!["atCuts".to_string(), "affected".to_string()]
        );
        assert!(spec.orphaned_modifiers().is_empty());

        let orphaned = SamplerSpec {
            limit: Some(4),
            span: Some(0.5),
            ..SamplerSpec::default()
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
                ..SamplerSpec::default()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
            },
        )
        .expect("samplers produce times");

        assert_eq!(outcome.report.candidates, 5, "1.0, 2.0, 3.94, 4.0, 6.0");
        assert_eq!(outcome.report.selected, 3);
        assert!(outcome.report.limited);
        assert_eq!(times(&outcome.samples), vec![1.0, 3.94, 6.0]);
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
                ..SamplerSpec::default()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &[],
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
    fn run_should_echo_the_affected_ranges_it_read() {
        let seq = two_shot_sequence();
        let effects = HashMap::new();
        let ranges = vec![TimeRange::new(2.0, 6.0)];

        let outcome = run(
            &SamplerSpec {
                affected: true,
                ..SamplerSpec::default()
            },
            &SamplerInputs {
                sequence: &seq,
                effects: &effects,
                affected_ranges: &ranges,
            },
        )
        .expect("the recorded range produces times");

        assert_eq!(outcome.report.affected_ranges, Some(ranges));
    }
}
