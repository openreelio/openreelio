//! Overlapping visual clips composited into one picture, instead of played in turn.
//!
//! # Why this exists
//!
//! The timeline stitch ([`append_timeline_video_output`](super::export::append_timeline_video_output))
//! lays segments end to end. That is exactly right for clips that follow one
//! another and exactly wrong for clips that share time: two segments covering
//! the same seconds get concatenated, so the render plays them in turn and ends
//! up longer than the timeline. Until now the export refused such a sequence
//! outright.
//!
//! This module folds a run of time-sharing segments into a single composited
//! segment covering the same span, so the timeline stitch never learns that
//! layering happened — the same trick, and for the same reason, as
//! [`stitch_transition_groups`](super::transition_stitch::stitch_transition_groups).
//! That one folds along time with `xfade`; this one folds along Z with `overlay`.
//!
//! # Group-span folding, not edge-splitting
//!
//! The obvious segmentation is to cut at every layer's in and out point, so that
//! within each piece the set of active layers is constant. It is also the wrong
//! one: it splits a clip that a picture-in-picture happens to sit on top of, and
//! every branch ends in `setpts=PTS-STARTPTS`, so each half of a split clip
//! restarts its own clock at zero. Keyframed motion is written as expressions in
//! `t`, so a split clip's Ken Burns move would start over at the seam.
//!
//! Instead a whole connected run of overlapping clips folds into **one** segment
//! spanning the run. No clip is split, every layer keeps its own intact stream
//! with its own `setpts=PTS-STARTPTS` at its own zero, and keyframe times need
//! no rebasing at all. A layer that starts partway into the group is delayed
//! into place with `tpad`.
//!
//! # The two halves, and why they are separated
//!
//! Compositing needs the layers above the bottom of the stack to arrive with
//! **transparency** — an opaque full-canvas frame simply hides everything under
//! it. But a clip's filter chain is emitted long before this module runs, so the
//! decision to stage a clip transparently cannot be made here. It is made in
//! [`plan_pip_groups`], which reads the *sequence* before any chain is emitted
//! and hands each clip's group membership back to the builder; the builder
//! passes `transparent_canvas` to the composition emitters. [`fold_pip_groups`]
//! then only has to delay each layer into place and stack them.
//!
//! Both halves therefore agree on the grouping by construction: the group index
//! is assigned once, in the plan, and travels on the segment. Nothing re-derives
//! it from segment spans, which is what would let the two halves disagree.
//!
//! # Fidelity
//!
//! The composite is measured against what the preview draws
//! (`TimelinePreviewPlayer.drawVisualWithClipTransform`), which clears to opaque
//! black, walks tracks so that track 0 is drawn last, sets `globalAlpha` to the
//! clip's opacity and draws source-over onto a plain 8-bit sRGB canvas. So:
//!
//! * The backdrop is **opaque black**, and layers stack **bottom first** —
//!   highest track index first, track 0 last and therefore on top.
//! * Compositing runs in **`gbrap`**: planar sRGB with straight alpha, gamma
//!   encoded. Measured on the bundled FFmpeg 8.0.1, a 50% layer over a
//!   backdrop lands on 127/128 — the gamma-space answer. Compositing in linear
//!   light would have produced ~188, and staging in `yuva420p` instead measured
//!   1-2 LSB off with chroma fringing at every layer edge.
//! * `overlay` gets `alpha=straight` and `eof_action=pass:repeatlast=0`. The
//!   `eof_action` pair is not decoration: with FFmpeg's defaults a layer that
//!   ends before the group does has its **last frame frozen onto every
//!   remaining frame** — measured, a picture-in-picture that never leaves.

use std::collections::{HashMap, HashSet};

use crate::core::timeline::{BlendMode, Clip, Sequence, TrackKind};

use super::{
    export::{
        effective_blend_mode_for_clip, format_speed_number, is_text_clip, ExportError,
        PipLayerInfo, VideoTimelineSegment, TIMELINE_EPSILON_SEC,
    },
    transition_stitch::TransitionPlan,
};

// =============================================================================
// Planning
// =============================================================================

/// Which clips composite together, decided before any filter chain is emitted.
#[derive(Clone, Debug, Default)]
pub(super) struct PipPlan {
    /// Clips that take part in a composite, by clip id.
    layers: HashMap<String, PipLayerInfo>,
}

impl PipPlan {
    /// The composite this clip takes part in, if it takes part in one.
    pub(super) fn layer(&self, clip_id: &str) -> Option<PipLayerInfo> {
        self.layers.get(clip_id).copied()
    }
}

/// One clip as the planner sees it, before any of it reaches FFmpeg.
struct PlannedClip<'a> {
    clip: &'a Clip,
    track_index: usize,
    start_sec: f64,
    end_sec: f64,
    /// The blend the clip really asks for, with its track's own folded in.
    blend_mode: BlendMode,
}

/// W3C `color-dodge`, written out because FFmpeg's own `dodge` is not it.
///
/// `blend`'s `dodge` is `min(max, B*(max+1)/(max-A))`, which differs from the
/// specification in two ways. The scale factor is `max+1` rather than `max`, and
/// — the one that matters — it returns `max` whenever the *source* is `max`,
/// where the specification returns 0 if the backdrop is 0. Measured over all
/// 65536 8-bit backdrop/source pairs, that is one pixel wrong by the full range:
/// pure white over pure black rendered white where the canvas draws black.
/// Writing the specification out costs one expression and measures 1/255.
///
/// Operands follow the same convention as every other mode here: `blend`'s first
/// input is the backdrop and its second is the layer, so in the expression `A`
/// is the backdrop `Cb` and `B` is the source `Cs`. Nothing is reversed —
/// the reversal FFmpeg's own `dodge` and `burn` would need is precisely what
/// writing the formula out avoids.
///
/// The literal `255` ties this to an 8-bit working format; it is
/// [`COMPOSITE_LAYER_FORMAT`](super::export::COMPOSITE_LAYER_FORMAT) that makes
/// that true, and the two have to move together.
const COLOR_DODGE_BLEND: &str =
    "all_expr='if(lte(A,0),0,if(gte(B,255),255,min(255,A*255/(255-B))))'";

/// W3C `color-burn`, written out for the same reason as [`COLOR_DODGE_BLEND`].
///
/// FFmpeg's `burn` returns 0 whenever the source is 0, where the specification
/// returns 1 if the backdrop is 1 — again one pixel wrong by the full range,
/// pure black over pure white.
const COLOR_BURN_BLEND: &str =
    "all_expr='if(gte(A,255),255,if(lte(B,0),0,255-min(255,(255-A)*255/B)))'";

/// The `blend` options that reproduce one canvas blend mode, if any do.
///
/// `None` covers two different things, and callers that care must tell them
/// apart with [`composite_blend_is_supported`]: `Normal` needs no blend at all
/// (it is plain source-over, which `overlay` already does), and the modes the
/// stack cannot reproduce faithfully are refused before they reach here.
///
/// Every mode below is measured against the W3C separable blend functions over
/// all 65536 8-bit backdrop/source pairs, at full opacity and at half: worst
/// error 1.99/255, and not one pair over 2/255. The **operand order is uniform**
/// — backdrop first — which is worth stating because it is a trap: fed the other
/// way round `overlay` silently computes `hard-light` (and vice versa), which is
/// a plausible-looking picture rather than an error. Measured, that mistake is
/// 255/255 wrong.
///
/// `soft-light` is absent on purpose. FFmpeg implements the Pegtop formula, not
/// the specification's, and no operand order fixes that.
fn blend_filter_spec(mode: &BlendMode) -> Option<&'static str> {
    match mode {
        BlendMode::Multiply => Some("all_mode=multiply"),
        BlendMode::Screen => Some("all_mode=screen"),
        BlendMode::Overlay => Some("all_mode=overlay"),
        BlendMode::Darken => Some("all_mode=darken"),
        BlendMode::Lighten => Some("all_mode=lighten"),
        BlendMode::HardLight => Some("all_mode=hardlight"),
        BlendMode::Difference => Some("all_mode=difference"),
        BlendMode::Exclusion => Some("all_mode=exclusion"),
        BlendMode::ColorDodge => Some(COLOR_DODGE_BLEND),
        BlendMode::ColorBurn => Some(COLOR_BURN_BLEND),
        _ => None,
    }
}

/// Whether the render can composite a layer asking for this blend mode.
///
/// The single predicate behind both the preflight's refusal and the builder's,
/// so what the GUI offers and what the render accepts cannot drift apart.
pub(super) fn composite_blend_is_supported(mode: &BlendMode) -> bool {
    matches!(mode, BlendMode::Normal) || blend_filter_spec(mode).is_some()
}

/// The blend modes a layered render can perform, for the refusal message.
pub(super) const SUPPORTED_BLEND_MODES: &str =
    "Normal, Multiply, Screen, Overlay, Darken, Lighten, Color Burn, Color Dodge, \
     Hard Light, Difference and Exclusion";

/// Collects the clips that paint into the picture, with their track depth.
///
/// The filter has to match the builder's own exactly. A clip the builder skips
/// must not appear in a group, or the fold would wait for a stream that never
/// arrives. Measured: a *muted* video track passes `visible`, so filtering on
/// `visible` alone let a muted clip join a composite and the export failed with
/// "Sequence has no visual clips".
///
/// `contributes_to_output` is the gate
/// [`collect_enabled_clips_sorted`](super::export::collect_enabled_clips_sorted)
/// uses, and `Video && visible` is the builder's own `contributes_visual_output`.
///
/// Track index is the sequence's own order, in which **0 is the topmost track**
/// — the same convention [`build_render_graph`](super::graph) reads by walking
/// tracks in reverse.
fn planned_clips(sequence: &Sequence) -> Vec<PlannedClip<'_>> {
    let mut planned = Vec::new();

    for (track_index, track) in sequence.tracks.iter().enumerate() {
        if !track.contributes_to_output()
            || !matches!(track.kind, TrackKind::Video)
            || !track.visible
        {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled || clip.is_adjustment_layer() || is_text_clip(clip) {
                continue;
            }

            planned.push(PlannedClip {
                clip,
                track_index,
                start_sec: clip.place.timeline_in_sec,
                end_sec: clip.place.timeline_out_sec(),
                blend_mode: effective_blend_mode_for_clip(clip, track),
            });
        }
    }

    planned
}

/// Disjoint sets over clip indices, used to merge overlap runs with transitions.
struct DisjointSets {
    parent: Vec<usize>,
}

impl DisjointSets {
    fn new(len: usize) -> Self {
        Self {
            parent: (0..len).collect(),
        }
    }

    fn find(&mut self, mut index: usize) -> usize {
        while self.parent[index] != index {
            self.parent[index] = self.parent[self.parent[index]];
            index = self.parent[index];
        }
        index
    }

    fn union(&mut self, left: usize, right: usize) {
        let (left, right) = (self.find(left), self.find(right));
        if left != right {
            self.parent[right] = left;
        }
    }
}

