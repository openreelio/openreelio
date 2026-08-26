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

use std::collections::{HashMap, HashSet};

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
pub(super) const HANDLE_SLACK_FRAMES: f64 = 1.0;

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
pub(crate) struct TransitionRefusal {
    /// Clip carrying the effect.
    pub clip_id: String,
    /// The effect that was refused.
    ///
    /// Carried so the caller can match a refusal to the exact effect it came
    /// from. Matching on the label instead reports the same refusal once per
    /// same-typed effect on the clip, which is precisely the case — two
    /// dissolves on one clip — where the second one is the thing being refused.
    pub effect_id: String,
    /// Track the clip sits on, so a caller can address the effect.
    pub track_id: String,
    /// Track the clip sits on, for the message.
    pub track_name: String,
    /// Human-readable effect name.
    pub effect_label: String,
    /// What stopped it, phrased so the caller can act on it.
    pub reason: String,
}

impl TransitionRefusal {
    /// The warning text the export reports for this refusal.
    pub(crate) fn warning(&self) -> String {
        format!(
            "Transition effect '{}' on clip '{}' on track '{}' renders as a cut: {}",
            self.effect_label, self.clip_id, self.track_name, self.reason
        )
    }
}

/// A transition the render *will* blend, with something the caller should know.
///
/// Distinct from a refusal because the picture does change: the file gets the
/// blend that was asked for. What an advisory reports is that the blend will not
/// achieve what the caller presumably wanted, which is not a reason to withhold
/// it.
#[derive(Clone, Debug)]
pub(super) struct TransitionAdvisory {
    /// Clip carrying the effect.
    pub clip_id: String,
    /// The effect the advisory is about.
    pub effect_id: String,
    /// Track the clip sits on, for the message.
    pub track_name: String,
    /// Human-readable effect name.
    pub effect_label: String,
    /// What the caller should know, phrased so they can act on it.
    pub reason: String,
}

impl TransitionAdvisory {
    /// The warning text the export reports for this advisory.
    pub(super) fn warning(&self) -> String {
        format!(
            "Transition effect '{}' on clip '{}' on track '{}' renders, but {}",
            self.effect_label, self.clip_id, self.track_name, self.reason
        )
    }
}

/// Every renderable transition in a sequence, plus the ones that were refused.
#[derive(Clone, Debug, Default)]
pub(crate) struct TransitionPlan {
    /// Keyed by the outgoing clip's id.
    by_outgoing: HashMap<String, PlannedTransition>,
    /// Incoming clip id to the transition that ends on it.
    by_incoming: HashMap<String, String>,
    refusals: Vec<TransitionRefusal>,
    advisories: Vec<TransitionAdvisory>,
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
    pub(crate) fn refusals(&self) -> &[TransitionRefusal] {
        &self.refusals
    }

    /// The transitions that will be rendered but are worth a word to the caller.
    pub(super) fn advisories(&self) -> &[TransitionAdvisory] {
        &self.advisories
    }

    /// Whether anything at all will be blended.
    pub(super) fn is_empty(&self) -> bool {
        self.by_outgoing.is_empty()
    }
}

// =============================================================================
// Planning
// =============================================================================

/// Every enabled two-input transition a clip carries, in the clip's own order.
///
/// A clip has exactly one out point, and a two-input transition is a property of
/// that out point, so at most the first of these can be rendered. The rest are
/// returned rather than quietly skipped: silently dropping the second one means
/// a caller who stacks a dissolve and a wipe sees only the dissolve in the file
/// and no warning saying the wipe went nowhere.
fn two_input_transitions_on<'a>(
    clip: &Clip,
    effects: &'a HashMap<String, Effect>,
) -> Vec<&'a Effect> {
    clip.effects
        .iter()
        .filter_map(|effect_id| effects.get(effect_id))
        .filter(|effect| effect.enabled && effect.effect_type.is_two_input_transition())
        .collect()
}

