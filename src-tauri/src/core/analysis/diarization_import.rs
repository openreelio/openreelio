//! External diarization JSON import.
//!
//! This module intentionally supports import-only speaker identity assignment.
//! It does not run a diarization model itself. Instead, it merges externally
//! generated speaker spans into cached transcript segments.

use serde::Deserialize;

use crate::core::analysis::speaker_turns::infer_speaker_turns;
use crate::core::analysis::types::SpeechRegion;
use crate::core::annotations::models::TranscriptSegment;
use crate::core::{CoreError, CoreResult};

/// Minimum overlap duration required to assign a speaker ID to a transcript segment.
const MIN_SPEAKER_OVERLAP_SEC: f64 = 0.15;

/// Minimum overlap share of a transcript segment required for speaker assignment.
const MIN_SPEAKER_OVERLAP_SHARE: f64 = 0.25;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSpeakerSegment {
    pub speaker_id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ImportedDiarizationPayload {
    SegmentsObject {
        segments: Vec<ImportedSpeakerSegment>,
    },
    SpeakersObject {
        speakers: Vec<ImportedSpeakerSegment>,
    },
    Direct(Vec<ImportedSpeakerSegment>),
}

fn overlap_duration(left_start: f64, left_end: f64, right_start: f64, right_end: f64) -> f64 {
    (left_end.min(right_end) - left_start.max(right_start)).max(0.0)
}

/// Parses a supported external diarization JSON payload.
pub fn parse_imported_diarization_json(json: &str) -> CoreResult<Vec<ImportedSpeakerSegment>> {
    let payload = serde_json::from_str::<ImportedDiarizationPayload>(json).map_err(|e| {
        CoreError::Internal(format!("Failed to parse diarization JSON payload: {}", e))
    })?;

    let mut segments = match payload {
        ImportedDiarizationPayload::SegmentsObject { segments } => segments,
        ImportedDiarizationPayload::SpeakersObject { speakers } => speakers,
        ImportedDiarizationPayload::Direct(segments) => segments,
    };

    segments.retain(|segment| {
        !segment.speaker_id.trim().is_empty()
            && segment.end_sec.is_finite()
            && segment.end_sec > segment.start_sec
    });
    segments.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));

    if segments.is_empty() {
        return Err(CoreError::Internal(
            "Diarization JSON did not contain any valid speaker segments".to_string(),
        ));
    }

    Ok(segments)
}

/// Applies imported speaker IDs to transcript segments, then recomputes speaker turns.
pub fn apply_imported_diarization(
    transcript: &[TranscriptSegment],
    diarization_segments: &[ImportedSpeakerSegment],
    speech_regions: &[SpeechRegion],
) -> Vec<TranscriptSegment> {
    let mut updated = transcript.to_vec();

    for segment in &mut updated {
        let segment_duration = (segment.end_sec - segment.start_sec).max(0.0);
        let best_match = diarization_segments
            .iter()
            .map(|speaker_segment| {
                (
                    speaker_segment,
                    overlap_duration(
                        segment.start_sec,
                        segment.end_sec,
                        speaker_segment.start_sec,
                        speaker_segment.end_sec,
                    ),
                )
            })
            .filter(|(_, overlap)| *overlap > 0.0)
            .max_by(|left, right| left.1.total_cmp(&right.1));

        if let Some((speaker_segment, overlap_sec)) = best_match {
            let overlap_share = if segment_duration > 0.0 {
                overlap_sec / segment_duration
            } else {
                0.0
            };
            if overlap_sec >= MIN_SPEAKER_OVERLAP_SEC || overlap_share >= MIN_SPEAKER_OVERLAP_SHARE
            {
                segment.speaker_id = Some(speaker_segment.speaker_id.clone());
            }
        }
    }

    infer_speaker_turns(&updated, speech_regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_segments_object_payload() {
        let json = r#"{
          "segments": [
            { "speakerId": "speaker_a", "startSec": 0.0, "endSec": 1.0 },
            { "speakerId": "speaker_b", "startSec": 1.0, "endSec": 2.0 }
          ]
        }"#;

        let segments = parse_imported_diarization_json(json).unwrap();

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].speaker_id, "speaker_a");
        assert_eq!(segments[1].speaker_id, "speaker_b");
    }

    #[test]
    fn should_assign_speaker_ids_by_overlap() {
        let transcript = vec![
            TranscriptSegment::new(0.0, 1.0, "Hello", 0.9),
            TranscriptSegment::new(1.2, 2.4, "Hi there", 0.9),
        ];
        let diarization = vec![
            ImportedSpeakerSegment {
                speaker_id: "speaker_a".to_string(),
                start_sec: 0.0,
                end_sec: 1.0,
                confidence: Some(0.9),
            },
            ImportedSpeakerSegment {
                speaker_id: "speaker_b".to_string(),
                start_sec: 1.0,
                end_sec: 2.5,
                confidence: Some(0.9),
            },
        ];

        let updated = apply_imported_diarization(&transcript, &diarization, &[]);

        assert_eq!(updated[0].speaker_id.as_deref(), Some("speaker_a"));
        assert_eq!(updated[1].speaker_id.as_deref(), Some("speaker_b"));
        assert_eq!(updated[0].speaker_turn_id.as_deref(), Some("turn_001"));
        assert_eq!(updated[1].speaker_turn_id.as_deref(), Some("turn_002"));
    }

    #[test]
    fn should_leave_segment_without_sufficient_overlap_unlabeled() {
        let transcript = vec![TranscriptSegment::new(0.0, 2.0, "Hello", 0.9)];
        let diarization = vec![ImportedSpeakerSegment {
            speaker_id: "speaker_a".to_string(),
            start_sec: 1.95,
            end_sec: 2.0,
            confidence: Some(0.9),
        }];

        let updated = apply_imported_diarization(&transcript, &diarization, &[]);

        assert_eq!(updated[0].speaker_id, None);
    }
}
