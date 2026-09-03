//! Timeline inspection signals — the "where to look" summary.
//!
//! An agent that has just applied an edit needs a mechanical answer to
//! *where on the timeline* the result should be inspected. Reading
//! `timeline clips` and reconstructing cut times, transition spans and marker
//! positions by hand is both tedious and easy to get wrong: a transition is
//! stored on the outgoing clip and blends *across* the cut, so its span is not
//! any clip boundary the clip list prints.
//!
//! This module derives those signals once, from a [`Sequence`] plus the effect
//! table its clips reference, so the CLI (`timeline info`) and the MCP
//! (`openreelio.timeline.snapshot`) serialize the same numbers.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{get_text_data_from_effects, is_text_clip},
    effects::{Effect, EffectType},
    render::{
        export::TIMELINE_EPSILON_SEC,
        track_included_in_export,
        transition_stitch::{picture_refusal_reason, DEFAULT_TRANSITION_SEC, MAX_TRANSITION_SEC},
    },
    timeline::{Canvas, Clip, Marker, Sequence, Track, TrackKind},
    EffectId, Ratio, TimeSec,
};

/// Tolerance used when deciding whether an edit point sits on the timeline's
/// start or end rather than between two shots (1 microsecond).
const TIME_EPSILON: f64 = 1e-6;

/// A span of timeline occupied by words on screen — a caption or a text clip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpan {
    /// Clip id carrying the words.
    pub id: String,
    /// Track the clip sits on.
    pub track_id: String,
    /// Timeline in point, in seconds.
    pub start_sec: TimeSec,
    /// Timeline out point, in seconds.
    pub end_sec: TimeSec,
    /// The words the span shows, as far as the project state records them.
    pub text: String,
}

/// The stretch of timeline a two-input transition blends across.
///
/// Transitions are stored on the **outgoing** clip and rendered around the cut,
/// so the span reaches back into the outgoing shot and forward into the incoming
/// one. Neither boundary is a clip boundary, which is exactly why a caller
/// cannot derive this from a clip list.
///
/// The span is frame-quantised the way the render stitcher quantises it, and is
/// therefore *asymmetric* for an odd frame count: the extra frame goes after the
/// cut, so the blend still starts on the cut's own frame. See
/// [`transition_span_sec`].
///
/// A stored transition the renderer refuses is still listed, with
/// [`renders_as_cut`](Self::renders_as_cut) set and
/// [`refusal_reason`](Self::refusal_reason) saying why — an agent that asked for
/// a dissolve needs to learn that the file will show a hard cut, and a span it
/// can go and look at is how it checks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionSpan {
    /// Outgoing clip the transition effect hangs on.
    pub clip_id: String,
    /// Track the outgoing clip sits on.
    pub track_id: String,
    /// The transition effect itself.
    pub effect_id: String,
    /// Effect type, e.g. `cross_dissolve`.
    pub effect_type: EffectType,
    /// The cut the transition is centred on — the outgoing clip's out point.
    pub cut_sec: TimeSec,
    /// First instant of the blend, clamped at the timeline start.
    pub start_sec: TimeSec,
    /// Last instant of the blend.
    pub end_sec: TimeSec,
    /// The blend length, quantised to whole output frames.
    pub duration_sec: TimeSec,
    /// Whether the renderer refuses this transition and writes a hard cut.
    pub renders_as_cut: bool,
    /// Why the renderer refuses it; `None` when the file really gets the blend.
    pub refusal_reason: Option<String>,
}

/// How much there is to look at, at a glance.
///
/// Counts only; the detail sits in the corresponding lists on
/// [`InspectionSummary`]. A caller deciding how many frames to sample can read
/// these without pulling the whole summary apart.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionHints {
    /// Cuts the render actually shows — see [`collect_video_cuts`].
    pub cut_count: usize,
    /// Two-input transitions the render will really blend.
    pub transition_count: usize,
    /// Stored two-input transitions the render refuses and writes as cuts.
    pub refused_transition_count: usize,
    /// Clips on caption tracks.
    pub caption_count: usize,
    /// Text clips.
    pub text_count: usize,
    /// Sequence markers.
    pub marker_count: usize,
}