/// Why this clip cannot contribute a picture the stitch can blend.
///
/// One message per cause rather than one message for all of them: "it is not on
/// a visible video track" is actively misleading advice for a title, which is on
/// a perfectly visible video track and simply is not a picture.
fn picture_refusal_reason(clip: &Clip, track: &Track) -> Option<&'static str> {
    if !matches!(track.kind, TrackKind::Video) {
        return Some("it is not on a video track, so there is no picture to blend");
    }
    // The export collects its clips from the tracks that contribute to the
    // output, so a muted track has no segment for the stitch to fold. Planning a
    // transition across a boundary the stitch will never see leaves the plan
    // entry orphaned, which the fold refuses outright - the whole render fails
    // over a transition on a track the caller had already taken out of the file.
    // Refuse the transition here instead, and keep this predicate the same one
    // `collect_enabled_clips_sorted` uses so the two cannot disagree.
    if !track.contributes_to_output() {
        return Some("its track is muted, so the export leaves it out of the render entirely");
    }
    if !track.visible {
        return Some("its track is hidden, so there is no picture to blend");
    }
    if !clip.enabled {
        return Some("the clip is disabled, so there is no picture to blend");
    }
    if clip.is_adjustment_layer() {
        return Some(
            "it is an adjustment layer, which grades the clips beneath it rather than \
             contributing a picture of its own",
        );
    }
    if is_text_clip(clip) {
        return Some(
            "it is a text clip, which is drawn over the finished picture rather than \
             contributing one to blend",
        );
    }
    None
}

/// Clip ids that more than one of the clips in this render answers to.
///
/// Every map in a [`TransitionPlan`] is keyed by clip id, and a video segment
/// carries nothing but that id, so the plan has no way to tell two clips with
/// one id apart. The consequences are not cosmetic: the second clip to be
/// planned overwrites the first's entry in `by_outgoing`, the handles widened
/// for one clip's source window are applied to the other's trim and `adelay`,
/// and the fold either blends the wrong pair or refuses the render for an orphan
/// the planner created itself.
///
/// Nothing this engine mints produces a duplicate id, but an operation log or
/// snapshot restored from elsewhere is not checked for one, so the planner has
/// to assume it can happen. Repairing the ids belongs to whatever wrote them;
/// what the planner owes the caller is to leave that boundary as a clean cut and
/// say which id made it ambiguous.
///
/// Scoped to the clips the export actually collects, which is the same set the
/// segments are built from - a duplicate on a track that is not in the file
/// cannot be confused with anything that is.
fn duplicated_clip_ids(sequence: &Sequence) -> HashSet<&str> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut duplicated: HashSet<&str> = HashSet::new();

    for track in &sequence.tracks {
        if !track.contributes_to_output() {
            continue;
        }
        for clip in track.clips.iter().filter(|clip| clip.enabled) {
            if !seen.insert(clip.id.as_str()) {
                duplicated.insert(clip.id.as_str());
            }
        }
    }

    duplicated
}

