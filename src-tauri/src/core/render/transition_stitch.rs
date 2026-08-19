//! Two-input transitions rendered as real `xfade` overlaps that spend no
//! timeline time.
//!
//! # The handle method
//!
//! A transition of length `D` is stored on the *outgoing* clip of a boundary —
//! the clip that ends at the cut (see
//! [`generate_steps_with_transitions`](crate::core::analysis::style_planner)).
//! Overlapping the two clips by `D` the naive way shortens the picture by `D`
//! while every clip's audio stays at its absolute timeline position, so the
//! render drifts out of sync and ends before [`Sequence::output_duration`].
//!
//! Instead both clips reach *outward* into source media the edit is not using:
//! the outgoing clip plays `D/2` past its out point and the incoming clip
//! starts `D/2` before its in point. Those extensions are handles. `xfade` then
//! eats exactly `D` of the combined stream, so
//!
//! ```text
//! (slot_a + D/2) + (slot_b + D/2) - D  ==  slot_a + slot_b
//! ```
//!
//! and the boundary blends without moving a single frame of the timeline.
//! [`Sequence::output_duration`] stays the render's length by construction.
//!
//! The price is that a transition needs unused source media on both sides. A
//! clip already using its source to the last frame has no handle, and the
//! boundary degrades to a cut with a warning that says which side ran out.
//!
//! # Frame exactness
//!
//! `xfade`'s `offset` is a position in the stream feeding its first input, so
//! it has to be derived from that stream's real frame count. Two things keep
//! that count knowable:
//!
//! 1. Every segment that takes part in a transition is pinned to an exact frame
//!    count (`tpad` to guarantee length, `trim=end_frame` to cap it) — see
//!    [`append_video_stream_normalization`](super::export::append_video_stream_normalization).
//! 2. A run of transition-linked segments is folded into a single stream
//!    *before* it reaches the timeline stitch, so the offsets depend only on the
//!    clips in that run. Black gap fillers and unrelated segments elsewhere in
//!    the timeline cannot shift them — which matters because `color` sources
//!    round their final frame differently across FFmpeg releases.
//!
//! Every length in this module is therefore counted in frames and converted to
//! seconds only when a filter parameter is formatted.

use std::collections::HashMap;

use crate::core::{
    assets::Asset,
    effects::{effect_type_label, Effect, IntoFFmpegFilter, ParamValue},
    timeline::{Clip, Sequence, Track, TrackKind},
};

use super::export::{is_text_clip, ExportError, VideoTimelineSegment, TIMELINE_EPSILON_SEC};

/// Longest transition the engine will place, in seconds.
///
/// Not a technical limit — a guard against a `duration` param that is really a
/// millisecond value, or a typo, quietly eating a whole shot.
const MAX_TRANSITION_SEC: f64 = 10.0;

/// Slack, in frames, required beyond the handle a transition needs.
///
/// The render path reads an asset's length from the probe the export already
/// ran; validation, which has no probe results to hand, measures the file
/// itself. The two agree on any real file, but they are separate measurements
/// and a sub-frame disagreement about a container's duration must not be able
/// to flip eligibility — and with it whether the warning the caller reads
/// matches the file it gets.
const HANDLE_SLACK_FRAMES: f64 = 1.0;

// =============================================================================
// Planned transitions
// =============================================================================

/// A boundary the render will blend, with every length already in frames.
#[derive(Clone, Debug)]
pub(super) struct PlannedTransition {
    /// Clip that ends at the cut and carries the effect.
    pub outgoing_clip_id: String,
    /// Clip that starts at the cut.
    pub incoming_clip_id: String,
    /// Total overlap, in output frames. Always at least 1.
    pub frames: u32,
    /// Frames of the outgoing clip that play past the cut.
    pub tail_frames: u32,
    /// Frames of the incoming clip that play before the cut.
    pub head_frames: u32,
    /// The stored effect. `offset` is injected at the stitch, never here.
    pub effect: Effect,
    /// Output frame rate the frame counts were derived against.
    pub fps: f64,
}

