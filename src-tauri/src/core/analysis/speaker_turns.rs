//! Heuristic speaker-turn inference.
//!
//! This module does not perform true speaker diarization. Instead it infers
//! conversational turns from transcript timing, speech-region continuity, and
//! pause/punctuation heuristics.

use crate::core::analysis::types::SpeechRegion;
use crate::core::annotations::models::TranscriptSegment;

/// Hard gap that always starts a new inferred speaker turn.
const TURN_HARD_GAP_SEC: f64 = 1.0;

/// Shorter gap that starts a new turn when the previous segment looks like a
/// sentence boundary.
const TURN_PUNCTUATION_GAP_SEC: f64 = 0.35;

/// Small speech-region changes only count as turn changes when there is a real
/// audible pause between segments, to avoid over-splitting one speaker into
/// many turns.
const TURN_SPEECH_REGION_GAP_SEC: f64 = 0.2;

fn overlap_duration(left_start: f64, left_end: f64, right_start: f64, right_end: f64) -> f64 {
    (left_end.min(right_end) - left_start.max(right_start)).max(0.0)
}

fn ends_sentence(text: &str) -> bool {
    let trimmed = text
        .trim_end()
        .trim_end_matches(['"', '\'', ')', ']', '}', '”', '’']);
    trimmed.ends_with('.') || trimmed.ends_with('!') || trimmed.ends_with('?')
}

fn dominant_speech_region_index(
    speech_regions: &[SpeechRegion],
    start_sec: f64,
    end_sec: f64,
) -> Option<usize> {
    speech_regions
        .iter()
        .enumerate()
        .map(|(index, region)| {
            (
                index,
                overlap_duration(region.start_sec, region.end_sec, start_sec, end_sec),
            )
        })
        .filter(|(_, overlap)| *overlap > 0.0)
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(index, _)| index)
}

/// Infer speaker turns for transcript segments.
pub fn infer_speaker_turns(
    segments: &[TranscriptSegment],
    speech_regions: &[SpeechRegion],
) -> Vec<TranscriptSegment> {
    if segments.is_empty() {
        return Vec::new();
    }

    let mut sorted = segments.to_vec();
    sorted.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));

    let mut turn_index = 0usize;
    let mut previous_segment: Option<TranscriptSegment> = None;
    let mut previous_speech_region_index: Option<usize> = None;

    for segment in &mut sorted {
        let current_speech_region_index =
            dominant_speech_region_index(speech_regions, segment.start_sec, segment.end_sec);
        let should_start_new_turn = match &previous_segment {
            None => true,
            Some(previous) => {
                let gap_sec = (segment.start_sec - previous.end_sec).max(0.0);
                let speech_region_changed = previous_speech_region_index.is_some()
                    && current_speech_region_index.is_some()
                    && previous_speech_region_index != current_speech_region_index
                    && gap_sec > TURN_SPEECH_REGION_GAP_SEC;

                gap_sec > TURN_HARD_GAP_SEC
                    || speech_region_changed
                    || (gap_sec > TURN_PUNCTUATION_GAP_SEC && ends_sentence(&previous.text))
            }
        };

        if should_start_new_turn {
            turn_index += 1;
        }

        segment.speaker_turn_id = Some(format!("turn_{:03}", turn_index));
        previous_speech_region_index = current_speech_region_index;
        previous_segment = Some(segment.clone());
    }

    sorted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_keep_continuous_segments_in_same_turn() {
        let segments = vec![
            TranscriptSegment::new(0.0, 1.0, "Hello there", 0.9),
            TranscriptSegment::new(1.05, 2.0, "still talking", 0.9),
        ];
        let speech_regions = vec![SpeechRegion::new(0.0, 2.0)];

        let turns = infer_speaker_turns(&segments, &speech_regions);

        assert_eq!(turns[0].speaker_turn_id.as_deref(), Some("turn_001"));
        assert_eq!(turns[1].speaker_turn_id.as_deref(), Some("turn_001"));
    }

    #[test]
    fn should_split_turns_on_large_gaps() {
        let segments = vec![
            TranscriptSegment::new(0.0, 1.0, "First speaker.", 0.9),
            TranscriptSegment::new(2.4, 3.0, "Second speaker.", 0.9),
        ];

        let turns = infer_speaker_turns(&segments, &[]);

        assert_eq!(turns[0].speaker_turn_id.as_deref(), Some("turn_001"));
        assert_eq!(turns[1].speaker_turn_id.as_deref(), Some("turn_002"));
    }

    #[test]
    fn should_split_turns_when_speech_region_changes() {
        let segments = vec![
            TranscriptSegment::new(0.0, 0.8, "Hello", 0.9),
            TranscriptSegment::new(1.2, 2.0, "Reply", 0.9),
        ];
        let speech_regions = vec![SpeechRegion::new(0.0, 0.9), SpeechRegion::new(1.1, 2.0)];

        let turns = infer_speaker_turns(&segments, &speech_regions);

        assert_eq!(turns[0].speaker_turn_id.as_deref(), Some("turn_001"));
        assert_eq!(turns[1].speaker_turn_id.as_deref(), Some("turn_002"));
    }

    #[test]
    fn should_not_split_turns_on_tiny_pause_between_speech_regions() {
        let segments = vec![
            TranscriptSegment::new(0.0, 0.8, "Hello", 0.9),
            TranscriptSegment::new(0.9, 1.6, "still me", 0.9),
        ];
        let speech_regions = vec![SpeechRegion::new(0.0, 0.82), SpeechRegion::new(0.88, 1.6)];

        let turns = infer_speaker_turns(&segments, &speech_regions);

        assert_eq!(turns[0].speaker_turn_id.as_deref(), Some("turn_001"));
        assert_eq!(turns[1].speaker_turn_id.as_deref(), Some("turn_001"));
    }
}