/// A sequence's clips, and the composites they form.
struct CompositeGrouping<'a> {
    clips: Vec<PlannedClip<'a>>,
    /// Indices into `clips`, one entry per composite, topmost track first.
    groups: Vec<Vec<usize>>,
}

/// Works out which clips composite together.
///
/// Two relations put clips in the same group, and both are needed:
///
/// 1. **Overlap.** Clips that share timeline seconds have to be composited.
/// 2. **Transitions.** A transition folds its two sides into one stream before
///    this module's fold runs. If one side composited transparently and the
///    other did not, `xfade` would blend an opaque frame with a transparent one
///    and the opaque one would black out the layers beneath for its half of the
///    boundary. So a transition chain touching a composite joins it whole.
///
/// A run linked *only* by transitions and never by overlap is not a composite —
/// that is the ordinary sequential timeline, and it keeps the cheaper graph.
///
/// Shared by [`plan_pip_groups`] and
/// [`composite_refusal`] so that what the export refuses and
/// what the export composites are decided by one piece of code. They disagreed
/// once: the preflight looked at overlap runs alone, so a clip pulled into a
/// group by relation 2 could carry a blend mode nobody checked, and the render
/// silently dropped it.
fn composite_grouping<'a>(
    sequence: &'a Sequence,
    transition_plan: &TransitionPlan,
) -> CompositeGrouping<'a> {
    let clips = planned_clips(sequence);
    if clips.is_empty() {
        return CompositeGrouping {
            clips,
            groups: Vec::new(),
        };
    }

    // A clip asking for a blend mode composites whether or not anything overlaps
    // it: the preview blends it against whatever it has already drawn, and for a
    // lone clip that is the opaque black canvas. Multiply over nothing really is
    // black, and the export has to say so too.
    let blended: Vec<bool> = clips
        .iter()
        .map(|planned| blend_filter_spec(&planned.blend_mode).is_some())
        .collect();

    // Sweep for connected runs under overlap. Sorting by start means a run
    // extends exactly while the next clip begins before the furthest end so far.
    let mut order: Vec<usize> = (0..clips.len()).collect();
    order.sort_by(|left, right| {
        clips[*left]
            .start_sec
            .partial_cmp(&clips[*right].start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut sets = DisjointSets::new(clips.len());
    let mut overlapped: Vec<bool> = vec![false; clips.len()];
    let mut run_start = 0_usize;
    let mut furthest_end = clips[order[0]].end_sec;

    for position in 1..order.len() {
        let index = order[position];
        if clips[index].start_sec < furthest_end - TIMELINE_EPSILON_SEC {
            // Genuinely shares time with something already in this run.
            overlapped[index] = true;
            overlapped[order[run_start]] = true;
            sets.union(order[run_start], index);
            furthest_end = furthest_end.max(clips[index].end_sec);
        } else {
            run_start = position;
            furthest_end = clips[index].end_sec;
        }
    }

    if !overlapped.iter().any(|shares| *shares) && !blended.iter().any(|asks| *asks) {
        return CompositeGrouping {
            clips,
            groups: Vec::new(),
        };
    }

    // Pull whole transition chains into whatever run they touch.
    let index_by_clip: HashMap<&str, usize> = clips
        .iter()
        .enumerate()
        .map(|(index, planned)| (planned.clip.id.as_str(), index))
        .collect();
    for (index, planned) in clips.iter().enumerate() {
        if let Some(transition) = transition_plan.transition_after(&planned.clip.id) {
            if let Some(other) = index_by_clip.get(transition.incoming_clip_id.as_str()) {
                sets.union(index, *other);
            }
        }
    }

    // A set composites when any of its members really shares time with another.
    // Resolving the roots only now is deliberate: a union performed after a clip
    // was marked may have moved it under a different representative.
    let mut composite_roots: HashSet<usize> = HashSet::new();
    let composites: Vec<usize> = overlapped
        .iter()
        .zip(blended.iter())
        .enumerate()
        .filter_map(|(index, (shares, asks))| (*shares || *asks).then_some(index))
        .collect();
    for index in composites {
        let root = sets.find(index);
        composite_roots.insert(root);
    }

    let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..clips.len() {
        let root = sets.find(index);
        if composite_roots.contains(&root) {
            members.entry(root).or_default().push(index);
        }
    }

    let mut groups: Vec<Vec<usize>> = members
        .into_values()
        .filter(|group| group.len() > 1 || group.iter().any(|index| blended[*index]))
        .map(|mut group| {
            group.sort_by(|left, right| {
                clips[*left]
                    .track_index
                    .cmp(&clips[*right].track_index)
                    .then(
                        clips[*left]
                            .start_sec
                            .partial_cmp(&clips[*right].start_sec)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
            });
            group
        })
        .collect();

    // Deterministic group order: by the earliest clip in each group, so the
    // group indices a render uses do not depend on hash iteration order.
    groups.sort_by(|left, right| {
        let earliest = |group: &Vec<usize>| {
            group
                .iter()
                .map(|index| clips[*index].start_sec)
                .fold(f64::INFINITY, f64::min)
        };
        earliest(left)
            .partial_cmp(&earliest(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    CompositeGrouping { clips, groups }
}

/// A composite the render cannot perform, and the clip responsible for it.
pub(super) struct CompositeRefusal<'a> {
    /// The clip the user has to change.
    pub clip_id: &'a str,
    /// What to tell them, phrased for someone looking at a timeline.
    pub message: String,
}

/// Why this sequence's composites cannot be rendered, if they cannot.
///
/// The single source of both the preflight's refusal and the builder's, so that
/// what the GUI offers and what the render accepts cannot drift apart — down to
/// the wording, which is produced here once.
pub(super) fn composite_refusal<'a>(
    sequence: &'a Sequence,
    transition_plan: &TransitionPlan,
) -> Option<CompositeRefusal<'a>> {
    let grouping = composite_grouping(sequence, transition_plan);
    let layers = || {
        grouping
            .groups
            .iter()
            .flatten()
            .map(|index| &grouping.clips[*index])
    };

    // A mode the stack cannot perform is refused wherever it appears, not only
    // where clips overlap. Only *supported* modes pull a clip into a group, so a
    // lone clip asking for an unsupported one belongs to no group at all —
    // checking the groups alone would let it render as plain source-over with
    // nothing said. The scope here is deliberately the one the blanket refusal
    // this replaced used: every enabled clip on a video track that reaches the
    // file, text and adjustment layers included, so nothing that used to be
    // refused quietly starts exporting instead.
    if let Some((_, clip)) = sequence
        .tracks
        .iter()
        .filter(|track| track.contributes_to_output() && matches!(track.kind, TrackKind::Video))
        .flat_map(|track| {
            track
                .clips
                .iter()
                .filter(|clip| clip.enabled)
                .map(move |clip| (track, clip))
        })
        .find(|(track, clip)| {
            !composite_blend_is_supported(&effective_blend_mode_for_clip(clip, track))
        })
    {
        return Some(CompositeRefusal {
            clip_id: clip.id.as_str(),
            message: format!(
                "This clip asks for a blend mode the final render cannot perform yet; \
                 supported modes are {SUPPORTED_BLEND_MODES}"
            ),
        });
    }

    // A transition folds its two clips into a single stream *before* the stack
    // runs, so a blend on either side would be applied to the already-blended
    // pair rather than to each clip against the backdrop — which is not what the
    // preview draws. Getting it right would mean compositing each side against
    // the backdrop first and cross-fading the two finished pictures, which
    // inverts the order the two folds run in. Refuse rather than render
    // something plausible and wrong.
    if let Some(planned) = layers().find(|planned| {
        planned.blend_mode != BlendMode::Normal
            && (transition_plan.transition_after(&planned.clip.id).is_some()
                || transition_plan
                    .transition_before(&planned.clip.id)
                    .is_some())
    }) {
        return Some(CompositeRefusal {
            clip_id: planned.clip.id.as_str(),
            message: "This clip has both a transition and a blend mode. The transition blends \
                      it into its neighbour before the layers are stacked, so the blend mode \
                      would apply to the pair rather than to the clip; remove one of the two"
                .to_string(),
        });
    }

    None
}

/// Decides which clips composite together.
///
/// Runs before the builder emits a single filter, because the answer changes how
/// each clip's own chain is emitted: a clip in a composite stages onto a
/// transparent canvas rather than an opaque black one.
pub(super) fn plan_pip_groups(
    sequence: &Sequence,
    transition_plan: &TransitionPlan,
) -> Result<PipPlan, ExportError> {
    let grouping = composite_grouping(sequence, transition_plan);

    // A composite addresses its layers by clip id, so two clips sharing one is
    // not a cosmetic problem: the second overwrites the first in the map, and
    // the render either stacks the layers in the wrong order or drops one
    // outright. Nothing this engine mints produces a duplicate, but an operation
    // log or snapshot restored from elsewhere is not checked for one — the same
    // reason the transition planner guards its own boundaries. Repairing the ids
    // belongs to whatever wrote them; what the planner owes the caller is to say
    // which id made the stack ambiguous.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut duplicated: HashSet<&str> = HashSet::new();
    for planned in &grouping.clips {
        if !seen.insert(planned.clip.id.as_str()) {
            duplicated.insert(planned.clip.id.as_str());
        }
    }
    if let Some(clip_id) = grouping
        .groups
        .iter()
        .flatten()
        .map(|index| grouping.clips[*index].clip.id.as_str())
        .find(|clip_id| duplicated.contains(clip_id))
    {
        return Err(ExportError::InvalidSettings(format!(
            "Duplicate clip id in a layered composite: more than one clip in this render is \
             called '{clip_id}', and a composite addresses its layers by id, so the layers \
             would be stacked in the wrong order or dropped outright; give the clips \
             distinct ids"
        )));
    }

    // Both refusals, and their wording, come from the one predicate the
    // preflight reads. This is the backstop for every caller that does not run
    // the preflight first.
    if let Some(refusal) = composite_refusal(sequence, transition_plan) {
        return Err(ExportError::InvalidSettings(format!(
            "Clip '{}': {}",
            refusal.clip_id, refusal.message
        )));
    }

    let mut plan = PipPlan::default();
    for (group_index, group) in grouping.groups.iter().enumerate() {
        for index in group {
            let planned = &grouping.clips[*index];
            plan.layers.insert(
                planned.clip.id.clone(),
                PipLayerInfo {
                    group_index,
                    track_index: planned.track_index,
                    blend_spec: blend_filter_spec(&planned.blend_mode),
                },
            );
        }
    }

    Ok(plan)
}

// =============================================================================
// Fold
// =============================================================================

/// Folds every run of composited segments into one stacked stream.
///
/// Mirrors [`stitch_transition_groups`](super::transition_stitch::stitch_transition_groups):
/// each fold replaces its run with a single segment covering the same timeline
/// span, so the caller's gap filling, tail padding and output length are decided
/// by code that never learns compositing happened.
pub(super) fn fold_pip_groups(
    filter_complex: &mut String,
    segments: Vec<VideoTimelineSegment>,
    fps: f64,
    width: u32,
    height: u32,
    pixel_format: &str,
) -> Result<Vec<VideoTimelineSegment>, ExportError> {
    if !fps.is_finite() || fps <= 0.0 || segments.iter().all(|segment| segment.layer.is_none()) {
        return Ok(segments);
    }

    // Group by the index the plan assigned. Nothing here re-derives grouping
    // from spans: the plan already decided, and the emitted chains were staged
    // to match that decision.
    let mut grouped: HashMap<usize, Vec<VideoTimelineSegment>> = HashMap::new();
    let mut passthrough: Vec<VideoTimelineSegment> = Vec::new();

    for segment in segments {
        match segment.layer {
            Some(layer) => grouped.entry(layer.group_index).or_default().push(segment),
            None => passthrough.push(segment),
        }
    }

    let mut folded = passthrough;
    let mut group_indices: Vec<usize> = grouped.keys().copied().collect();
    group_indices.sort_unstable();

    for group_index in group_indices {
        let mut group = grouped.remove(&group_index).unwrap_or_default();

        // A group that arrived with fewer than two layers means the builder
        // dropped a segment the plan expected. Passing the survivor through
        // would look like a graceful degradation and is not one: the plan staged
        // it for a composite, so it carries transparency and the output pixel
        // format of a *layer*, and handing it to the timeline stitch would push
        // a `gbrap` stream into a concat of `yuv420p` ones. Refuse instead.
        // One layer is a real composite when that layer asks for a blend mode:
        // it blends against the opaque black backdrop, which is what the preview
        // shows for a lone blended clip (multiply over nothing is black). One
        // layer with no blend is not a composite at all, and means the builder
        // dropped a segment the plan expected. Passing it through would look
        // like a graceful degradation and is not one: the plan staged it as a
        // *layer*, so it carries transparency and a layer's pixel format, and
        // the timeline stitch would push a `gbrap` stream into a concat of
        // `yuv420p` ones.
        let blends = group.iter().any(|segment| {
            segment
                .layer
                .is_some_and(|layer| layer.blend_spec.is_some())
        });
        if group.len() < 2 && !blends {
            return Err(ExportError::InvalidSettings(format!(
                "Composite group {group_index} was planned with more layers than the render \
                 produced, so a layer staged for compositing would reach the timeline on its \
                 own, still carrying the transparency the stack was going to consume"
            )));
        }

        // Bottom of the stack first: the highest track index is furthest back,
        // and track 0 is composited last so it lands on top.
        group.sort_by(|left, right| {
            let depth = |segment: &VideoTimelineSegment| {
                segment.layer.map(|layer| layer.track_index).unwrap_or(0)
            };
            depth(right)
                .cmp(&depth(left))
                .then(left.start_sec.total_cmp(&right.start_sec))
        });

        folded.push(fold_group(
            filter_complex,
            &group,
            fps,
            width,
            height,
            pixel_format,
            group_index,
        )?);
    }

    // The timeline stitch lays whatever it is handed end to end and advances its
    // cursor past each segment, so an overlap that survived this fold would be
    // concatenated — silently rendering a video longer than the timeline, and
    // exiting successfully while doing so. Refuse instead.
    folded.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));
    for pair in folded.windows(2) {
        if pair[1].start_sec < pair[0].end_sec - TIMELINE_EPSILON_SEC {
            return Err(ExportError::InvalidSettings(format!(
                "Layered clips covering {:.3}s-{:.3}s were not composited into a single \
                 picture, so the render would play them one after another and finish longer \
                 than the timeline",
                pair[1].start_sec, pair[0].end_sec
            )));
        }
    }

    Ok(folded)
}

/// Frames between two timeline positions, measured the way every other stage does.
///
/// Cumulative boundaries rather than a rounded duration, so that consecutive
/// spans telescope and every frame of the timeline is claimed exactly once —
/// the same arithmetic as
/// [`clip_stream_frames`](super::transition_stitch::clip_stream_frames).
fn span_frames(start_sec: f64, end_sec: f64, fps: f64) -> i64 {
    (end_sec * fps).round() as i64 - (start_sec * fps).round() as i64
}

/// Blends one layer against the accumulated picture, ready to be composited.
///
/// Returns the backdrop branch the caller's `overlay` should use, and the label
/// of the blended layer.
///
/// The W3C compositing model separates the two halves of what a blend mode does:
///
/// ```text
/// Co = as·B(Cb, Cs) + (1 - as)·Cb          (with an opaque backdrop)
/// ```
///
/// `B` is the blend function, and it applies to **colour only**. The `as` term
/// is ordinary source-over compositing. So the chain here computes `B` with
/// `blend` on colour-only streams, puts the layer's own alpha back onto the
/// result, and lets the caller's `overlay` do the `as` arithmetic — which is
/// exactly the formula above.
///
/// Three details are load-bearing, each measured:
///
/// 1. **`blend` runs on `gbrp`, never `gbrap`.** Handed a stream with alpha it
///    blends the alpha plane as if it were colour. Measured with a half-opaque
///    layer in `screen`, that produced the *full-opacity* answer: the clip's
///    opacity was silently discarded.
/// 2. **The backdrop is `blend`'s first input.** Fed the other way round,
///    `overlay` computes `hard-light` and `hard-light` computes `overlay` — a
///    plausible picture rather than an error, and 255/255 wrong.
/// 3. **`repeatlast=0`.** Without it a layer that ends before the group does has
///    its last blended frame frozen onto every remaining frame. Measured: 30 of
///    90 frames wrong.
///
/// Opacity deliberately does not go through `blend`'s own `all_opacity`, whose
/// semantics are inconsistent between modes; it is already baked into the
/// layer's alpha channel by the composition emitter, and this chain carries that
/// alpha through untouched.
fn append_blended_layer(
    filter_complex: &mut String,
    backdrop_label: &str,
    layer_label: &str,
    blend_spec: &str,
    group_index: usize,
    depth: usize,
) -> (String, String) {
    let blend_backdrop = format!("[pipbb{group_index}_{depth}]");
    let blend_backdrop_colour = format!("[pipbc{group_index}_{depth}]");
    let overlay_backdrop = format!("[pipob{group_index}_{depth}]");
    let layer_colour_source = format!("[pipcs{group_index}_{depth}]");
    let layer_alpha_source = format!("[pipas{group_index}_{depth}]");
    let layer_colour = format!("[pipsc{group_index}_{depth}]");
    let layer_alpha = format!("[pipsa{group_index}_{depth}]");
    let blended = format!("[pipbl{group_index}_{depth}]");
    let blended_with_alpha = format!("[pipbm{group_index}_{depth}]");

    filter_complex.push_str(&format!(
        "{backdrop_label}split{blend_backdrop}{overlay_backdrop};\
         {blend_backdrop}format=gbrp{blend_backdrop_colour};\
         {layer_label}split{layer_colour_source}{layer_alpha_source};\
         {layer_colour_source}format=gbrp{layer_colour};\
         {layer_alpha_source}alphaextract{layer_alpha};\
         {blend_backdrop_colour}{layer_colour}blend={blend_spec}:repeatlast=0{blended};\
         {blended}{layer_alpha}alphamerge{blended_with_alpha};"
    ));

    (overlay_backdrop, blended_with_alpha)
}

/// Stacks one run of layers, back to front, onto an opaque black backdrop.
fn fold_group(
    filter_complex: &mut String,
    group: &[VideoTimelineSegment],
    fps: f64,
    width: u32,
    height: u32,
    pixel_format: &str,
    group_index: usize,
) -> Result<VideoTimelineSegment, ExportError> {
    let group_start = group
        .iter()
        .map(|segment| segment.start_sec)
        .fold(f64::INFINITY, f64::min);
    let group_end = group
        .iter()
        .map(|segment| segment.end_sec)
        .fold(f64::NEG_INFINITY, f64::max);

    let group_frames = span_frames(group_start, group_end, fps).max(1);

    // The backdrop is what the preview clears to, and it is also what decides
    // the composite's length: it is `overlay`'s main input at every step, and
    // `eof_action=pass` leaves the main input in charge.
    let backdrop_label = format!("pipbd{group_index}");
    filter_complex.push_str(&format!(
        "color=c=black:s={}x{}:r={},format=gbrp,setsar=1,trim=end_frame={},setpts=PTS-STARTPTS[{}];",
        width,
        height,
        format_speed_number(fps),
        group_frames,
        backdrop_label
    ));

    let mut accumulated = format!("[{}]", backdrop_label);

    for (depth, segment) in group.iter().enumerate() {
        // Each layer arrives with its own clock zeroed by its own
        // `setpts=PTS-STARTPTS`, which is exactly why no keyframe time needs
        // rebasing. Delaying it into the group is a matter of prepending
        // transparent frames, not of moving its timestamps.
        let offset_frames = span_frames(group_start, segment.start_sec, fps).max(0);
        let layer_label = if offset_frames > 0 {
            let delayed = format!("[pipL{group_index}_{depth}]");
            filter_complex.push_str(&format!(
                "{}tpad=start_duration={}:start_mode=add:color=black@0{};",
                segment.stream_label,
                format_speed_number(offset_frames as f64 / fps),
                delayed
            ));
            delayed
        } else {
            segment.stream_label.clone()
        };

        let is_last = depth + 1 == group.len();
        let output_label = if is_last {
            format!("[pipv{group_index}]")
        } else {
            format!("[pipk{group_index}_{depth}]")
        };

        // `format=auto` is safe here precisely because it is not safe in
        // general: it resolves to the least chroma-capable of its two inputs.
        // The backdrop is `gbrp` and each layer is `gbrap` — both full chroma,
        // one of them carrying alpha — so the mode it settles on is full chroma
        // with alpha, and FFmpeg converts the backdrop up to match. Naming a
        // mode explicitly instead would have to name one that carries alpha, and
        // the subsampled ones cannot address an odd overlay offset. Measured: a
        // three-layer stack at odd offsets came out with exactly the four
        // colours predicted and no fringe at any layer edge.
        //
        // `eof_action=pass:repeatlast=0` is what lets a layer end before the
        // group does. FFmpeg's defaults freeze its last frame onto every
        // remaining frame instead. `shortest` is deliberately absent: it would
        // end the composite at whichever layer runs out first.
        //
        // A layer asking for a blend mode reaches `overlay` already blended
        // against the accumulated picture; see `append_blended_layer`. It needs
        // the backdrop twice — once to blend against, once to composite onto —
        // so the blend hands back the branch the overlay should use.
        let (backdrop_label, composited_label) =
            match segment.layer.and_then(|layer| layer.blend_spec) {
                Some(blend_spec) => append_blended_layer(
                    filter_complex,
                    &accumulated,
                    &layer_label,
                    blend_spec,
                    group_index,
                    depth,
                ),
                None => (accumulated.clone(), layer_label),
            };

        filter_complex.push_str(&format!(
            "{}{}overlay=x=0:y=0:format=auto:alpha=straight:eof_action=pass:repeatlast=0{};",
            backdrop_label, composited_label, output_label
        ));
        accumulated = output_label;
    }

    // Back to the output's own format, in the same shape every other segment
    // ends in, so the timeline stitch cannot tell a composite from a plain clip.
    let output_label = format!("[vpip{group_index}]");
    filter_complex.push_str(&format!(
        "{}setsar=1,fps={},trim=end_frame={},setpts=PTS-STARTPTS,format={}{};",
        accumulated,
        format_speed_number(fps),
        group_frames,
        pixel_format,
        output_label
    ));

    debug_assert_eq!(
        group_frames,
        span_frames(group_start, group_end, fps).max(1),
        "a composite group must occupy exactly its timeline span"
    );

    Ok(VideoTimelineSegment::new(
        output_label,
        group_start,
        group_end,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{SequenceFormat, Track, Transform};
    use crate::core::Point2D;

    use super::super::export::{
        append_video_stream_normalization, append_video_transform_composition,
    };
    use super::super::transform_layout::ClipTransformLayout;

    const FPS: f64 = 30.0;

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /// One clip on its own video track, placed on the timeline.
    struct ClipSpec {
        start_sec: f64,
        duration_sec: f64,
        blend_mode: BlendMode,
    }

    impl ClipSpec {
        fn at(start_sec: f64, duration_sec: f64) -> Self {
            Self {
                start_sec,
                duration_sec,
                blend_mode: BlendMode::Normal,
            }
        }

        fn blended(mut self, blend_mode: BlendMode) -> Self {
            self.blend_mode = blend_mode;
            self
        }
    }

    /// A sequence of one-clip video tracks. The first spec becomes **track 0**,
    /// which is the topmost track.
    fn sequence_of(specs: Vec<ClipSpec>) -> Sequence {
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        sequence.tracks.clear();

        for (index, spec) in specs.into_iter().enumerate() {
            let mut clip = Clip::new(&format!("asset{index}"))
                .with_source_range(0.0, spec.duration_sec)
                .place_at(spec.start_sec);
            clip.id = format!("clip{index}");
            clip.blend_mode = spec.blend_mode;

            let mut track = Track::new_video(&format!("V{index}"));
            track.add_clip(clip);
            sequence.add_track(track);
        }

        sequence
    }

    fn plan_for(sequence: &Sequence) -> Result<PipPlan, ExportError> {
        plan_pip_groups(sequence, &TransitionPlan::default())
    }

    // -------------------------------------------------------------------------
    // Planning
    // -------------------------------------------------------------------------

    /// Feature: Layered video in the final render
    /// Scenario: clips that merely follow one another are not a composite
    ///
    /// The composite graph costs a backdrop and an overlay per layer. A timeline
    /// whose clips take turns needs neither, and every existing graph-shape test
    /// is written against the unfolded chain.
    #[test]
    fn clips_that_do_not_share_time_are_left_alone() {
        let sequence = sequence_of(vec![ClipSpec::at(0.0, 3.0), ClipSpec::at(3.0, 3.0)]);
        let plan = plan_for(&sequence).expect("a sequential timeline must plan");

        assert!(
            plan.layer("clip0").is_none() && plan.layer("clip1").is_none(),
            "back-to-back clips must not composite"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: overlapping clips join one composite, carrying their track depth
    #[test]
    fn overlapping_clips_join_one_group_carrying_their_track_depth() {
        let sequence = sequence_of(vec![ClipSpec::at(1.0, 3.0), ClipSpec::at(0.0, 3.0)]);
        let plan = plan_for(&sequence).expect("an overlap must plan");

        let top = plan.layer("clip0").expect("the PiP must composite");
        let bottom = plan.layer("clip1").expect("the base must composite");
        assert_eq!(
            top.group_index, bottom.group_index,
            "one overlap, one group"
        );
        assert_eq!(top.track_index, 0, "track 0 is the topmost track");
        assert_eq!(bottom.track_index, 1);
    }

    /// Feature: Layered video in the final render
    /// Scenario: every layer of an overlap is composited, whatever is on top
    ///
    /// An earlier draft dropped the layers beneath an opaque, canvas-filling top
    /// layer as an optimisation. It was wrong twice over. It read a clip's codec
    /// as proof its pixels were opaque, which `VideoInfo::has_alpha` cannot
    /// support — it is hardcoded `false` and nothing probes the pixel format — so
    /// a ProRes 4444 or VP9-alpha overlay rendered the layer beneath as black.
    /// And dropping a clip the transition planner had already planned around left
    /// that boundary unfoldable, failing an export the preflight had permitted.
    ///
    /// Compositing every layer reaches the same picture: an opaque full-canvas
    /// top layer simply covers the ones under it through `overlay`.
    #[test]
    fn every_layer_of_an_overlap_is_composited_even_under_a_full_canvas_clip() {
        let sequence = sequence_of(vec![ClipSpec::at(0.0, 3.0), ClipSpec::at(1.0, 1.0)]);
        let plan = plan_for(&sequence).expect("an overlap must plan");

        let top = plan
            .layer("clip0")
            .expect("the covering layer must composite");
        let bottom = plan
            .layer("clip1")
            .expect("the covered layer must composite too, not be dropped");
        assert_eq!(top.group_index, bottom.group_index);
    }

    /// Feature: Layered video in the final render
    /// Scenario: a muted track is not a layer
    ///
    /// Muting a video track drops it from the render entirely, but it stays
    /// `visible`. Counting it as a layer made it a phantom the fold waited for.
    #[test]
    fn a_muted_track_takes_no_part_in_a_composite() {
        let mut sequence = sequence_of(vec![ClipSpec::at(0.0, 3.0), ClipSpec::at(0.0, 3.0)]);
        sequence.tracks[0].muted = true;
        let plan = plan_for(&sequence).expect("a muted overlap must plan");

        assert!(
            plan.layer("clip0").is_none() && plan.layer("clip1").is_none(),
            "one visible clip is not a composite"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a blend the stack cannot perform is refused, not dropped
    ///
    /// `overlay` does source-over and nothing else, so a layer asking for
    /// another blend would be composited as if it had asked for this one and the
    /// render would quietly differ from the preview.
    #[test]
    fn an_unsupported_blend_inside_an_overlap_is_refused() {
        let sequence = sequence_of(vec![
            ClipSpec::at(1.0, 3.0).blended(BlendMode::SoftLight),
            ClipSpec::at(0.0, 3.0),
        ]);

        let error = plan_for(&sequence).expect_err("an unsupported layer must be refused");
        assert!(
            format!("{error:?}").contains("clip0"),
            "the refusal must name the clip whose blend cannot be rendered: {error:?}"
        );
        assert_eq!(
            composite_refusal(&sequence, &TransitionPlan::default()).map(|refusal| refusal.clip_id),
            Some("clip0"),
            "the preflight must refuse exactly what the planner refuses"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a track's own blend mode counts as the clip's
    ///
    /// A clip left on `Normal` inherits its track's blend mode, so reading the
    /// clip's field alone would let a whole blended track through.
    #[test]
    fn a_tracks_blend_mode_is_refused_the_same_way_a_clips_is() {
        let mut sequence = sequence_of(vec![ClipSpec::at(1.0, 3.0), ClipSpec::at(0.0, 3.0)]);
        sequence.tracks[0].blend_mode = BlendMode::SoftLight;

        assert!(
            plan_for(&sequence).is_err(),
            "a blended track must be refused as surely as a blended clip"
        );
        assert_eq!(
            composite_refusal(&sequence, &TransitionPlan::default()).map(|refusal| refusal.clip_id),
            Some("clip0"),
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: two clips sharing an id cannot be stacked
    ///
    /// A composite addresses its layers by clip id, so a duplicate collapses the
    /// map: the layers stack in the wrong order, or one is dropped outright.
    /// Nothing this engine mints produces a duplicate, but an operation log or
    /// snapshot restored from elsewhere is not checked for one — the same reason
    /// the transition planner guards its own boundaries.
    #[test]
    fn duplicate_clip_ids_inside_a_composite_are_refused() {
        let mut sequence = sequence_of(vec![ClipSpec::at(1.0, 3.0), ClipSpec::at(0.0, 3.0)]);
        sequence.tracks[1].clips[0].id = "clip0".to_string();

        let error = plan_for(&sequence).expect_err("a duplicated layer id must be refused");
        assert!(
            format!("{error:?}").contains("Duplicate clip id")
                && format!("{error:?}").contains("clip0"),
            "the refusal must name the id that made the stack ambiguous: {error:?}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a duplicate id outside every composite is left alone
    ///
    /// The guard is scoped to clips that actually stack. A duplicate elsewhere is
    /// the transition planner's business, not this one's, and refusing it here
    /// would fail renders that have always worked.
    #[test]
    fn a_duplicate_clip_id_outside_a_composite_is_not_this_planners_business() {
        let mut sequence = sequence_of(vec![
            ClipSpec::at(1.0, 3.0),
            ClipSpec::at(0.0, 3.0),
            ClipSpec::at(20.0, 1.0),
            ClipSpec::at(30.0, 1.0),
        ]);
        sequence.tracks[3].clips[0].id = "clip2".to_string();

        assert!(
            plan_for(&sequence).is_ok(),
            "a duplicate id among clips that never stack must not fail the render"
        );
    }

    // -------------------------------------------------------------------------
    // Fold graph shape
    // -------------------------------------------------------------------------

    fn layer_segment(
        label: &str,
        start: f64,
        end: f64,
        track_index: usize,
    ) -> VideoTimelineSegment {
        grouped_segment(label, start, end, track_index, 0)
    }

    fn grouped_segment(
        label: &str,
        start: f64,
        end: f64,
        track_index: usize,
        group_index: usize,
    ) -> VideoTimelineSegment {
        VideoTimelineSegment::new(label, start, end).with_layer(Some(PipLayerInfo {
            group_index,
            track_index,
            blend_spec: None,
        }))
    }

    /// Feature: Layered video in the final render
    /// Scenario: a composite missing a layer is refused, not half-rendered
    ///
    /// Passing the survivor through would look like a graceful degradation and
    /// is not one: the plan staged it as a *layer*, so it carries transparency
    /// and a layer's pixel format, and the timeline stitch would push a `gbrap`
    /// stream into a concat of `yuv420p` ones.
    #[test]
    fn a_composite_that_lost_a_layer_refuses_the_render() {
        let mut graph = String::new();
        let error = fold_pip_groups(
            &mut graph,
            vec![layer_segment("[only]", 0.0, 3.0, 0)],
            FPS,
            1280,
            720,
            "yuv420p",
        )
        .expect_err("a composite of one layer must refuse the render");

        assert!(
            format!("{error:?}").contains("more layers than the render produced"),
            "the refusal must say what went missing: {error:?}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a run of layers becomes one segment spanning the same time
    #[test]
    fn a_fold_hands_back_one_segment_covering_the_whole_group() {
        let mut graph = String::new();
        let folded = fold_pip_groups(
            &mut graph,
            vec![
                layer_segment("[a]", 0.0, 3.0, 1),
                layer_segment("[b]", 1.0, 2.0, 0),
            ],
            FPS,
            1280,
            720,
            "yuv420p",
        )
        .expect("layers must fold");

        assert_eq!(folded.len(), 1, "a group folds to one segment");
        assert_eq!(folded[0].start_sec, 0.0);
        assert_eq!(folded[0].end_sec, 3.0);
        assert_eq!(folded[0].stream_label, "[vpip0]");

        assert!(
            graph.contains("color=c=black:s=1280x720:r=30,format=gbrp,setsar=1,trim=end_frame=90,"),
            "the backdrop is opaque black, pinned to the group frame count: {graph}"
        );
        let bottom = graph.find("[a]").expect("bottom layer");
        let top = graph.find("[b]").expect("top layer");
        assert!(
            bottom < top,
            "the deepest track must be composited first so track 0 lands on top: {graph}"
        );
        assert!(
            graph.contains(
                "overlay=x=0:y=0:format=auto:alpha=straight:eof_action=pass:repeatlast=0"
            ),
            "the stack must not freeze a layer that ends early: {graph}"
        );
        assert!(
            !graph.contains("shortest"),
            "shortest would end the composite at the first layer to run out: {graph}"
        );
        assert!(
            graph.contains("trim=end_frame=90,setpts=PTS-STARTPTS,format=yuv420p[vpip0];"),
            "the composite must end in the shape every other segment ends in: {graph}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a layer that starts late is delayed, not re-timed
    ///
    /// Delaying with `tpad` leaves the layer's own clock alone, which is why a
    /// keyframed move inside a composite needs no rebasing: its expressions in
    /// `t` still measure from the zero they always did.
    #[test]
    fn a_layer_that_starts_late_is_delayed_with_transparent_padding() {
        let mut graph = String::new();
        fold_pip_groups(
            &mut graph,
            vec![
                layer_segment("[a]", 0.0, 3.0, 1),
                layer_segment("[b]", 1.0, 2.0, 0),
            ],
            FPS,
            1280,
            720,
            "yuv420p",
        )
        .expect("layers must fold");

        assert!(
            graph.contains("[b]tpad=start_duration=1:start_mode=add:color=black@0"),
            "a layer one second into the group must be delayed by one second: {graph}"
        );
        assert!(
            !graph.contains("[a]tpad=start_duration="),
            "a layer that starts with the group must not be padded at all: {graph}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: segments outside a composite are passed straight through
    #[test]
    fn segments_outside_a_composite_are_untouched() {
        let mut graph = String::new();
        let folded = fold_pip_groups(
            &mut graph,
            vec![VideoTimelineSegment::new("[solo]", 0.0, 3.0)],
            FPS,
            1280,
            720,
            "yuv420p",
        )
        .expect("a lone segment must pass through");

        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].stream_label, "[solo]");
        assert!(
            graph.is_empty(),
            "nothing to fold must emit nothing: {graph}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: an overlap that escaped the fold is refused, not concatenated
    ///
    /// The timeline stitch lays whatever it is handed end to end and advances a
    /// cursor past each segment, so a surviving overlap would be concatenated —
    /// rendering a video longer than the timeline, and exiting successfully
    /// while doing so.
    #[test]
    fn an_overlap_that_survived_the_fold_refuses_the_render() {
        let mut graph = String::new();
        let error = fold_pip_groups(
            &mut graph,
            vec![
                layer_segment("[a]", 0.0, 3.0, 1),
                layer_segment("[b]", 1.0, 4.0, 0),
                // A second, complete group whose span still overlaps the first.
                grouped_segment("[c]", 2.0, 5.0, 3, 1),
                grouped_segment("[d]", 3.0, 6.0, 2, 1),
            ],
            FPS,
            1280,
            720,
            "yuv420p",
        )
        .expect_err("a surviving overlap must refuse the render");

        assert!(
            format!("{error:?}").contains("longer than the timeline"),
            "the refusal must say what would have gone wrong: {error:?}"
        );
    }

    // -------------------------------------------------------------------------
    // Blend modes
    // -------------------------------------------------------------------------

    /// The W3C separable blend functions, on gamma-encoded sRGB in 0..1.
    ///
    /// Written out here rather than derived from the emitter so the tests check
    /// the render against the specification, not against itself.
    fn w3c_blend(mode: &BlendMode, cb: f64, cs: f64) -> f64 {
        let screen = |cb: f64, cs: f64| cb + cs - cb * cs;
        let hard_light = |cb: f64, cs: f64| {
            if cs <= 0.5 {
                cb * (2.0 * cs)
            } else {
                screen(cb, 2.0 * cs - 1.0)
            }
        };
        match mode {
            BlendMode::Multiply => cb * cs,
            BlendMode::Screen => screen(cb, cs),
            BlendMode::Overlay => hard_light(cs, cb),
            BlendMode::Darken => cb.min(cs),
            BlendMode::Lighten => cb.max(cs),
            BlendMode::HardLight => hard_light(cb, cs),
            BlendMode::Difference => (cb - cs).abs(),
            BlendMode::Exclusion => cb + cs - 2.0 * cb * cs,
            BlendMode::ColorDodge => {
                if cb == 0.0 {
                    0.0
                } else if cs == 1.0 {
                    1.0
                } else {
                    1.0_f64.min(cb / (1.0 - cs))
                }
            }
            BlendMode::ColorBurn => {
                if cb == 1.0 {
                    1.0
                } else if cs == 0.0 {
                    0.0
                } else {
                    1.0 - 1.0_f64.min((1.0 - cb) / cs)
                }
            }
            _ => cs,
        }
    }

    /// The W3C composite of one layer over an opaque backdrop, in 0..255.
    ///
    /// `Co = as * B(Cb, Cs) + (1 - as) * Cb`, which is the model with `ab = 1` —
    /// true here because the bottom of every composite is opaque black.
    fn w3c_composite(mode: &BlendMode, cb: u8, cs: u8, alpha: f64) -> u8 {
        let (cb, cs) = (f64::from(cb) / 255.0, f64::from(cs) / 255.0);
        let blended = w3c_blend(mode, cb, cs);
        ((alpha * blended + (1.0 - alpha) * cb) * 255.0).round() as u8
    }

    fn blend_graph_for(mode: BlendMode) -> String {
        let mut graph = String::new();
        let segments = vec![
            VideoTimelineSegment::new("[base]", 0.0, 2.0).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 1,
                blend_spec: None,
            })),
            VideoTimelineSegment::new("[top]", 0.0, 2.0).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 0,
                blend_spec: blend_filter_spec(&mode),
            })),
        ];
        fold_pip_groups(&mut graph, segments, FPS, 320, 180, "yuv420p").expect("must fold");
        graph
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a blended layer is blended against what is already drawn
    ///
    /// The W3C model splits a blend mode in two: the blend function applies to
    /// colour, and the layer's alpha then composites the result source-over. So
    /// the graph has to blend colour-only streams and put the alpha back
    /// afterwards — never hand `blend` a stream that still carries alpha.
    #[test]
    fn a_blended_layer_blends_against_the_accumulated_picture() {
        let graph = blend_graph_for(BlendMode::Multiply);

        assert!(
            graph.contains("blend=all_mode=multiply:repeatlast=0"),
            "the layer must be blended, and must not freeze when it ends: {graph}"
        );
        assert!(
            graph.contains("alphaextract") && graph.contains("alphamerge"),
            "the layer's own alpha must be carried around the blend: {graph}"
        );
        assert!(
            graph.contains("format=gbrp[pipbc0_1]") && graph.contains("format=gbrp[pipsc0_1]"),
            "both sides of the blend must be colour-only: {graph}"
        );
        // Operand order is the trap: fed the other way round `overlay` computes
        // `hard-light`, which looks plausible and is 255/255 wrong.
        let blend_call = graph
            .split("blend=all_mode=multiply")
            .next()
            .expect("blend call")
            .rsplit(';')
            .next()
            .expect("operands");
        assert_eq!(
            blend_call, "[pipbc0_1][pipsc0_1]",
            "the backdrop must be the blend's first input: {graph}"
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: colour-dodge and colour-burn are written out, not borrowed
    ///
    /// FFmpeg's own `dodge` and `burn` are not the specification's. Each gets one
    /// pixel of the 8-bit domain wrong by the full range — pure white over pure
    /// black renders white under `dodge` where the canvas draws black — and flat
    /// black and white are exactly what letterbox bars and blown highlights are
    /// made of.
    #[test]
    fn colour_dodge_and_burn_are_written_out_rather_than_borrowed() {
        for mode in [BlendMode::ColorDodge, BlendMode::ColorBurn] {
            let graph = blend_graph_for(mode.clone());
            assert!(
                graph.contains("blend=all_expr="),
                "{mode:?} must use the written-out formula: {graph}"
            );
            assert!(
                !graph.contains("all_mode=dodge") && !graph.contains("all_mode=burn"),
                "{mode:?} must not use FFmpeg's own mode: {graph}"
            );
        }
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a blend mode alone makes a clip a composite
    ///
    /// The preview blends every clip against what it has already drawn, and for a
    /// clip with nothing under it that is the opaque black canvas. So a blended
    /// clip composites whether or not anything overlaps it.
    #[test]
    fn a_lone_blended_clip_is_a_one_layer_composite() {
        let mut sequence = sequence_of(vec![ClipSpec::at(0.0, 3.0)]);
        sequence.tracks[0].clips[0].blend_mode = BlendMode::Multiply;
        let plan = plan_for(&sequence).expect("a lone blended clip must plan");

        assert!(
            plan.layer("clip0").is_some(),
            "a blended clip composites even with nothing to overlap"
        );

        let mut plain = sequence_of(vec![ClipSpec::at(0.0, 3.0)]);
        plain.tracks[0].clips[0].blend_mode = BlendMode::Normal;
        assert!(
            plan_for(&plain).expect("plain").layer("clip0").is_none(),
            "a clip with no blend and nothing to overlap must keep the cheaper graph"
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: an unsupported mode is refused even with nothing to overlap
    ///
    /// Only *supported* modes pull a clip into a composite, so a lone clip
    /// asking for an unsupported one is in no group. Refusing by walking the
    /// groups alone would therefore let it through, and it would render as plain
    /// source-over with nothing said — refused when it overlaps something,
    /// silent when it does not.
    #[test]
    fn an_unsupported_blend_is_refused_even_with_nothing_to_overlap() {
        let mut lone = sequence_of(vec![ClipSpec::at(0.0, 3.0)]);
        lone.tracks[0].clips[0].blend_mode = BlendMode::SoftLight;
        assert_eq!(
            composite_refusal(&lone, &TransitionPlan::default()).map(|refusal| refusal.clip_id),
            Some("clip0"),
            "a lone unsupported blend must be refused, not quietly ignored"
        );

        let mut supported = sequence_of(vec![ClipSpec::at(0.0, 3.0)]);
        supported.tracks[0].clips[0].blend_mode = BlendMode::Multiply;
        assert!(
            composite_refusal(&supported, &TransitionPlan::default()).is_none(),
            "a lone supported blend must render, not be refused"
        );
        assert!(
            plan_for(&supported)
                .expect("a lone supported blend must plan")
                .layer("clip0")
                .is_some(),
            "and it must actually composite"
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: every supported mode is emitted, and no other one is
    #[test]
    fn exactly_the_measured_modes_are_supported() {
        for mode in [
            BlendMode::Multiply,
            BlendMode::Screen,
            BlendMode::Overlay,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorBurn,
            BlendMode::ColorDodge,
            BlendMode::HardLight,
            BlendMode::Difference,
            BlendMode::Exclusion,
        ] {
            assert!(
                blend_filter_spec(&mode).is_some() && composite_blend_is_supported(&mode),
                "{mode:?} was measured against the specification and must render"
            );
        }
        assert!(
            composite_blend_is_supported(&BlendMode::Normal)
                && blend_filter_spec(&BlendMode::Normal).is_none(),
            "Normal is source-over, which needs no blend filter at all"
        );
        for mode in [
            BlendMode::SoftLight,
            BlendMode::Add,
            BlendMode::Subtract,
            BlendMode::LinearBurn,
            BlendMode::LinearDodge,
            BlendMode::VividLight,
            BlendMode::LinearLight,
            BlendMode::PinLight,
        ] {
            assert!(
                !composite_blend_is_supported(&mode),
                "{mode:?} cannot be rendered faithfully and must stay refused"
            );
        }
    }

    // -------------------------------------------------------------------------
    // Rendered pixels
    // -------------------------------------------------------------------------
    //
    // These render the composite the builder really emits and measure what comes
    // out. They run the fold with `gbrp` as the output format so that the
    // measurement is of the composite itself rather than of the 4:2:0 conversion
    // every export pays on the way to disk; the production tail (`yuv420p`) is
    // pinned by `a_fold_hands_back_one_segment_covering_the_whole_group`.

    /// One layer of a test composite.
    struct LayerSpec {
        /// Which `-i` this layer's picture comes from.
        input: usize,
        /// 0 is the topmost track.
        track_index: usize,
        /// Where the layer's picture lands on the canvas.
        corner: (i32, i32),
        size: (u32, u32),
        opacity: f64,
        start_sec: f64,
        end_sec: f64,
        /// The blend this layer composites through. `Normal` is source-over.
        blend: BlendMode,
    }

    impl LayerSpec {
        fn plain(input: usize, track_index: usize, size: (u32, u32), canvas: (u32, u32)) -> Self {
            let _ = canvas;
            Self {
                input,
                track_index,
                corner: (0, 0),
                size,
                opacity: 1.0,
                start_sec: 0.0,
                end_sec: 2.0,
                blend: BlendMode::Normal,
            }
        }

        fn blended(mut self, blend: BlendMode) -> Self {
            self.blend = blend;
            self
        }

        fn faded(mut self, opacity: f64) -> Self {
            self.opacity = opacity;
            self
        }

        fn placed(mut self, corner: (i32, i32)) -> Self {
            self.corner = corner;
            self
        }
    }

    /// A solid-colour clip, encoded losslessly so the measured colour is exact.
    fn solid_clip(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        name: &str,
        size: (u32, u32),
        colour: (u8, u8, u8),
        duration_sec: f64,
    ) -> Option<std::path::PathBuf> {
        let path = dir.join(name);
        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        let built = command
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "color=c=black:s={}x{}:r=30:d={duration_sec}",
                    size.0, size.1
                ),
                "-vf",
                &format!(
                    "format=gbrp,geq=r={}:g={}:b={}",
                    colour.0, colour.1, colour.2
                ),
                "-c:v",
                "ffv1",
                "-pix_fmt",
                "gbrp",
            ])
            .arg(&path)
            .output()
            .ok()?;

        (built.status.success() && path.exists()).then_some(path)
    }

    /// The composite graph the builder emits for these layers.
    ///
    /// Every layer goes through the real composition emitter with
    /// `transparent_canvas`, exactly as the builder does for a clip the plan put
    /// in a group, and the real fold stacks them.
    fn composite_graph(layers: &[LayerSpec], canvas: (u32, u32)) -> String {
        let mut graph = String::new();
        let mut segments = Vec::new();

        for spec in layers {
            let label = format!("vnorm{}", spec.input);
            let layout = ClipTransformLayout {
                scaled_width: spec.size.0,
                scaled_height: spec.size.1,
                rotation_rad: 0.0,
                bounding_width: spec.size.0,
                bounding_height: spec.size.1,
                overlay_x: spec.corner.0,
                overlay_y: spec.corner.1,
                opacity: spec.opacity,
            };
            append_video_transform_composition(
                &mut graph,
                &format!("{}:v", spec.input),
                &label,
                &layout,
                spec.end_sec - spec.start_sec,
                canvas.0,
                canvas.1,
                FPS,
                "gbrp",
                true,
            );
            segments.push(
                VideoTimelineSegment::new(format!("[{label}]"), spec.start_sec, spec.end_sec)
                    .with_layer(Some(PipLayerInfo {
                        group_index: 0,
                        track_index: spec.track_index,
                        blend_spec: blend_filter_spec(&spec.blend),
                    })),
            );
        }

        let folded = fold_pip_groups(&mut graph, segments, FPS, canvas.0, canvas.1, "gbrp")
            .expect("the layers must fold");
        assert_eq!(folded.len(), 1, "the layers must fold into one segment");
        graph.push_str(&format!("{}null[out];", folded[0].stream_label));
        graph
    }

    /// Renders `graph` over `inputs` and hands back its frames as packed RGB.
    fn render_rgb_frames(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        inputs: &[std::path::PathBuf],
        graph: &str,
        canvas: (u32, u32),
    ) -> Vec<Vec<u8>> {
        let graph_file = dir.join("graph.txt");
        std::fs::write(&graph_file, graph.trim_end_matches(';')).expect("write filtergraph");

        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        for input in inputs {
            command.arg("-i").arg(input);
        }
        let render = command
            .arg("-/filter_complex")
            .arg(&graph_file)
            .args(["-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .expect("run ffmpeg");

        assert!(
            render.status.success(),
            "ffmpeg refused the composite graph: {}\n{graph}",
            String::from_utf8_lossy(&render.stderr)
        );

        render
            .stdout
            .chunks_exact(canvas.0 as usize * canvas.1 as usize * 3)
            .map(<[u8]>::to_vec)
            .collect()
    }

    fn pixel(frame: &[u8], width: u32, x: u32, y: u32) -> (u8, u8, u8) {
        let offset = ((y * width + x) * 3) as usize;
        (frame[offset], frame[offset + 1], frame[offset + 2])
    }

    /// The bounding box of every pixel matching `colour`, as (x0, y0, x1, y1).
    fn colour_bounds(
        frame: &[u8],
        canvas: (u32, u32),
        colour: (u8, u8, u8),
    ) -> Option<(u32, u32, u32, u32)> {
        let mut bounds: Option<(u32, u32, u32, u32)> = None;
        for y in 0..canvas.1 {
            for x in 0..canvas.0 {
                if pixel(frame, canvas.0, x, y) == colour {
                    bounds = Some(match bounds {
                        None => (x, y, x, y),
                        Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                    });
                }
            }
        }
        bounds
    }

    /// Feature: Layered video in the final render
    /// Scenario: a picture-in-picture lands where it was put, and blends as the
    /// preview blends
    ///
    /// Two things are measured here, and the second is the more important.
    ///
    /// The **rectangle** proves the placement survives the composite at an odd
    /// offset — `overlay` in a chroma-subsampled mode cannot address one.
    ///
    /// The **colour** proves the stack composites in gamma-encoded sRGB, which is
    /// what a 2D canvas does. A 50% green layer over a red backdrop lands on
    /// (127, 128, 0) that way. Compositing in linear light — the other plausible
    /// choice, and the one a colour-managed compositor would make — would have
    /// produced roughly (188, 188, 0) instead. The two answers are 60 levels
    /// apart, so this is not a tolerance question.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored picture_in_picture
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_picture_in_picture_lands_on_its_pixel_and_blends_in_gamma_space() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (640, 360);
        const PIP: (u32, u32) = (320, 180);
        const CORNER: (i32, i32) = (101, 51);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let (Some(base), Some(pip)) = (
            solid_clip(&ffmpeg, dir.path(), "base.mkv", CANVAS, (255, 0, 0), 2.0),
            solid_clip(&ffmpeg, dir.path(), "pip.mkv", PIP, (0, 255, 0), 2.0),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let graph = composite_graph(
            &[
                LayerSpec {
                    input: 0,
                    track_index: 1,
                    corner: (0, 0),
                    size: CANVAS,
                    opacity: 1.0,
                    start_sec: 0.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
                LayerSpec {
                    input: 1,
                    track_index: 0,
                    corner: CORNER,
                    size: PIP,
                    opacity: 0.5,
                    start_sec: 0.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
            ],
            CANVAS,
        );

        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, pip], &graph, CANVAS);
        assert!(!frames.is_empty(), "the composite must render frames");
        let frame = &frames[0];

        // 8-bit alpha quantises 0.5 to 128/255, so the blend is 0.50196 of the
        // PiP over 0.49804 of the backdrop: (127.0, 128.0, 0.0).
        let blended = (127, 128, 0);
        assert_eq!(
            pixel(frame, CANVAS.0, 200, 100),
            blended,
            "a 50% layer must blend in gamma space; linear light would be near (188, 188, 0)"
        );
        assert_eq!(
            pixel(frame, CANVAS.0, 10, 10),
            (255, 0, 0),
            "the backdrop layer must be untouched outside the PiP"
        );

        let bounds = colour_bounds(frame, CANVAS, blended).expect("the PiP must be on screen");
        assert_eq!(
            bounds,
            (
                CORNER.0 as u32,
                CORNER.1 as u32,
                CORNER.0 as u32 + PIP.0 - 1,
                CORNER.1 as u32 + PIP.1 - 1,
            ),
            "the PiP must occupy exactly the rectangle it was placed at, odd corner included"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: three layers stack in track order, and every region is exact
    ///
    /// The middle layer proves the order: a translucent top layer sitting partly
    /// over the middle one and partly over the bottom one blends differently in
    /// each place, so a stack built in the wrong order cannot produce both.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored three_layers
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn three_layers_stack_in_track_order_with_every_region_exact() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (640, 360);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let (Some(bottom), Some(middle), Some(top)) = (
            solid_clip(&ffmpeg, dir.path(), "b.mkv", CANVAS, (40, 40, 40), 2.0),
            solid_clip(
                &ffmpeg,
                dir.path(),
                "m.mkv",
                (320, 180),
                (200, 100, 50),
                2.0,
            ),
            solid_clip(
                &ffmpeg,
                dir.path(),
                "t.mkv",
                (200, 100),
                (100, 200, 20),
                2.0,
            ),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let graph = composite_graph(
            &[
                LayerSpec {
                    input: 0,
                    track_index: 2,
                    corner: (0, 0),
                    size: CANVAS,
                    opacity: 1.0,
                    start_sec: 0.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
                LayerSpec {
                    input: 1,
                    track_index: 1,
                    corner: (101, 51),
                    size: (320, 180),
                    opacity: 1.0,
                    start_sec: 0.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
                LayerSpec {
                    input: 2,
                    track_index: 0,
                    corner: (51, 31),
                    size: (200, 100),
                    opacity: 0.5,
                    start_sec: 0.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
            ],
            CANVAS,
        );

        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[bottom, middle, top], &graph, CANVAS);
        let frame = &frames[0];

        for (point, expected, what) in [
            ((10_u32, 10_u32), (40, 40, 40), "backdrop layer alone"),
            ((300, 200), (200, 100, 50), "middle layer alone"),
            (
                (200, 100),
                (150, 150, 35),
                "top layer at 50% over the middle layer",
            ),
            (
                (60, 100),
                (70, 120, 30),
                "top layer at 50% over the backdrop layer",
            ),
        ] {
            assert_eq!(
                pixel(frame, CANVAS.0, point.0, point.1),
                expected,
                "{what} must composite exactly"
            );
        }
    }

    /// Feature: Layered video in the final render
    /// Scenario: a layer that ends early leaves, instead of freezing on screen
    ///
    /// This is the whole reason `eof_action=pass:repeatlast=0` is on the stack.
    /// Measured negative control: with FFmpeg's defaults the layer's last frame
    /// is stamped onto every remaining frame of the group — on a 90-frame group
    /// with a layer covering frames 30-59, 28 of the 30 frames that follow kept
    /// showing a picture-in-picture that had already ended.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored ends_early
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_layer_that_ends_early_leaves_the_picture() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (320, 180);
        const BASE: (u8, u8, u8) = (40, 40, 40);
        const PIP: (u8, u8, u8) = (0, 255, 0);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let (Some(base), Some(pip)) = (
            solid_clip(&ffmpeg, dir.path(), "base.mkv", CANVAS, BASE, 3.2),
            solid_clip(&ffmpeg, dir.path(), "pip.mkv", (160, 90), PIP, 1.2),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        // A three-second group with the PiP present only for its middle second.
        let graph = composite_graph(
            &[
                LayerSpec {
                    input: 0,
                    track_index: 1,
                    corner: (0, 0),
                    size: CANVAS,
                    opacity: 1.0,
                    start_sec: 0.0,
                    end_sec: 3.0,
                    blend: BlendMode::Normal,
                },
                LayerSpec {
                    input: 1,
                    track_index: 0,
                    corner: (81, 45),
                    size: (160, 90),
                    opacity: 1.0,
                    start_sec: 1.0,
                    end_sec: 2.0,
                    blend: BlendMode::Normal,
                },
            ],
            CANVAS,
        );

        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, pip], &graph, CANVAS);
        assert_eq!(frames.len(), 90, "the group must be exactly three seconds");

        for (index, frame) in frames.iter().enumerate() {
            let centre = pixel(frame, CANVAS.0, 160, 90);
            let expected = if (30..60).contains(&index) { PIP } else { BASE };
            assert_eq!(
                centre, expected,
                "frame {index}: a layer covering frames 30-59 must appear and leave on time"
            );
            assert_eq!(
                pixel(frame, CANVAS.0, 5, 5),
                BASE,
                "frame {index}: the layer beneath must play throughout"
            );
        }
    }

    /// Feature: Layered video in the final render
    /// Scenario: a letterboxed layer lets the layer beneath show through its bars
    ///
    /// The preview draws only the picture, so whatever is under a layer shows in
    /// the bars its aspect ratio leaves. Staging a layer on an opaque black
    /// canvas — which is what a clip that owns its seconds outright gets — would
    /// paint those bars black and hide the layer beneath, in the export only.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored letterbox
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_letterboxed_layer_lets_the_layer_beneath_show_through_its_bars() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (640, 360);
        const BASE: (u8, u8, u8) = (40, 40, 40);
        const TOP: (u8, u8, u8) = (200, 100, 50);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        // A 4:3 source on a 16:9 canvas: 480x360 of picture, pillars either side.
        let (Some(base), Some(top)) = (
            solid_clip(&ffmpeg, dir.path(), "base.mkv", CANVAS, BASE, 2.0),
            solid_clip(&ffmpeg, dir.path(), "top.mkv", (480, 360), TOP, 2.0),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let mut graph = String::new();
        let mut segments = Vec::new();

        append_video_transform_composition(
            &mut graph,
            "0:v",
            "vnorm0",
            &ClipTransformLayout {
                scaled_width: CANVAS.0,
                scaled_height: CANVAS.1,
                rotation_rad: 0.0,
                bounding_width: CANVAS.0,
                bounding_height: CANVAS.1,
                overlay_x: 0,
                overlay_y: 0,
                opacity: 1.0,
            },
            2.0,
            CANVAS.0,
            CANVAS.1,
            FPS,
            "gbrp",
            true,
        );
        segments.push(
            VideoTimelineSegment::new("[vnorm0]", 0.0, 2.0).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 1,
                blend_spec: None,
            })),
        );

        // The top layer takes the fit-and-pad chain, which is what an untouched
        // clip gets — the very chain that used to bake opaque bars.
        append_video_stream_normalization(
            &mut graph, "1:v", "vnorm1", CANVAS.0, CANVAS.1, FPS, "gbrp", None, true,
        );
        segments.push(
            VideoTimelineSegment::new("[vnorm1]", 0.0, 2.0).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 0,
                blend_spec: None,
            })),
        );

        let folded = fold_pip_groups(&mut graph, segments, FPS, CANVAS.0, CANVAS.1, "gbrp")
            .expect("the layers must fold");
        graph.push_str(&format!("{}null[out];", folded[0].stream_label));

        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, top], &graph, CANVAS);
        let frame = &frames[0];

        assert_eq!(
            pixel(frame, CANVAS.0, 320, 180),
            TOP,
            "the letterboxed layer's own picture must be on top"
        );
        assert_eq!(
            pixel(frame, CANVAS.0, 10, 180),
            BASE,
            "the layer beneath must show through the pillar, not be blacked out"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a keyframed move keeps animating inside a composite
    ///
    /// This is what group-span folding buys. Every layer keeps its own intact
    /// stream with its own `setpts=PTS-STARTPTS`, so the expressions in `t` that
    /// drive a move still measure from the zero they were written against — no
    /// keyframe time needs rebasing. Splitting the base clip at the PiP's edges
    /// instead would have restarted the move at every seam.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored keyframed_move
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_keyframed_move_still_animates_inside_a_composite() {
        use super::super::export::append_animated_video_transform_composition;
        use super::super::transform_layout::resolve_clip_motion_track;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{KeyframeInterpolation, TransformKeyframe};

        const CANVAS: (u32, u32) = (320, 180);
        const SOURCE: (u32, u32) = (320, 180);
        const BASE: (u8, u8, u8) = (40, 40, 40);
        const MOVER: (u8, u8, u8) = (0, 255, 0);
        const SLOT_SEC: f64 = 2.0;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let (Some(base), Some(mover)) = (
            solid_clip(&ffmpeg, dir.path(), "base.mkv", CANVAS, BASE, 2.2),
            solid_clip(&ffmpeg, dir.path(), "mover.mkv", SOURCE, MOVER, 2.2),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        // A zoom from 0.3x to 0.8x, centred, so the layer's area grows every
        // frame while never covering the canvas.
        let zoom_at = |scale: f64| Transform {
            position: Point2D::new(0.5, 0.5),
            scale: Point2D::new(scale, scale),
            rotation_deg: 0.0,
            anchor: Point2D::center(),
        };
        let mut clip = Clip::new("mover")
            .with_source_range(0.0, SLOT_SEC)
            .place_at(0.0);
        clip.motion_keyframes = vec![
            TransformKeyframe {
                time_offset: 0.0,
                transform: zoom_at(0.3),
                interpolation: KeyframeInterpolation::Linear,
            },
            TransformKeyframe {
                time_offset: SLOT_SEC,
                transform: zoom_at(0.8),
                interpolation: KeyframeInterpolation::Linear,
            },
        ];
        let track = resolve_clip_motion_track(SOURCE.0, SOURCE.1, CANVAS.0, CANVAS.1, &clip, 0.0)
            .expect("the clip has motion keyframes");

        let mut graph = String::new();
        let mut segments = Vec::new();

        append_video_transform_composition(
            &mut graph,
            "0:v",
            "vnorm0",
            &ClipTransformLayout {
                scaled_width: CANVAS.0,
                scaled_height: CANVAS.1,
                rotation_rad: 0.0,
                bounding_width: CANVAS.0,
                bounding_height: CANVAS.1,
                overlay_x: 0,
                overlay_y: 0,
                opacity: 1.0,
            },
            SLOT_SEC,
            CANVAS.0,
            CANVAS.1,
            FPS,
            "gbrp",
            true,
        );
        segments.push(
            VideoTimelineSegment::new("[vnorm0]", 0.0, SLOT_SEC).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 1,
                blend_spec: None,
            })),
        );

        append_animated_video_transform_composition(
            &mut graph, "1:v", "vnorm1", &track, 1.0, SLOT_SEC, CANVAS.0, CANVAS.1, FPS, "gbrp",
            true,
        );
        segments.push(
            VideoTimelineSegment::new("[vnorm1]", 0.0, SLOT_SEC).with_layer(Some(PipLayerInfo {
                group_index: 0,
                track_index: 0,
                blend_spec: None,
            })),
        );

        let folded = fold_pip_groups(&mut graph, segments, FPS, CANVAS.0, CANVAS.1, "gbrp")
            .expect("the layers must fold");
        graph.push_str(&format!("{}null[out];", folded[0].stream_label));

        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, mover], &graph, CANVAS);
        assert_eq!(frames.len(), 60, "the composite must fill its slot");

        let widths: Vec<u32> = frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                let (x0, _, x1, _) = colour_bounds(frame, CANVAS, MOVER)
                    .unwrap_or_else(|| panic!("frame {index} shows no moving layer at all"));
                x1 - x0 + 1
            })
            .collect();

        let first = widths[0];
        let last = *widths.last().expect("frames");
        assert!(
            last > first + 100,
            "a 0.3x -> 0.8x zoom must keep growing inside the composite, got {first} -> {last}: \
             {widths:?}"
        );
        assert!(
            widths.windows(2).all(|pair| pair[1] >= pair[0]),
            "the move must never shrink or freeze: {widths:?}"
        );
        assert_eq!(
            pixel(&frames[0], CANVAS.0, 5, 5),
            BASE,
            "the layer beneath must show around the moving one"
        );
    }

    /// Largest deviation from the specification any supported mode is allowed.
    ///
    /// Measured over all 65536 8-bit backdrop/source pairs for every mode, at
    /// full opacity and at half: the worst was 1.99/255 (`overlay` and
    /// `hard-light`, both at the 0.5 hinge), and no pair anywhere exceeded 2.
    const BLEND_TOLERANCE: i16 = 2;

    fn assert_near(got: (u8, u8, u8), want: (u8, u8, u8), what: &str) {
        let delta = |a: u8, b: u8| (i16::from(a) - i16::from(b)).abs();
        assert!(
            delta(got.0, want.0) <= BLEND_TOLERANCE
                && delta(got.1, want.1) <= BLEND_TOLERANCE
                && delta(got.2, want.2) <= BLEND_TOLERANCE,
            "{what}: rendered {got:?}, specification says {want:?}"
        );
    }

    /// Renders one blended layer over one plain layer and returns the middle pixel.
    fn blended_pair(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        canvas: (u32, u32),
        base: (u8, u8, u8),
        top: (u8, u8, u8),
        mode: BlendMode,
        opacity: f64,
    ) -> (u8, u8, u8) {
        let base_clip =
            solid_clip(ffmpeg, dir, "bbase.mkv", canvas, base, 2.0).expect("base fixture");
        let top_clip = solid_clip(ffmpeg, dir, "btop.mkv", canvas, top, 2.0).expect("top fixture");
        let graph = composite_graph(
            &[
                LayerSpec::plain(0, 1, canvas, canvas),
                LayerSpec::plain(1, 0, canvas, canvas)
                    .blended(mode)
                    .faded(opacity),
            ],
            canvas,
        );
        let frames = render_rgb_frames(ffmpeg, dir, &[base_clip, top_clip], &graph, canvas);
        pixel(&frames[0], canvas.0, canvas.0 / 2, canvas.1 / 2)
    }

    /// Feature: Blend modes in the final render
    /// Scenario: every supported mode renders what the specification says
    ///
    /// One flat colour over another, measured against the W3C separable blend
    /// functions computed here. The spike swept all 65536 8-bit backdrop/source
    /// pairs per mode; this pins one representative pair per mode so a wiring
    /// mistake — the operand order especially — cannot pass unnoticed.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored every_supported_blend
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn every_supported_blend_mode_matches_the_specification() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (64, 64);
        const BASE: (u8, u8, u8) = (100, 150, 200);
        const TOP: (u8, u8, u8) = (200, 50, 25);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        if solid_clip(&ffmpeg, dir.path(), "probe.mkv", CANVAS, BASE, 0.1).is_none() {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        }

        for mode in [
            BlendMode::Multiply,
            BlendMode::Screen,
            BlendMode::Overlay,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorBurn,
            BlendMode::ColorDodge,
            BlendMode::HardLight,
            BlendMode::Difference,
            BlendMode::Exclusion,
        ] {
            let got = blended_pair(&ffmpeg, dir.path(), CANVAS, BASE, TOP, mode.clone(), 1.0);
            let want = (
                w3c_composite(&mode, BASE.0, TOP.0, 1.0),
                w3c_composite(&mode, BASE.1, TOP.1, 1.0),
                w3c_composite(&mode, BASE.2, TOP.2, 1.0),
            );
            assert_near(got, want, &format!("{mode:?}"));
        }
    }

    /// Feature: Blend modes in the final render
    /// Scenario: colour-dodge keeps a black backdrop black
    ///
    /// This is the pixel FFmpeg's own `dodge` gets wrong, and it is not an
    /// exotic one: pure white over pure black. The specification returns the
    /// backdrop's own 0; `dodge` returns white. Flat black and white are what
    /// letterbox bars, titles and blown highlights are made of.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored dodge_keeps
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn colour_dodge_keeps_a_black_backdrop_black() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (64, 64);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        if solid_clip(&ffmpeg, dir.path(), "probe.mkv", CANVAS, (0, 0, 0), 0.1).is_none() {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        }

        let got = blended_pair(
            &ffmpeg,
            dir.path(),
            CANVAS,
            (0, 0, 0),
            (255, 255, 255),
            BlendMode::ColorDodge,
            1.0,
        );
        assert_near(
            got,
            (0, 0, 0),
            "pure white colour-dodged onto pure black (FFmpeg's own dodge renders white)",
        );

        let burned = blended_pair(
            &ffmpeg,
            dir.path(),
            CANVAS,
            (255, 255, 255),
            (0, 0, 0),
            BlendMode::ColorBurn,
            1.0,
        );
        assert_near(
            burned,
            (255, 255, 255),
            "pure black colour-burned onto pure white (FFmpeg's own burn renders black)",
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: opacity scales the blend, it does not bypass it
    ///
    /// The W3C model composites the blended colour source-over at the layer's
    /// alpha, so half opacity lands halfway between the backdrop and the fully
    /// blended result. `blend`'s own `all_opacity` does not mean that — its
    /// semantics differ between modes — so the opacity rides on the layer's alpha
    /// channel and the final `overlay` does the arithmetic.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored half_opacity
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_blended_layer_at_half_opacity_lands_halfway() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (64, 64);
        const BASE: (u8, u8, u8) = (100, 150, 200);
        const TOP: (u8, u8, u8) = (200, 50, 25);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        if solid_clip(&ffmpeg, dir.path(), "probe.mkv", CANVAS, BASE, 0.1).is_none() {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        }

        // 8-bit alpha quantises 0.5 to 128/255.
        let alpha = 128.0 / 255.0;
        for mode in [BlendMode::Multiply, BlendMode::ColorDodge] {
            let got = blended_pair(&ffmpeg, dir.path(), CANVAS, BASE, TOP, mode.clone(), 0.5);
            let want = (
                w3c_composite(&mode, BASE.0, TOP.0, alpha),
                w3c_composite(&mode, BASE.1, TOP.1, alpha),
                w3c_composite(&mode, BASE.2, TOP.2, alpha),
            );
            assert_near(got, want, &format!("{mode:?} at half opacity"));
            let full = (
                w3c_composite(&mode, BASE.0, TOP.0, 1.0),
                w3c_composite(&mode, BASE.1, TOP.1, 1.0),
                w3c_composite(&mode, BASE.2, TOP.2, 1.0),
            );
            assert_ne!(
                want, full,
                "the fixture must distinguish half opacity from full, or it proves nothing"
            );
        }
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a blended layer leaves the backdrop alone outside its picture
    ///
    /// A layer smaller than the canvas is transparent around its picture, and a
    /// blend applies only where the layer actually is. Blending the alpha plane
    /// along with the colour — which is what happens if `blend` is handed a
    /// stream that still carries alpha — spreads the blend across the whole
    /// canvas.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored outside_its_picture
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_blended_layer_changes_nothing_outside_its_picture() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (128, 128);
        const BASE: (u8, u8, u8) = (100, 150, 200);
        const TOP: (u8, u8, u8) = (200, 50, 25);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let (Some(base), Some(top)) = (
            solid_clip(&ffmpeg, dir.path(), "lbase.mkv", CANVAS, BASE, 2.0),
            solid_clip(&ffmpeg, dir.path(), "ltop.mkv", (64, 64), TOP, 2.0),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let graph = composite_graph(
            &[
                LayerSpec::plain(0, 1, CANVAS, CANVAS),
                LayerSpec::plain(1, 0, (64, 64), CANVAS)
                    .blended(BlendMode::Multiply)
                    .placed((33, 33)),
            ],
            CANVAS,
        );
        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, top], &graph, CANVAS);
        let frame = &frames[0];

        assert_eq!(
            pixel(frame, CANVAS.0, 5, 5),
            BASE,
            "outside the layer's picture the backdrop must be untouched"
        );
        assert_eq!(
            pixel(frame, CANVAS.0, 120, 120),
            BASE,
            "and untouched on the other side of it too"
        );
        assert_near(
            pixel(frame, CANVAS.0, 64, 64),
            (
                w3c_composite(&BlendMode::Multiply, BASE.0, TOP.0, 1.0),
                w3c_composite(&BlendMode::Multiply, BASE.1, TOP.1, 1.0),
                w3c_composite(&BlendMode::Multiply, BASE.2, TOP.2, 1.0),
            ),
            "inside the layer's picture it must be blended",
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: each layer blends against everything already drawn
    ///
    /// Three layers, two different modes. The top layer's blend must see the
    /// picture the middle layer produced, not the bottom layer — that is what
    /// "accumulated backdrop" means, and a stack that blended every layer against
    /// the original backdrop would give a different answer here.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored accumulated
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn blended_layers_stack_against_the_accumulated_picture() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (64, 64);
        const BASE: (u8, u8, u8) = (100, 150, 200);
        const MID: (u8, u8, u8) = (128, 128, 128);
        const TOP: (u8, u8, u8) = (200, 50, 25);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let (Some(base), Some(mid), Some(top)) = (
            solid_clip(&ffmpeg, dir.path(), "sbase.mkv", CANVAS, BASE, 2.0),
            solid_clip(&ffmpeg, dir.path(), "smid.mkv", CANVAS, MID, 2.0),
            solid_clip(&ffmpeg, dir.path(), "stop.mkv", CANVAS, TOP, 2.0),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let graph = composite_graph(
            &[
                LayerSpec::plain(0, 2, CANVAS, CANVAS),
                LayerSpec::plain(1, 1, CANVAS, CANVAS).blended(BlendMode::Multiply),
                LayerSpec::plain(2, 0, CANVAS, CANVAS)
                    .blended(BlendMode::Screen)
                    .faded(0.5),
            ],
            CANVAS,
        );
        let frames = render_rgb_frames(&ffmpeg, dir.path(), &[base, mid, top], &graph, CANVAS);
        let got = pixel(&frames[0], CANVAS.0, 32, 32);

        let alpha = 128.0 / 255.0;
        let chain = |base: u8, mid: u8, top: u8| {
            let after_mid = w3c_composite(&BlendMode::Multiply, base, mid, 1.0);
            w3c_composite(&BlendMode::Screen, after_mid, top, alpha)
        };
        assert_near(
            got,
            (
                chain(BASE.0, MID.0, TOP.0),
                chain(BASE.1, MID.1, TOP.1),
                chain(BASE.2, MID.2, TOP.2),
            ),
            "a multiply then a half-opacity screen, each against what came before",
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a lone blended clip blends against the black canvas
    ///
    /// The preview blends every clip against what it has already drawn, and for a
    /// clip with nothing beneath it that is the opaque black canvas. Multiply
    /// over nothing really is black, and the export has to agree — this is the
    /// case where "blend modes only matter when clips overlap" would be wrong.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored lone_blended
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_lone_blended_clip_blends_against_the_black_canvas() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (64, 64);
        const COLOUR: (u8, u8, u8) = (200, 50, 25);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(clip) = solid_clip(&ffmpeg, dir.path(), "lone.mkv", CANVAS, COLOUR, 2.0) else {
            skip_without_ffmpeg("ffmpeg could not build the fixture");
            return;
        };

        for (mode, want) in [
            // Multiply against black is black; screen against black is the clip.
            (BlendMode::Multiply, (0, 0, 0)),
            (BlendMode::Screen, COLOUR),
        ] {
            let graph = composite_graph(
                &[LayerSpec::plain(0, 0, CANVAS, CANVAS).blended(mode.clone())],
                CANVAS,
            );
            let frames = render_rgb_frames(
                &ffmpeg,
                dir.path(),
                std::slice::from_ref(&clip),
                &graph,
                CANVAS,
            );
            assert_near(
                pixel(&frames[0], CANVAS.0, 32, 32),
                want,
                &format!("a lone {mode:?} clip over the black canvas"),
            );
        }
    }
}