/// Everything a caller needs to decide where on a sequence to look.
///
/// Additive by contract: every field here is a *new* signal, and the surfaces
/// that serialize it (`timeline info`, `openreelio.timeline.snapshot`) merge it
/// alongside their existing keys rather than replacing any of them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionSummary {
    /// Editing length — the last out point of any clip, enabled or not.
    /// See [`Sequence::duration`].
    pub duration_sec: TimeSec,
    /// Render length — what a full-range export writes.
    /// See [`Sequence::output_duration`].
    pub output_duration_sec: TimeSec,
    /// Frame rate as a float, for arithmetic.
    pub fps: f64,
    /// Frame rate as the exact ratio the sequence stores.
    pub fps_ratio: Ratio,
    /// Output canvas size.
    pub canvas: Canvas,
    /// Sorted, deduplicated clip boundaries on *every* track, including `0.0`
    /// and the timeline's end, and including disabled clips.
    ///
    /// This is the editing view of the timeline. For "where does the picture
    /// change" read [`cuts`](Self::cuts) instead.
    pub edit_points: Vec<TimeSec>,
    /// Cuts the render actually shows — see [`collect_video_cuts`].
    pub cuts: Vec<TimeSec>,
    /// Sequence markers, in timeline order.
    pub markers: Vec<Marker>,
    /// Two-input transition spans, in cut order, refused ones included.
    pub transitions: Vec<TransitionSpan>,
    /// Caption-track clips, in timeline order.
    pub caption_spans: Vec<TextSpan>,
    /// Text clips, in timeline order.
    pub text_spans: Vec<TextSpan>,
    /// Counts derived from the lists above.
    pub inspection_hints: InspectionHints,
}