impl PlannedTransition {
    /// Overlap length in seconds, quantised to whole output frames.
    pub(super) fn duration_sec(&self) -> f64 {
        self.frames as f64 / self.fps
    }

    /// Seconds of timeline the outgoing clip plays past its out point.
    pub(super) fn tail_sec(&self) -> f64 {
        self.tail_frames as f64 / self.fps
    }

    /// Seconds of timeline the incoming clip plays before its in point.
    pub(super) fn head_sec(&self) -> f64 {
        self.head_frames as f64 / self.fps
    }
}

/// How far one clip's render window reaches beyond its timeline slot.
///
/// Timeline seconds, not source seconds: a clip playing at 2x consumes twice
/// this much source media per second of handle, which is why the trim builders
/// scale by the clip's speed rather than using these values directly.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct ClipHandles {
    /// Seconds the render window starts before the clip's in point.
    pub head_sec: f64,
    /// Seconds the render window runs past the clip's out point.
    pub tail_sec: f64,
}

impl ClipHandles {
    /// Whether this clip renders exactly its own slot, as it always did.
    pub(super) fn is_none(&self) -> bool {
        self.head_sec <= 0.0 && self.tail_sec <= 0.0
    }
}

/// The constant-power fades a transition adds to one clip's audio branch.
///
/// Unlike the picture, the sound is not overlapped by a filter that consumes
/// frames: both branches keep their own place in the master mix and simply fade
/// through each other. Because the handles put the outgoing branch's tail and
/// the incoming branch's head over the same stretch of the timeline, a `qsin`
/// pair summed by the mix's `normalize=0` holds the level flat across the blend.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct EngineAudioFades {
    /// Fade-in length at the head of the branch, in seconds.
    pub fade_in_sec: f64,
    /// Fade-out length at the tail of the branch, in seconds.
    pub fade_out_sec: f64,
}

impl EngineAudioFades {
    /// Whether this branch is left exactly as the editor authored it.
    pub(super) fn is_none(&self) -> bool {
        self.fade_in_sec <= 0.0 && self.fade_out_sec <= 0.0
    }
}

/// A stored two-input transition the render will not blend, and why.
#[derive(Clone, Debug)]
pub(super) struct TransitionRefusal {
    /// Clip carrying the effect.
    pub clip_id: String,
    /// Track the clip sits on, for the message.
    pub track_name: String,
    /// Human-readable effect name.
    pub effect_label: String,
    /// What stopped it, phrased so the caller can act on it.
    pub reason: String,
}

impl TransitionRefusal {
    /// The warning text the export reports for this refusal.
    pub(super) fn warning(&self) -> String {
        format!(
            "Transition effect '{}' on clip '{}' on track '{}' renders as a cut: {}",
            self.effect_label, self.clip_id, self.track_name, self.reason
        )
    }
}

/// Every renderable transition in a sequence, plus the ones that were refused.
#[derive(Clone, Debug, Default)]
pub(super) struct TransitionPlan {
    /// Keyed by the outgoing clip's id.
    by_outgoing: HashMap<String, PlannedTransition>,
    /// Incoming clip id to the transition that ends on it.
    by_incoming: HashMap<String, String>,
    refusals: Vec<TransitionRefusal>,
}

impl TransitionPlan {
    /// The transition that starts at this clip's out point, if any.
    pub(super) fn transition_after(&self, clip_id: &str) -> Option<&PlannedTransition> {
        self.by_outgoing.get(clip_id)
    }

    /// The transition that ends at this clip's in point, if any.
    pub(super) fn transition_before(&self, clip_id: &str) -> Option<&PlannedTransition> {
        self.by_incoming
            .get(clip_id)
            .and_then(|outgoing| self.by_outgoing.get(outgoing))
    }

    /// How far this clip's render window reaches beyond its timeline slot.
    pub(super) fn handles(&self, clip_id: &str) -> ClipHandles {
        ClipHandles {
            head_sec: self
                .transition_before(clip_id)
                .map(PlannedTransition::head_sec)
                .unwrap_or(0.0),
            tail_sec: self
                .transition_after(clip_id)
                .map(PlannedTransition::tail_sec)
                .unwrap_or(0.0),
        }
    }