/// The refusal reason for a boundary whose clip id names more than one clip.
fn duplicate_id_refusal_reason(clip_id: &str, side: &str) -> String {
    format!(
        "duplicate clip id at a transition boundary: more than one clip in this render is \
         called '{clip_id}', and the render addresses a clip only by its id, so the handles \
         and fades meant for the {side} clip could be applied to the other one; give the \
         clips distinct ids"
    )
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

/// Whether a boundary joins one continuous stretch of footage to itself.
///
/// A razor split leaves the outgoing clip's out point exactly where the incoming
/// clip's in point is, in the same source. Blending across it is correct NLE
/// semantics — and completely invisible, because every frame of the blend mixes
/// a frame with itself. It is also exactly what a pacing profile or a style
/// planner produces when it drops transitions onto an assembly it built by
/// splitting one take, so it is worth saying out loud rather than leaving the
/// caller to wonder why their dissolve did nothing.
fn blends_footage_into_itself(outgoing: &Clip, incoming: &Clip) -> bool {
    outgoing.asset_id == incoming.asset_id
        && (outgoing.range.source_out_sec - incoming.range.source_in_sec).abs()
            <= TIMELINE_EPSILON_SEC
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
pub(crate) fn plan_sequence_transitions(
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
    let duplicated_ids = duplicated_clip_ids(sequence);

    for track in &sequence.tracks {
        let mut clips: Vec<&Clip> = track.clips.iter().filter(|clip| clip.enabled).collect();
        clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .partial_cmp(&b.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (index, clip) in clips.iter().enumerate() {
            let stored = two_input_transitions_on(clip, effects);
            let Some((effect, extras)) = stored.split_first() else {
                continue;
            };

            // A clip has one out point, so it can carry one two-input
            // transition. Every further one is refused by name rather than
            // dropped, so a caller who stacked a dissolve and a wipe learns
            // which of them the file actually got.
            for extra in extras {
                plan.refusals.push(TransitionRefusal {
                    clip_id: clip.id.clone(),
                    effect_id: extra.id.clone(),
                    track_id: track.id.clone(),
                    track_name: track.name.clone(),
                    effect_label: effect_type_label(&extra.effect_type),
                    reason: format!(
                        "another transition ('{}') already occupies this clip's out point, and a \
                         clip has only one out point to blend across; remove one of them",
                        effect_type_label(&effect.effect_type)
                    ),
                });
            }

            let label = effect_type_label(&effect.effect_type);
            let effect_id = effect.id.clone();
            let refuse = |reason: String| TransitionRefusal {
                clip_id: clip.id.clone(),
                effect_id: effect_id.clone(),
                track_id: track.id.clone(),
                track_name: track.name.clone(),
                effect_label: label.clone(),
                reason,
            };

            if let Some(reason) = picture_refusal_reason(clip, track) {
                plan.refusals.push(refuse(reason.to_string()));
                continue;
            }

            if duplicated_ids.contains(clip.id.as_str()) {
                plan.refusals
                    .push(refuse(duplicate_id_refusal_reason(&clip.id, "outgoing")));
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

            if let Some(reason) = picture_refusal_reason(next, track) {
                plan.refusals.push(refuse(format!(
                    "the incoming clip '{}' contributes no picture to blend into: {reason}",
                    next.id
                )));
                continue;
            }

            if duplicated_ids.contains(next.id.as_str()) {
                plan.refusals
                    .push(refuse(duplicate_id_refusal_reason(&next.id, "incoming")));
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

            if blends_footage_into_itself(clip, next) {
                plan.advisories.push(TransitionAdvisory {
                    clip_id: clip.id.clone(),
                    effect_id: effect.id.clone(),
                    track_name: track.name.clone(),
                    effect_label: label.clone(),
                    reason: format!(
                        "it blends continuous footage into itself — clip '{}' ends where clip \
                         '{}' begins in the same source, so every frame of the blend mixes a \
                         frame with itself and nothing will be visible; trim material at the \
                         boundary first, or remove the transition",
                        clip.id, next.id
                    ),
                });
            }

            let mut planned_effect = (*effect).clone();
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
    plan.advisories.sort_by(|a, b| a.clip_id.cmp(&b.clip_id));
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
        // What the fold actually needs is that the outgoing clip's *stream* —
        // its slot plus both handles — outlasts the blend, so `fold_group`
        // always has at least one pass-through frame left.
        //
        // Comparing `head + tail < slot` instead asserts something stronger than
        // the code requires, and stronger than the second-valued refusal
        // (`d < slot` on both sides) can guarantee once every length is rounded
        // to whole frames: a 1.01s middle clip is 30 slot frames at 30fps and
        // still owes 15 head and 15 tail, which is not `< 30` even though the
        // fold has 30 pass-through frames to spare.
        let stream_frames = outgoing_slot_frames + head_claim + transition.tail_frames;
        debug_assert!(
            stream_frames > transition.frames,
            "clip '{}' gives {} head and {} tail frames out of {}, leaving no picture \
             before a {}-frame blend",
            transition.outgoing_clip_id,
            head_claim,
            transition.tail_frames,
            outgoing_slot_frames,
            transition.frames
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

    // Sorted by track first, then by time. A boundary is only recognised when
    // its two sides are *adjacent* in this list, and both sides of a transition
    // always sit on the same track — so a clip on another track whose slot falls
    // between them must not be allowed to come between them here. That is not
    // hypothetical: a picture-in-picture straddling a cross dissolve starts after
    // the outgoing clip and before the incoming one, and sorting by time alone
    // dropped it right into the middle of the pair. The boundary then went
    // unfolded and the whole render was refused.
    //
    // Only a clip that shares seconds with something can interleave a pair, and
    // any such clip is in a composite group and therefore carries a track index.
    // Segments with none share their seconds with nothing, so they cannot come
    // between two sides of a boundary at all; they sort together at the end and
    // keep exactly the time order they had. On a timeline with no layering that
    // is every segment, and this sort is the old one.
    let mut ordered = segments;
    ordered.sort_by(|a, b| {
        let depth = |segment: &VideoTimelineSegment| {
            segment
                .layer
                .map(|layer| layer.track_index)
                .unwrap_or(usize::MAX)
        };
        depth(a).cmp(&depth(b)).then(
            a.start_sec
                .partial_cmp(&b.start_sec)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    let mut stitched: Vec<VideoTimelineSegment> = Vec::with_capacity(ordered.len());
    let mut group_index = 0_usize;
    let mut cursor = 0_usize;
    let mut folded: HashSet<&str> = HashSet::new();

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
        for segment in &group[..group.len() - 1] {
            if let Some(clip_id) = segment.clip_id.as_deref() {
                folded.insert(clip_id);
            }
        }
        stitched.push(fold_group(filter_complex, group, plan, fps, group_index)?);
        group_index += 1;
        cursor = end + 1;
    }

    // Every planned boundary must have been folded. A plan entry the walk above
    // never reached is not a cosmetic miss: the trim builders have already
    // widened that clip's source window and its `adelay` has already been pulled
    // back by the head handle, so leaving the picture unfolded ships a stream
    // longer than its timeline slot with the sound shifted against it — and
    // exits successfully while doing so. Refuse the render instead.
    if let Some(orphan) = plan
        .by_outgoing
        .keys()
        .find(|clip_id| !folded.contains(clip_id.as_str()))
    {
        return Err(ExportError::InvalidSettings(format!(
            "Transition on clip '{orphan}' was planned but its boundary was never folded, so the \
             handles it added to the source window would be left baked into the render; the \
             segment order the stitch saw does not put the two sides of the boundary next to \
             each other"
        )));
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

/// The exact frame count one clip's stream carries, handles included.
///
/// The slot is measured as the difference between its two *cumulative* timeline
/// boundaries rather than by rounding its own duration. That is what makes the
/// counts telescope: back-to-back 4.02s clips at 30fps each round to 121 frames
/// on their own, so a run of them claims one more frame per clip than the
/// timeline holds, and the last `xfade` in a chain lands on the wrong frame. Cut
/// at the boundaries instead and every frame is claimed exactly once.
///
/// Both handles are already whole multiples of the frame duration, so they add
/// exactly the frames the planner counted.
pub(super) fn clip_stream_frames(
    start_sec: f64,
    end_sec: f64,
    handles: ClipHandles,
    fps: f64,
) -> u32 {
    if !fps.is_finite() || fps <= 0.0 {
        return 1;
    }

    let slot_frames = (end_sec * fps).round() - (start_sec * fps).round();
    let head_frames = (handles.head_sec.max(0.0) * fps).round();
    let tail_frames = (handles.tail_sec.max(0.0) * fps).round();

    (slot_frames + head_frames + tail_frames).max(1.0) as u32
}

/// The frame count one segment's stream carries, handles included.
fn segment_frames(segment: &VideoTimelineSegment, plan: &TransitionPlan, fps: f64) -> u32 {
    let handles = segment
        .clip_id
        .as_deref()
        .map(|clip_id| plan.handles(clip_id))
        .unwrap_or_default();
    clip_stream_frames(segment.start_sec, segment.end_sec, handles, fps)
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
    //
    // Measured with the same cut-at-the-boundaries arithmetic every segment used,
    // because that is the only formulation that telescopes. Rounding the group's
    // span in one go instead compares against a different number whenever the
    // group's edges are not on frame boundaries, and reports a defect that is
    // really just two roundings disagreeing.
    debug_assert_eq!(
        accumulated_frames,
        clip_stream_frames(start_sec, end_sec, ClipHandles::default(), fps),
        "a transition group must occupy exactly its timeline span"
    );

    // The fold's output is one layer of whatever composite its inputs belonged
    // to. Every clip in a transition chain sits on the same track, and the
    // composite plan pulls whole chains into the same group precisely so that
    // this inheritance is unambiguous.
    Ok(VideoTimelineSegment::new(accumulated_label, start_sec, end_sec).with_layer(group[0].layer))
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

    /// Builds the two folded segments a two-clip group produces.
    fn segments_for(boundaries: &[(f64, f64)]) -> Vec<VideoTimelineSegment> {
        boundaries
            .iter()
            .enumerate()
            .map(|(index, (start, end))| {
                VideoTimelineSegment::new(format!("[v{index}]"), *start, *end)
                    .with_clip(format!("clip{index}"))
            })
            .collect()
    }

    #[test]
    fn should_admit_a_middle_clip_whose_frame_rounding_leaves_it_exactly_full() {
        // Reproduces a debug-build panic on a legal timeline. A 1.01s middle
        // clip is 30 slot frames at 30fps and owes 15 head plus 15 tail to its
        // two 1s dissolves — not `< 30`, but the fold still has 30 pass-through
        // frames, because its stream is the slot *plus* both handles.
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 1.01, Some(dissolve(1.0))),
            with_handles(6.01, 5.0, None),
        ]);

        assert!(plan.refusals().is_empty(), "{:?}", plan.refusals());
        assert!(
            plan.transition_after("clip1").is_some(),
            "a 1.0s transition fits inside a 1.01s shot"
        );
    }

    #[test]
    fn should_fold_clips_whose_durations_do_not_land_on_frame_boundaries() {
        // Reproduces a second debug-build panic. 4.02s at 30fps is 120.6 frames:
        // rounded on its own every clip claims 121, so a two-clip group claimed
        // 242 frames of a 241-frame timeline. Cutting at the cumulative
        // boundaries instead gives 121 and 120, which telescope exactly.
        let plan = plan_for(vec![
            with_handles(0.0, 4.02, Some(dissolve(1.0))),
            with_handles(4.02, 4.02, None),
        ]);
        assert!(plan.refusals().is_empty(), "{:?}", plan.refusals());

        let segments = segments_for(&[(0.0, 4.02), (4.02, 8.04)]);
        let mut filter_complex = String::new();
        let stitched = stitch_transition_groups(&mut filter_complex, segments, &plan, FPS)
            .expect("the group must fold");

        assert_eq!(stitched.len(), 1, "both clips fold into one segment");
        assert_eq!(stitched[0].start_sec, 0.0);
        assert_eq!(stitched[0].end_sec, 8.04);
    }

    #[test]
    fn should_count_a_clip_stream_by_cutting_at_its_timeline_boundaries() {
        // The property the fold depends on: consecutive clips must claim every
        // frame of the span exactly once, however their own durations round.
        let head = ClipHandles::default();
        let first = clip_stream_frames(0.0, 4.02, head, FPS);
        let second = clip_stream_frames(4.02, 8.04, head, FPS);

        assert_eq!(first + second, clip_stream_frames(0.0, 8.04, head, FPS));
        assert_eq!(first, 121);
        assert_eq!(second, 120);
    }

    #[test]
    fn should_refuse_the_render_when_a_planned_boundary_is_never_folded() {
        // A plan entry the stitch cannot reach is not cosmetic: the trim
        // builders have already widened that clip's source window and its
        // `adelay` has already moved, so shipping the picture unfolded means a
        // stream longer than its slot with the sound shifted against it — and a
        // successful exit code while it happens.
        let plan = plan_for(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        assert!(plan.transition_after("clip0").is_some(), "planned");

        // The two sides are no longer adjacent in the segment list, so the walk
        // never links them.
        let segments = vec![
            VideoTimelineSegment::new("[v0]", 0.0, 5.0).with_clip("clip0"),
            VideoTimelineSegment::new("[gap]", 5.0, 6.0),
            VideoTimelineSegment::new("[v1]", 6.0, 11.0).with_clip("clip1"),
        ];

        let mut filter_complex = String::new();
        let error = stitch_transition_groups(&mut filter_complex, segments, &plan, FPS)
            .expect_err("an unfolded plan entry must stop the render");

        let ExportError::InvalidSettings(message) = error else {
            panic!("the refusal must name the settings that cannot be honoured");
        };
        assert!(
            message.contains("clip0"),
            "the refusal must name the clip: {message}"
        );
    }

    #[test]
    fn should_refuse_every_two_input_transition_after_the_first_on_one_clip() {
        // A clip has one out point, so it can blend across one boundary. The
        // second effect used to be dropped without a word.
        let mut wipe = Effect::new(EffectType::Wipe);
        wipe.id = "wipe-extra".to_string();
        wipe.set_param("duration", ParamValue::Float(1.0));
        wipe.enabled = true;

        let (mut sequence, assets, mut effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        sequence.tracks[0].clips[0].effects.push(wipe.id.clone());
        effects.insert(wipe.id.clone(), wipe);

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(
            plan.transition_after("clip0").is_some(),
            "the first transition still renders"
        );
        let refusals = plan.refusals();
        assert_eq!(refusals.len(), 1, "exactly one refusal: {refusals:?}");
        assert_eq!(refusals[0].effect_id, "wipe-extra");
        assert!(
            refusals[0].reason.contains("already occupies"),
            "the refusal must say what took the out point: {}",
            refusals[0].reason
        );
    }

    #[test]
    fn should_warn_when_a_transition_blends_continuous_footage_into_itself() {
        // A dissolve across a razor split mixes every frame with itself. It
        // renders — correctly, by NLE semantics — and is invisible, which is
        // exactly what a pacing profile produces when it drops transitions onto
        // an assembly built by splitting one take.
        let (mut sequence, mut assets, effects, mut lengths) = build(vec![
            ClipSpec {
                source_in: 2.0,
                source_out: 7.0,
                timeline_in: 0.0,
                source_length: 14.0,
                transition: Some(dissolve(1.0)),
            },
            ClipSpec {
                source_in: 7.0,
                source_out: 12.0,
                timeline_in: 5.0,
                source_length: 14.0,
                transition: None,
            },
        ]);
        // Both clips are cut from the same take, at the same frame.
        sequence.tracks[0].clips[1].asset_id = "asset0".to_string();
        assets.remove("asset1");
        lengths.remove("asset1");

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(
            plan.transition_after("clip0").is_some(),
            "a self-blend still renders: {:?}",
            plan.refusals()
        );
        let advisories = plan.advisories();
        assert_eq!(advisories.len(), 1, "{advisories:?}");
        assert!(
            advisories[0].reason.contains("into itself")
                && advisories[0].reason.contains("trim material"),
            "the advisory must say what happened and what to do: {}",
            advisories[0].reason
        );
    }

    #[test]
    fn should_not_warn_about_a_self_blend_when_the_boundary_is_not_contiguous() {
        // Same asset on both sides, but the incoming clip starts somewhere else
        // in the take — that is a real blend between two different pictures.
        let (mut sequence, mut assets, effects, mut lengths) = build(vec![
            ClipSpec {
                source_in: 2.0,
                source_out: 7.0,
                timeline_in: 0.0,
                source_length: 20.0,
                transition: Some(dissolve(1.0)),
            },
            ClipSpec {
                source_in: 12.0,
                source_out: 17.0,
                timeline_in: 5.0,
                source_length: 20.0,
                transition: None,
            },
        ]);
        sequence.tracks[0].clips[1].asset_id = "asset0".to_string();
        assets.remove("asset1");
        lengths.remove("asset1");

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(plan.transition_after("clip0").is_some());
        assert!(
            plan.advisories().is_empty(),
            "two different stretches of one take blend visibly: {:?}",
            plan.advisories()
        );
    }

    #[test]
    fn should_name_the_reason_a_title_cannot_be_blended() {
        // "It is not on a visible video track" is actively wrong advice for a
        // title, which is on a perfectly visible video track and simply is not
        // a picture.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        sequence.tracks[0].clips[0].asset_id = "__text__title".to_string();

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        let reason = &plan.refusals()[0].reason;
        assert!(
            reason.contains("text clip"),
            "the refusal must name what the clip really is: {reason}"
        );
    }

    #[test]
    fn should_refuse_a_transition_on_a_muted_video_track_rather_than_orphan_it() {
        // The export collects its clips from the tracks that contribute to the
        // output, and muting a video track takes it out of that list entirely.
        // A transition planned across a boundary on such a track therefore has
        // no segments for the stitch to fold, and the fold refuses an unfolded
        // plan entry by failing the whole render - so muting one track used to
        // stop the export dead rather than simply leaving that track out.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        sequence.tracks[0].muted = true;
        assert!(
            sequence.tracks[0].visible,
            "the track has to stay visible so the muting is what refuses it"
        );
        assert!(
            !sequence.tracks[0].contributes_to_output(),
            "the fixture must match the predicate the export collects clips with"
        );

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(
            plan.is_empty(),
            "a muted track's transition must never reach the fold"
        );
        assert!(
            !plan.touches("clip0") && !plan.touches("clip1"),
            "neither side may be given handles the render would bake in"
        );
        let refusal = &plan.refusals()[0];
        assert_eq!(refusal.clip_id, "clip0");
        assert!(
            refusal.reason.contains("muted"),
            "the refusal must name muting as the cause: {}",
            refusal.reason
        );
    }

    #[test]
    fn should_refuse_a_boundary_whose_clip_id_names_more_than_one_clip() {
        // Every map in the plan is keyed by clip id, and a video segment carries
        // nothing but that id, so two clips answering to one id make the plan
        // ambiguous: the handles widened for the boundary's incoming clip would
        // also be applied to an unrelated clip elsewhere in the render, whose
        // source window would then be trimmed to media the edit never asked for.
        // Nothing this engine mints produces a duplicate id, but a snapshot
        // restored from elsewhere is not checked for one.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);

        let mut other = Track::new_video("V2");
        let mut collision = Clip::new("asset1")
            .with_source_range(2.0, 7.0)
            .place_at(20.0);
        collision.id = "clip1".to_string();
        other.add_clip(collision);
        sequence.add_track(other);

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(
            plan.is_empty(),
            "an ambiguous boundary must be left as a clean cut"
        );
        assert_eq!(
            plan.handles("clip1"),
            ClipHandles::default(),
            "neither clip called 'clip1' may have a handle applied to it"
        );
        assert!(
            plan.audio_fades("clip1").is_none(),
            "neither clip called 'clip1' may have a fade applied to it"
        );
        assert!(!plan.touches("clip0") && !plan.touches("clip1"));

        let refusal = &plan.refusals()[0];
        assert_eq!(refusal.clip_id, "clip0");
        assert!(
            refusal
                .reason
                .contains("duplicate clip id at a transition boundary"),
            "the refusal must name the cause: {}",
            refusal.reason
        );
        assert!(
            refusal.reason.contains("clip1"),
            "the refusal must name the id that is ambiguous: {}",
            refusal.reason
        );
    }

    #[test]
    fn should_refuse_a_boundary_whose_outgoing_clip_id_is_duplicated() {
        // The same ambiguity on the side that carries the effect. Its entry in
        // `by_outgoing` would be overwritten by whichever clip of that id was
        // planned last, so the render could blend a boundary nobody authored.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);

        let mut other = Track::new_video("V2");
        let mut collision = Clip::new("asset0")
            .with_source_range(2.0, 7.0)
            .place_at(20.0);
        collision.id = "clip0".to_string();
        other.add_clip(collision);
        sequence.add_track(other);

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(plan.is_empty());
        assert_eq!(plan.handles("clip0"), ClipHandles::default());
        assert!(plan.refusals()[0]
            .reason
            .contains("duplicate clip id at a transition boundary"));
    }

    #[test]
    fn should_still_plan_a_boundary_when_the_duplicate_is_on_a_track_that_is_not_in_the_file() {
        // A muted track is not in the render, so its clips never become segments
        // and its id cannot be confused with anything that does. Refusing here
        // would cost a caller a perfectly renderable transition.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);

        let mut muted = Track::new_video("V2");
        muted.muted = true;
        let mut collision = Clip::new("asset1")
            .with_source_range(2.0, 7.0)
            .place_at(20.0);
        collision.id = "clip1".to_string();
        muted.add_clip(collision);
        sequence.add_track(muted);

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        assert!(
            plan.transition_after("clip0").is_some(),
            "{:?}",
            plan.refusals()
        );
    }

    #[test]
    fn should_still_refuse_a_hidden_track_for_having_no_picture() {
        // A hidden video track still contributes its audio, so it stays in the
        // export's clip list and its transition is refused for the reason it
        // always was. Only muting removes the track outright.
        let (mut sequence, assets, effects, lengths) = build(vec![
            with_handles(0.0, 5.0, Some(dissolve(1.0))),
            with_handles(5.0, 5.0, None),
        ]);
        sequence.tracks[0].visible = false;

        let plan = plan_sequence_transitions(&sequence, &assets, &effects, FPS, |asset| {
            lengths.get(&asset.id).copied()
        });

        let reason = &plan.refusals()[0].reason;
        assert!(
            reason.contains("hidden"),
            "a hidden track keeps its own reason: {reason}"
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