/// Builds the inspection summary for a sequence.
///
/// `effects` is the project's whole effect table; only the ids the sequence's
/// clips reference are read, so passing a superset is free.
pub fn inspection_summary(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> InspectionSummary {
    let duration_sec = sequence.duration();
    let edit_points = sequence.collect_edit_points();
    let cuts = collect_video_cuts(sequence);
    let transitions = collect_transition_spans(sequence, effects);
    let caption_spans = collect_caption_spans(sequence);
    let text_spans = collect_text_spans(sequence, effects);

    let mut markers = sequence.markers.clone();
    markers.sort_by(|a, b| {
        a.time_sec
            .partial_cmp(&b.time_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let refused_transition_count = transitions
        .iter()
        .filter(|span| span.renders_as_cut)
        .count();

    let hints = InspectionHints {
        cut_count: cuts.len(),
        transition_count: transitions.len() - refused_transition_count,
        refused_transition_count,
        caption_count: caption_spans.len(),
        text_count: text_spans.len(),
        marker_count: markers.len(),
    };

    InspectionSummary {
        duration_sec,
        output_duration_sec: sequence.output_duration(),
        fps: sequence.format.fps.as_f64(),
        fps_ratio: sequence.format.fps.clone(),
        canvas: sequence.format.canvas.clone(),
        edit_points,
        cuts,
        markers,
        transitions,
        caption_spans,
        text_spans,
        inspection_hints: hints,
    }
}

/// Collects the cuts the finished render actually shows, in timeline order.
///
/// A cut is a boundary between two **shots**, which is narrower than an edit
/// point in four ways: it only counts clips on video tracks the export includes
/// (see [`track_included_in_export`]), only enabled clips, not text clips —
/// which are titles drawn over the picture rather than shots, and are covered by
/// [`collect_text_spans`] — and not the timeline's own head and tail, neither of
/// which has a shot on both sides. It is the same clip set the frame probe's
/// `per_shot` sampler sweeps, so "a cut between two shots" means one thing.
///
/// [`Sequence::collect_edit_points`] answers a different question and stays the
/// answer to it: it is every boundary on every track, disabled clips included,
/// which is what an editor navigating with "next edit point" wants. Counting
/// those as cuts reported a caption's in point, an audio-only boundary and the
/// end of the timeline as places the picture changes.
pub fn collect_video_cuts(sequence: &Sequence) -> Vec<TimeSec> {
    // The render's own length, not the editing length: a boundary at or past
    // what the export writes has no incoming shot, so it is a tail, not a cut.
    let duration_sec = sequence.output_duration();

    let mut cuts: Vec<TimeSec> = Vec::new();
    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Video) || !track_included_in_export(track) {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled || is_text_clip(clip) {
                continue;
            }
            cuts.push(clip.place.timeline_in_sec);
            cuts.push(clip.place.timeline_out_sec());
        }
    }

    cuts.retain(|cut| cut.is_finite() && *cut > TIME_EPSILON && *cut < duration_sec - TIME_EPSILON);
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    cuts.dedup_by(|later, earlier| (*later - *earlier).abs() < TIME_EPSILON);
    cuts
}

/// Returns the blend length a two-input transition effect requests.
///
/// `None` unless the effect is enabled, is a two-input transition (see
/// [`EffectType::is_two_input_transition`]) and carries a usable positive
/// duration. Falls back to the engine's default length when the effect states
/// no `duration` parameter, matching what the render stitcher plans.
pub fn transition_duration_sec(effect: &Effect) -> Option<TimeSec> {
    if !effect.enabled || !effect.effect_type.is_two_input_transition() {
        return None;
    }

    let duration_sec = effect
        .get_float("duration")
        .unwrap_or(DEFAULT_TRANSITION_SEC);
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return None;
    }

    Some(duration_sec)
}

/// Returns the timeline stretch a two-input transition blends across.
///
/// The stitcher does not place a symmetric `±D/2` window. It rounds the
/// requested length to a whole number of output frames, gives the incoming
/// clip `frames / 2` of them (integer division) and the outgoing clip the
/// remainder, so an odd frame count puts the extra frame *after* the cut and the
/// blend still starts on the cut's own frame. Reporting `±D/2` therefore named a
/// window up to half a frame away from the one the file gets, on both edges.
///
/// The result is clamped at the timeline start, so a transition on the first cut
/// never reports a negative in point. `None` for anything
/// [`transition_duration_sec`] refuses, and for a non-finite cut. An unusable
/// `fps` falls back to the symmetric `±D/2` window, which is the best available
/// answer when there is no frame grid to quantise to.
///
/// This is the span of the *requested* blend. Whether the renderer will place it
/// is a separate question — see [`collect_transition_spans`].
pub fn transition_span_sec(
    effect: &Effect,
    cut_sec: TimeSec,
    fps: f64,
) -> Option<(TimeSec, TimeSec)> {
    if !cut_sec.is_finite() {
        return None;
    }
    let duration_sec = transition_duration_sec(effect)?;

    let Some(frames) = transition_frames(duration_sec, fps) else {
        let half = duration_sec / 2.0;
        return Some(((cut_sec - half).max(0.0), cut_sec + half));
    };

    let head_frames = (frames / 2) as f64;
    let tail_frames = frames as f64 - head_frames;
    Some((
        (cut_sec - head_frames / fps).max(0.0),
        cut_sec + tail_frames / fps,
    ))
}

/// The whole output frames a transition of `duration_sec` occupies.
///
/// The stitcher's own quantisation — `round`, floored at one frame — so the
/// reported span and the rendered blend are the same length. `None` when there
/// is no usable frame grid to quantise against.
fn transition_frames(duration_sec: TimeSec, fps: f64) -> Option<u32> {
    if !fps.is_finite() || fps <= 0.0 {
        return None;
    }
    Some((duration_sec * fps).round().max(1.0) as u32)
}

/// Collects every two-input transition span in the sequence, in cut order.
///
/// Refused transitions are reported too, with
/// [`renders_as_cut`](TransitionSpan::renders_as_cut) set: the span is where to
/// look to *confirm* the file shows a hard cut there. The refusals applied here
/// are the ones a timeline alone settles — the track kind and whether the export
/// includes it, whether either side contributes a picture, whether a clip that
/// starts where this one ends exists at all, the one-transition-per-out-point
/// rule, and the engine's length cap. The renderer additionally refuses a
/// transition for reasons only source media answers (no unused footage to reach
/// into, a blend not shorter than the shots it joins, a frozen or time-remapped
/// side); `render start` reports those as export warnings.
pub fn collect_transition_spans(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> Vec<TransitionSpan> {
    let fps = sequence.format.fps.as_f64();
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        let mut enabled: Vec<&Clip> = track.clips.iter().filter(|clip| clip.enabled).collect();
        enabled.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .partial_cmp(&b.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for clip in &track.clips {
            let cut_sec = clip.place.timeline_out_sec();
            let incoming = incoming_clip(&enabled, clip);

            for (index, effect) in stored_transitions(clip, effects).into_iter().enumerate() {
                let Some(duration_sec) = transition_duration_sec(effect) else {
                    continue;
                };
                let Some((start_sec, end_sec)) = transition_span_sec(effect, cut_sec, fps) else {
                    continue;
                };
                let refusal_reason =
                    transition_refusal_reason(clip, track, incoming, index, duration_sec);

                spans.push(TransitionSpan {
                    clip_id: clip.id.clone(),
                    track_id: track.id.clone(),
                    effect_id: effect.id.clone(),
                    effect_type: effect.effect_type.clone(),
                    cut_sec,
                    start_sec,
                    end_sec,
                    duration_sec: transition_frames(duration_sec, fps)
                        .map(|frames| frames as f64 / fps)
                        .unwrap_or(duration_sec),
                    renders_as_cut: refusal_reason.is_some(),
                    refusal_reason,
                });
            }
        }
    }

    spans.sort_by(|a, b| {
        a.cut_sec
            .partial_cmp(&b.cut_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    spans
}

/// The two-input transitions stored on a clip, in the order the renderer reads
/// them.
///
/// The same filter the render stitcher applies, so "the first one" means the
/// same effect on both sides.
fn stored_transitions<'a>(clip: &Clip, effects: &'a HashMap<EffectId, Effect>) -> Vec<&'a Effect> {
    clip.effects
        .iter()
        .filter_map(|effect_id| effects.get(effect_id))
        .filter(|effect| effect.enabled && effect.effect_type.is_two_input_transition())
        .collect()
}

/// The clip that starts where `outgoing` ends, on the same track.
///
/// `None` when the next enabled clip leaves a gap: there is no second picture to
/// blend into, so the boundary is a cut into black however it is decorated.
fn incoming_clip<'a>(enabled: &[&'a Clip], outgoing: &Clip) -> Option<&'a Clip> {
    let index = enabled.iter().position(|clip| clip.id == outgoing.id)?;
    enabled.get(index + 1).copied().filter(|next| {
        (next.place.timeline_in_sec - outgoing.place.timeline_out_sec()).abs()
            <= TIMELINE_EPSILON_SEC
    })
}