    /// The fades a clip's audio branch needs to blend through its neighbours.
    pub(super) fn audio_fades(&self, clip_id: &str) -> EngineAudioFades {
        EngineAudioFades {
            fade_in_sec: self
                .transition_before(clip_id)
                .map(PlannedTransition::duration_sec)
                .unwrap_or(0.0),
            fade_out_sec: self
                .transition_after(clip_id)
                .map(PlannedTransition::duration_sec)
                .unwrap_or(0.0),
        }
    }

    /// Whether a clip takes part in any transition.
    pub(super) fn touches(&self, clip_id: &str) -> bool {
        self.by_outgoing.contains_key(clip_id) || self.by_incoming.contains_key(clip_id)
    }

    /// The transitions that will not be rendered, with their reasons.
    pub(super) fn refusals(&self) -> &[TransitionRefusal] {
        &self.refusals
    }

    /// Whether anything at all will be blended.
    pub(super) fn is_empty(&self) -> bool {
        self.by_outgoing.is_empty()
    }
}

// =============================================================================
// Planning
// =============================================================================

/// The first enabled two-input transition on a clip, if it carries one.
fn two_input_transition_on<'a>(
    clip: &Clip,
    effects: &'a HashMap<String, Effect>,
) -> Option<&'a Effect> {
    clip.effects
        .iter()
        .filter_map(|effect_id| effects.get(effect_id))
        .find(|effect| effect.enabled && effect.effect_type.is_two_input_transition())
}

/// Whether a clip's render window can be moved into unused source media at all.
///
/// A frozen, reversed or time-remapped clip does not map timeline seconds onto
/// source seconds the way the handle math assumes, so the engine refuses rather
/// than guessing.
fn clip_supports_handles(clip: &Clip) -> bool {
    !clip.freeze_frame && !clip.reverse && !clip.has_time_remap()
}

/// The name for a clip in a refusal message.
fn describe_side(is_outgoing: bool) -> &'static str {
    if is_outgoing {
        "outgoing"
    } else {
        "incoming"
    }
}

/// Whether this clip contributes a picture the stitch can blend.
fn renders_picture(clip: &Clip, track: &Track) -> bool {
    matches!(track.kind, TrackKind::Video)
        && track.visible
        && clip.enabled
        && !clip.is_adjustment_layer()
        && !is_text_clip(clip)
}

/// A candidate boundary before the cross-clip checks run.
struct Candidate {
    transition: PlannedTransition,
    outgoing_slot_frames: u32,
}

