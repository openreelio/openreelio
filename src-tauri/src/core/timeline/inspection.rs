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
    render::transition_stitch::DEFAULT_TRANSITION_SEC,
    timeline::{Canvas, Marker, Sequence, TrackKind},
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
/// Transitions are stored on the **outgoing** clip and rendered centred on the
/// cut, so the span reaches back into the outgoing shot and forward into the
/// incoming one. Neither boundary is a clip boundary, which is exactly why a
/// caller cannot derive this from a clip list.
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
    /// `cut_sec - duration_sec / 2`, clamped at the timeline start.
    pub start_sec: TimeSec,
    /// `cut_sec + duration_sec / 2`.
    pub end_sec: TimeSec,
    /// The blend length the effect requests, in seconds.
    pub duration_sec: TimeSec,
}

/// How much there is to look at, at a glance.
///
/// Counts only; the detail sits in the corresponding lists on
/// [`InspectionSummary`]. A caller deciding how many frames to sample can read
/// these without pulling the whole summary apart.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionHints {
    /// Interior clip boundaries — edit points strictly inside the timeline.
    pub cut_count: usize,
    /// Two-input transitions that blend across a cut.
    pub transition_count: usize,
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
    /// Sorted, deduplicated clip boundaries, including `0.0`.
    pub edit_points: Vec<TimeSec>,
    /// Sequence markers, in timeline order.
    pub markers: Vec<Marker>,
    /// Two-input transition spans, in cut order.
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
    let transitions = collect_transition_spans(sequence, effects);
    let caption_spans = collect_caption_spans(sequence);
    let text_spans = collect_text_spans(sequence, effects);

    let mut markers = sequence.markers.clone();
    markers.sort_by(|a, b| {
        a.time_sec
            .partial_cmp(&b.time_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let cut_count = edit_points
        .iter()
        .filter(|point| **point > TIME_EPSILON && **point < duration_sec - TIME_EPSILON)
        .count();

    let hints = InspectionHints {
        cut_count,
        transition_count: transitions.len(),
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
        markers,
        transitions,
        caption_spans,
        text_spans,
        inspection_hints: hints,
    }
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
/// The span is centred on `cut_sec` — the outgoing clip's out point — and
/// clamped at the timeline start, so a transition on the first cut never
/// reports a negative in point. `None` for anything
/// [`transition_duration_sec`] refuses, and for a non-finite cut.
///
/// This is the *requested* span. The render stitcher additionally refuses a
/// transition it cannot place (no source handles, longer than the shot, longer
/// than the engine cap); such a boundary renders as a hard cut even though the
/// span is reported here.
pub fn transition_span_sec(effect: &Effect, cut_sec: TimeSec) -> Option<(TimeSec, TimeSec)> {
    if !cut_sec.is_finite() {
        return None;
    }
    let duration_sec = transition_duration_sec(effect)?;
    let half = duration_sec / 2.0;
    Some(((cut_sec - half).max(0.0), cut_sec + half))
}

/// Collects every two-input transition span in the sequence, in cut order.
pub fn collect_transition_spans(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> Vec<TransitionSpan> {
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        for clip in &track.clips {
            let cut_sec = clip.place.timeline_out_sec();
            for effect_id in &clip.effects {
                let Some(effect) = effects.get(effect_id) else {
                    continue;
                };
                let Some(duration_sec) = transition_duration_sec(effect) else {
                    continue;
                };
                let Some((start_sec, end_sec)) = transition_span_sec(effect, cut_sec) else {
                    continue;
                };

                spans.push(TransitionSpan {
                    clip_id: clip.id.clone(),
                    track_id: track.id.clone(),
                    effect_id: effect.id.clone(),
                    effect_type: effect.effect_type.clone(),
                    cut_sec,
                    start_sec,
                    end_sec,
                    duration_sec,
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

/// Collects caption-track clips as spans, in timeline order.
///
/// Caption text lives on the clip label — see the caption command module — so a
/// caption with no label reports an empty string rather than being dropped: the
/// span is still somewhere the picture changes.
pub fn collect_caption_spans(sequence: &Sequence) -> Vec<TextSpan> {
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Caption) {
            continue;
        }
        for clip in &track.clips {
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
pub fn collect_text_spans(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> Vec<TextSpan> {
    let mut spans = Vec::new();

    for track in &sequence.tracks {
        for clip in &track.clips {
            if !is_text_clip(clip) {
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
        assert_eq!(summary.inspection_hints.cut_count, 1);
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
        assert_eq!(summary.inspection_hints.transition_count, 1);
    }

    #[test]
    fn should_clamp_a_transition_span_at_the_timeline_start() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("duration", ParamValue::Float(2.0));

        let span = transition_span_sec(&effect, 0.5).expect("span");
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
        let effect = Effect::new(EffectType::CrossDissolve);
        let duration = effect.get_float("duration");
        let expected = duration.unwrap_or(DEFAULT_TRANSITION_SEC);

        assert_eq!(transition_duration_sec(&effect), Some(expected));
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