/// Why the renderer will write a cut instead of this blend, if it will.
fn transition_refusal_reason(
    clip: &Clip,
    track: &Track,
    incoming: Option<&Clip>,
    index: usize,
    duration_sec: TimeSec,
) -> Option<String> {
    if let Some(reason) = picture_refusal_reason(clip, track) {
        return Some(reason.to_string());
    }
    if index > 0 {
        return Some(
            "another transition already occupies this clip's out point, and a clip has only one \
             out point to blend across; remove one of them"
                .to_string(),
        );
    }
    let Some(incoming) = incoming else {
        return Some(
            "no clip starts where it ends on this track, so there is nothing to blend into"
                .to_string(),
        );
    };
    if let Some(reason) = picture_refusal_reason(incoming, track) {
        return Some(format!(
            "the incoming clip '{}' contributes no picture to blend into: {reason}",
            incoming.id
        ));
    }
    if duration_sec > MAX_TRANSITION_SEC {
        return Some(format!(
            "its duration of {duration_sec:.3}s is longer than the {MAX_TRANSITION_SEC:.0}s the \
             engine will place"
        ));
    }

    None
}

/// Collects caption-track clips as spans, in timeline order.
///
/// Caption text lives on the clip label — see the caption command module — so a
/// caption with no label reports an empty string rather than being dropped: the
/// span is still somewhere the picture changes.
///
/// A disabled caption, or one on a hidden or muted caption track, is left out:
/// the export drops it, so a still of its span shows the picture without it and
/// nothing about the words the caller wanted to read.
pub fn collect_caption_spans(sequence: &Sequence) -> Vec<TextSpan> {
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Caption) || !track_included_in_export(track) {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }
            spans.push(TextSpan {
                id: clip.id.clone(),
                track_id: track.id.clone(),
                start_sec: clip.place.timeline_in_sec,
                end_sec: clip.place.timeline_out_sec(),
                text: clip.label.clone().unwrap_or_default(),
            });
        }
    }

    sort_spans(&mut spans);
    spans
}

/// Collects text clips as spans, in timeline order.
///
/// Disabled clips and tracks the export leaves out are skipped, for the same
/// reason [`collect_caption_spans`] skips them: a title the render will not draw
/// is not somewhere to look for a title.
pub fn collect_text_spans(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> Vec<TextSpan> {
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        if !track_included_in_export(track) {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled || !is_text_clip(clip) {
                continue;
            }
            let text = get_text_data_from_effects(clip, effects)
                .map(|data| data.content)
                .or_else(|| clip.label.clone())
                .unwrap_or_default();
            spans.push(TextSpan {
                id: clip.id.clone(),
                track_id: track.id.clone(),
                start_sec: clip.place.timeline_in_sec,
                end_sec: clip.place.timeline_out_sec(),
                text,
            });
        }
    }

    sort_spans(&mut spans);
    spans
}