/// Plans every two-input transition in a sequence.
///
/// `source_duration` answers "how long is this asset's media", and is allowed
/// to say it does not know: an outgoing clip whose source length is unknown
/// cannot be proven to have a handle, so its transition is refused rather than
/// rendered into a black tail.
pub(super) fn plan_sequence_transitions(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    fps: f64,
    mut source_duration: impl FnMut(&Asset) -> Option<f64>,
) -> TransitionPlan {
    let mut plan = TransitionPlan::default();

    if !fps.is_finite() || fps <= 0.0 {
        return plan;
    }

    let frame_sec = 1.0 / fps;
    let mut candidates: Vec<Candidate> = Vec::new();

    for track in &sequence.tracks {
        let mut clips: Vec<&Clip> = track.clips.iter().filter(|clip| clip.enabled).collect();
        clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .partial_cmp(&b.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (index, clip) in clips.iter().enumerate() {
            let Some(effect) = two_input_transition_on(clip, effects) else {
                continue;
            };

            let label = effect_type_label(&effect.effect_type);
            let refuse = |reason: String| TransitionRefusal {
                clip_id: clip.id.clone(),
                track_name: track.name.clone(),
                effect_label: label.clone(),
                reason,
            };

            if !renders_picture(clip, track) {
                plan.refusals.push(refuse(
                    "it is not on a visible video track, so there is no picture to blend"
                        .to_string(),
                ));
                continue;
            }

            let Some(next) = clips.get(index + 1).copied().filter(|next| {
                (next.place.timeline_in_sec - clip.place.timeline_out_sec()).abs()
                    <= TIMELINE_EPSILON_SEC
            }) else {
                plan.refusals.push(refuse(
                    "no clip starts where it ends on this track, so there is nothing to blend into"
                        .to_string(),
                ));
                continue;
            };

            if !renders_picture(next, track) {
                plan.refusals.push(refuse(format!(
                    "the incoming clip '{}' contributes no picture to blend into",
                    next.id
                )));
                continue;
            }

            let unsupported = [(true, *clip), (false, next)]
                .into_iter()
                .find(|(_, side)| !clip_supports_handles(side));
            if let Some((is_outgoing, side)) = unsupported {
                plan.refusals.push(refuse(format!(
                    "the {} clip '{}' is frozen, reversed or time-remapped, so its render window \
                     cannot reach into unused source media",
                    describe_side(is_outgoing),
                    side.id
                )));
                continue;
            }

            let requested_sec = effect.get_float("duration").unwrap_or(1.0);
            if !requested_sec.is_finite() || requested_sec <= 0.0 {
                plan.refusals.push(refuse(format!(
                    "its duration of {requested_sec}s is not a positive length"
                )));
                continue;
            }
            if requested_sec > MAX_TRANSITION_SEC {
                plan.refusals.push(refuse(format!(
                    "its duration of {requested_sec:.3}s is longer than the {MAX_TRANSITION_SEC:.0}s \
                     the engine will place"
                )));
                continue;
            }

            let frames = (requested_sec * fps).round().max(1.0) as u32;
            let duration_sec = frames as f64 / fps;
            let outgoing_slot = clip.place.duration_sec;
            let incoming_slot = next.place.duration_sec;
            let shortest_slot = outgoing_slot.min(incoming_slot);

            if duration_sec > shortest_slot - TIMELINE_EPSILON_SEC {
                plan.refusals.push(refuse(format!(
                    "its {duration_sec:.3}s is not shorter than the {shortest_slot:.3}s shot it \
                     sits on; shorten the transition or lengthen the clips"
                )));
                continue;
            }

            // An odd frame count cannot be split evenly. The extra frame goes to
            // the outgoing side so the blend still starts on the cut's frame.
            let head_frames = frames / 2;
            let tail_frames = frames - head_frames;

            let mut insufficient: Option<String> = None;
            for (is_outgoing, side, needed_frames) in
                [(true, *clip, tail_frames), (false, next, head_frames)]
            {
                let needed_sec =
                    (needed_frames as f64 + HANDLE_SLACK_FRAMES) * frame_sec * side.safe_speed();

                if is_outgoing {
                    let Some(asset) = assets.get(&side.asset_id) else {
                        insufficient = Some(format!(
                            "the outgoing clip's asset '{}' is missing",
                            side.asset_id
                        ));
                        break;
                    };
                    let Some(available) =
                        source_duration(asset).filter(|d| d.is_finite() && *d > 0.0)
                    else {
                        insufficient = Some(format!(
                            "the length of '{}' is unknown, so the outgoing clip cannot be shown \
                             to have {:.3}s of unused media after its out point — run an analysis \
                             or re-import the asset so it is probed",
                            asset.id,
                            needed_frames as f64 * frame_sec * side.safe_speed()
                        ));
                        break;
                    };
                    if side.range.source_out_sec + needed_sec > available {
                        insufficient = Some(format!(
                            "the outgoing clip '{}' ends {:.3}s from the end of its source, which \
                             is less than the {:.3}s handle a {duration_sec:.3}s transition needs",
                            side.id,
                            (available - side.range.source_out_sec).max(0.0),
                            needed_sec
                        ));
                        break;
                    }
                } else if side.range.source_in_sec - needed_sec < 0.0 {
                    insufficient = Some(format!(
                        "the incoming clip '{}' starts {:.3}s into its source, which is less than \
                         the {:.3}s handle a {duration_sec:.3}s transition needs",
                        side.id,
                        side.range.source_in_sec.max(0.0),
                        needed_sec
                    ));
                    break;
                }
            }

            if let Some(reason) = insufficient {
                plan.refusals.push(refuse(reason));
                continue;
            }

            let mut planned_effect = effect.clone();
            planned_effect.set_param("duration", ParamValue::Float(duration_sec));

            candidates.push(Candidate {
                transition: PlannedTransition {
                    outgoing_clip_id: clip.id.clone(),
                    incoming_clip_id: next.id.clone(),
                    frames,
                    tail_frames,
                    head_frames,
                    effect: planned_effect,
                    fps,
                },
                outgoing_slot_frames: (outgoing_slot * fps).round().max(0.0) as u32,
            });
        }
    }

    admit_candidates(&mut plan, candidates);
    plan.refusals.sort_by(|a, b| a.clip_id.cmp(&b.clip_id));
    plan
}

/// Admits candidates in timeline order.
///
/// A clip between two transitions gives a handle to each: the incoming half of
/// the boundary before it and the outgoing half of the boundary after it. Those
/// two must fit inside the clip, or its audio would still be fading in when the
/// fade-out began and its picture would be blended over its whole length.
///
/// Refusing a transition that is not shorter than *both* the shots it joins
/// already guarantees this. With `d1 < slot` and `d2 < slot`, the handles come
/// to `d1/2 + d2/2 < slot` for any pair, so the invariant holds by arithmetic
/// rather than by a second check — which is why it is asserted here instead of
/// producing a refusal message no caller could ever read.
fn admit_candidates(plan: &mut TransitionPlan, candidates: Vec<Candidate>) {
    let mut claimed_head: HashMap<String, u32> = HashMap::new();
    for candidate in &candidates {
        claimed_head.insert(
            candidate.transition.incoming_clip_id.clone(),
            candidate.transition.head_frames,
        );
    }

    for candidate in candidates {
        let Candidate {
            transition,
            outgoing_slot_frames,
            ..
        } = candidate;

        let head_claim = claimed_head
            .get(&transition.outgoing_clip_id)
            .copied()
            .unwrap_or(0);
        debug_assert!(
            head_claim + transition.tail_frames < outgoing_slot_frames,
            "clip '{}' cannot give {} head and {} tail frames out of {}",
            transition.outgoing_clip_id,
            head_claim,
            transition.tail_frames,
            outgoing_slot_frames
        );

        plan.by_incoming.insert(
            transition.incoming_clip_id.clone(),
            transition.outgoing_clip_id.clone(),
        );
        plan.by_outgoing
            .insert(transition.outgoing_clip_id.clone(), transition);
    }
}

// =============================================================================
// Video stitch
// =============================================================================

/// Folds every run of transition-linked segments into one blended stream.
///
/// Returns the segment list the timeline stitch should concatenate: each fold
/// replaces its run with a single segment spanning the same timeline range, so
/// the caller's black-gap and tail-padding logic is untouched and the finished
/// video is still exactly as long as the timeline says.
pub(super) fn stitch_transition_groups(
    filter_complex: &mut String,
    segments: Vec<VideoTimelineSegment>,
    plan: &TransitionPlan,
    fps: f64,
) -> Result<Vec<VideoTimelineSegment>, ExportError> {
    if plan.is_empty() || !fps.is_finite() || fps <= 0.0 {
        return Ok(segments);
    }

    let mut ordered = segments;
    ordered.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut stitched: Vec<VideoTimelineSegment> = Vec::with_capacity(ordered.len());
    let mut group_index = 0_usize;
    let mut cursor = 0_usize;

    while cursor < ordered.len() {
        let mut end = cursor;
        while end + 1 < ordered.len() && links(&ordered[end], &ordered[end + 1], plan) {
            end += 1;
        }

        if end == cursor {
            stitched.push(ordered[cursor].clone());
            cursor += 1;
            continue;
        }

        let group = &ordered[cursor..=end];
        stitched.push(fold_group(filter_complex, group, plan, fps, group_index)?);
        group_index += 1;
        cursor = end + 1;
    }

    Ok(stitched)
}

/// Whether these two segments are the two sides of one planned transition.
fn links(left: &VideoTimelineSegment, right: &VideoTimelineSegment, plan: &TransitionPlan) -> bool {
    let (Some(left_id), Some(right_id)) = (left.clip_id.as_deref(), right.clip_id.as_deref())
    else {
        return false;
    };

    plan.transition_after(left_id)
        .is_some_and(|transition| transition.incoming_clip_id == right_id)
}

/// The frame count one segment's stream carries, handles included.
fn segment_frames(segment: &VideoTimelineSegment, plan: &TransitionPlan, fps: f64) -> u32 {
    let handles = segment
        .clip_id
        .as_deref()
        .map(|clip_id| plan.handles(clip_id))
        .unwrap_or_default();
    let span = (segment.end_sec - segment.start_sec).max(0.0) + handles.head_sec + handles.tail_sec;
    (span * fps).round().max(1.0) as u32
}

/// Folds one run of linked segments left to right into a single stream.
fn fold_group(
    filter_complex: &mut String,
    group: &[VideoTimelineSegment],
    plan: &TransitionPlan,
    fps: f64,
    group_index: usize,
) -> Result<VideoTimelineSegment, ExportError> {
    let mut accumulated_label = group[0].stream_label.clone();
    let mut accumulated_frames = segment_frames(&group[0], plan, fps);

    for (step, segment) in group.iter().enumerate().skip(1) {
        let previous_id = group[step - 1].clip_id.as_deref().unwrap_or_default();
        let transition = plan.transition_after(previous_id).ok_or_else(|| {
            ExportError::InvalidSettings(format!(
                "Transition stitch lost the boundary after clip '{previous_id}'"
            ))
        })?;

        // Frames of the accumulated stream that play before the blend starts.
        let pass_through = accumulated_frames
            .checked_sub(transition.frames)
            .filter(|frames| *frames >= 1)
            .ok_or_else(|| {
                ExportError::InvalidSettings(format!(
                    "Transition on clip '{}' is longer than the picture before it",
                    transition.outgoing_clip_id
                ))
            })?;

        // `xfade` rescales `offset` into its input's time base with
        // round-to-nearest and then passes through every frame whose PTS is
        // below it, so a whole number of frames is what it wants and landing
        // exactly on one leaves half a frame of margin either side. That margin
        // is what absorbs the four decimal places the filter body is formatted
        // to — and it holds whatever time base the link happens to carry.
        let offset_sec = pass_through as f64 / fps;

        let mut effect = transition.effect.clone();
        effect.set_param("offset", ParamValue::Float(offset_sec));
        effect.set_param("duration", ParamValue::Float(transition.duration_sec()));

        let output_label = format!("[vxf{group_index}_{step}]");
        // Every input to `xfade` is a full-canvas frame at the output frame
        // rate, SAR 1 and the output pixel format — `append_video_stream_normalization`
        // and `append_video_transform_composition` both end in exactly that
        // shape — so the two inputs are compatible by construction.
        filter_complex.push_str(&format!(
            "{}{}{}{};",
            accumulated_label,
            segment.stream_label,
            effect.to_filter_body(),
            output_label
        ));

        accumulated_frames = pass_through + segment_frames(segment, plan, fps);
        accumulated_label = output_label;
    }

    let start_sec = group[0].start_sec;
    let end_sec = group[group.len() - 1].end_sec;

    // The handles cancel: `xfade` eats exactly as many frames as the two sides
    // added, so the fold lands back on the timeline it started from.
    debug_assert_eq!(
        accumulated_frames,
        ((end_sec - start_sec) * fps).round().max(1.0) as u32,
        "a transition group must occupy exactly its timeline span"
    );

    Ok(VideoTimelineSegment::new(
        accumulated_label,
        start_sec,
        end_sec,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::VideoInfo;
    use crate::core::effects::EffectType;
    use crate::core::timeline::{SequenceFormat, Track};

    const FPS: f64 = 30.0;

    fn dissolve(duration_sec: f64) -> Effect {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.id = format!("dissolve-{duration_sec}");
        effect.set_param("duration", ParamValue::Float(duration_sec));
        effect.enabled = true;
        effect
    }

    /// One clip in a planner fixture.
    struct ClipSpec {
        source_in: f64,
        source_out: f64,
        timeline_in: f64,
        /// How long the asset's media runs, which decides the handles.
        source_length: f64,
        transition: Option<Effect>,
    }

    /// A sequence plus the maps the planner needs to read it.
    type Fixture = (
        Sequence,
        HashMap<String, Asset>,
        HashMap<String, Effect>,
        HashMap<String, f64>,
    );

    fn build(specs: Vec<ClipSpec>) -> Fixture {
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        let mut assets = HashMap::new();
        let mut effects = HashMap::new();
        let mut lengths = HashMap::new();

        for (index, spec) in specs.into_iter().enumerate() {
            let asset_id = format!("asset{index}");
            let mut clip = Clip::new(&asset_id)
                .with_source_range(spec.source_in, spec.source_out)
                .place_at(spec.timeline_in);
            clip.id = format!("clip{index}");

            if let Some(effect) = spec.transition {
                clip.effects.push(effect.id.clone());
                effects.insert(effect.id.clone(), effect);
            }
            track.add_clip(clip);

            let mut asset = Asset::new_video(&asset_id, "/tmp/x.mp4", VideoInfo::default());
            asset.id = asset_id.clone();
            assets.insert(asset_id.clone(), asset);
            lengths.insert(asset_id, spec.source_length);
        }

        sequence.add_track(track);
        (sequence, assets, effects, lengths)
    }

    fn plan_for(specs: Vec<ClipSpec>) -> TransitionPlan {
        let (sequence, assets, effects, lengths) = build(specs);
        plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        })
    }

    fn with_handles(timeline_in: f64, length: f64, transition: Option<Effect>) -> ClipSpec {
        // Two seconds of unused media either side of the used range.
        ClipSpec {
            source_in: 2.0,
            source_out: 2.0 + length,
            timeline_in,
            source_length: length + 4.0,
            transition,
        }
    }

    #[test]
    fn should_plan_a_centred_overlap_when_both_sides_have_handles() {
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);

        let transition = plan
            .transition_after("clip0")
            .expect("an eligible dissolve must be planned");
        assert_eq!(transition.frames, 30, "1s at 30fps is 30 frames");
        assert_eq!(transition.head_frames, 15);
        assert_eq!(transition.tail_frames, 15);
        assert_eq!(plan.handles("clip0").tail_sec, 0.5);
        assert_eq!(plan.handles("clip1").head_sec, 0.5);
        assert!(plan.refusals().is_empty(), "{:?}", plan.refusals());
    }

    #[test]
    fn should_refuse_when_the_outgoing_clip_has_no_media_after_its_out_point() {
        let plan = plan_for(vec![
            ClipSpec {
                source_in: 0.0,
                source_out: 5.0,
                timeline_in: 0.0,
                source_length: 5.0,
                transition: Some(dissolve(1.0)),
            },
            with_handles(5.0, 5.0, None),
        ]);

        assert!(plan.is_empty(), "a handleless boundary must not be blended");
        let reason = &plan.refusals()[0].reason;
        assert!(
            reason.contains("outgoing clip") && reason.contains("handle"),
            "the refusal must name the side that ran out: {reason}"
        );
    }

    #[test]
    fn should_refuse_when_the_incoming_clip_starts_at_the_head_of_its_source() {
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            ClipSpec {
                source_in: 0.0,
                source_out: 5.0,
                timeline_in: 5.0,
                source_length: 9.0,
                transition: None,
            },
        ]);

        assert!(plan.is_empty());
        let reason = &plan.refusals()[0].reason;
        assert!(
            reason.contains("incoming clip"),
            "the refusal must name the side that ran out: {reason}"
        );
    }

    #[test]
    fn should_refuse_when_no_clip_starts_where_the_carrier_ends() {
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(7.0, 5.0, None),
        ]);

        assert!(plan.is_empty());
        assert!(
            plan.refusals()[0].reason.contains("nothing to blend into"),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_refuse_a_transition_that_is_not_shorter_than_its_shots() {
        let plan = plan_for(vec![
            with_handles(0.0, 1.0, Some(dissolve(2.0))),
            with_handles(1.0, 5.0, None),
        ]);

        assert!(plan.is_empty());
        assert!(
            plan.refusals()[0].reason.contains("shorter"),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_let_one_clip_give_a_handle_to_each_of_its_neighbours() {
        // The middle clip is only 1.2s and gives 0.5s to each side. Both
        // boundaries survive, and the clip is left with 0.2s of its own.
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 1.2, Some(dissolve(1.0))),
            with_handles(6.2, 5.0, None),
        ]);

        assert!(plan.refusals().is_empty(), "{:?}", plan.refusals());
        assert!(plan.transition_after("clip0").is_some());
        assert!(plan.transition_after("clip1").is_some());

        let middle = plan.handles("clip1");
        assert_eq!(middle.head_sec, 0.5);
        assert_eq!(middle.tail_sec, 0.5);
        assert_eq!(
            plan.audio_fades("clip1"),
            EngineAudioFades {
                fade_in_sec: 1.0,
                fade_out_sec: 1.0,
            },
            "the middle clip fades in through one boundary and out through the next"
        );
    }

    #[test]
    fn should_refuse_a_transition_as_long_as_the_shot_it_sits_between() {
        // The guard that keeps a middle clip's two handles from colliding is an
        // arithmetic consequence of this refusal, so this is what enforces it.
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 1.0, Some(dissolve(1.0))),
            with_handles(6.0, 5.0, None),
        ]);

        assert!(
            plan.transition_after("clip1").is_none(),
            "a 1.0s transition does not fit in a 1.0s shot"
        );
        assert!(
            plan.refusals()
                .iter()
                .any(|refusal| refusal.reason.contains("shorter")),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_refuse_a_frozen_clip() {
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        sequence.tracks[0].clips[1].freeze_frame = true;

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(plan.is_empty());
        assert!(
            plan.refusals()[0].reason.contains("frozen"),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_scale_the_handle_by_clip_speed() {
        // At 2x, 0.5s of timeline handle eats 1.0s of source. A clip with only
        // 0.6s of media past its out point cannot afford it.
        let (mut sequence, assets, effects, lengths) = build(vec![
            ClipSpec {
                source_in: 2.0,
                source_out: 7.0,
                timeline_in: 0.0,
                source_length: 7.6,
                transition: Some(dissolve(1.0)),
            },
            with_handles(2.5, 5.0, None),
        ]);
        sequence.tracks[0].clips[0].speed = 2.0;
        sequence.tracks[0].clips[0].place.duration_sec = 2.5;

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(plan.is_empty(), "0.6s of media cannot cover a 1.0s reach");
    }

    #[test]
    fn should_refuse_when_the_source_length_is_unknown() {
        let (sequence, assets, effects, _lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |_| None);

        assert!(plan.is_empty());
        assert!(
            plan.refusals()[0].reason.contains("unknown"),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_split_an_odd_frame_count_without_losing_a_frame() {
        // 0.5s at 30fps is 15 frames: 7 before the cut, 8 after.
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(0.5))),
            with_handles(5.0, 5.0, None),
        ]);

        let transition = plan.transition_after("clip0").expect("planned");
        assert_eq!(transition.frames, 15);
        assert_eq!(
            transition.head_frames + transition.tail_frames,
            transition.frames,
            "the split must not lose or invent a frame"
        );
        assert_eq!(
            transition.tail_frames, 8,
            "the extra frame plays past the cut"
        );
    }
}