fn sort_spans(spans: &mut [TextSpan]) {
    spans.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::commands::TEXT_ASSET_PREFIX;
    use crate::core::effects::ParamValue;
    use crate::core::timeline::{Clip, ClipPlace, SequenceFormat, Track};

    fn sequence() -> Sequence {
        Sequence::new("Inspection", SequenceFormat::youtube_1080())
    }

    fn clip_at(asset_id: &str, start: f64, duration: f64) -> Clip {
        let mut clip = Clip::new(asset_id);
        clip.place = ClipPlace::new(start, duration);
        clip
    }

    #[test]
    fn should_report_duration_fps_and_canvas_from_the_sequence_format() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 4.0));
        seq.tracks.push(track);

        let summary = inspection_summary(&seq, &HashMap::new());

        assert_eq!(summary.duration_sec, 4.0);
        assert_eq!(summary.output_duration_sec, 4.0);
        assert_eq!(summary.fps, 30.0);
        assert_eq!(summary.fps_ratio.num, 30);
        assert_eq!(summary.fps_ratio.den, 1);
        assert_eq!(summary.canvas.width, 1920);
        assert_eq!(summary.canvas.height, 1080);
    }

    #[test]
    fn should_count_only_interior_boundaries_as_cuts() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 2.0));
        track.clips.push(clip_at("asset-b", 2.0, 3.0));
        seq.tracks.push(track);

        let summary = inspection_summary(&seq, &HashMap::new());

        assert_eq!(summary.edit_points, vec![0.0, 2.0, 5.0]);
        // 0.0 is the head and 5.0 the tail; only 2.0 is a cut.
        assert_eq!(summary.cuts, vec![2.0]);
        assert_eq!(summary.inspection_hints.cut_count, 1);
    }

    #[test]
    fn should_not_count_caption_audio_or_disabled_boundaries_as_cuts() {
        let mut seq = sequence();

        let mut video = Track::new_video("V1");
        video.clips.push(clip_at("asset-a", 0.0, 2.0));
        video.clips.push(clip_at("asset-b", 2.0, 4.0));
        let mut hidden_clip = clip_at("asset-c", 3.0, 1.0);
        hidden_clip.enabled = false;
        video.clips.push(hidden_clip);
        seq.tracks.push(video);

        let mut captions = Track::new_caption("C1");
        captions.clips.push(clip_at("__caption__", 1.0, 0.5));
        seq.tracks.push(captions);

        let mut audio = Track::new("A1", TrackKind::Audio);
        audio.clips.push(clip_at("asset-music", 4.5, 1.0));
        seq.tracks.push(audio);

        let summary = inspection_summary(&seq, &HashMap::new());

        // Every one of those boundaries is an edit point...
        assert!(
            summary.edit_points.contains(&1.0),
            "{:?}",
            summary.edit_points
        );
        assert!(
            summary.edit_points.contains(&4.5),
            "{:?}",
            summary.edit_points
        );
        // ...but the only place the *picture* changes is 2.0.
        assert_eq!(summary.cuts, vec![2.0]);
        assert_eq!(summary.inspection_hints.cut_count, 1);
    }

    #[test]
    fn should_not_count_a_title_cards_boundaries_as_cuts() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 4.0));
        seq.tracks.push(track);

        let mut titles = Track::new_video("V2");
        titles
            .clips
            .push(clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 1.0, 1.0));
        seq.tracks.push(titles);

        assert!(
            collect_video_cuts(&seq).is_empty(),
            "a title is drawn over the picture, not cut to"
        );
    }

    #[test]
    fn should_not_treat_a_muted_tracks_tail_as_the_end_of_the_timeline() {
        // A muted twenty-second music bed is not in the render, so the last
        // picture boundary is a tail, not a cut.
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 2.0));
        track.clips.push(clip_at("asset-b", 2.0, 2.0));
        seq.tracks.push(track);

        let mut music = Track::new("A1", TrackKind::Audio);
        music.muted = true;
        music.clips.push(clip_at("asset-music", 0.0, 20.0));
        seq.tracks.push(music);

        assert_eq!(collect_video_cuts(&seq), vec![2.0]);
    }

    #[test]
    fn should_leave_out_captions_and_titles_the_export_drops() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 8.0));
        seq.tracks.push(track);

        let mut captions = Track::new_caption("C1");
        let mut disabled_caption = clip_at("__caption__", 1.0, 2.0);
        disabled_caption.enabled = false;
        disabled_caption.label = Some("Never drawn".to_string());
        captions.clips.push(disabled_caption);
        seq.tracks.push(captions);

        let mut hidden_captions = Track::new_caption("C2");
        hidden_captions.visible = false;
        let mut hidden_caption = clip_at("__caption__", 4.0, 2.0);
        hidden_caption.label = Some("Also never drawn".to_string());
        hidden_captions.clips.push(hidden_caption);
        seq.tracks.push(hidden_captions);

        let mut titles = Track::new_video("V2");
        titles.muted = true;
        titles
            .clips
            .push(clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 6.0, 1.0));
        seq.tracks.push(titles);

        let summary = inspection_summary(&seq, &HashMap::new());

        assert!(
            summary.caption_spans.is_empty(),
            "{:?}",
            summary.caption_spans
        );
        assert!(summary.text_spans.is_empty(), "{:?}", summary.text_spans);
        assert_eq!(summary.inspection_hints.caption_count, 0);
        assert_eq!(summary.inspection_hints.text_count, 0);
    }

    #[test]
    fn should_not_count_cuts_on_a_track_the_export_leaves_out() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 2.0));
        track.clips.push(clip_at("asset-b", 2.0, 3.0));
        track.visible = false;
        seq.tracks.push(track);

        assert!(
            collect_video_cuts(&seq).is_empty(),
            "a hidden track is not in the render, so its boundaries are not cuts"
        );
    }

    #[test]
    fn should_report_markers_in_timeline_order() {
        let mut seq = sequence();
        seq.markers.push(Marker::new(4.0, "Late"));
        seq.markers.push(Marker::new(1.5, "Hook"));

        let summary = inspection_summary(&seq, &HashMap::new());

        let times: Vec<f64> = summary.markers.iter().map(|m| m.time_sec).collect();
        assert_eq!(times, vec![1.5, 4.0]);
        assert_eq!(summary.markers[0].label, "Hook");
        assert_eq!(summary.inspection_hints.marker_count, 2);
    }

    #[test]
    fn should_centre_a_transition_span_on_the_cut() {
        let mut seq = sequence();
        let mut outgoing = clip_at("asset-a", 0.0, 3.0);
        let mut incoming = clip_at("asset-b", 3.0, 3.0);
        incoming.id = "incoming".to_string();

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));
        outgoing.effects.push(effect.id.clone());
        let effect_id = effect.id.clone();

        let mut track = Track::new_video("V1");
        let track_id = track.id.clone();
        let outgoing_id = outgoing.id.clone();
        track.clips.push(outgoing);
        track.clips.push(incoming);
        seq.tracks.push(track);

        let mut effects = HashMap::new();
        effects.insert(effect_id.clone(), effect);

        let summary = inspection_summary(&seq, &effects);

        assert_eq!(summary.transitions.len(), 1);
        let span = &summary.transitions[0];
        assert_eq!(span.clip_id, outgoing_id);
        assert_eq!(span.track_id, track_id);
        assert_eq!(span.effect_id, effect_id);
        assert_eq!(span.effect_type, EffectType::CrossDissolve);
        assert_eq!(span.cut_sec, 3.0);
        assert_eq!(span.start_sec, 2.5);
        assert_eq!(span.end_sec, 3.5);
        assert_eq!(span.duration_sec, 1.0);
        assert!(!span.renders_as_cut);
        assert_eq!(span.refusal_reason, None);
        assert_eq!(summary.inspection_hints.transition_count, 1);
        assert_eq!(summary.inspection_hints.refused_transition_count, 0);
    }

    #[test]
    fn should_quantise_an_odd_frame_blend_the_way_the_stitcher_splits_it() {
        // 0.1s at 30fps is three frames, which cannot be split evenly. The
        // stitcher gives the extra frame to the side *after* the cut, so a
        // symmetric +/- D/2 span named a window the render never produces.
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(0.1));

        let (start_sec, end_sec) = transition_span_sec(&effect, 3.0, 30.0).expect("span");

        assert!((start_sec - (3.0 - 1.0 / 30.0)).abs() < 1e-9, "{start_sec}");
        assert!((end_sec - (3.0 + 2.0 / 30.0)).abs() < 1e-9, "{end_sec}");
    }

    #[test]
    fn should_fall_back_to_a_symmetric_span_without_a_usable_frame_rate() {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));

        assert_eq!(transition_span_sec(&effect, 3.0, 0.0), Some((2.5, 3.5)));
        assert_eq!(
            transition_span_sec(&effect, 3.0, f64::NAN),
            Some((2.5, 3.5))
        );
    }

    #[test]
    fn should_clamp_a_transition_span_at_the_timeline_start() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("duration", ParamValue::Float(2.0));

        let span = transition_span_sec(&effect, 0.5, 30.0).expect("span");
        assert_eq!(span, (0.0, 1.5));
    }

    #[test]
    fn should_ignore_disabled_and_single_input_transition_effects() {
        let mut disabled = Effect::new(EffectType::CrossDissolve);
        disabled.enabled = false;
        assert!(transition_duration_sec(&disabled).is_none());

        let fade = Effect::new(EffectType::Fade);
        assert!(transition_duration_sec(&fade).is_none());

        let mut zero = Effect::new(EffectType::Slide);
        zero.set_param("duration", ParamValue::Float(0.0));
        assert!(transition_duration_sec(&zero).is_none());
    }

    #[test]
    fn should_fall_back_to_the_engine_default_transition_length() {
        // `AddEffect` leaves `params` empty, so an agent-added dissolve arrives
        // with no duration at all and must be measured at the length the render
        // stitcher will actually place it at — one second.
        let effect = Effect::new(EffectType::CrossDissolve);

        assert_eq!(effect.get_float("duration"), None);
        assert_eq!(DEFAULT_TRANSITION_SEC, 1.0);
        assert_eq!(transition_duration_sec(&effect), Some(1.0));
    }

    /// A two-shot video track with a one-second dissolve on the first clip.
    ///
    /// Returns the sequence and the effect table, so a test can break exactly
    /// one of the renderer's preconditions and check the refusal it earns.
    fn dissolve_sequence(duration_sec: f64) -> (Sequence, HashMap<EffectId, Effect>) {
        let mut seq = sequence();

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(duration_sec));

        let mut outgoing = clip_at("asset-a", 0.0, 3.0);
        outgoing.effects.push(effect.id.clone());
        let incoming = clip_at("asset-b", 3.0, 3.0);

        let mut track = Track::new_video("V1");
        track.clips.push(outgoing);
        track.clips.push(incoming);
        seq.tracks.push(track);

        let mut effects = HashMap::new();
        effects.insert(effect.id.clone(), effect);
        (seq, effects)
    }

    /// The single span the sequence reports, panicking if there is not one.
    fn only_span(seq: &Sequence, effects: &HashMap<EffectId, Effect>) -> TransitionSpan {
        let mut spans = collect_transition_spans(seq, effects);
        assert_eq!(spans.len(), 1, "{spans:?}");
        spans.remove(0)
    }

    /// Asserts the span is reported as a cut for a reason mentioning `needle`.
    fn assert_refused(span: &TransitionSpan, needle: &str) {
        assert!(span.renders_as_cut, "{span:?}");
        let reason = span.refusal_reason.as_deref().unwrap_or_default();
        assert!(reason.contains(needle), "expected '{needle}' in: {reason}");
    }

    #[test]
    fn should_refuse_a_transition_on_a_track_that_is_not_video() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].kind = TrackKind::Overlay;

        assert_refused(&only_span(&seq, &effects), "not on a video track");
    }

    #[test]
    fn should_refuse_a_transition_on_a_track_the_export_leaves_out() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].muted = true;

        assert_refused(&only_span(&seq, &effects), "muted");

        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].visible = false;

        assert_refused(&only_span(&seq, &effects), "hidden");
    }

    #[test]
    fn should_refuse_a_transition_on_a_disabled_clip() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[0].enabled = false;

        assert_refused(&only_span(&seq, &effects), "disabled");
    }

    #[test]
    fn should_refuse_a_transition_on_a_text_clip_or_an_adjustment_layer() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[0].asset_id = format!("{TEXT_ASSET_PREFIX}title");

        assert_refused(&only_span(&seq, &effects), "text clip");

        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[0].is_adjustment_layer = true;

        assert_refused(&only_span(&seq, &effects), "adjustment layer");
    }

    #[test]
    fn should_refuse_a_transition_with_nothing_to_blend_into() {
        // A gap after the outgoing clip: the boundary is a cut into black.
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[1].place = ClipPlace::new(4.0, 3.0);

        assert_refused(&only_span(&seq, &effects), "nothing to blend into");

        // A disabled incoming clip is not there either.
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[1].enabled = false;

        assert_refused(&only_span(&seq, &effects), "nothing to blend into");
    }

    #[test]
    fn should_refuse_a_transition_whose_incoming_clip_shows_no_picture() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[1].asset_id = format!("{TEXT_ASSET_PREFIX}title");

        assert_refused(&only_span(&seq, &effects), "incoming clip");
    }

    #[test]
    fn should_refuse_every_transition_after_the_first_on_one_clip() {
        let (mut seq, mut effects) = dissolve_sequence(1.0);

        let mut second = Effect::new(EffectType::Wipe);
        second.set_param("duration", ParamValue::Float(1.0));
        seq.tracks[0].clips[0].effects.push(second.id.clone());
        effects.insert(second.id.clone(), second.clone());

        let spans = collect_transition_spans(&seq, &effects);
        assert_eq!(spans.len(), 2, "{spans:?}");

        let blended: Vec<&TransitionSpan> =
            spans.iter().filter(|span| !span.renders_as_cut).collect();
        assert_eq!(blended.len(), 1, "a clip has one out point: {spans:?}");
        let refused = spans
            .iter()
            .find(|span| span.effect_id == second.id)
            .expect("the second transition is still listed");
        assert_refused(refused, "already occupies this clip's out point");
    }

    #[test]
    fn should_refuse_a_transition_longer_than_the_engine_will_place() {
        let (seq, effects) = dissolve_sequence(MAX_TRANSITION_SEC + 1.0);

        assert_refused(&only_span(&seq, &effects), "longer than");
    }

    #[test]
    fn should_keep_refused_transitions_out_of_the_blend_count() {
        let (mut seq, effects) = dissolve_sequence(1.0);
        seq.tracks[0].clips[0].enabled = false;

        let summary = inspection_summary(&seq, &effects);

        assert_eq!(summary.transitions.len(), 1, "{summary:?}");
        assert_eq!(summary.inspection_hints.transition_count, 0);
        assert_eq!(summary.inspection_hints.refused_transition_count, 1);
    }

    #[test]
    fn should_report_caption_and_text_spans_with_their_words() {
        let mut seq = sequence();

        let mut caption_track = Track::new_caption("C1");
        let caption_track_id = caption_track.id.clone();
        let mut caption = clip_at("__caption__", 1.0, 2.0);
        caption.label = Some("Hello there".to_string());
        let caption_id = caption.id.clone();
        caption_track.clips.push(caption);
        seq.tracks.push(caption_track);

        let mut overlay_track = Track::new_video("V2");
        let mut text_clip = clip_at(&format!("{TEXT_ASSET_PREFIX}title"), 0.5, 1.0);
        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.set_param("text", ParamValue::String("Big Title".to_string()));
        text_clip.effects.push(text_effect.id.clone());
        let text_id = text_clip.id.clone();
        overlay_track.clips.push(text_clip);
        seq.tracks.push(overlay_track);

        let mut effects = HashMap::new();
        effects.insert(text_effect.id.clone(), text_effect);

        let summary = inspection_summary(&seq, &effects);

        assert_eq!(summary.caption_spans.len(), 1);
        assert_eq!(summary.caption_spans[0].id, caption_id);
        assert_eq!(summary.caption_spans[0].track_id, caption_track_id);
        assert_eq!(summary.caption_spans[0].start_sec, 1.0);
        assert_eq!(summary.caption_spans[0].end_sec, 3.0);
        assert_eq!(summary.caption_spans[0].text, "Hello there");

        assert_eq!(summary.text_spans.len(), 1);
        assert_eq!(summary.text_spans[0].id, text_id);
        assert_eq!(summary.text_spans[0].text, "Big Title");

        assert_eq!(summary.inspection_hints.caption_count, 1);
        assert_eq!(summary.inspection_hints.text_count, 1);
    }

    #[test]
    fn should_separate_editing_duration_from_render_duration() {
        let mut seq = sequence();
        let mut track = Track::new_video("V1");
        track.clips.push(clip_at("asset-a", 0.0, 2.0));
        let mut disabled = clip_at("asset-b", 2.0, 4.0);
        disabled.enabled = false;
        track.clips.push(disabled);
        seq.tracks.push(track);

        let summary = inspection_summary(&seq, &HashMap::new());

        assert_eq!(summary.duration_sec, 6.0);
        assert_eq!(summary.output_duration_sec, 2.0);
    }
}
